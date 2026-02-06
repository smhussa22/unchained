import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Platform,
  PermissionsAndroid,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import AudioRecord from 'react-native-audio-record';
import InCallManager from 'react-native-incall-manager';
import { Buffer } from 'buffer';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  SharedValue,
} from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';

// Components
import { ActiveOrb, OrbMode } from './components/ActiveOrb';
import { StatusPill } from './components/StatusPill';
import { ControlSheet } from './components/ControlSheet';
import { Viewfinder, CameraFacing, ViewfinderRef } from './components/Viewfinder';
import { CallHistoryScreen, AgentConfig, CallHistoryItem, generateSystemPrompt } from './components/CallHistoryScreen';
import { GapWordsScreen } from './components/GapWordsScreen';
import { THEME } from './theme';

// Storage utilities
import { loadAgents, addAgent, loadCallHistory, saveCallHistory, addGapWord, GapWord } from './storage';

// Helper to generate unique IDs
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Hooks
import { useCameraStabilityWithReset } from './hooks/useCameraStability';

// ============================================================================
// CONFIGURATION
// ============================================================================
// Set to true to use the relay running on your machine.
const USE_LOCAL_RELAY = false;
const RELAY_PRODUCTION_URL = 'ws://98.92.191.197:8082';
const RELAY_PORT = 8082;
// Physical Android via USB: use adb reverse, then connect to localhost (set below).
const USE_ADB_REVERSE = true; // true = device plugged in + adb reverse tcp:8082 tcp:8082
// For iOS Simulator or physical device (no reverse): use your computer's LAN IP.
// For Android Emulator (USE_ADB_REVERSE false): we use 10.0.2.2 when this is 'localhost'.
const LOCAL_RELAY_IP = 'localhost';

const RELAY_SERVER_URL = (() => {
  if (!USE_LOCAL_RELAY) return RELAY_PRODUCTION_URL;
  if (Platform.OS === 'android') {
    // Physical device + adb reverse: device's localhost:8082 → host's 8082
    if (USE_ADB_REVERSE) return `ws://127.0.0.1:${RELAY_PORT}`;
    // Emulator: 10.0.2.2 is the host loopback
    const host = LOCAL_RELAY_IP === 'localhost' ? '10.0.2.2' : LOCAL_RELAY_IP;
    return `ws://${host}:${RELAY_PORT}`;
  }
  return `ws://${LOCAL_RELAY_IP}:${RELAY_PORT}`;
})();

const SAMPLE_RATE = 24000; // OpenAI Realtime API requirement

// ============================================================================
// BARGE-IN CONFIGURATION
// ============================================================================
// RMS threshold for barge-in during AI playback. Audio above this threshold
// is considered real user speech (not echo) and will be sent to the server.
// Typical values: residual echo ~0.01-0.05, human speech ~0.08-0.3
// Start conservative and lower if interrupts aren't detected reliably.
const BARGE_IN_RMS_THRESHOLD = 0.08;

// Vision Configuration
const VISION_COOLDOWN_MS = 8000; // 8 seconds between captures
const FLASH_DURATION_MS = 150; // Flash animation duration
const CROSSHAIR_SIZE = 280; // Size of the viewfinder box (must match ActiveOrb)
const CROSSHAIR_RADIUS = 40; // Corner radius of the viewfinder box

// ============================================================================
// DEBUG MODE
// ============================================================================
const DEBUG_MODE = true;


const debugLog = (tag: string, message: string, data?: any) => {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`, data);
  } else {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`);
  }
};

// AudioRecord configuration for Microphone (PCM16 @ 24kHz)
const AUDIO_RECORD_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // VOICE_RECOGNITION (Android)
  wavFile: 'speak_vision.wav',
  bufferSize: 1920, // 40ms chunks at 24kHz
};

// ============================================================================
// FLASH OVERLAY COMPONENT (Box-sized, centered on crosshair)
// ============================================================================
interface FlashOverlayProps {
  flashOpacity: SharedValue<number>;
}

const FlashOverlay: React.FC<FlashOverlayProps> = ({ flashOpacity }) => {
  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: flashOpacity.value,
    };
  });

  return (
    <View style={styles.flashOverlayContainer} pointerEvents="none">
      <Animated.View
        style={[styles.flashOverlayBox, animatedStyle]}
      />
    </View>
  );
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
  const interactionModeRef = useRef<OrbMode>('idle');
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Agent Configuration State
  const [currentAgentConfig, setCurrentAgentConfig] = useState<AgentConfig | null>(null);
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);

  // Gap Words Screen Navigation State
  const [selectedAgentForGapWords, setSelectedAgentForGapWords] = useState<AgentConfig | null>(null);

  // UI States
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>('front');
  const [isNoiseIsolationOn, setIsNoiseIsolationOn] = useState(true);

  // Vision States
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);

  // Ref to track mute state in audio callback (avoids stale closure)
  const isMutedRef = useRef(false);

  // Session timing for history
  const sessionStartTimeRef = useRef<number | null>(null);

  // -------------------------------------------------------------------------
  // REFS
  // -------------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const audioRecordInitializedRef = useRef(false);
  const viewfinderRef = useRef<ViewfinderRef>(null);

  // Latency Tracking
  const lastSpeechStoppedTimeRef = useRef<number | null>(null);
  const lastFirstAudioReceivedTimeRef = useRef<number | null>(null);

  // Vision Tracking
  const lastCaptureTimeRef = useRef<number>(0);
  const captureInProgressRef = useRef(false);
  const visionSendInProgressRef = useRef(false);

  // -------------------------------------------------------------------------
  // AUDIO CONTEXT & STREAMING REFS
  // -------------------------------------------------------------------------
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const pendingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isPlayingRef = useRef(false);

  // -------------------------------------------------------------------------
  // BARGE-IN / TRUNCATION TRACKING
  // -------------------------------------------------------------------------
  // Track current response for proper truncation on interrupt
  const lastResponseItemIdRef = useRef<string | null>(null);
  const responseStartTimeRef = useRef<number>(0); // AudioContext.currentTime when response started


  // -------------------------------------------------------------------------
  // SHARED VALUES
  // -------------------------------------------------------------------------
  const volumeLevel = useSharedValue(0);
  const flashOpacity = useSharedValue(0);

  // Sync isMuted state to ref for use in audio callback (avoids stale closure)
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Sync interactionMode state to ref for use in WebSocket handler (avoids stale closure)
  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  // -------------------------------------------------------------------------
  // STABILITY HOOK (Auto-Vision Trigger)
  // -------------------------------------------------------------------------
  const {
    isStableSV,
    stabilityProgress,
    varianceSV,
    resetStability,
  } = useCameraStabilityWithReset({
    enabled: visionEnabled && isConnected && isCameraOn && !isCapturing,
  });

  // -------------------------------------------------------------------------
  // UTILITY: Calculate RMS volume
  // -------------------------------------------------------------------------
  const calculateRMS = useCallback((base64Data: string): number => {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const len = buffer.length;
      if (len < 2) return 0;
      const samples = len >> 1;
      const view = new DataView(buffer.buffer, buffer.byteOffset, len);
      let sum = 0;
      for (let i = 0; i < len - 1; i += 2) {
        const sample = view.getInt16(i, true);
        sum += sample * sample;
      }
      return Math.min(Math.sqrt(sum / samples) / 16000, 1);
    } catch {
      return 0;
    }
  }, []);

  // -------------------------------------------------------------------------
  // FLASH ANIMATION
  // -------------------------------------------------------------------------
  const triggerFlash = useCallback(() => {
    'worklet';
    flashOpacity.value = 0.8;
    flashOpacity.value = withTiming(0, {
      duration: FLASH_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [flashOpacity]);

  // -------------------------------------------------------------------------
  // VISION CAPTURE LOGIC
  // -------------------------------------------------------------------------
  const captureAndSendFrame = useCallback(async () => {
    // Guard: Prevent concurrent captures
    if (captureInProgressRef.current) {
      debugLog('VISION', 'Capture already in progress, skipping');
      return;
    }

    // Guard: Check cooldown
    const now = Date.now();
    const timeSinceLastCapture = now - lastCaptureTimeRef.current;
    if (timeSinceLastCapture < VISION_COOLDOWN_MS) {
      debugLog('VISION', `Cooldown active (${Math.round((VISION_COOLDOWN_MS - timeSinceLastCapture) / 1000)}s remaining)`);
      return;
    }

    // Guard: Check if AI is speaking (don't interrupt)
    if (isPlayingRef.current) {
      debugLog('VISION', 'AI is speaking, skipping capture');
      return;
    }

    // Guard: Check camera ref
    if (!viewfinderRef.current) {
      debugLog('VISION', 'Camera ref not available');
      return;
    }

    // Guard: Check WebSocket
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      debugLog('VISION', 'WebSocket not connected');
      return;
    }

    try {
      captureInProgressRef.current = true;
      setIsCapturing(true);

      // 1. Trigger flash animation (run on UI thread)
      runOnUI(triggerFlash)();

      // 2. Set mode to processing
      setInteractionMode('processing');

      // 3. Capture photo (silent - no shutter sound)
      debugLog('VISION', 'Capturing frame...');
      const photo = await viewfinderRef.current.takePictureAsync({
        quality: 0.7, // Higher quality for cropping
        base64: true,
        skipProcessing: true,
        shutterSound: false, // Disable shutter sound
      });

      if (!photo?.base64 || !photo.uri) {
        console.error('[VISION] Failed to capture photo - no base64 data');
        setInteractionMode('listening');
        return;
      }

      debugLog('VISION', `Photo captured: ${photo.width}x${photo.height}`);

      // 5. Crop to crosshair region (center square)
      const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

      // Calculate the crosshair box position in screen coordinates
      // The crosshair is centered on screen and is CROSSHAIR_SIZE x CROSSHAIR_SIZE
      const crosshairScreenX = (screenWidth - CROSSHAIR_SIZE) / 2;
      const crosshairScreenY = (screenHeight - CROSSHAIR_SIZE) / 2;

      // Map screen coordinates to photo coordinates
      // Photo aspect ratio may differ from screen, so we need to handle this
      const photoAspect = photo.width / photo.height;
      const screenAspect = screenWidth / screenHeight;

      let scaleX: number, scaleY: number, offsetX = 0, offsetY = 0;

      if (photoAspect > screenAspect) {
        // Photo is wider than screen - crop sides
        scaleY = photo.height / screenHeight;
        scaleX = scaleY;
        offsetX = (photo.width - screenWidth * scaleX) / 2;
      } else {
        // Photo is taller than screen - crop top/bottom
        scaleX = photo.width / screenWidth;
        scaleY = scaleX;
        offsetY = (photo.height - screenHeight * scaleY) / 2;
      }

      // Calculate crop region in photo coordinates
      const cropX = Math.max(0, Math.round(offsetX + crosshairScreenX * scaleX));
      const cropY = Math.max(0, Math.round(offsetY + crosshairScreenY * scaleY));
      const cropSize = Math.round(CROSSHAIR_SIZE * scaleX);

      // Ensure crop doesn't exceed photo bounds
      const finalCropX = Math.min(cropX, photo.width - cropSize);
      const finalCropY = Math.min(cropY, photo.height - cropSize);
      const finalCropSize = Math.min(cropSize, photo.width - finalCropX, photo.height - finalCropY);

      debugLog('VISION', `Cropping to: x=${finalCropX}, y=${finalCropY}, size=${finalCropSize}`);

      // Crop and resize the image
      const croppedImage = await ImageManipulator.manipulateAsync(
        photo.uri,
        [
          {
            crop: {
              originX: finalCropX,
              originY: finalCropY,
              width: finalCropSize,
              height: finalCropSize,
            },
          },
          {
            resize: { width: 384, height: 384 }, // Standardize output size
          },
        ],
        { base64: true, compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );

      if (!croppedImage.base64) {
        console.error('[VISION] Failed to crop photo');
        setInteractionMode('listening');
        return;
      }

      debugLog('VISION', `Cropped image: 384x384, base64 length: ${croppedImage.base64.length}`);

      // 6. Send to WebSocket
      const payload = {
        type: 'vision.direct_injection',
        image: croppedImage.base64,
        timestamp: now,
      };

      visionSendInProgressRef.current = true;
      const visionTimeout = setTimeout(() => { visionSendInProgressRef.current = false; }, 200);
      wsRef.current.send(JSON.stringify(payload));
      visionSendInProgressRef.current = false;
      clearTimeout(visionTimeout);
      debugLog('VISION', 'Frame sent to server');

      // 6. Update cooldown
      lastCaptureTimeRef.current = now;

      // 7. Reset stability tracking
      resetStability();

    } catch (error) {
      console.error('[VISION] Capture error:', error);
      setInteractionMode('listening');
    } finally {
      captureInProgressRef.current = false;
      setIsCapturing(false);
    }
  }, [triggerFlash, resetStability]);

  // -------------------------------------------------------------------------
  // STABILITY-TRIGGERED CAPTURE (via SharedValue reaction, no re-renders)
  // -------------------------------------------------------------------------
  useAnimatedReaction(
    () => isStableSV.value,
    (currentlyStable, previouslyStable) => {
      if (currentlyStable && !previouslyStable) {
        runOnJS(captureAndSendFrame)();
      }
    }
  );

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

      // Mark as playing (for echo prevention) - ALWAYS set this when audio starts
      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        console.log('[AUDIO] Playback starting - mic suppressed');
      }

      // Log First Audio Playback Latency (optional tracking)
      if (lastFirstAudioReceivedTimeRef.current) {
        const now = Date.now();
        const processingLag = now - lastFirstAudioReceivedTimeRef.current;
        console.log(`[CLIENT] [LATENCY] Stream Started (Processing Lag: ${processingLag}ms)`);

        if (lastSpeechStoppedTimeRef.current) {
          console.log(`[CLIENT] [LATENCY] TOTAL E2E LATENCY: ${now - lastSpeechStoppedTimeRef.current}ms`);
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
          debugLog('MODE', 'Mode: -> idle (playback complete)');
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
        // iOS: Permission is requested automatically by react-native-audio-record
        // when recording starts. Return true to proceed.
        console.log('[CLIENT] iOS: Mic permission handled by native module');
        return true;
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

      // Calculate RMS for visualization
      const rms = calculateRMS(base64Data);

      // Early return if muted (use ref to avoid stale closure)
      if (isMutedRef.current) {
        // Still update visualization when muted (shows user they're speaking but muted)
        volumeLevel.value = withTiming(rms * 0.3, {
          duration: 40,
          easing: Easing.out(Easing.quad),
        });
        return;
      }

      // Vision pause: throttle audio during vision frame upload to prevent stutter
      if (visionSendInProgressRef.current) {
        volumeLevel.value = withTiming(rms * 0.3, {
          duration: 40,
          easing: Easing.out(Easing.quad),
        });
        return;
      }

      // =========================================================================
      // BARGE-IN WITH ECHO PREVENTION (RMS Threshold Gate)
      //
      // Instead of hard-muting the mic during AI playback, we use an RMS
      // threshold to distinguish real user speech from echo/residual audio.
      // - Below threshold during playback: likely echo, suppress
      // - Above threshold during playback: likely real speech, allow (barge-in)
      // - Not playing: always allow
      //
      // This requires hardware AEC (via react-native-incall-manager) to work well.
      // =========================================================================
      if (isPlayingRef.current) {
        if (rms < BARGE_IN_RMS_THRESHOLD) {
          // Below threshold - likely echo, suppress
          volumeLevel.value = withTiming(rms * 0.2, {
            duration: 40,
            easing: Easing.out(Easing.quad),
          });
          return; // Don't send - this is probably echo
        }
        // Above threshold during playback - potential barge-in!
        debugLog('BARGE-IN', `Loud audio during playback (RMS: ${rms.toFixed(3)}) - allowing through`);
      }

      // Update volume visualization with timing matched to 40ms audio chunk cadence
      volumeLevel.value = withTiming(rms, {
        duration: 40,
        easing: Easing.out(Easing.quad),
      });

      // Send audio to relay server
      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Data,
      }));
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
    debugLog('MODE', 'Mode: -> listening (recording started)');
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
        debugLog('WS_EVENT', `<- ${eventType}`);
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

        case 'response.function_call_arguments.done':
          // Tool call from the LLM (e.g. log_gap_word in Friend Mode)
          const toolName = data.name ?? 'unknown';
          let toolArgs: Record<string, string> = {};
          try {
            if (typeof data.arguments === 'string') toolArgs = JSON.parse(data.arguments);
          } catch { /* ignore */ }
          console.log('[CLIENT] TOOL CALL:', toolName, toolArgs);

          // Handle log_gap_word tool - save the gap word to storage
          if (toolName === 'log_gap_word' && currentAgentConfig) {
            const gapWord: GapWord = {
              native_word: toolArgs.native_word || '',
              target_word: toolArgs.target_word || '',
              timestamp: Date.now(),
            };
            addGapWord(currentAgentConfig.name, gapWord);
            console.log('[CLIENT] Gap word saved:', gapWord);
          }
          break;

        case 'response.audio.delta':
          // Track item_id for truncation on interrupt
          if (data.item_id) {
            lastResponseItemIdRef.current = data.item_id;
          }

          if (interactionModeRef.current !== 'speaking') {
            debugLog('MODE', 'Mode: -> speaking (streaming started)');
            setInteractionMode('speaking');

            // Track when this response started playing (for truncation calculation)
            if (audioContextRef.current) {
              responseStartTimeRef.current = audioContextRef.current.currentTime;
              debugLog('BARGE-IN', `Response started at AudioContext time: ${responseStartTimeRef.current.toFixed(3)}s`);
            }
          }

          // Latency Log: First Byte
          if (lastSpeechStoppedTimeRef.current && !lastFirstAudioReceivedTimeRef.current) {
            lastFirstAudioReceivedTimeRef.current = Date.now();
            const latency = lastFirstAudioReceivedTimeRef.current - lastSpeechStoppedTimeRef.current;
            console.log(`[CLIENT] [LATENCY] First Audio Delta Received: ${latency}ms`);
          }

          if (data.delta) {
            scheduleAudioChunk(data.delta);
          }
          break;

        case 'input_audio_buffer.speech_started':
          console.log('[CLIENT] INTERRUPT - User speaking (server VAD)');
          debugLog('MODE', 'INTERRUPT! Mode: -> listening');

          // Calculate how much audio actually played before interrupt (for truncation)
          let audioEndMs = 0;
          if (audioContextRef.current && responseStartTimeRef.current > 0) {
            const elapsedSeconds = audioContextRef.current.currentTime - responseStartTimeRef.current;
            audioEndMs = Math.max(0, Math.floor(elapsedSeconds * 1000));
            debugLog('BARGE-IN', `Audio played before interrupt: ${audioEndMs}ms`);
          }

          // Send truncation event to keep conversation history coherent
          // This tells OpenAI exactly how much of its response the user heard
          if (lastResponseItemIdRef.current && audioEndMs > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            const truncateEvent = {
              type: 'conversation.item.truncate',
              item_id: lastResponseItemIdRef.current,
              content_index: 0,
              audio_end_ms: audioEndMs,
            };
            wsRef.current.send(JSON.stringify(truncateEvent));
            console.log(`[CLIENT] Sent truncate event: item_id=${lastResponseItemIdRef.current}, audio_end_ms=${audioEndMs}`);
          }

          stopAudioPlayback();
          setInteractionMode('listening');

          // Reset tracking refs
          lastResponseItemIdRef.current = null;
          responseStartTimeRef.current = 0;
          break;

        case 'input_audio_buffer.speech_stopped':
          debugLog('MODE', 'Mode: -> processing');
          lastSpeechStoppedTimeRef.current = Date.now();
          lastFirstAudioReceivedTimeRef.current = null;
          setInteractionMode('processing');
          break;

        // Barge-in confirmation events
        case 'response.cancelled':
          console.log('[CLIENT] Response cancelled (barge-in successful)');
          break;

        case 'conversation.item.truncated':
          debugLog('BARGE-IN', 'Truncation confirmed by OpenAI');
          break;

        // Vision acknowledgment from server (optional)
        case 'vision.received':
          debugLog('VISION', 'Server acknowledged vision frame');
          break;
      }
    } catch (e) {
      console.log('[CLIENT] Non-JSON message received');
    }
  }, [scheduleAudioChunk, stopAudioPlayback, initAudioContext, startRecording]);

  // -------------------------------------------------------------------------
  // WEBSOCKET CONNECTION
  // -------------------------------------------------------------------------
  const BYPASS_BACKEND = false; // Set to true for UI testing without AWS backend

  const connect = useCallback((config: AgentConfig) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Validate config
    if (!config || !config.name || !config.language) {
      console.error('[CLIENT] Invalid agent config:', config);
      return;
    }

    // Store the agent config and update display name
    try {
      setCurrentAgentConfig(config);
      setAgentName(config.name);
      sessionStartTimeRef.current = Date.now();
      debugLog('CONNECTION', `Connecting to ${config.name} (${config.language})...`);
      setConnectionStatus('Connecting...');
    } catch (e) {
      console.error('[CLIENT] Error setting up connection state:', e);
      return;
    }

    if (BYPASS_BACKEND) {
      console.log('[CLIENT] BYPASS_BACKEND active. Simulating connection...');
      setTimeout(() => {
        setConnectionStatus('AI Connected');
        setIsConnected(true);
        setInteractionMode('listening');
        debugLog('CONNECTION', 'Connected (Simulated)');
      }, 1500);
      return;
    }

    try {
      const ws = new WebSocket(RELAY_SERVER_URL);
      wsRef.current = ws;

      // Track if we successfully connected (to distinguish close events)
      let didConnect = false;

      ws.onopen = () => {
        didConnect = true;
        console.log('[CLIENT] Connected');
        debugLog('CONNECTION', 'Connected');

        // =====================================================================
        // HARDWARE AEC ACTIVATION
        // Start InCallManager to activate iOS voiceChat mode / Android voice
        // call routing. This enables hardware echo cancellation which is
        // critical for barge-in to work without feedback loops.
        // =====================================================================
        try {
          InCallManager.start({ media: 'audio' });
          console.log('[AEC] InCallManager started - hardware echo cancellation active');
        } catch (e) {
          console.warn('[AEC] Failed to start InCallManager:', e);
        }

        // PHASE 3.1: Send agent.config to trigger dynamic persona on server
        // The server will handle generating the Friend Mode system prompt
        const agentConfigMessage = {
          type: 'agent.config',
          config: {
            name: config.name,
            language: config.language,
          },
        };
        ws.send(JSON.stringify(agentConfigMessage));
        debugLog('SESSION', `Sent agent.config for ${config.name}: ${config.language} tutor`);
      };

      ws.onmessage = handleMessage;

      ws.onerror = (e) => {
        console.error('[CLIENT] WebSocket error:', e);
        // Don't reset UI here - let onclose handle it
      };

      ws.onclose = (event) => {
        console.log('[CLIENT] Disconnected, code:', event.code, 'reason:', event.reason);
        debugLog('CONNECTION', 'Disconnected');

        // Only reset UI if we were previously connected or after a delay
        if (didConnect) {
          // Normal disconnect - reset immediately
          setConnectionStatus('Offline');
          setIsConnected(false);
          setInteractionMode('idle');
        } else {
          // Connection failed - show error briefly before resetting
          setConnectionStatus('Connection Failed');
          setTimeout(() => {
            setConnectionStatus('Offline');
            setIsConnected(false);
            setInteractionMode('idle');
          }, 2000);
        }

        wsRef.current = null;
        stopAudioPlayback();
        stopRecording();
      };
    } catch (error) {
      console.error('[CLIENT] Failed to create WebSocket:', error);
      setConnectionStatus('Connection Failed');
      setTimeout(() => {
        setConnectionStatus('Offline');
        setIsConnected(false);
      }, 2000);
    }
  }, [handleMessage, stopRecording, stopAudioPlayback]);

  const disconnect = useCallback(() => {
    // Save to history before disconnecting
    if (currentAgentConfig && sessionStartTimeRef.current) {
      const duration = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000);
      const historyItem: CallHistoryItem = {
        id: generateUUID(),
        agentConfig: currentAgentConfig,
        timestamp: new Date(sessionStartTimeRef.current),
        duration,
      };
      setCallHistory(prev => {
        const updated = [historyItem, ...prev];
        // Persist to AsyncStorage
        saveCallHistory(updated);
        return updated;
      });
      // Also save the agent to persistent storage
      addAgent(currentAgentConfig);
      debugLog('HISTORY', `Saved session: ${currentAgentConfig.name} (${duration}s)`);
    }

    stopRecording();
    stopAudioPlayback();

    // Stop hardware AEC
    try {
      InCallManager.stop();
      console.log('[AEC] InCallManager stopped');
    } catch (e) {
      console.warn('[AEC] Failed to stop InCallManager:', e);
    }

    // Reset agent config
    setCurrentAgentConfig(null);
    sessionStartTimeRef.current = null;

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
  }, [stopRecording, stopAudioPlayback, currentAgentConfig]);

  // -------------------------------------------------------------------------
  // UI CONTROL HANDLERS
  // -------------------------------------------------------------------------
  const handleToggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const handleToggleCamera = useCallback(() => {
    setIsCameraOn(prev => !prev);
  }, []);

  const handleFlipCamera = useCallback(() => {
    setCameraFacing(prev => prev === 'front' ? 'back' : 'front');
  }, []);

  const handleToggleNoiseIsolation = useCallback(() => {
    setIsNoiseIsolationOn(prev => !prev);
  }, []);

  // Delete a call history item
  const handleDeleteItem = useCallback((itemId: string) => {
    setCallHistory(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      saveCallHistory(updated);
      return updated;
    });
  }, []);

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      const granted = await requestMicrophonePermission();
      setPermissionGranted(granted);

      // Load persisted data from AsyncStorage
      const storedHistory = await loadCallHistory();

      // If no history exists, load placeholder data for preview
      if (storedHistory.length === 0) {
        const placeholderHistory: CallHistoryItem[] = [
          {
            id: 'demo-1',
            agentConfig: { name: 'María', language: 'Spanish', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 30), // 30 min ago
            duration: 245,
          },
          {
            id: 'demo-2',
            agentConfig: { name: 'Pierre', language: 'French', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3), // 3 hours ago
            duration: 180,
          },
          {
            id: 'demo-3',
            agentConfig: { name: 'Yuki', language: 'Japanese', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // yesterday
            duration: 420,
          },
        ];
        setCallHistory(placeholderHistory);

        // Also add some placeholder gap words for María
        const { saveAllGapWords } = await import('./storage');
        await saveAllGapWords({
          'María': [
            { native_word: 'to run', target_word: 'correr', timestamp: Date.now() - 1000 * 60 * 25 },
            { native_word: 'window', target_word: 'ventana', timestamp: Date.now() - 1000 * 60 * 20 },
            { native_word: 'to understand', target_word: 'entender', timestamp: Date.now() - 1000 * 60 * 15 },
            { native_word: 'beautiful', target_word: 'hermoso', timestamp: Date.now() - 1000 * 60 * 10 },
          ],
          'Pierre': [
            { native_word: 'always', target_word: 'toujours', timestamp: Date.now() - 1000 * 60 * 60 * 2 },
            { native_word: 'tomorrow', target_word: 'demain', timestamp: Date.now() - 1000 * 60 * 60 * 2.5 },
          ],
        });
        console.log('[STORAGE] Loaded placeholder data for preview');
      } else {
        setCallHistory(storedHistory);
        console.log('[STORAGE] Loaded call history:', storedHistory.length, 'items');
      }
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


  const showCallUI = isConnected || connectionStatus === 'Connecting...' || connectionStatus === 'Connection Failed';

  // -------------------------------------------------------------------------
  // ANIMATION STATE & STYLES (Optimized for 120Hz iOS + Android)
  // -------------------------------------------------------------------------
  const animState = useSharedValue(0); // 0 = Disconnected (Sheet visible), 1 = Connected (UI visible)
  const { height: SCREEN_HEIGHT } = Dimensions.get('window');

  // Platform-specific easing - Android performs better with simpler curves
  const TRANSITION_EASING = Platform.select<any>({
    ios: Easing.bezier(0.2, 0.0, 0.0, 1.0), // Apple's native curve
    android: Easing.out(Easing.cubic), // Faster on Android
    default: Easing.out(Easing.cubic),
  });

  // Shorter duration on Android feels snappier
  const TRANSITION_DURATION = Platform.select({
    ios: 450,
    android: 300,
    default: 350,
  });

  useEffect(() => {
    animState.value = withTiming(showCallUI ? 1 : 0, {
      duration: TRANSITION_DURATION,
      easing: TRANSITION_EASING,
    });
  }, [showCallUI]);

  // Android: Use opacity-heavy transition (GPU accelerated)
  // iOS: Use translateY (works great with ProMotion)
  const sheetStyle = useAnimatedStyle(() => {
    'worklet';
    if (Platform.OS === 'android') {
      // Android: Fade + subtle scale (more performant than large translateY)
      return {
        opacity: interpolate(
          animState.value,
          [0, 0.5, 1],
          [1, 0.5, 0],
          Extrapolation.CLAMP
        ),
        transform: [{
          scale: interpolate(
            animState.value,
            [0, 1],
            [1, 0.95],
            Extrapolation.CLAMP
          )
        }],
      };
    }
    // iOS: Slide down
    return {
      transform: [{
        translateY: interpolate(
          animState.value,
          [0, 1],
          [0, SCREEN_HEIGHT],
          Extrapolation.CLAMP
        )
      }],
    };
  });

  const uiLayerStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: interpolate(
        animState.value,
        [0, 0.2, 1],
        [0, 0, 1],
        Extrapolation.CLAMP
      ),
      transform: [{
        translateY: interpolate(
          animState.value,
          [0, 1],
          [Platform.OS === 'android' ? 15 : 30, 0],
          Extrapolation.CLAMP
        )
      }],
    };
  });


  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* LAYER 1: Viewfinder Background (Always active but obscured by Sheet initially) */}
      <Viewfinder
        ref={viewfinderRef}
        isCameraOn={isCameraOn}
        facing={cameraFacing}
      />

      {/* LAYER 2: Flash Overlay (Above camera, below UI) */}
      <FlashOverlay flashOpacity={flashOpacity} />

      {/* LAYER 3: Main Call UI (Fade In / Slide Up) */}
      <Animated.View
        style={[
          styles.uiLayer,
          { paddingTop: insets.top, paddingBottom: insets.bottom, zIndex: showCallUI ? 10 : 0 },
          uiLayerStyle
        ]}
        pointerEvents={showCallUI ? 'auto' : 'none'}
      >
        {/* Top Status */}
        <StatusPill
          status={isConnected ? `Connected to ${agentName}` : connectionStatus}
          isConnected={isConnected}
        />

        {/* Center Orb (smaller, integrated) */}
        <View style={styles.orbContainer}>
          <ActiveOrb
            mode={interactionMode}
            volumeLevel={volumeLevel}
            stabilityProgress={stabilityProgress}
            isStable={isStableSV}
          />
        </View>

        {/* Bottom Controls */}
        <ControlSheet
          onDisconnect={disconnect}
          isMuted={isMuted}
          onToggleMute={handleToggleMute}
          isCameraOn={isCameraOn}
          onToggleCamera={handleToggleCamera}
          onFlipCamera={handleFlipCamera}
          isNoiseIsolationOn={isNoiseIsolationOn}
          onToggleNoiseIsolation={handleToggleNoiseIsolation}
        />
      </Animated.View>

      {/* LAYER 4: Call History / Start Screen (Slides Down) */}
      <Animated.View style={[StyleSheet.absoluteFill, sheetStyle]}>
        <CallHistoryScreen
          onConnect={connect}
          history={callHistory}
          onViewGapWords={(agent) => setSelectedAgentForGapWords(agent)}
          onDeleteItem={handleDeleteItem}
        />
      </Animated.View>

      {/* LAYER 5: Gap Words Screen (slides in from right) */}
      {selectedAgentForGapWords && (
        <GapWordsScreen
          agent={selectedAgentForGapWords}
          onBack={() => setSelectedAgentForGapWords(null)}
        />
      )}
    </View>
  );
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Show loading indicator while fonts load (Android only needs this)
  if (!fontsLoaded && Platform.OS === 'android') {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#34C759" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uiLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    zIndex: 10,
  },
  orbContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  flashOverlayContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  flashOverlayBox: {
    width: CROSSHAIR_SIZE,
    height: CROSSHAIR_SIZE,
    borderRadius: CROSSHAIR_RADIUS,
    backgroundColor: '#FFFFFF',
  },
});
