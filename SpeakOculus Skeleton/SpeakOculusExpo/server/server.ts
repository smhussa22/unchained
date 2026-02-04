import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';

// =============================================================================
// ENVIRONMENT SETUP
// =============================================================================
// Try multiple locations for .env file (handles both dev and production)
// When running as dist/server.js, __dirname is dist/ — load from project root first.
const envPaths = [
    path.resolve(__dirname, '../.env'),            // Project root when running from dist/
    path.resolve(__dirname, '.env'),               // Same directory as script
    path.resolve(process.cwd(), '.env'),          // Current working directory
];

for (const envPath of envPaths) {
    const result = dotenv.config({ path: envPath });
    if (!result.error) {
        console.log(`[RELAY] Loaded .env from: ${envPath}`);
        break;
    }
}

const PORT = 8082;
const HOST = '0.0.0.0'; // Accept traffic from any interface (required for AWS EC2)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

// Keep-alive interval (30 seconds) - prevents AWS/router from dropping idle connections
const PING_INTERVAL_MS = 30000;

if (!OPENAI_API_KEY) {
    console.error('[FATAL] OPENAI_API_KEY is missing or empty in .env');
    console.error('[FATAL] Check: .env must contain exactly one line: OPENAI_API_KEY=sk-proj-... (no spaces, no quotes)');
    process.exit(1);
}

// Create WebSocket Server bound to all interfaces
const wss = new WebSocketServer({ port: PORT, host: HOST });

console.log(`[RELAY] Server running on ${HOST}:${PORT}`);
console.log('[RELAY] Waiting for client connections...');

// =============================================================================
// SESSION CONFIGURATION (OpenAI Realtime API)
// =============================================================================
const SESSION_CONFIG = {
    modalities: ['audio', 'text'],
    instructions: `
    You are a friendly, helpful AI assistant.
    - Style: Conversational, concise, and warm.
    - Voice: Alloy.
    - Language: English.
    - Response: Keep responses short (1-2 sentences) unless asked for detail.
  `,
    voice: 'alloy',
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16', // RAW PCM16 @ 24kHz (OpenAI standard)
    input_audio_transcription: {
        model: 'whisper-1',
    },
    turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500, // Fast turn-taking for natural conversation
    },
};

// =============================================================================
// CRITICAL EVENTS - Events that the Frontend needs for UI synchronization
// =============================================================================
const CRITICAL_EVENTS = [
    'session.created',              // Session ready - Client can show "connected"
    'input_audio_buffer.speech_started', // VAD detected user speaking - Stop AI audio playback
    'input_audio_buffer.speech_stopped', // User stopped speaking
    'response.created',             // AI is about to respond
    'response.done',                // AI finished responding
    'error',                        // Something went wrong
];

// =============================================================================
// CONNECTION HANDLER - One Client = One OpenAI Session (1:1 Mapping)
// =============================================================================
wss.on('connection', (clientWs: WebSocket) => {
    const clientId = Date.now().toString(36); // Simple unique ID for logging
    console.log(`[RELAY] Client ${clientId} connected`);

    // Track cleanup state to prevent double-cleanup
    let isCleanedUp = false;
    let pingInterval: NodeJS.Timeout | null = null;

    // -------------------------------------------------------------------------
    // CLEANUP FUNCTION - The "Billing Saver"
    // Ensures both sockets are destroyed when either side disconnects.
    // This prevents zombie sessions from draining API credits.
    // -------------------------------------------------------------------------
    const cleanup = (reason: string) => {
        if (isCleanedUp) return; // Prevent double-cleanup
        isCleanedUp = true;

        console.log(`[RELAY] Cleanup triggered for ${clientId}: ${reason}`);

        // Stop the keep-alive ping
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        // Close OpenAI socket if still open
        if (openAiWs.readyState === WebSocket.OPEN || openAiWs.readyState === WebSocket.CONNECTING) {
            console.log(`[RELAY] Closing OpenAI socket for ${clientId}`);
            openAiWs.close();
        }

        // Close Client socket if still open
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
            console.log(`[RELAY] Closing Client socket for ${clientId}`);
            clientWs.close();
        }

        console.log(`[RELAY] Session ${clientId} fully cleaned up`);
    };

    // -------------------------------------------------------------------------
    // UPSTREAM CONNECTION - Relay <-> OpenAI Realtime API
    // -------------------------------------------------------------------------
    // Model: gpt-realtime-mini-2025-12-15 - cost-effective with vision support
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    // OpenAI Socket Opened - Configure session
    openAiWs.on('open', () => {
        console.log(`[RELAY] OpenAI handshake complete for ${clientId}`);

        // Send session configuration
        const sessionUpdate = {
            type: 'session.update',
            session: SESSION_CONFIG,
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log(`[RELAY] Session configured for ${clientId}`);

        // Start keep-alive ping to prevent connection drops
        pingInterval = setInterval(() => {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.ping();
            }
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.ping();
            }
        }, PING_INTERVAL_MS);
    });

    // OpenAI Message Received - Forward to Client
    openAiWs.on('message', (data: any) => {
        try {
            const response = JSON.parse(data.toString());
            const eventType = response.type;

            // ===== CRITICAL EVENT: SPEECH STARTED (VAD Link) =====
            // This is the most important event for UI synchronization.
            // When OpenAI detects the user speaking, we IMMEDIATELY notify
            // the client so it can stop AI audio playback (barge-in).
            if (eventType === 'input_audio_buffer.speech_started') {
                console.log(`[RELAY] Speech started - interrupting client ${clientId}`);
            }

            // Log critical events, suppress audio delta spam
            if (CRITICAL_EVENTS.includes(eventType)) {
                console.log(`[OPENAI -> CLIENT] ${eventType}`);
            } else if (eventType !== 'response.audio.delta') {
                // Log non-audio events for debugging
                console.log(`[OPENAI] ${eventType}`);
            }

            // Forward to Client (passthrough - no transformation)
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data.toString());
            }
        } catch (e) {
            console.error(`[RELAY] Error parsing OpenAI message for ${clientId}:`, e);
        }
    });

    // OpenAI Socket Closed - Trigger cleanup
    openAiWs.on('close', (code, reason) => {
        console.log(`[RELAY] OpenAI disconnected for ${clientId} (code: ${code}, reason: ${reason || 'none'})`);
        cleanup('OpenAI socket closed');
    });

    // OpenAI Socket Error - Log and cleanup
    openAiWs.on('error', (err: Error) => {
        console.error(`[RELAY] OpenAI error for ${clientId}:`, err.message);
        cleanup('OpenAI socket error');
    });

    // -------------------------------------------------------------------------
    // DOWNSTREAM CONNECTION - Client <-> Relay
    // -------------------------------------------------------------------------

    // Client Message Received - Forward to OpenAI
    clientWs.on('message', (data: any) => {
        try {
            const message = JSON.parse(data.toString());
            const messageType = message.type;

            // Log non-audio messages for debugging
            if (messageType !== 'input_audio_buffer.append') {
                console.log(`[CLIENT -> OPENAI] ${messageType}`);
            }

            // =================================================================
            // VISION DIRECT INJECTION HANDLER (Phase 2.1)
            // Injects images directly into the active OpenAI Realtime session
            // as a user message with multimodal content (text + image).
            //
            // Documentation confirms format uses:
            //   - type: 'input_image'
            //   - image_url: 'data:image/jpeg;base64,...' (data URI format)
            // =================================================================
            if (messageType === 'vision.direct_injection') {
                const base64Image = message.image;

                if (!base64Image) {
                    console.warn(`[Vision] Received vision event without image payload`);
                    return;
                }

                console.log(`[Vision] Received image payload. Size: ${base64Image.length} chars`);

                // Construct the conversation.item.create payload with multimodal content
                const visionPayload = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [
                            {
                                type: 'input_text',
                                text: 'I am showing you something. Describe it briefly and ask me a question about it.',
                            },
                            {
                                type: 'input_image',
                                image_url: `data:image/jpeg;base64,${base64Image}`,
                            },
                        ],
                    },
                };

                // Safety: Wrap send in try/catch to handle flaky connections
                try {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        // Send the image injection
                        openAiWs.send(JSON.stringify(visionPayload));
                        console.log(`[Vision] Injected image into session for ${clientId}`);

                        // Immediately trigger a response so AI acknowledges the image now
                        const responseCreate = { type: 'response.create' };
                        openAiWs.send(JSON.stringify(responseCreate));
                        console.log(`[Vision] Triggered response.create for ${clientId}`);
                    } else {
                        console.warn(`[Vision] Cannot inject - OpenAI socket not open (state: ${openAiWs.readyState})`);
                    }
                } catch (sendError) {
                    console.error(`[Vision] Failed to send vision payload for ${clientId}:`, sendError);
                }

                return; // Don't forward vision.direct_injection to OpenAI as-is
            }

            // Forward to OpenAI (passthrough - no transformation)
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify(message));
            } else {
                console.warn(`[RELAY] Cannot forward to OpenAI - socket not open (state: ${openAiWs.readyState})`);
            }
        } catch (e) {
            console.error(`[RELAY] Error parsing client message for ${clientId}:`, e);
        }
    });

    // Client Socket Closed - Trigger cleanup
    clientWs.on('close', (code, reason) => {
        console.log(`[RELAY] Client ${clientId} disconnected (code: ${code}, reason: ${reason || 'none'})`);
        cleanup('Client socket closed');
    });

    // Client Socket Error - Log and cleanup
    clientWs.on('error', (err: Error) => {
        console.error(`[RELAY] Client error for ${clientId}:`, err.message);
        cleanup('Client socket error');
    });

    // Handle pong responses (for keep-alive)
    clientWs.on('pong', () => {
        // Connection is alive - no action needed
    });
    openAiWs.on('pong', () => {
        // Connection is alive - no action needed
    });
});

// =============================================================================
// GRACEFUL SHUTDOWN - Clean exit for PM2 and manual termination
// =============================================================================
const shutdown = (signal: string) => {
    console.log(`[RELAY] ${signal} received - shutting down gracefully...`);

    // Close the server (stop accepting new connections)
    wss.close(() => {
        console.log('[RELAY] Server closed');
        process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[RELAY] Forced shutdown after timeout');
        process.exit(1);
    }, 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
