import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Platform,
  PermissionsAndroid,
  Text,
  Dimensions,
} from 'react-native';
import { Audio } from 'expo-av';
import AudioRecord from 'react-native-audio-record';
import { Buffer } from 'buffer';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';

// Components
import { ActiveOrb, OrbMode } from './components/ActiveOrb';
import { StatusPill } from './components/StatusPill';
import { ControlSheet } from './components/ControlSheet';
import { Viewfinder } from './components/Viewfinder';
import { CallHistoryScreen } from './components/CallHistoryScreen';
import { THEME } from './theme';

// ============================================================================
// CONFIGURATION
// ============================================================================
const RELAY_SERVER_URL = 'ws://98.92.191.197:8082';
const SAMPLE_RATE = 24000; // OpenAI Output Sample Rate

// ============================================================================
// DEBUG MODE
// ============================================================================
const DEBUG_MODE = true;
const DEBUG_VOLUME_INTERVAL = 10;
let volumeLogCounter = 0;

// ============================================================================
// CLIENT-SIDE VAD CONFIGURATION (Optimistic Barge-In)
// ============================================================================
const CLIENT_VAD_CONFIG = {
  threshold: 0.015,          // RMS threshold - very sensitive for normal speech
  consecutiveFrames: 2,      // Reduced frames for faster response
  enabled: true,             // Feature flag for A/B testing
};

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
  bufferSize: 1920, // 40ms chunks
};

// ============================================================================
// MAIN SCREEN COMPONENT
// ============================================================================
const MainScreen = () => {
  const insets = useSafeAreaInsets();

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------
  const [connectionStatus, setConnectionStatus] = useState<string>('Offline');
  const [isConnected, setIsConnected] = useState(false);
  const [agentName, setAgentName] = useState('Assistant');
  const [interactionMode, setInteractionMode] = useState<OrbMode>('idle');
  const [permissionGranted, setPermissionGranted] = useState(false);

  // UI States
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isNoiseIsolationOn, setIsNoiseIsolationOn] = useState(true);

  // -------------------------------------------------------------------------
  // REFS
  // -------------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const audioRecordInitializedRef = useRef(false);

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
  // CLIENT VAD STATE (Optimistic Barge-In)
  // -------------------------------------------------------------------------
  const vadFrameCountRef = useRef(0);
  const clientVadTriggeredRef = useRef(false);

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
        isPlayingRef.current = true;
        console.log('[VAD DEBUG] 🎵 isPlayingRef set to TRUE - audio playback starting');
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

        const index = pendingSourcesRef.current.indexOf(source);
        if (index > -1) pendingSourcesRef.current.splice(index, 1);

        // If queue empty, we are idle
        if (pendingSourcesRef.current.length === 0) {
          debugLog('MODE', '💤 Mode: → idle (playback complete)');
          setInteractionMode('idle');
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
      if (!base64Data || base64Data.length < 50) return;

      // Calculate RMS for visualization AND client VAD
      const rms = calculateRMS(base64Data);

      // =========================================================================
      // 🚀 DIRTY CLIENT VAD
      // =========================================================================
      if (CLIENT_VAD_CONFIG.enabled && isPlayingRef.current && !clientVadTriggeredRef.current) {
        if (rms > CLIENT_VAD_CONFIG.threshold) {
          vadFrameCountRef.current++;

          if (vadFrameCountRef.current >= CLIENT_VAD_CONFIG.consecutiveFrames) {
            console.log(`[CLIENT] [VAD] ⚡ LOCAL INTERRUPT! RMS=${rms.toFixed(3)} frames=${vadFrameCountRef.current}`);
            clientVadTriggeredRef.current = true;
            stopAudioPlayback();

            wsRef.current?.send(JSON.stringify({
              type: 'response.cancel',
            }));
          }
        } else {
          vadFrameCountRef.current = 0;
        }
      } else if (!isPlayingRef.current && !isMuted) {
        vadFrameCountRef.current = 0;
        clientVadTriggeredRef.current = false;
      }

      // Early return if muted
      if (isMuted) return;

      // Update volume visualization
      volumeLevel.value = rms;

      // Send audio to server
      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Data,
      }));
    });

    audioRecordInitializedRef.current = true;
    return true;
  }, [calculateRMS, volumeLevel, stopAudioPlayback, isMuted]);

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
    debugLog('MODE', '👂 Mode: → listening (recording started)');
    setInteractionMode('listening');
  }, [permissionGranted, initAudioRecord, stopAudioPlayback]);

  const stopRecording = useCallback(() => {
    try { AudioRecord.stop(); } catch { }
    volumeLevel.value = 0;
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
          initAudioContext();
          setConnectionStatus('AI Connected');
          setIsConnected(true);
          // Start recording audio immediately upon connection
          startRecording();
          break;

        case 'session.updated':
          console.log('[CLIENT] Session ready');
          break;

        case 'response.audio.delta':
          // Auto-mute mic during playback if not using VAD-based interruption
          // But here we rely on VAD, so we don't force mute unless user muted manually
          if (interactionMode !== 'speaking') {
            debugLog('MODE', '🗣️ Mode: → speaking (streaming started)');
            setInteractionMode('speaking');
          }

          // Latency Log: First Byte
          if (lastSpeechStoppedTimeRef.current && !lastFirstAudioReceivedTimeRef.current) {
            lastFirstAudioReceivedTimeRef.current = Date.now();
            const latency = lastFirstAudioReceivedTimeRef.current - lastSpeechStoppedTimeRef.current;
            console.log(`[CLIENT] [LATENCY] 📥 First Audio Delta Received: ${latency}ms`);
          }

          if (data.delta) {
            scheduleAudioChunk(data.delta);
          }
          break;

        case 'input_audio_buffer.speech_started':
          console.log('[CLIENT] INTERRUPT - User speaking (server VAD)');
          debugLog('MODE', '⚡ INTERRUPT! Mode: → listening');

          stopAudioPlayback();

          // Reset client VAD state
          vadFrameCountRef.current = 0;
          clientVadTriggeredRef.current = false;

          setInteractionMode('listening');
          break;

        case 'input_audio_buffer.speech_stopped':
          debugLog('MODE', '🧠 Mode: → processing');
          lastSpeechStoppedTimeRef.current = Date.now();
          lastFirstAudioReceivedTimeRef.current = null;
          setInteractionMode('processing');
          break;
      }
    } catch (e) {
      console.log('[CLIENT] Non-JSON message received');
    }
  }, [scheduleAudioChunk, stopAudioPlayback, interactionMode, initAudioContext, startRecording]);

  // -------------------------------------------------------------------------
  // WEBSOCKET CONNECTION
  // -------------------------------------------------------------------------
  const BYPASS_BACKEND = true; // Toggle this to true to test UI without backend

  const connect = useCallback((name: string = 'Assistant') => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setAgentName(name);
    debugLog('CONNECTION', `🟡 Connecting to ${name}...`);
    setConnectionStatus('Connecting...');

    if (BYPASS_BACKEND) {
      console.log('[CLIENT] BYPASS_BACKEND active. Simulating connection...');
      setTimeout(() => {
        setConnectionStatus('AI Connected');
        setIsConnected(true);
        setInteractionMode('listening');
        debugLog('CONNECTION', '🟢 Connected (Simulated)');
      }, 1500);
      return;
    }

    const ws = new WebSocket(RELAY_SERVER_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[CLIENT] Connected');
      debugLog('CONNECTION', '🟢 Connected');
    };

    ws.onmessage = handleMessage;
    ws.onerror = (e) => console.error('[CLIENT] WebSocket error:', e);

    ws.onclose = () => {
      console.log('[CLIENT] Disconnected');
      debugLog('CONNECTION', '🔴 Disconnected');
      setConnectionStatus('Offline');
      setIsConnected(false);
      setInteractionMode('idle');
      wsRef.current = null;
      stopAudioPlayback();
      stopRecording();
    };
  }, [handleMessage, stopRecording, stopAudioPlayback]);

  const disconnect = useCallback(() => {
    stopRecording();
    stopAudioPlayback();

    if (BYPASS_BACKEND) {
      setConnectionStatus('Offline');
      setIsConnected(false);
      setInteractionMode('idle');
      return;
    }

    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }
    setConnectionStatus('Offline');
    setIsConnected(false);
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
  // AUTO-CONNECT FOR DEMO (Optional)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // connect(); // Uncomment to auto-connect on load
  }, [connect]);


  const showCallUI = isConnected || connectionStatus === 'Connecting...';

  // -------------------------------------------------------------------------
  // ANIMATION STATE & STYLES
  // -------------------------------------------------------------------------
  const animState = useSharedValue(0); // 0 = Disconnected (Sheet visible), 1 = Connected (UI visible)
  const { height: SCREEN_HEIGHT } = Dimensions.get('window');

  useEffect(() => {
    // If showCallUI is true (Connecting or Connected), animate to 1
    // If false (Offline), animate to 0
    animState.value = withSpring(showCallUI ? 1 : 0, {
      damping: 20,
      stiffness: 90,
      mass: 0.5, // Lightweight feel
    });
  }, [showCallUI]);

  const sheetStyle = useAnimatedStyle(() => {
    return {
      // Slide down off screen
      transform: [{
        translateY: interpolate(animState.value, [0, 1], [0, SCREEN_HEIGHT], Extrapolation.CLAMP)
      }],
    };
  });

  const uiLayerStyle = useAnimatedStyle(() => {
    return {
      opacity: interpolate(animState.value, [0, 0.5, 1], [0, 0, 1], Extrapolation.CLAMP),
      transform: [{
        translateY: interpolate(animState.value, [0, 1], [50, 0], Extrapolation.CLAMP)
      }],
      zIndex: animState.value > 0.5 ? 10 : 0,
    };
  });


  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* LAYER 1: Viewfinder Background (Always active but obscured by Sheet initially) */}
      <Viewfinder isCameraOn={isCameraOn} />

      {/* LAYER 2: Main Call UI (Fade In / Slide Up) */}
      <Animated.View
        style={[
          styles.uiLayer,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
          uiLayerStyle
        ]}
        pointerEvents={showCallUI ? 'auto' : 'none'}
      >
        {/* Top Status */}
        <StatusPill status={isConnected ? `Connected to ${agentName}` : connectionStatus} isConnected={isConnected} />

        {/* Center Orb (smaller, integrated) */}
        <View style={styles.orbContainer}>
          <ActiveOrb mode={interactionMode} volumeLevel={volumeLevel} />
        </View>

        {/* Bottom Controls */}
        <ControlSheet
          onDisconnect={disconnect}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted(!isMuted)}
          isCameraOn={isCameraOn}
          onToggleCamera={() => setIsCameraOn(!isCameraOn)}
          isNoiseIsolationOn={isNoiseIsolationOn}
          onToggleNoiseIsolation={() => setIsNoiseIsolationOn(!isNoiseIsolationOn)}
        />
      </Animated.View>

      {/* LAYER 3: Call History / Start Screen (Slides Down) */}
      <Animated.View style={[StyleSheet.absoluteFill, sheetStyle]}>
        <CallHistoryScreen onConnect={connect} />
      </Animated.View>
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
  uiLayer: {
    flex: 1,
    justifyContent: 'space-between',
    zIndex: 10,
  },
  orbContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    // Make orbit smaller or transparent if needed
  },
});
