import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { LucideIcon } from 'lucide-react-native';
import { THEME } from '../theme';

interface FeatureToggleProps {
    icon: LucideIcon;
    label: string;
    isActive: boolean;
    onPress: () => void;
}

export const FeatureToggle = ({ icon: Icon, label, isActive, onPress }: FeatureToggleProps) => {
    return (
        <TouchableOpacity
            style={[styles.container, isActive ? styles.active : styles.inactive]}
            onPress={onPress}
            activeOpacity={0.8}
        >
            <Icon
                size={16}
                color={isActive ? THEME.colors.iconActive : THEME.colors.iconDefault}
            />
            <Text style={[styles.label, isActive ? styles.labelActive : styles.labelInactive]}>
                {label}
            </Text>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: THEME.spacing.sm,
        paddingHorizontal: THEME.spacing.sm,
        borderRadius: THEME.borderRadius.xl,
        gap: THEME.spacing.xs,
    },
    inactive: {
        backgroundColor: THEME.colors.controlBackground,
    },
    active: {
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
