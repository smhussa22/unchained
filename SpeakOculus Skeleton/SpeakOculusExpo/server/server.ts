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

// =============================================================================
// STABILITY CONSTANTS
// =============================================================================
// Keep-alive interval (30 seconds) - prevents AWS/router from dropping idle connections
const PING_INTERVAL_MS = 30_000;
// [FIX: Zombie Detection] Maximum gap words per session (FIFO eviction when exceeded)
const MAX_GAP_WORDS = 50;
// [FIX: Bounded Growth] Maximum characters for instructions payload.
// OpenAI Realtime API has a ~16,384 token budget for instructions+tools.
// At ~4 chars/token, that is ~65K chars. We cap at 8,000 chars for instructions
// to leave headroom for tool definitions (~2K tokens) and safety margin.
const MAX_INSTRUCTIONS_CHARS = 8_000;
// [FIX: Race Condition] Debounce window for session.update after tool calls.
// Coalesces rapid tool calls into a single context injection.
const CONTEXT_UPDATE_DEBOUNCE_MS = 2_000;
// [FIX: Input Validation] Maximum base64 image size (5MB base64 ~ 3.75MB decoded)
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024 * (4 / 3); // ~6.67M chars
// [FIX: Input Validation] Maximum single message size from client (10MB)
const MAX_CLIENT_MESSAGE_BYTES = 10 * 1024 * 1024;

if (!OPENAI_API_KEY) {
    console.error('[FATAL] OPENAI_API_KEY is missing or empty in .env');
    console.error('[FATAL] Check: .env must contain exactly one line: OPENAI_API_KEY=sk-proj-... (no spaces, no quotes)');
    process.exit(1);
}

// Create WebSocket Server bound to all interfaces
// [FIX: Input Validation] Set maxPayload to reject oversized frames at the protocol level
const wss = new WebSocketServer({
    port: PORT,
    host: HOST,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
});

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
            description: 'Call this when the user says a meaningful English word instead of the target language equivalent. Only log words that represent genuine vocabulary gaps — NOT discourse markers (okay, yes, no, um, so, like, well), NOT loanwords commonly used in the target language, and NOT filler words. If the user says multiple English words in one utterance, log only the MOST important one (the one most relevant to the current conversation topic, or the most common word). Do NOT log the same word twice in one session.',
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
                    severity: {
                        type: 'string',
                        enum: ['critical', 'topic', 'common', 'recurring'],
                        description: 'How important this correction is: critical=incomprehensible, topic=related to current discussion, common=high-frequency word, recurring=user has said this before',
                    },
                },
                required: ['native_word', 'target_word', 'severity'],
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

    // [FIX: Zombie Detection] Track liveness of both sockets via pong responses
    let clientIsAlive = true;
    let openAiIsAlive = true;

    // =========================================================================
    // SESSION MEMORY (Phase 3.0 - The Friend Loop)
    // =========================================================================
    // Gap words the user forgot during this session
    // [FIX: Bounded Growth] Capped at MAX_GAP_WORDS with FIFO eviction
    let gapWords: Array<{ native: string; target: string }> = [];
    // Current base instructions (set by agent.config, NOT appended to)
    let baseInstructions = DEFAULT_INSTRUCTIONS;
    // Pending agent config (client may send before OpenAI is ready)
    let pendingAgentConfig: { name: string; language: string } | null = null;

    // [FIX: Race Condition] Debounce timer for context injection via session.update
    let contextUpdateTimer: NodeJS.Timeout | null = null;

    // -------------------------------------------------------------------------
    // HELPER: Add Gap Word with Bounded Growth and Deduplication
    // -------------------------------------------------------------------------
    const addGapWord = (native: string, target: string): void => {
        // Deduplicate: skip if this exact pair already exists
        const exists = gapWords.some(
            (gw) => gw.native === native && gw.target === target
        );
        if (exists) {
            console.log(`[MEMORY] Duplicate gap word skipped for ${clientId}: "${native}" -> "${target}"`);
            return;
        }

        // [FIX: Bounded Growth] FIFO eviction when at capacity
        if (gapWords.length >= MAX_GAP_WORDS) {
            const evicted = gapWords.shift();
            console.log(`[MEMORY] Evicted oldest gap word for ${clientId}: "${evicted?.native}" -> "${evicted?.target}"`);
        }

        gapWords.push({ native, target });
        console.log(`[MEMORY] Logged gap word for ${clientId}: "${native}" -> "${target}" (${gapWords.length}/${MAX_GAP_WORDS})`);
    };

    // -------------------------------------------------------------------------
    // HELPER: Build Instructions with Gap Word Context (Bounded)
    // Instead of appending to instructions indefinitely, we rebuild from base
    // instructions + a bounded summary of recent gap words.
    // -------------------------------------------------------------------------
    const buildInstructionsWithContext = (): string => {
        if (gapWords.length === 0) {
            return baseInstructions;
        }

        // Bounded sliding window: only include last 3 gap words for focused context
        const recentGapWords = gapWords.slice(-3);
        const gapWordSummary = recentGapWords
            .map((gw) => `"${gw.target}" (user said "${gw.native}")`)
            .join(', ');

        const contextSection = `\n\n== SESSION MEMORY ==
Words the user has struggled with recently: ${gapWordSummary}.
Do NOT quiz them on these words. When a natural opportunity arises (topic change, related question), you may weave ONE of these words into your response — but only if it fits organically. Never force it.`;

        const fullInstructions = baseInstructions + contextSection;

        // [FIX: Bounded Growth] Hard cap on total instruction size
        if (fullInstructions.length > MAX_INSTRUCTIONS_CHARS) {
            console.warn(`[RELAY] Instructions truncated for ${clientId}: ${fullInstructions.length} > ${MAX_INSTRUCTIONS_CHARS} chars`);
            return fullInstructions.substring(0, MAX_INSTRUCTIONS_CHARS);
        }

        return fullInstructions;
    };

    // -------------------------------------------------------------------------
    // HELPER: Schedule Debounced Context Update
    // [FIX: Race Condition] Coalesces rapid tool calls into a single session.update
    // -------------------------------------------------------------------------
    const scheduleContextUpdate = (): void => {
        // Clear any pending debounce timer
        if (contextUpdateTimer) {
            clearTimeout(contextUpdateTimer);
        }

        contextUpdateTimer = setTimeout(() => {
            contextUpdateTimer = null;

            // Guard: only send if session is still alive and OpenAI socket is open
            if (isCleanedUp || openAiWs.readyState !== WebSocket.OPEN) {
                return;
            }

            const instructions = buildInstructionsWithContext();
            const sessionUpdate = {
                type: 'session.update',
                session: { instructions },
            };
            openAiWs.send(JSON.stringify(sessionUpdate));
            console.log(`[RELAY] Debounced context update sent for ${clientId} (${gapWords.length} gap words, ${instructions.length} chars)`);
        }, CONTEXT_UPDATE_DEBOUNCE_MS);
    };

    // -------------------------------------------------------------------------
    // CLEANUP FUNCTION - The "Billing Saver"
    // Ensures both sockets are destroyed when either side disconnects.
    // This prevents zombie sessions from draining API credits.
    // -------------------------------------------------------------------------
    const cleanup = (reason: string) => {
        if (isCleanedUp) return; // Prevent double-cleanup
        isCleanedUp = true;

        console.log(`[RELAY] Cleanup triggered for ${clientId}: ${reason}`);

        // [FIX: Race Condition] Clear debounce timer to prevent stale session.update
        if (contextUpdateTimer) {
            clearTimeout(contextUpdateTimer);
            contextUpdateTimer = null;
        }

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

        // [FIX: Memory Cleanup] Remove all event listeners to break closure references
        // and allow GC to collect session state promptly
        openAiWs.removeAllListeners();
        clientWs.removeAllListeners();

        // [FIX: Memory Cleanup] Null out session state to release memory immediately
        // rather than waiting for the closure to be GC'd
        gapWords = [];
        baseInstructions = '';
        pendingAgentConfig = null;

        console.log(`[RELAY] Session ${clientId} fully cleaned up (listeners removed, state cleared)`);
    };

    // -------------------------------------------------------------------------
    // HELPER: Apply Agent Config (builds and sends the Friend Mode prompt)
    // -------------------------------------------------------------------------
    const applyAgentConfig = (name: string, language: string) => {
        // Build the Friend Mode system prompt
        // [FIX: Bounded Growth] Set baseInstructions (not currentInstructions).
        // Context injection rebuilds from baseInstructions + gap words each time.
        baseInstructions = `You are ${name}, a native ${language} speaker having a relaxed, friendly conversation. You are NOT a teacher. You are a friend who happens to speak ${language} natively.

== LANGUAGE RULE ==
Speak ONLY in ${language}. Your entire output must be in ${language}, except when performing a recast correction (see below).

== YOUR PERSONALITY ==
- You are curious, warm, and genuinely interested in what the user has to say.
- You react to the CONTENT of their message first. Their ideas matter more than their grammar.
- You keep responses short (1-2 sentences). This is a real-time voice conversation, not a lecture.
- You ask follow-up questions to keep the conversation flowing.
- You celebrate when the user expresses something well, but casually — like a friend would ("Nice!", "Exactement!"), not like a teacher grading them.
- If the user shows you an object (via image), describe it and ask questions about it — all in ${language}.
- Start your first message with a warm, casual greeting in ${language}.

== CORRECTION PHILOSOPHY ==
You follow the "patient friend" approach to corrections:
1. FLOW OVER ACCURACY: A user who keeps talking with errors is learning faster than a user who stops talking because they are afraid of errors. Protect their confidence above all.
2. RECAST, DO NOT LECTURE: When correcting, naturally weave the correct ${language} word into YOUR response. Do NOT say "the word for X is Y" or "you made a mistake." Just USE the correct word naturally and move on.
3. ONE BITE AT A TIME: If the user makes multiple errors in one sentence, correct AT MOST ONE — the most important one. Silently let the rest go.
4. LET IT BREATHE: After delivering a correction (even a gentle recast), do NOT correct again for your next 3 responses. During this cooldown, focus entirely on conversation flow and encouragement.

== CORRECTION PRIORITY (when choosing which error to address) ==
If the user says multiple English words, pick the ONE that matters most:
1. CRITICAL: The error makes the sentence incomprehensible (always correct these).
2. TOPIC WORD: The word is directly related to what you are currently discussing.
3. COMMON WORD: The word is extremely high-frequency and the user will need it constantly.
4. RECURRING: The user has made this same error before in this conversation.

IGNORE (never correct, even if you notice them):
- Discourse markers: "okay", "so", "um", "like", "yes", "no", "well", "right"
- Loanwords commonly used in ${language}
- Minor grammar errors that do not affect comprehension
- Pronunciation differences (you are in a voice conversation — accent is not an error)

== TOOL USAGE: log_gap_word ==
You have access to the log_gap_word tool. Use it thoughtfully:
- Call it ONLY for meaningful vocabulary gaps (Priority 1-4 above).
- Do NOT call it for discourse markers, loanwords, or filler words.
- Call it ONCE per error, even if the user repeats the English word.
- After calling the tool, deliver your recast correction naturally and then MOVE ON. Do not dwell on the correction.

== CALLBACK BEHAVIOR (reinforcing previous words) ==
When the conversation context mentions words the user previously forgot:
- Do NOT quiz them ("Do you remember the word for X?").
- Do NOT bring it up immediately. Wait for a natural topic transition.
- Weave the word into something YOU would say anyway, organically.
- If the user produces the word correctly on their own, acknowledge it briefly and move on. That word is now learned.

== WHAT A GREAT RESPONSE LOOKS LIKE ==
User: "Hier, je suis alle au... um... store pour acheter du... food"
You: "Au magasin! Qu'est-ce que tu as achete? Moi j'adore faire les courses le weekend."
(Recasts "magasin" naturally. Ignores "food" — that can wait. Asks engaging follow-up. No lecture.)

== WHAT A BAD RESPONSE LOOKS LIKE ==
User: "Hier, je suis alle au... um... store pour acheter du... food"
You: "On dit 'magasin' pour 'store', et 'nourriture' pour 'food'. Aussi, c'est 'alle' pas 'alle' — tu dois utiliser..."
(Corrects everything at once. Feels like a test. User will stop talking.)`;

        // Send session.update to OpenAI with the new instructions
        const instructions = buildInstructionsWithContext();
        const sessionUpdate = {
            type: 'session.update',
            session: { instructions },
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log(`[RELAY] Agent configured for ${clientId}: "${name}" teaching "${language}" (${instructions.length} chars)`);
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

        // [FIX: Zombie Detection] Start heartbeat with isAlive tracking.
        // Pings both sockets every 30s. If a pong was not received since the
        // last ping, the connection is considered dead and terminated.
        pingInterval = setInterval(() => {
            // --- Check client liveness ---
            if (!clientIsAlive) {
                console.warn(`[ZOMBIE] Client ${clientId} failed pong check - terminating`);
                clientWs.terminate(); // Hard kill - triggers 'close' event
                return; // cleanup() will be triggered by the 'close' event
            }
            clientIsAlive = false;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.ping();
            }

            // --- Check OpenAI liveness ---
            if (!openAiIsAlive) {
                console.warn(`[ZOMBIE] OpenAI socket for ${clientId} failed pong check - terminating`);
                openAiWs.terminate();
                return;
            }
            openAiIsAlive = false;
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.ping();
                // [FIX: Backpressure] Monitor buffer health
                if (openAiWs.bufferedAmount > 32 * 1024) {
                    console.warn(
                        `[RELAY] Buffer warning for ${clientId}: ` +
                        `OpenAI=${openAiWs.bufferedAmount}B, Client=${clientWs.bufferedAmount}B`
                    );
                }
            }
        }, PING_INTERVAL_MS);
    });

    // [FIX: Zombie Detection] Track pong responses to detect dead connections
    clientWs.on('pong', () => {
        clientIsAlive = true;
    });
    openAiWs.on('pong', () => {
        openAiIsAlive = true;
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

                // [FIX: Input Validation] Validate call_id exists before using it
                if (!call_id) {
                    console.error(`[RELAY] Tool call missing call_id for ${clientId}, skipping`);
                } else if (name === 'log_gap_word') {
                    try {
                        const args = JSON.parse(argsJson);
                        const { native_word, target_word } = args;

                        // [FIX: Input Validation] Validate tool arguments are strings
                        if (typeof native_word !== 'string' || typeof target_word !== 'string') {
                            console.error(`[RELAY] Invalid tool args for ${clientId}: native_word or target_word not a string`);
                            return;
                        }

                        // 1. Store in session memory (bounded, deduplicated)
                        addGapWord(native_word, target_word);

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
                                    message: 'Word logged. Continue the conversation naturally. Do NOT force this word into your next response. It will come up organically later.',
                                }),
                            },
                        };
                        openAiWs.send(JSON.stringify(toolOutput));
                        console.log(`[RELAY] Sent tool output for ${clientId}`);

                        // 3. Trigger response so AI continues speaking
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        console.log(`[RELAY] Triggered response.create for ${clientId}`);

                        // 4. Notify client for UI feedback (gap word indicator)
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'gap_word.logged',
                                native_word,
                                target_word,
                                severity: args.severity || 'common',
                                total_gaps: gapWords.length,
                            }));
                        }

                        // 5. [FIX: Race Condition] Schedule debounced context injection.
                        // Instead of sending session.update immediately (which races with
                        // the response.create above), we debounce it. Multiple rapid tool
                        // calls coalesce into a single session.update after a quiet period.
                        scheduleContextUpdate();

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

                // [FIX: Input Validation] Reject oversized image payloads
                if (typeof base64Image !== 'string') {
                    console.warn(`[Vision] Image payload is not a string for ${clientId}`);
                    return;
                }
                if (base64Image.length > MAX_IMAGE_BASE64_CHARS) {
                    console.warn(`[Vision] Image too large for ${clientId}: ${base64Image.length} chars (max: ${Math.floor(MAX_IMAGE_BASE64_CHARS)})`);
                    // Notify client of rejection
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'error',
                            error: { message: 'Image payload exceeds maximum size limit (5MB)' },
                        }));
                    }
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
                        // [FIX: Backpressure] Check buffer before sending large vision payload
                        const VISION_BUFFER_LIMIT = 128 * 1024; // 128KB threshold
                        if (openAiWs.bufferedAmount > VISION_BUFFER_LIMIT) {
                            console.warn(
                                `[Vision] Dropping vision frame for ${clientId} - ` +
                                `OpenAI socket congested (bufferedAmount: ${openAiWs.bufferedAmount} bytes)`
                            );
                            return;
                        }

                        // Send the image injection
                        openAiWs.send(JSON.stringify(visionPayload));
                        console.log(`[Vision] Injected image for ${clientId} (bufferedAmount: ${openAiWs.bufferedAmount} bytes)`);

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
                // [FIX: Backpressure] Drop audio frames if OpenAI socket buffer is congested
                const MAX_AUDIO_BUFFER_BYTES = 64 * 1024; // 64KB threshold
                if (messageType === 'input_audio_buffer.append' && openAiWs.bufferedAmount > MAX_AUDIO_BUFFER_BYTES) {
                    if (!isCleanedUp) {
                        console.warn(
                            `[RELAY] Backpressure: dropping audio frame for ${clientId} ` +
                            `(bufferedAmount: ${openAiWs.bufferedAmount} bytes)`
                        );
                    }
                    return;
                }
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
