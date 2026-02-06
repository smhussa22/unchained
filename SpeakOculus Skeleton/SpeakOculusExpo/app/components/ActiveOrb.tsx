import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSpring,
  withSequence,
  Easing,
  interpolate,
  SharedValue,
  ReduceMotion,
} from 'react-native-reanimated';

export type OrbMode = 'idle' | 'listening' | 'speaking' | 'processing';

interface ActiveOrbProps {
  mode: OrbMode;
  volumeLevel: SharedValue<number>; // 0-1 shared value from audio input
  stabilityProgress?: SharedValue<number>; // 0-1 SharedValue, how close to stable (for lock-on indicator)
  isStable?: SharedValue<boolean>; // SharedValue, true when device is fully stable (ready to capture)
}

// Increased size for the viewfinder box
const ORB_SIZE = 280;
const BORDER_WIDTH = 4;
const CORNER_RADIUS = 40;

// Optimized spring configs for 60fps+ animations
const SPRING_CONFIG = {
  fast: {
    damping: 15,
    stiffness: 400,
    mass: 0.5,
    restDisplacementThreshold: 0.001,
    restSpeedThreshold: 0.001,
  },
  smooth: {
    damping: 20,
    stiffness: 200,
    mass: 0.8,
    restDisplacementThreshold: 0.001,
    restSpeedThreshold: 0.001,
  },
  bouncy: {
    damping: 12,
    stiffness: 180,
    mass: 0.6,
    overshootClamping: false,
  },
};

export const ActiveOrb: React.FC<ActiveOrbProps> = ({
  mode,
  volumeLevel,
  stabilityProgress: stabilityProgressProp,
  isStable: isStableProp,
}) => {
  // Default SharedValues for when props are not provided
  const defaultStabilityProgress = useSharedValue(0);
  const defaultIsStable = useSharedValue(false);
  const stabilityProgress = stabilityProgressProp ?? defaultStabilityProgress;
  const isStable = isStableProp ?? defaultIsStable;

  // Internal animation values
  const baseScale = useSharedValue(1);
  const opacity = useSharedValue(0.8);
  const rippleScale = useSharedValue(1);
  const rippleOpacity = useSharedValue(0);

  // FaceTime-inspired Colors
  const ACTIVE_GREEN = '#34C759';
  const STABLE_GREEN = '#34C759'; // Same green for stability lock-on
  const PROCESSING_WHITE = 'rgba(255, 255, 255, 0.9)';
  const IDLE_GREY = 'rgba(255, 255, 255, 0.3)';
  const STABILITY_PROGRESS_COLOR = 'rgba(52, 199, 89, 0.6)'; // Semi-transparent green

  useEffect(() => {
    // Cancel previous animations by setting new values
    rippleScale.value = 1;
    rippleOpacity.value = 0;

    switch (mode) {
      case 'idle':
        // Gentle breathing - smoother with longer duration
        baseScale.value = withRepeat(
          withSequence(
            withTiming(1.02, { duration: 1500, easing: Easing.inOut(Easing.sin) }),
            withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) })
          ),
          -1,
          false
        );
        opacity.value = withSpring(0.4, SPRING_CONFIG.smooth);
        break;

      case 'listening':
        // Snap to attentive state
        baseScale.value = withSpring(1, SPRING_CONFIG.fast);
        opacity.value = withSpring(1, SPRING_CONFIG.fast);
        break;

      case 'processing':
        // Faster pulse for processing feedback
        baseScale.value = withRepeat(
          withSequence(
            withTiming(0.96, { duration: 400, easing: Easing.inOut(Easing.sin) }),
            withTiming(1, { duration: 400, easing: Easing.inOut(Easing.sin) })
          ),
          -1,
          false
        );
        opacity.value = withSpring(0.85, SPRING_CONFIG.smooth);
        break;

      case 'speaking':
        // Snap to speaking state
        baseScale.value = withSpring(1, SPRING_CONFIG.fast);
        opacity.value = withSpring(1, SPRING_CONFIG.fast);

        // Smoother ripple with opacity fade
        rippleOpacity.value = 0.6;
        rippleScale.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 0 }),
            withTiming(1.35, { duration: 1000, easing: Easing.out(Easing.cubic) })
          ),
          -1,
          false
        );
        rippleOpacity.value = withRepeat(
          withSequence(
            withTiming(0.5, { duration: 0 }),
            withTiming(0, { duration: 1000, easing: Easing.out(Easing.cubic) })
          ),
          -1,
          false
        );
        break;
    }
  }, [mode]);

  // Main box style - optimized for 60fps
  // Includes stability-based border color when listening
  const boxStyle = useAnimatedStyle(() => {
    'worklet';
    // Volume reactivity - smooth interpolation
    const volumeBoost = (mode === 'listening' || mode === 'speaking')
      ? volumeLevel.value * 0.12
      : 0;

    // Determine border color based on mode and stability
    let borderColor = IDLE_GREY;
    if (mode === 'processing') {
      borderColor = PROCESSING_WHITE;
    } else if (mode === 'listening' || mode === 'speaking') {
      borderColor = ACTIVE_GREEN;
    }

    return {
      transform: [
        { scale: baseScale.value + volumeBoost },
      ],
      borderColor: borderColor,
      opacity: opacity.value,
      borderWidth: mode === 'processing' ? 2 : 4,
    };
  }, [mode]);

  // Ripple style - now using dedicated opacity value for smoother fades
  const rippleStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ scale: rippleScale.value }],
      opacity: rippleOpacity.value,
      borderColor: ACTIVE_GREEN,
    };
  });

  // Background tint style - subtle fill to make the box feel like a lens
  const fillStyle = useAnimatedStyle(() => {
    'worklet';
    const activeFillOpacity = interpolate(
      volumeLevel.value,
      [0, 0.3, 1],
      [0.03, 0.1, 0.2]
    );
    return {
      backgroundColor: mode === 'idle' ? 'transparent' : ACTIVE_GREEN,
      opacity: mode === 'idle' ? 0 : activeFillOpacity,
    };
  }, [mode]);

  // Corner marker animated style - reads from SharedValues on UI thread
  const cornerAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const progress = stabilityProgress.value;
    const stable = isStable.value;
    const showStability = mode === 'listening' && progress > 0.5;

    if (showStability) {
      if (stable) {
        return { borderColor: STABLE_GREEN };
      }
      // Interpolate opacity based on stability progress
      const alpha = 0.3 + progress * 0.7;
      return { borderColor: `rgba(52, 199, 89, ${alpha})` };
    }
    return { borderColor: 'rgba(255,255,255,0.3)' };
  }, [mode]);

  // Always-mounted ripple style with mode-based visibility
  const rippleVisibilityStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ scale: rippleScale.value }],
      opacity: mode === 'speaking' ? rippleOpacity.value : 0,
      borderColor: ACTIVE_GREEN,
    };
  }, [mode]);

  // Always-mounted stability ring style with mode-based visibility
  const stabilityRingVisibilityStyle = useAnimatedStyle(() => {
    'worklet';
    const progress = stabilityProgress.value;
    const stable = isStable.value;
    const shouldShow = mode === 'listening' && progress > 0;
    return {
      opacity: shouldShow ? progress : 0,
      borderColor: stable ? STABLE_GREEN : STABILITY_PROGRESS_COLOR,
      borderWidth: stable ? 6 : 4,
      transform: [{ scale: stable ? 1.02 : 1 }],
    };
  }, [mode]);

  return (
    <View style={styles.container}>
      {/* Stability Lock-On Indicator (Behind main box) - always mounted */}
      <Animated.View style={[styles.stabilityRing, stabilityRingVisibilityStyle]} />

      {/* Ripple Effect - always mounted, visibility controlled by animated style */}
      <Animated.View style={[styles.box, rippleVisibilityStyle]} />

      {/* Main Square Crosshair Box */}
      <Animated.View style={[styles.box, boxStyle]}>
        {/* Subtle inner fill reacting to volume */}
        <Animated.View style={[styles.fill, fillStyle]} />

        {/* Crosshair Corners (Visual Flourish) - Color changes with stability via SharedValues */}
        <Animated.View style={[styles.cornerTL, cornerAnimatedStyle]} />
        <Animated.View style={[styles.cornerTR, cornerAnimatedStyle]} />
        <Animated.View style={[styles.cornerBL, cornerAnimatedStyle]} />
        <Animated.View style={[styles.cornerBR, cornerAnimatedStyle]} />
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
  stabilityRing: {
    width: ORB_SIZE + 16,
    height: ORB_SIZE + 16,
    borderRadius: CORNER_RADIUS + 4,
    borderWidth: 4,
    borderColor: '#34C759',
    position: 'absolute',
    opacity: 0,
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
