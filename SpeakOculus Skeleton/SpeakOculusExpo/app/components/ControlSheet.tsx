import React from 'react';
import { View, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Globe, Mic, MicOff, Camera, PhoneOff, VideoOff, AudioWaveform, Video } from 'lucide-react-native';
import { CircleButton } from './CircleButton';
import { FeatureToggle } from './FeatureToggle';
import { THEME } from '../theme';

interface ControlSheetProps {
    onDisconnect: () => void;
    isMuted: boolean;
    onToggleMute: () => void;
    isCameraOn: boolean;
    onToggleCamera: () => void;
    onFlipCamera: () => void;
    isNoiseIsolationOn: boolean;
    onToggleNoiseIsolation: () => void;
}

export const ControlSheet = ({
    onDisconnect,
    isMuted,
    onToggleMute,
    isCameraOn,
    onToggleCamera,
    onFlipCamera,
    isNoiseIsolationOn,
    onToggleNoiseIsolation,
}: ControlSheetProps) => {
    return (
        <View style={styles.container}>
            <BlurView intensity={THEME.blur.intensity} tint={THEME.blur.tint} style={styles.blurContainer}>
                {/* Handle */}
                <View style={styles.handle} />

                {/* Circle Buttons Row */}
                <View style={styles.row}>
                    <CircleButton
                        icon={Globe}
                        label="languages"
                        onPress={() => { }}
                    />
                    <CircleButton
                        icon={isMuted ? MicOff : Mic}
                        label="mute"
                        isActive={isMuted}
                        onPress={onToggleMute}
                    />
                    <CircleButton
                        icon={Camera}
                        label="flip"
                        onPress={onFlipCamera}
                    />
                    <CircleButton
                        icon={PhoneOff}
                        label="end"
                        variant="destructive"
                        onPress={onDisconnect}
                    />
                </View>

                {/* Feature Toggles Row */}
                <View style={styles.featuresRow}>
                    <FeatureToggle
                        icon={isCameraOn ? Video : VideoOff}
                        label={isCameraOn ? "Camera On" : "Camera Off"}
                        isActive={isCameraOn}
                        onPress={onToggleCamera}
                    />
                    <FeatureToggle
                        icon={AudioWaveform}
                        label="Noise Isolation"
                        isActive={isNoiseIsolationOn}
                        onPress={onToggleNoiseIsolation}
                    />
                </View>
            </BlurView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
        paddingHorizontal: THEME.spacing.md,
        paddingBottom: THEME.spacing.lg,
    },
    blurContainer: {
        padding: THEME.spacing.lg,
        backgroundColor: 'rgba(30, 30, 30, 0.90)', // Reduced transparency (more opaque)
        gap: THEME.spacing.xl,
        borderRadius: 48, // Increased for a smoother, rounder box
        overflow: 'hidden',
        // Floating shadow
        shadowColor: "#000",
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.3,
        shadowRadius: 10,
        elevation: 10,
    },
    handle: {
        width: 36,
        height: 5,
        borderRadius: 2.5,
        backgroundColor: 'rgba(255, 255, 255, 0.3)',
        alignSelf: 'center',
        marginBottom: THEME.spacing.xs,
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: THEME.spacing.xs,
    },
    featuresRow: {
        flexDirection: 'row',
        gap: THEME.spacing.md,
        marginBottom: THEME.spacing.md,
    },
});
