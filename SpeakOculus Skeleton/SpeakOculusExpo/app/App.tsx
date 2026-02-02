import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  StatusBar,
  Platform,
  PermissionsAndroid,
  Text,
} from 'react-native';
import { Audio } from 'expo-av';
import AudioRecord from 'react-native-audio-record';
import { Buffer } from 'buffer';
import Animated, {
  useSharedValue,
} from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';

// Components
import { ActiveOrb, OrbMode } from './components/ActiveOrb';
import { StatusPill, ConnectionStatus } from './components/StatusPill';

// ============================================================================
// CONFIGURATION
// ============================================================================
const RELAY_SERVER_URL = 'ws://localhost:8082';
const SAMPLE_RATE = 24000; // OpenAI Output Sample Rate

// ============================================================================
// DEBUG MODE
// ============================================================================
const DEBUG_MODE = true;
const DEBUG_VOLUME_INTERVAL = 10;
let volumeLogCounter = 0;

const debugLog = (tag: string, message: string, data?: any) => {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`, data);
  } else {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`);
  }
};

// AudioRecord configuration for Microphone
const AUDIO_RECORD_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // VOICE_RECOGNITION (Android)
  wavFile: 'speak_vision.wav',
};

// ============================================================================
// MAIN SCREEN COMPONENT
// ============================================================================
const MainScreen = () => {
  const insets = useSafeAreaInsets();

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [interactionMode, setInteractionMode] = useState<OrbMode>('idle');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);

  // -------------------------------------------------------------------------
  // REFS
  // -------------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const audioRecordInitializedRef = useRef(false);
  const isMutedRef = useRef(false);

  // Latency Tracking
  const lastSpeechStoppedTimeRef = useRef<number | null>(null);
  const lastFirstAudioReceivedTimeRef = useRef<number | null>(null);

  // -------------------------------------------------------------------------
  // AUDIO CONTEXT & STREAMING REFS
  // -------------------------------------------------------------------------
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const pendingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isPlayingRef = useRef(false);

  // -------------------------------------------------------------------------
  // SHARED VALUES
  // -------------------------------------------------------------------------
  const volumeLevel = useSharedValue(0);

  // -------------------------------------------------------------------------
  // UTILITY: Calculate RMS volume
  // -------------------------------------------------------------------------
  const calculateRMS = useCallback((base64Data: string): number => {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length < 2) return 0;
      const samples = Math.floor(buffer.length / 2);
      let sum = 0;
      for (let i = 0; i < buffer.length - 1; i += 2) {
        const sample = buffer.readInt16LE(i);
        sum += sample * sample;
      }
      return Math.min(Math.sqrt(sum / samples) / 16000, 1);
    } catch {
      return 0;
    }
  }, []);

  // -------------------------------------------------------------------------
  // STREAMING AUDIO LOGIC
  // -------------------------------------------------------------------------
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      console.log('[AUDIO] Initializing AudioContext');
      audioContextRef.current = new AudioContext({
        sampleRate: SAMPLE_RATE,
      });
      nextStartTimeRef.current = 0; // Reset time pointer
    } else if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  }, []);

  const scheduleAudioChunk = useCallback(async (base64Delta: string) => {
    if (!audioContextRef.current) initAudioContext();
    const ctx = audioContextRef.current!;

    // Ensure running
    if (ctx.state === 'suspended') {
      console.log('[AUDIO] Context suspended. Resuming...');
      await ctx.resume();
    }

    try {
      // 1. Decode Base64 -> PCM16 Buffer
      const rawBuffer = Buffer.from(base64Delta, 'base64');
      const int16Array = new Int16Array(
        rawBuffer.buffer,
        rawBuffer.byteOffset,
        rawBuffer.length / 2
      );

      // 2. Convert to Float32 (Web Audio API requirement)
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // 3. Create AudioBuffer
      const audioBuffer = ctx.createBuffer(1, float32Array.length, SAMPLE_RATE);
      audioBuffer.copyToChannel(float32Array, 0);

      // 4. Create Source Node
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      // 5. Schedule Gapless Playback
      // If nextStartTime is in the past (underrun), play NOW.
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      source.start(startTime);

      // Log First Audio Playback Latency
      if (lastFirstAudioReceivedTimeRef.current && !isPlayingRef.current) {
        // This is technically "Scheduled", actual sound comes a few ms later
        // But for logic purposes, playback "starts" here.
        isPlayingRef.current = true;
        const now = Date.now();
        const processingLag = now - lastFirstAudioReceivedTimeRef.current;
        console.log(`[CLIENT] [LATENCY] 🔊 Stream Started (Processing Lag: ${processingLag}ms)`);

        if (lastSpeechStoppedTimeRef.current) {
          console.log(`[CLIENT] [LATENCY] ⚡ TOTAL E2E LATENCY: ${now - lastSpeechStoppedTimeRef.current}ms`);
        }
        lastFirstAudioReceivedTimeRef.current = null;
      }

      // 6. Advance Time Pointer
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      // Keep track to stop if needed
      pendingSourcesRef.current.push(source);

      // Cleanup when done (optional, but good for memory)
      const onEndedHandler = () => {
        if ((source as any)._hasEnded) return;
        (source as any)._hasEnded = true;

        console.log('[AUDIO] Chunk ended');
        const index = pendingSourcesRef.current.indexOf(source);
        if (index > -1) pendingSourcesRef.current.splice(index, 1);

        // If queue empty, we are idle
        if (pendingSourcesRef.current.length === 0) {
          debugLog('MODE', '💤 Mode: → idle (playback complete)');
          setInteractionMode('idle');
          isMutedRef.current = false;
          isPlayingRef.current = false;
        }
      };

      source.onEnded = onEndedHandler;
      (source as any).onEnded = onEndedHandler;

    } catch (e) {
      console.error('[AUDIO] Chunk scheduling error:', e);
    }
  }, [initAudioContext]);

  const stopAudioPlayback = useCallback(() => {
    console.log('[AUDIO] Stopping playback...');

    // Stop all active sources
    pendingSourcesRef.current.forEach(source => {
      try { source.stop(); } catch { }
    });
    pendingSourcesRef.current = [];

    // Reset Context Time
    nextStartTimeRef.current = 0;

    // Optional: Suspend context to stop hardware (and save battery)
    if (audioContextRef.current) {
      audioContextRef.current.suspend();
    }

    isPlayingRef.current = false;
  }, []);

  // -------------------------------------------------------------------------
  // PERMISSION REQUEST
  // -------------------------------------------------------------------------
  const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Speak Vision needs microphone access.',
            buttonPositive: 'OK',
            buttonNegative: 'Cancel',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const { status } = await Audio.requestPermissionsAsync();
        return status === 'granted';
      }
    } catch (error) {
      console.error('[CLIENT] Permission error:', error);
      return false;
    }
  }, []);

  // -------------------------------------------------------------------------
  // AUDIO RECORD INITIALIZATION
  // -------------------------------------------------------------------------
  const initAudioRecord = useCallback((): boolean => {
    if (audioRecordInitializedRef.current) return true;

    if (!AudioRecord || typeof (AudioRecord as any).init !== 'function') {
      console.error('[CLIENT] AudioRecord native module not available');
      return false;
    }

    console.log('[CLIENT] Initializing AudioRecord');
    AudioRecord.init(AUDIO_RECORD_OPTIONS);

    AudioRecord.on('data', (base64Data: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (isMutedRef.current) return;
      if (!base64Data || base64Data.length < 50) return;

      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Data,
      }));

      const rms = calculateRMS(base64Data);
      volumeLevel.value = rms;

      volumeLogCounter++;
      if (volumeLogCounter % DEBUG_VOLUME_INTERVAL === 0) {
        debugLog('VOLUME', `RMS: ${rms.toFixed(3)} | Bar: ${'█'.repeat(Math.floor(rms * 20))}${'░'.repeat(20 - Math.floor(rms * 20))}`);
      }
    });

    audioRecordInitializedRef.current = true;
    return true;
  }, [calculateRMS, volumeLevel]);

  // -------------------------------------------------------------------------
  // RECORDING CONTROLS
  // -------------------------------------------------------------------------
  const startRecording = useCallback(async () => {
    if (!permissionGranted) return;
    const ready = initAudioRecord();
    if (!ready) return;

    // Ensure playback is stopped before listening
    stopAudioPlayback();

    AudioRecord.start();
    setIsRecording(true);
    debugLog('MODE', '👂 Mode: → listening (recording started)');
    setInteractionMode('listening');
  }, [permissionGranted, initAudioRecord, stopAudioPlayback]);

  const stopRecording = useCallback(() => {
    try { AudioRecord.stop(); } catch { }
    setIsRecording(false);
    volumeLevel.value = 0;

    // If we simply stopped recording manually, we go to idle
    // But usually 'speech_stopped' handles the transition to 'processing'
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Just visual reset if needed
    }
    console.log('[CLIENT] Recording stopped');
  }, [volumeLevel]);

  // -------------------------------------------------------------------------
  // WEBSOCKET MESSAGE HANDLER
  // -------------------------------------------------------------------------
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      const eventType = data.type || 'unknown';

      if (!eventType.includes('audio.delta')) {
        debugLog('WS_EVENT', `← ${eventType}`);
      }

      switch (eventType) {
        case 'session.created':
          console.log('[CLIENT] Session created');
          initAudioContext(); // Warm up audio engine
          break;

        case 'session.updated':
          console.log('[CLIENT] Session ready');
          break;

        case 'response.audio.delta':
          // Mute mic immediately
          isMutedRef.current = true;

          if (interactionMode !== 'speaking') {
            debugLog('MODE', '🗣️ Mode: → speaking (streaming started)');
            setInteractionMode('speaking');
          }

          // Latency Log: First Byte
          if (lastSpeechStoppedTimeRef.current && !lastFirstAudioReceivedTimeRef.current) {
            lastFirstAudioReceivedTimeRef.current = Date.now();
            const latency = lastFirstAudioReceivedTimeRef.current - lastSpeechStoppedTimeRef.current;
            console.log(`[CLIENT] [LATENCY] 📥 First Audio Delta Received (Time from Speech Stop: ${latency}ms)`);
          }

          if (data.delta) {
            scheduleAudioChunk(data.delta);
          }
          break;

        case 'response.audio.done':
          // End of stream - we don't need to do anything, 
          // logic is handled by 'onended' of the source nodes.
          break;

        case 'response.audio_transcript.delta':
          if (data.delta) {
            setTranscriptText((prev) => prev + data.delta);
            setShowTranscript(true);
          }
          break;

        case 'input_audio_buffer.speech_started':
          console.log('[CLIENT] INTERRUPT - User speaking');
          debugLog('MODE', '⚡ INTERRUPT! Mode: → listening');

          // CRITICAL: Stop AI speech immediately
          stopAudioPlayback();
          isMutedRef.current = false;

          setInteractionMode('listening');
          setShowTranscript(false);
          setTranscriptText('');
          break;

        case 'input_audio_buffer.speech_stopped':
          debugLog('MODE', '🧠 Mode: → processing');
          lastSpeechStoppedTimeRef.current = Date.now();
          lastFirstAudioReceivedTimeRef.current = null;
          console.log(`[CLIENT] [LATENCY] 🛑 Speech Stopped at ${lastSpeechStoppedTimeRef.current}`);
          setInteractionMode('processing');
          break;

        case 'error':
        case 'relay.error':
          console.error('[CLIENT] Error:', data.error);
          break;
      }
    } catch (e) {
      console.log('[CLIENT] Non-JSON message received');
    }
  }, [scheduleAudioChunk, stopAudioPlayback, interactionMode, initAudioContext]);

  // -------------------------------------------------------------------------
  // WEBSOCKET CONNECTION
  // -------------------------------------------------------------------------
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    debugLog('CONNECTION', '🟡 Connecting...');
    setConnectionStatus('connecting');

    const ws = new WebSocket(RELAY_SERVER_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[CLIENT] Connected');
      debugLog('CONNECTION', '🟢 Connected');
      setConnectionStatus('connected');
    };

    ws.onmessage = handleMessage;
    ws.onerror = (e) => console.error('[CLIENT] WebSocket error:', e);

    ws.onclose = () => {
      console.log('[CLIENT] Disconnected');
      debugLog('CONNECTION', '🔴 Disconnected');
      setConnectionStatus('disconnected');
      setInteractionMode('idle');
      wsRef.current = null;
      stopAudioPlayback();
      stopRecording();
    };
  }, [handleMessage, stopRecording, stopAudioPlayback]);

  const disconnect = useCallback(() => {
    stopRecording();
    stopAudioPlayback();
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }
    setConnectionStatus('disconnected');
    setInteractionMode('idle');
    setShowTranscript(false);
    setTranscriptText('');
  }, [stopRecording, stopAudioPlayback]);

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      const granted = await requestMicrophonePermission();
      setPermissionGranted(granted);
    };
    init();

    return () => {
      stopRecording();
      stopAudioPlayback();
      if (wsRef.current) wsRef.current.close();
    };
  }, [requestMicrophonePermission, stopRecording, stopAudioPlayback]);

  // -------------------------------------------------------------------------
  // UI HANDLERS
  // -------------------------------------------------------------------------
  const handleConnectPress = () => {
    if (connectionStatus === 'connected') disconnect();
    else if (connectionStatus === 'disconnected') connect();
  };

  const handleTalkPress = () => {
    if (connectionStatus !== 'connected') return;
    if (isRecording) stopRecording();
    else startRecording();
  };

  // -------------------------------------------------------------------------
  // RENDER (Same UI as before)
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.background} />

      <View style={[styles.topContainer, { paddingTop: insets.top + 12 }]}>
        <StatusPill status={connectionStatus} />
      </View>

      <View style={styles.orbContainer}>
        <ActiveOrb mode={interactionMode} volumeLevel={volumeLevel} />
      </View>

      {showTranscript && transcriptText && (
        <View style={[styles.transcriptContainer, { paddingBottom: insets.bottom + 120 }]}>
          <BlurView intensity={60} tint="dark" style={styles.transcriptBlur}>
            <Text style={styles.transcriptLabel}>AI Response</Text>
            <View style={styles.transcriptDivider} />
            <Text style={styles.transcriptText}>
              {transcriptText}
              <Text style={styles.cursor}>|</Text>
            </Text>
          </BlurView>
        </View>
      )}

      <View style={[styles.controlsContainer, { paddingBottom: insets.bottom + 24 }]}>
        <TouchableOpacity
          style={[
            styles.controlButton,
            connectionStatus === 'connecting' && styles.buttonDisabled,
            connectionStatus === 'connected' && styles.buttonDisconnect,
          ]}
          onPress={handleConnectPress}
          disabled={connectionStatus === 'connecting'}
        >
          <Text style={styles.buttonText}>
            {connectionStatus === 'connected' ? 'Disconnect' : 'Connect'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.controlButton,
            styles.talkButton,
            isRecording && styles.talkButtonActive,
            connectionStatus !== 'connected' && styles.buttonDisabled,
          ]}
          onPress={handleTalkPress}
          disabled={connectionStatus !== 'connected'}
        >
          <Text style={[
            styles.buttonText,
            connectionStatus !== 'connected' && styles.buttonTextDisabled,
          ]}>
            {isRecording ? 'Stop' : 'Push to Talk'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.footer, { bottom: insets.bottom + 8 }]}>
        <Text style={styles.footerText}>
          {RELAY_SERVER_URL} | PCM16 24kHz Streaming
        </Text>
      </View>
    </View>
  );
};

export default function App() {
  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  background: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a0a0a',
  },
  topContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  orbContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transcriptContainer: {
    position: 'absolute',
    bottom: 0,
    left: 16,
    right: 16,
    maxHeight: 200,
  },
  transcriptBlur: {
    borderRadius: 20,
    padding: 16,
    backgroundColor: 'rgba(20,20,20,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  transcriptLabel: {
    color: '#888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  transcriptDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginBottom: 10,
  },
  transcriptText: {
    color: '#eee',
    fontSize: 16,
    lineHeight: 22,
  },
  cursor: {
    color: '#00f260',
    fontWeight: '700',
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    flexDirection: 'row',
    gap: 12,
  },
  controlButton: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  buttonDisabled: {
    backgroundColor: '#1a1a1a',
    opacity: 0.5,
  },
  buttonDisconnect: {
    backgroundColor: 'rgba(200,60,60,0.3)',
    borderColor: 'rgba(200,60,60,0.5)',
  },
  talkButton: {
    backgroundColor: 'rgba(0,150,255,0.2)',
    borderColor: 'rgba(0,150,255,0.4)',
  },
  talkButtonActive: {
    backgroundColor: 'rgba(255,100,0,0.3)',
    borderColor: 'rgba(255,100,0,0.5)',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: '#555',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  footerText: {
    color: '#333',
    fontSize: 10,
  },
});
