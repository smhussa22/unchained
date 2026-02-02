import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PORT = 8082;
const wss = new WebSocketServer({ port: PORT });
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY is missing in .env');
    process.exit(1);
}

console.log(`🚀 Relay Server running on port ${PORT}`);

// SESSION CONFIGURATION
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
    output_audio_format: 'pcm16', // We expect RAW PCM16 from OpenAI
    input_audio_transcription: {
        model: 'whisper-1',
    },
    turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500, // Fast turn-taking
    },
};

wss.on('connection', (clientWs: WebSocket) => {
    console.log('[SERVER] Client connected');

    // Connect to OpenAI Realtime API
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    openAiWs.on('open', () => {
        console.log('[SERVER] Connected to OpenAI');

        // Initialize Session
        const sessionUpdate = {
            type: 'session.update',
            session: SESSION_CONFIG,
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log('[SERVER] Session configured');
    });

    openAiWs.on('message', (data: any) => {
        try {
            const response = JSON.parse(data.toString());

            // Log interesting events
            if (response.type === 'response.audio.delta') {
                // Suppress massive log spam, just forward audio
            } else {
                console.log(`[OPENAI] ${response.type}`);
            }

            // Forward to Client
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data.toString());
            }
        } catch (e) {
            console.error('[SERVER] Error parsing OpenAI message:', e);
        }
    });

    openAiWs.on('close', () => console.log('[SERVER] OpenAI Disconnected'));
    openAiWs.on('error', (err: any) => console.error('[SERVER] OpenAI Error:', err));

    // --------------------------------------------------------------------------
    // CLIENT -> OPENAI
    // --------------------------------------------------------------------------
    clientWs.on('message', (data: any) => {
        try {
            const message = JSON.parse(data.toString());

            // Log
            if (message.type !== 'input_audio_buffer.append') {
                console.log(`[CLIENT] ${message.type}`);
            }

            // Forward to OpenAI
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify(message));
            }
        } catch (e) {
            console.error('[SERVER] Error parsing client message:', e);
        }
    });

    clientWs.on('close', () => {
        console.log('[SERVER] Client Disconnected');
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
});
