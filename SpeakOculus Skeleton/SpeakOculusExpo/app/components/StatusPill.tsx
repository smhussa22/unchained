import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface StatusPillProps {
  status: ConnectionStatus;
}

export const StatusPill: React.FC<StatusPillProps> = ({ status }) => {
  const width = useSharedValue(120);
  const opacity = useSharedValue(1);
  const dotScale = useSharedValue(1);

  useEffect(() => {
    switch (status) {
      case 'disconnected':
        width.value = withSpring(100);
        opacity.value = withTiming(0.8);
        dotScale.value = withTiming(1);
        break;

      case 'connecting':
        width.value = withSpring(140);
        opacity.value = withTiming(1);
        // Pulsing dot animation
        dotScale.value = withRepeat(
          withSequence(
            withTiming(1.5, { duration: 500 }),
            withTiming(1, { duration: 500 })
          ),
          -1,
          true
        );
        break;

      case 'connected':
        width.value = withSpring(130);
        opacity.value = withTiming(1);
        dotScale.value = withTiming(1);
        break;
    }
  }, [status]);

  const containerStyle = useAnimatedStyle(() => ({
    width: width.value,
    opacity: opacity.value,
  }));

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: dotScale.value }],
  }));

  const getStatusColor = (): string => {
    switch (status) {
      case 'disconnected':
        return '#666'; // Gray
      case 'connecting':
        return '#FFD700'; // Yellow
      case 'connected':
        return '#00FF00'; // Green
      default:
        return '#666';
    }
  };

  const getStatusText = (): string => {
    switch (status) {
      case 'disconnected':
        return 'Offline';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Live';
      default:
        return '';
    }
  };

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      <BlurView intensity={40} tint="dark" style={styles.blur}>
        <View style={styles.content}>
          <Animated.View
            style={[
              styles.dot,
              { backgroundColor: getStatusColor() },
              dotStyle,
            ]}
          />
          <Text style={styles.text}>{getStatusText()}</Text>
        </View>
      </BlurView>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  blur: {
    flex: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
});
