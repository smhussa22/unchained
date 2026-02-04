import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Link, Video, Info } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { THEME } from '../theme';

interface CallHistoryScreenProps {
    onConnect: (name: string) => void;
}

export const CallHistoryScreen: React.FC<CallHistoryScreenProps> = ({ onConnect }) => {
    const insets = useSafeAreaInsets();

    return (
        <View style={styles.container}>
            {/* Background Blur */}
            {Platform.OS !== 'android' && (
                <BlurView intensity={THEME.blur.intensity} tint={THEME.blur.tint} style={StyleSheet.absoluteFill} />
            )}
            {Platform.OS === 'android' && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: THEME.colors.surface }]} />
            )}

            <ScrollView
                contentContainerStyle={[
                    styles.contentContainer,
                    { paddingTop: insets.top, paddingBottom: insets.bottom + 20 }
                ]}
            >
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity>
                        <Text style={styles.editText}>Edit</Text>
                    </TouchableOpacity>
                </View>

                <Text style={styles.pageTitle}>LangTime</Text>

                {/* Action Buttons */}
                <View style={styles.actionButtonsContainer}>
                    <TouchableOpacity style={styles.actionButtonLeft}>
                        <Link color="#FFF" size={24} style={{ marginBottom: 8 }} />
                        <Text style={styles.actionButtonText}>Create Link</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.actionButtonRight}
                        onPress={() => onConnect('New Agent')}
                    >
                        <Video color="#FFF" size={24} fill="#FFF" style={{ marginBottom: 8 }} />
                        <Text style={styles.actionButtonText}>New Agent</Text>
                    </TouchableOpacity>
                </View>

                {/* Section Header */}
                <Text style={styles.sectionHeader}>TODAY</Text>

                {/* Call List Item */}
                <TouchableOpacity style={styles.callItem} onPress={() => onConnect('Ankur')}>
                    <View style={styles.avatarContainer}>
                        {/* Using a placeholder image or initials if no image */}
                        <View style={styles.avatarPlaceholder}>
                            <Text style={styles.avatarInitials}>A</Text>
                        </View>
                    </View>

                    <View style={styles.callDetails}>
                        <Text style={styles.callerName}>Ankur</Text>
                        <View style={styles.callTypeContainer}>
                            <Video size={12} color={THEME.colors.textSecondary} style={{ marginRight: 4 }} />
                            <Text style={styles.callSubtitle}>FaceTime Video</Text>
                        </View>
                    </View>

                    <View style={styles.callMeta}>
                        <Text style={styles.timeText}>1:52 PM</Text>
                        <TouchableOpacity style={styles.infoButton}>
                            <Info size={20} color={THEME.colors.accent} />
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>

                {/* Separator */}
                <View style={styles.separator} />

            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 20, // Sit on top of Viewfinder
    },
    contentContainer: {
        paddingHorizontal: THEME.spacing.md,
    },
    header: {
        marginBottom: 10,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: 44,
    },
    editText: {
        ...THEME.typography.body,
        color: THEME.colors.accent,
    },
    pageTitle: {
        ...THEME.typography.largeTitle,
        color: THEME.colors.textPrimary,
        marginBottom: 20,
    },
    actionButtonsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 30,
    },
    actionButtonLeft: {
        flex: 1,
        backgroundColor: THEME.colors.surfaceHighlight, // Slightly transparent
        borderRadius: THEME.borderRadius.md,
        padding: 16,
        height: 80,
        justifyContent: 'center',
    },
    actionButtonRight: {
        flex: 1,
        backgroundColor: THEME.colors.accent,
        borderRadius: THEME.borderRadius.md,
        padding: 16,
        height: 80,
        justifyContent: 'center',
    },
    actionButtonText: {
        ...THEME.typography.subheadline,
        fontWeight: '600',
        color: '#FFF',
    },
    sectionHeader: {
        ...THEME.typography.footnote,
        fontWeight: '600',
        color: THEME.colors.textSecondary,
        marginBottom: 8,
        marginLeft: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    callItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: THEME.colors.surfaceHighlight,
        borderRadius: THEME.borderRadius.md,
        padding: 12,
    },
    avatarContainer: {
        marginRight: 12,
    },
    avatarPlaceholder: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#9DA0A5',
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarInitials: {
        ...THEME.typography.headline,
        color: '#FFF',
    },
    callDetails: {
        flex: 1,
    },
    callerName: {
        ...THEME.typography.headline,
        color: THEME.colors.textPrimary,
        marginBottom: 2,
    },
    callSubtitle: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    callTypeContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    callMeta: {
        justifyContent: 'center',
        alignItems: 'flex-end',
    },
    timeText: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
        marginBottom: 4,
        marginRight: 36,
    },
    infoButton: {
        position: 'absolute',
        right: 0,
        padding: 4,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: '#38383A',
        marginLeft: 64,
        marginTop: 0,
    },
});
