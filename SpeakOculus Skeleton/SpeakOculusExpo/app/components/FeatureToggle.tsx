import React, { useCallback } from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
} from 'react-native-reanimated';
import { LucideIcon } from 'lucide-react-native';
import { THEME } from '../theme';

interface FeatureToggleProps {
    icon: LucideIcon;
    label: string;
    isActive: boolean;
    onPress: () => void;
}

export const FeatureToggle = ({ icon: Icon, label, isActive, onPress }: FeatureToggleProps) => {
    const scale = useSharedValue(1);

    const handlePress = useCallback(() => {
        onPress();
    }, [onPress]);

    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        return { transform: [{ scale: scale.value }] };
    });

    return (
        <Pressable
            onPressIn={() => {
                scale.value = withSpring(0.93, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
                scale.value = withSpring(1, { damping: 12, stiffness: 200 });
            }}
            onPress={handlePress}
            style={styles.pressable}
        >
            <Animated.View
                style={[
                    styles.container,
                    isActive && styles.containerActive,
                    animatedStyle,
                ]}
            >
                <Icon
                    size={15}
                    color={isActive ? THEME.colors.iconActive : THEME.colors.iconDefault}
                    strokeWidth={2}
                />
                <Text style={[styles.label, isActive ? styles.labelActive : styles.labelInactive]}>
                    {label}
                </Text>
            </Animated.View>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    pressable: {
        flex: 1,
    },
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        paddingHorizontal: THEME.spacing.sm,
        borderRadius: THEME.borderRadius.xl,
        gap: 6,
        backgroundColor: THEME.colors.controlBackground,
    },
    containerActive: {
        backgroundColor: THEME.colors.controlActive,
    },
    label: {
        ...THEME.typography.caption1,
        fontWeight: '600',
    },
    labelInactive: {
        color: THEME.colors.textPrimary,
    },
    labelActive: {
        color: '#000000',
    },
});
