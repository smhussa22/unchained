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

const ORB_SIZE = 80;

export const ActiveOrb: React.FC<ActiveOrbProps> = ({ mode, volumeLevel }) => {
  // Internal animation values
  const baseScale = useSharedValue(1);
  const rotation = useSharedValue(0);
  const opacity = useSharedValue(0.8);
  const ripple1Scale = useSharedValue(1);
  const ripple2Scale = useSharedValue(1);

  useEffect(() => {
    // Reset animations
    rotation.value = withTiming(0);
    ripple1Scale.value = 1;
    ripple2Scale.value = 1;

    switch (mode) {
      case 'idle':
        // Gentle breathing animation
        baseScale.value = withRepeat(
          withTiming(1.05, { duration: 2000, easing: Easing.inOut(Easing.quad) }),
          -1,
          true
        );
        opacity.value = withTiming(0.7);
        break;

      case 'listening':
        // Base scale is controlled by volumeLevel in animated style
        baseScale.value = withTiming(1);
        opacity.value = withTiming(1);
        break;

      case 'processing':
        // Fast spin animation
        baseScale.value = withSpring(0.85);
        rotation.value = withRepeat(
          withTiming(360, { duration: 800, easing: Easing.linear }),
          -1,
          false
        );
        opacity.value = withTiming(0.9);
        break;

      case 'speaking':
        // Sine wave pulse + ripples
        baseScale.value = withRepeat(
          withTiming(1.15, { duration: 600, easing: Easing.inOut(Easing.sin) }),
          -1,
          true
        );
        opacity.value = withTiming(1);

        // Expanding ripple rings
        ripple1Scale.value = withRepeat(
          withTiming(3, { duration: 1500, easing: Easing.out(Easing.quad) }),
          -1,
          false
        );
        ripple2Scale.value = withDelay(
          750,
          withRepeat(
            withTiming(3, { duration: 1500, easing: Easing.out(Easing.quad) }),
            -1,
            false
          )
        );
        break;
    }
  }, [mode]);

  // Main orb animated style
  const orbStyle = useAnimatedStyle(() => {
    // When listening, add volume-based scaling on top of base scale
    const volumeBoost = mode === 'listening' ? volumeLevel.value * 0.5 : 0;
    const finalScale = baseScale.value + volumeBoost;

    return {
      transform: [
        { scale: finalScale },
        { rotate: `${rotation.value}deg` },
      ],
      opacity: opacity.value,
    };
  });

  // Ripple styles for speaking mode
  const ripple1Style = useAnimatedStyle(() => ({
    transform: [{ scale: ripple1Scale.value }],
    opacity: interpolate(ripple1Scale.value, [1, 3], [0.5, 0]),
  }));

  const ripple2Style = useAnimatedStyle(() => ({
    transform: [{ scale: ripple2Scale.value }],
    opacity: interpolate(ripple2Scale.value, [1, 3], [0.5, 0]),
  }));

  // Gradient colors based on mode
  const getGradientColors = (): readonly [string, string] => {
    switch (mode) {
      case 'idle':
        return ['#4ca1af', '#c4e0e5']; // Calm blue-teal
      case 'listening':
        return ['#ff9966', '#ff5e62']; // Warm orange-red (attentive)
      case 'processing':
        return ['#8e2de2', '#4a00e0']; // Purple (thinking)
      case 'speaking':
        return ['#00f260', '#0575e6']; // Green-blue (output)
      default:
        return ['#ffffff', '#aaaaaa'];
    }
  };

  const colors = getGradientColors();

  return (
    <View style={styles.container}>
      {/* Ripple rings (visible in speaking mode) */}
      {mode === 'speaking' && (
        <>
          <Animated.View
            style={[styles.ripple, ripple1Style, { borderColor: colors[0] }]}
          />
          <Animated.View
            style={[styles.ripple, ripple2Style, { borderColor: colors[1] }]}
          />
        </>
      )}

      {/* Core orb */}
      <Animated.View style={[styles.orb, orbStyle]}>
        <LinearGradient
          colors={colors}
          style={styles.gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: ORB_SIZE * 3,
    height: ORB_SIZE * 3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orb: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    shadowColor: '#fff',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 10,
  },
  gradient: {
    flex: 1,
    borderRadius: ORB_SIZE / 2,
  },
  ripple: {
    position: 'absolute',
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    borderWidth: 2,
    zIndex: -1,
  },
});
