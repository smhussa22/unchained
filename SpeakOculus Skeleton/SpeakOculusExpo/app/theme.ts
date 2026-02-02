export const THEME = {
    colors: {
        background: '#000000',
        surface: 'rgba(30, 30, 30, 0.85)',
        surfaceHighlight: 'rgba(255, 255, 255, 0.1)',
        textPrimary: '#FFFFFF',
        textSecondary: 'rgba(255, 255, 255, 0.6)',
        accent: '#34C759', // Green for connected/active
        destructive: '#FF3B30', // Red for hangup
        iconDefault: '#FFFFFF',
        iconActive: '#000000',
        controlBackground: '#2C2C2E',
        controlActive: '#FFFFFF',
    },
    spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32,
    },
    borderRadius: {
        sm: 8,
        md: 12,
        lg: 20,
        xl: 32,
        pill: 999,
    },
    blur: {
        intensity: 80, // Increased for stronger blur/less see-through effect
        tint: 'dark' as const,
    },
};
