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
// Default instructions (can be overridden by agent.config from client)
const DEFAULT_INSTRUCTIONS = `
You are a friendly, helpful AI assistant.
- Style: Conversational, concise, and warm.
- Voice: Alloy.
- Language: English.
- Response: Keep responses short (1-2 sentences) unless asked for detail.
`;

const SESSION_CONFIG = {
    modalities: ['audio', 'text'],
    instructions: DEFAULT_INSTRUCTIONS,
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
    // ==========================================================================
    // TOOL DEFINITIONS (Phase 3.0 - The Friend Loop)
    // ==========================================================================
    tools: [
        {
            type: 'function',
            name: 'log_gap_word',
            description: 'ALWAYS call this function whenever the user says ANY word in English (their native language) instead of the target language. Call it for EVERY English word - be liberal. Even small words like "yes", "the", "okay" count. This tracks vocabulary gaps for spaced repetition. Call multiple times if user says multiple English words.',
            parameters: {
                type: 'object',
                properties: {
                    native_word: {
                        type: 'string',
                        description: 'The English word or short phrase the user said',
                    },
                    target_word: {
                        type: 'string',
                        description: 'The correct translation in the target language',
                    },
                },
                required: ['native_word', 'target_word'],
            },
        },
    ],
    tool_choice: 'auto',
};

// =============================================================================
// CRITICAL EVENTS - Events that the Frontend needs for UI synchronization
// =============================================================================
const CRITICAL_EVENTS = [
    'session.created',                          // Session ready - Client can show "connected"
    'session.updated',                          // Session config updated (e.g., new instructions)
    'input_audio_buffer.speech_started',        // VAD detected user speaking - Stop AI audio playback
    'input_audio_buffer.speech_stopped',        // User stopped speaking
    'response.created',                         // AI is about to respond
    'response.done',                            // AI finished responding
    'response.cancelled',                       // AI response was cancelled (barge-in)
    'conversation.item.truncated',              // Truncation confirmed by OpenAI
    'response.function_call_arguments.done',    // Tool call completed - Handle function
    'error',                                    // Something went wrong
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

    // =========================================================================
    // SESSION MEMORY (Phase 3.0 - The Friend Loop)
    // =========================================================================
    // Gap words the user forgot during this session
    const gapWords: Array<{ native: string; target: string }> = [];
    // Current instructions (mutable - updated by agent.config and context injection)
    let currentInstructions = DEFAULT_INSTRUCTIONS;
    // Pending agent config (client may send before OpenAI is ready)
    let pendingAgentConfig: { name: string; language: string } | null = null;

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
    // HELPER: Apply Agent Config (builds and sends the Friend Mode prompt)
    // -------------------------------------------------------------------------
    const applyAgentConfig = (name: string, language: string) => {
        // Build the Friend Mode system prompt
        currentInstructions = `You are ${name}, a friendly ${language} tutor having an immersive conversation.

CRITICAL: You MUST speak ONLY in ${language}. Do NOT speak English except when correcting an English word the user said.

TOOL USAGE - VERY IMPORTANT:
- You have access to the \`log_gap_word\` tool. You MUST call it EVERY TIME the user says ANY English word or phrase.
- Be LIBERAL with tool calls. If in doubt, log it.
- Call the tool for EACH distinct English word/phrase separately (e.g., if user says "the cat and the dog", call the tool twice: once for "cat"→"chat", once for "dog"→"chien").
- Even common words like "yes", "no", "okay", "the", "a" should be logged if said in English.
- The tool helps track vocabulary gaps. More data = better learning.

CORE BEHAVIORS:
1. ALWAYS respond in ${language}. Start your very first message with a warm greeting in ${language}.
2. If the user shows you an object (via image), describe it and ask questions about it — all in ${language}.
3. When the user says ANY English word, IMMEDIATELY:
   a) Call \`log_gap_word\` with native_word (the English) and target_word (the ${language} translation)
   b) Gently correct them by providing the ${language} word (e.g., "Ah, tu veux dire la cuillère!")
4. If the context mentions the user forgot a word, weave that word into your next response to reinforce it.
5. Keep responses SHORT (1-2 sentences). This is a real-time voice conversation.
6. Be encouraging! Celebrate progress in ${language}.

STYLE:
- Speak naturally and conversationally, as a native ${language} speaker would
- Adjust vocabulary to beginner/intermediate level
- Use simple sentence structures`;

        // Send session.update to OpenAI with the new instructions
        const sessionUpdate = {
            type: 'session.update',
            session: { instructions: currentInstructions },
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log(`[RELAY] Agent configured for ${clientId}: "${name}" teaching "${language}"`);
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

        // Apply pending agent config if client sent it before OpenAI was ready
        if (pendingAgentConfig) {
            console.log(`[RELAY] Applying pending agent config for ${clientId}`);
            applyAgentConfig(pendingAgentConfig.name, pendingAgentConfig.language);
            pendingAgentConfig = null;
        }

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

            // =================================================================
            // TOOL CALL HANDLER (Phase 3.0 - The Friend Loop)
            // When OpenAI calls a function, we handle it here.
            // =================================================================
            if (eventType === 'response.function_call_arguments.done') {
                const { call_id, name, arguments: argsJson } = response;

                if (name === 'log_gap_word') {
                    try {
                        const args = JSON.parse(argsJson);
                        const { native_word, target_word } = args;

                        // 1. Store in session memory
                        gapWords.push({ native: native_word, target: target_word });
                        console.log(`[MEMORY] Logged gap word for ${clientId}: "${native_word}" -> "${target_word}"`);
                        console.log(`[MEMORY] Session has ${gapWords.length} gap words total`);

                        // 2. Send function output back to OpenAI (completes the tool call loop)
                        const toolOutput = {
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: call_id,
                                output: JSON.stringify({
                                    status: 'logged',
                                    native_word,
                                    target_word,
                                    message: `Word logged. Try to use "${target_word}" in your next response to reinforce it.`,
                                }),
                            },
                        };
                        openAiWs.send(JSON.stringify(toolOutput));
                        console.log(`[RELAY] Sent tool output for ${clientId}`);

                        // 3. Trigger response so AI continues speaking
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        console.log(`[RELAY] Triggered response.create for ${clientId}`);

                        // 4. Context Injection: Update instructions with hint about the gap word
                        currentInstructions += `\n\nCONTEXT UPDATE: User recently forgot "${target_word}" (they said "${native_word}" instead). Try to use "${target_word}" naturally in your next response to reinforce it.`;
                        const sessionUpdate = {
                            type: 'session.update',
                            session: { instructions: currentInstructions },
                        };
                        openAiWs.send(JSON.stringify(sessionUpdate));
                        console.log(`[RELAY] Injected context hint for "${target_word}" into session ${clientId}`);

                    } catch (e) {
                        console.error(`[RELAY] Failed to parse tool arguments for ${clientId}:`, e);
                    }
                }
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

            // =================================================================
            // DYNAMIC PERSONA HANDLER (Phase 3.0 - The Friend Loop)
            // Client sends agent config (name, language) to set up Friend Mode.
            // =================================================================
            if (messageType === 'agent.config') {
                const { name, language } = message.config || {};

                if (name && language) {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        // OpenAI is ready - apply immediately
                        applyAgentConfig(name, language);
                    } else {
                        // OpenAI not ready yet - queue for later
                        console.log(`[RELAY] Queuing agent config for ${clientId} (OpenAI not ready)`);
                        pendingAgentConfig = { name, language };
                    }
                } else {
                    console.warn(`[RELAY] Received agent.config without name or language for ${clientId}`);
                }

                return; // Don't forward agent.config to OpenAI as-is
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
