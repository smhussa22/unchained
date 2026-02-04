import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { THEME } from '../theme';

interface StatusPillProps {
  status: string;
  isConnected?: boolean;
}

export const StatusPill = ({ status, isConnected = false }: StatusPillProps) => {
  return (
    <View style={styles.container}>
      <BlurView intensity={THEME.blur.intensity} tint={THEME.blur.tint} style={styles.blur}>
        {isConnected && <View style={styles.indicator} />}
        <Text style={styles.text}>{status}</Text>
      </BlurView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderRadius: THEME.borderRadius.pill,
    alignSelf: 'center',
    marginTop: THEME.spacing.xl, // Safe area inset top approx
  },
  blur: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: THEME.spacing.md,
    backgroundColor: THEME.colors.surfaceHighlight,
  },
  indicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: THEME.colors.accent,
    marginRight: THEME.spacing.sm,
  },
  text: {
    ...THEME.typography.headline,
    color: THEME.colors.textPrimary,
  },
});
