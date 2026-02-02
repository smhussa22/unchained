import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSpring,
  Easing,
  interpolate,
  withDelay,
  SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

export type OrbMode = 'idle' | 'listening' | 'speaking' | 'processing';

interface ActiveOrbProps {
  mode: OrbMode;
  volumeLevel: SharedValue<number>; // 0-1 shared value from audio input
}

// Increased size for the viewfinder box
const ORB_SIZE = 280;
const BORDER_WIDTH = 4;
const CORNER_RADIUS = 40;

export const ActiveOrb: React.FC<ActiveOrbProps> = ({ mode, volumeLevel }) => {
  // Internal animation values
  const baseScale = useSharedValue(1);
  const opacity = useSharedValue(0.8);
  const rippleScale = useSharedValue(1);

  // FaceTime-inspired Green Colors
  const ACTIVE_GREEN = '#34C759'; // FaceTime Green
  const DARK_GREEN = '#005a2b';
  const PROCESSING_WHITE = 'rgba(255, 255, 255, 0.9)';
  const IDLE_GREY = 'rgba(255, 255, 255, 0.3)';

  useEffect(() => {
    // Reset animations
    rippleScale.value = 1;

    switch (mode) {
      case 'idle':
        // Gentle breathing of the box
        baseScale.value = withRepeat(
          withTiming(1.02, { duration: 3000, easing: Easing.inOut(Easing.quad) }),
          -1,
          true
        );
        opacity.value = withTiming(0.4);
        break;

      case 'listening':
        // "Attentive" state - solid, steady box
        baseScale.value = withSpring(1);
        opacity.value = withTiming(1);
        break;

      case 'processing':
        // Pulsing while thinking
        baseScale.value = withRepeat(
          withTiming(0.95, { duration: 800, easing: Easing.inOut(Easing.quad) }),
          -1,
          true
        );
        opacity.value = withTiming(0.8);
        break;

      case 'speaking':
        // Active speaking - punchy scale changes
        baseScale.value = withSpring(1);
        opacity.value = withTiming(1);

        // Ripple effect for creating the "radiating" look
        rippleScale.value = withRepeat(
          withTiming(1.4, { duration: 1500, easing: Easing.out(Easing.quad) }),
          -1,
          false
        );
        break;
    }
  }, [mode]);

  // Main box style
  const boxStyle = useAnimatedStyle(() => {
    // Volume reactivity for listening/speaking
    const volumeBoost = (mode === 'listening' || mode === 'speaking')
      ? volumeLevel.value * 0.15
      : 0;

    return {
      transform: [
        { scale: baseScale.value + volumeBoost },
      ],
      borderColor: mode === 'idle' ? IDLE_GREY :
        mode === 'processing' ? PROCESSING_WHITE : ACTIVE_GREEN,
      opacity: opacity.value,
      borderWidth: mode === 'processing' ? 2 : 4,
    };
  });

  // Ripple style (the "echo" of the box)
  const rippleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: rippleScale.value }],
    opacity: interpolate(rippleScale.value, [1, 1.4], [0.6, 0]),
    borderColor: ACTIVE_GREEN,
  }));

  // Background tint style - subtle fill to make the box feel like a lens
  const fillStyle = useAnimatedStyle(() => {
    const activeFillOpacity = interpolate(volumeLevel.value, [0, 1], [0.05, 0.2]);
    return {
      backgroundColor: mode === 'idle' ? 'transparent' : ACTIVE_GREEN,
      opacity: mode === 'idle' ? 0 : activeFillOpacity,
    };
  });

  return (
    <View style={styles.container}>
      {/* Ripple Effect (Speaking Only) */}
      {mode === 'speaking' && (
        <Animated.View style={[styles.box, rippleStyle]} />
      )}

      {/* Main Square Crosshair Box */}
      <Animated.View style={[styles.box, boxStyle]}>
        {/* Subtle inner fill reacting to volume */}
        <Animated.View style={[styles.fill, fillStyle]} />

        {/* Crosshair Corners (Visual Flourish) */}
        <View style={styles.cornerTL} />
        <View style={styles.cornerTR} />
        <View style={styles.cornerBL} />
        <View style={styles.cornerBR} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: ORB_SIZE * 1.5,
    height: ORB_SIZE * 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    pointerEvents: 'none', // Allow touches to pass through the empty center
  },
  box: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: CORNER_RADIUS,
    borderWidth: BORDER_WIDTH,
    borderColor: '#fff', // Default, overridden by anim style
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: CORNER_RADIUS - 2,
  },
  // Crosshair Markers
  cornerTL: {
    position: 'absolute',
    top: 20,
    left: 20,
    width: 20,
    height: 20,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    borderTopLeftRadius: 10,
  },
  cornerTR: {
    position: 'absolute',
    top: 20,
    right: 20,
    width: 20,
    height: 20,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    borderTopRightRadius: 10,
  },
  cornerBL: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    width: 20,
    height: 20,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    borderBottomLeftRadius: 10,
  },
  cornerBR: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 20,
    height: 20,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    borderBottomRightRadius: 10,
  },
});
