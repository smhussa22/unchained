import React, { useCallback } from 'react';
import { Pressable, Text, StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { LucideIcon } from 'lucide-react-native';
import { THEME } from '../theme';

interface CircleButtonProps {
    icon: LucideIcon;
    label: string;
    onPress: () => void;
    variant?: 'default' | 'destructive';
    isActive?: boolean;
}

export const CircleButton = ({ icon: Icon, label, onPress, variant = 'default', isActive = false }: CircleButtonProps) => {
    const isDestructive = variant === 'destructive';
    const scale = useSharedValue(1);

    const handlePress = useCallback(() => {
        onPress();
    }, [onPress]);

    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        return { transform: [{ scale: scale.value }] };
    });

    return (
        <View style={styles.wrapper}>
            <Pressable
                onPressIn={() => {
                    scale.value = withSpring(0.88, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                    scale.value = withSpring(1, { damping: 12, stiffness: 200 });
                }}
                onPress={handlePress}
            >
                <Animated.View
                    style={[
                        styles.button,
                        isDestructive && styles.buttonDestructive,
                        isActive && !isDestructive && styles.buttonActive,
                        animatedStyle,
                    ]}
                >
                    <Icon
                        size={22}
                        color={isDestructive ? '#FFFFFF' : isActive ? '#000000' : '#FFFFFF'}
                        strokeWidth={2}
                    />
                </Animated.View>
            </Pressable>
            <Text style={styles.label}>{label}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    wrapper: {
        alignItems: 'center',
        gap: THEME.spacing.sm,
    },
    button: {
        width: 54,
        height: 54,
        borderRadius: 27,
        backgroundColor: THEME.colors.controlBackground,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonDestructive: {
        backgroundColor: THEME.colors.destructive,
    },
    buttonActive: {
        backgroundColor: THEME.colors.controlActive,
    },
    label: {
        ...THEME.typography.caption2,
        color: THEME.colors.textSecondary,
        textAlign: 'center',
    },
});
