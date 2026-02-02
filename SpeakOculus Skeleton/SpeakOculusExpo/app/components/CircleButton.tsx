import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
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

    return (
        <View style={styles.wrapper}>
            <TouchableOpacity
                style={[
                    styles.button,
                    isDestructive && styles.buttonDestructive,
                    isActive && !isDestructive && styles.buttonActive
                ]}
                onPress={onPress}
                activeOpacity={0.7}
            >
                <Icon
                    size={32}
                    color={
                        isDestructive
                            ? '#FFFFFF'
                            : isActive
                                ? '#000000'
                                : '#FFFFFF'
                    }
                />
            </TouchableOpacity>
            <Text style={styles.label}>{label}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    wrapper: {
        alignItems: 'center',
        gap: THEME.spacing.xs,
    },
    button: {
        width: 72,
        height: 72,
        borderRadius: 36,
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
        color: THEME.colors.textSecondary,
        fontSize: 12,
        textAlign: 'center',
        marginTop: 4,
    },
});
