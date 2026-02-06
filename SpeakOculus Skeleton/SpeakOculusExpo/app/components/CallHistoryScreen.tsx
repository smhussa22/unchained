import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Link, Video, Info, MinusCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withDelay,
    interpolate,
    Easing,
    runOnJS,
    FadeIn,
    FadeOut,
    FadeInUp,
    FadeInDown,
    SlideInLeft,
    SlideInUp,
    Layout,
} from 'react-native-reanimated';
import { THEME } from '../theme';
import { NewAgentSheet } from './NewAgentSheet';

// ============================================================================
// TYPES
// ============================================================================
export interface AgentConfig {
    name: string;
    language: string;
    systemPrompt: string;
}

export interface CallHistoryItem {
    id: string;
    agentConfig: AgentConfig;
    timestamp: Date;
    duration?: number; // in seconds
}

interface CallHistoryScreenProps {
    onConnect: (config: AgentConfig) => void;
    onViewGapWords: (agent: AgentConfig) => void;
    onDeleteItem: (itemId: string) => void;
    history?: CallHistoryItem[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
};

const formatDuration = (seconds?: number): string => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const getInitials = (name: string): string => {
    return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('');
};

const groupHistoryByDate = (history: CallHistoryItem[]): Map<string, CallHistoryItem[]> => {
    const grouped = new Map<string, CallHistoryItem[]>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    history.forEach(item => {
        const itemDate = new Date(item.timestamp);
        itemDate.setHours(0, 0, 0, 0);

        let key: string;
        if (itemDate.getTime() === today.getTime()) {
            key = 'TODAY';
        } else if (itemDate.getTime() === yesterday.getTime()) {
            key = 'YESTERDAY';
        } else {
            key = itemDate.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
            }).toUpperCase();
        }

        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key)!.push(item);
    });

    return grouped;
};

// ============================================================================
// GENERATE SYSTEM PROMPT
// ============================================================================
export const generateSystemPrompt = (name: string, language: string): string => {
    return `You are ${name}, a helpful ${language} tutor. Speak in ${language} and correct my mistakes gently. Be encouraging, patient, and adapt to my skill level. Start conversations naturally and help me practice real-world scenarios.`;
};

// ============================================================================
// ANIMATED CALL ROW COMPONENT
// ============================================================================
interface AnimatedCallRowProps {
    item: CallHistoryItem;
    index: number;
    globalIndex: number;  // For staggered entrance delay
    isEditMode: boolean;
    onRedial: (item: CallHistoryItem) => void;
    onDelete: (id: string) => void;
    onViewGapWords: (agent: AgentConfig) => void;
    isLast: boolean;
}

// Spring config optimized for Android (snappier, less bounce)
const SPRING_CONFIG = {
    damping: 18,
    stiffness: 180,
    mass: 0.8,
};

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

const AnimatedCallRow: React.FC<AnimatedCallRowProps> = ({
    item,
    index,
    globalIndex,
    isEditMode,
    onRedial,
    onDelete,
    onViewGapWords,
    isLast,
}) => {
    // Animated values
    const editModeProgress = useSharedValue(isEditMode ? 1 : 0);
    const rowScale = useSharedValue(1);
    const isDeleting = useSharedValue(false);
    const deleteProgress = useSharedValue(1);

    // Info button animation
    const infoButtonScale = useSharedValue(1);
    const infoButtonBgOpacity = useSharedValue(0);

    // Animate when edit mode changes
    useEffect(() => {
        editModeProgress.value = withSpring(isEditMode ? 1 : 0, SPRING_CONFIG);
    }, [isEditMode]);

    // Row content shifts right when delete button appears
    const rowContentStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { translateX: interpolate(editModeProgress.value, [0, 1], [0, 34]) },
            ],
        };
    });

    // Delete button slides in from left
    const deleteButtonStyle = useAnimatedStyle(() => {
        return {
            opacity: editModeProgress.value,
            transform: [
                { translateX: interpolate(editModeProgress.value, [0, 1], [-34, 0]) },
                { scale: interpolate(editModeProgress.value, [0, 0.5, 1], [0.5, 1.1, 1]) },
            ],
        };
    });

    // Row press animation
    const rowPressStyle = useAnimatedStyle(() => {
        return {
            transform: [{ scale: rowScale.value }],
        };
    });

    // Delete animation (shrink + fade)
    const deleteAnimStyle = useAnimatedStyle(() => {
        return {
            opacity: deleteProgress.value,
            transform: [
                { scaleY: deleteProgress.value },
            ],
            height: interpolate(deleteProgress.value, [0, 1], [0, 68]),
            overflow: 'hidden' as const,
        };
    });

    const handlePressIn = () => {
        if (!isEditMode) {
            rowScale.value = withSpring(0.97, { damping: 15, stiffness: 300 });
        }
    };

    const handlePressOut = () => {
        rowScale.value = withSpring(1, { damping: 15, stiffness: 300 });
    };

    // Info button animated style
    const infoButtonStyle = useAnimatedStyle(() => ({
        transform: [{ scale: infoButtonScale.value }],
        backgroundColor: `rgba(52, 199, 89, ${infoButtonBgOpacity.value})`,
    }));

    const handleInfoPressIn = () => {
        infoButtonScale.value = withSpring(0.85, { damping: 12, stiffness: 400 });
        infoButtonBgOpacity.value = withTiming(0.3, { duration: 100 });
    };

    const handleInfoPressOut = () => {
        infoButtonScale.value = withSpring(1.1, { damping: 10, stiffness: 350 });
        infoButtonBgOpacity.value = withTiming(0, { duration: 200 });
        // Settle back to 1
        setTimeout(() => {
            infoButtonScale.value = withSpring(1, { damping: 15, stiffness: 300 });
        }, 50);
    };

    const handleDelete = () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        isDeleting.value = true;
        deleteProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.out(Easing.cubic),
        }, (finished) => {
            if (finished) {
                runOnJS(onDelete)(item.id);
            }
        });
    };
    // Staggered entrance delay (30ms per row, max 300ms)
    const entranceDelay = Math.min(globalIndex * 30, 300);

    return (
        <Animated.View
            style={deleteAnimStyle}
            layout={Layout.springify().damping(18).stiffness(180)}
            entering={FadeInUp.delay(entranceDelay).duration(300).springify().damping(15)}
        >
            <AnimatedTouchable
                style={[styles.callItem, rowPressStyle]}
                onPress={() => !isEditMode && onRedial(item)}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                activeOpacity={1}
            >
                {/* Delete button - always rendered but animated */}
                <Animated.View style={[styles.deleteButtonContainer, deleteButtonStyle]}>
                    <TouchableOpacity
                        style={styles.deleteButton}
                        onPress={handleDelete}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <MinusCircle size={22} color="#FFF" fill={THEME.colors.destructive} />
                    </TouchableOpacity>
                </Animated.View>

                {/* Row content - shifts right in edit mode */}
                <Animated.View style={[styles.rowContent, rowContentStyle]}>
                    <View style={styles.avatarContainer}>
                        <View style={[
                            styles.avatarPlaceholder,
                            { backgroundColor: getAvatarColor(item.agentConfig.language) }
                        ]}>
                            <Text style={styles.avatarInitials}>
                                {getInitials(item.agentConfig.name)}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.callDetails}>
                        <Text style={styles.callerName}>{item.agentConfig.name}</Text>
                        <View style={styles.callTypeContainer}>
                            <Video size={12} color={THEME.colors.textSecondary} style={{ marginRight: 4 }} />
                            <Text style={styles.callSubtitle}>
                                {item.agentConfig.language} Tutor
                            </Text>
                        </View>
                    </View>

                    <View style={styles.callMeta}>
                        <Text style={styles.timeText}>{formatTime(item.timestamp)}</Text>
                        <Animated.View style={[styles.infoButton, infoButtonStyle]}>
                            <TouchableOpacity
                                onPress={(e) => {
                                    e.stopPropagation();
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    onViewGapWords(item.agentConfig);
                                }}
                                onPressIn={handleInfoPressIn}
                                onPressOut={handleInfoPressOut}
                                activeOpacity={1}
                                style={styles.infoButtonInner}
                            >
                                <Info size={18} color={THEME.colors.textSecondary} />
                            </TouchableOpacity>
                        </Animated.View>
                    </View>
                </Animated.View>
            </AnimatedTouchable>

            {/* Separator */}
            {!isLast && <View style={styles.separator} />}
        </Animated.View>
    );
};

// ============================================================================
// COMPONENT
// ============================================================================
export const CallHistoryScreen: React.FC<CallHistoryScreenProps> = ({
    onConnect,
    onViewGapWords,
    onDeleteItem,
    history = [],
}) => {
    const insets = useSafeAreaInsets();
    const [isNewAgentSheetVisible, setIsNewAgentSheetVisible] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);

    // Animated button scales
    const editButtonScale = useSharedValue(1);
    const createLinkScale = useSharedValue(1);
    const newAgentScale = useSharedValue(1);

    // Animated styles for buttons
    const editButtonStyle = useAnimatedStyle(() => ({
        transform: [{ scale: editButtonScale.value }],
    }));
    const createLinkStyle = useAnimatedStyle(() => ({
        transform: [{ scale: createLinkScale.value }],
    }));
    const newAgentStyle = useAnimatedStyle(() => ({
        transform: [{ scale: newAgentScale.value }],
    }));

    // Handle creating a new agent and starting a session
    const handleStartSession = useCallback((config: { name: string; language: string }) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

        const agentConfig: AgentConfig = {
            name: config.name,
            language: config.language,
            systemPrompt: generateSystemPrompt(config.name, config.language),
        };

        setIsNewAgentSheetVisible(false);
        onConnect(agentConfig);
    }, [onConnect]);

    // Handle redialing a previous agent
    const handleRedial = useCallback((item: CallHistoryItem) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onConnect(item.agentConfig);
    }, [onConnect]);

    // Handle viewing gap words for an agent
    const handleViewGapWords = useCallback((agent: AgentConfig) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onViewGapWords(agent);
    }, [onViewGapWords]);

    // Open new agent sheet
    const handleNewAgentPress = useCallback(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setIsNewAgentSheetVisible(true);
    }, []);

    // Toggle edit mode
    const handleToggleEditMode = useCallback(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setIsEditMode(prev => !prev);
    }, []);

    // Button press handlers
    const handleEditPressIn = useCallback(() => {
        editButtonScale.value = withSpring(0.92, { damping: 15, stiffness: 350 });
    }, []);
    const handleEditPressOut = useCallback(() => {
        editButtonScale.value = withSpring(1, { damping: 15, stiffness: 350 });
    }, []);

    const handleCreateLinkPressIn = useCallback(() => {
        createLinkScale.value = withSpring(0.94, { damping: 15, stiffness: 350 });
    }, []);
    const handleCreateLinkPressOut = useCallback(() => {
        createLinkScale.value = withSpring(1, { damping: 15, stiffness: 350 });
    }, []);

    const handleNewAgentPressIn = useCallback(() => {
        newAgentScale.value = withSpring(0.94, { damping: 15, stiffness: 350 });
    }, []);
    const handleNewAgentPressOut = useCallback(() => {
        newAgentScale.value = withSpring(1, { damping: 15, stiffness: 350 });
    }, []);

    // Delete a call history item
    const handleDelete = useCallback((itemId: string) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        onDeleteItem(itemId);
    }, [onDeleteItem]);

    // Group history items by date
    const groupedHistory = groupHistoryByDate(history);

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
                showsVerticalScrollIndicator={false}
            >
                {/* Header */}
                <Animated.View
                    style={styles.header}
                    entering={FadeInDown.duration(300).springify()}
                >
                    <Animated.View style={editButtonStyle}>
                        <TouchableOpacity
                            onPress={handleToggleEditMode}
                            onPressIn={handleEditPressIn}
                            onPressOut={handleEditPressOut}
                            activeOpacity={1}
                        >
                            <Animated.Text
                                style={[styles.editText, isEditMode && styles.editTextActive]}
                                entering={FadeIn.duration(150)}
                                key={isEditMode ? 'done' : 'edit'}
                            >
                                {isEditMode ? 'Done' : 'Edit'}
                            </Animated.Text>
                        </TouchableOpacity>
                    </Animated.View>
                </Animated.View>

                {/* Title */}
                <Animated.Text
                    style={styles.pageTitle}
                    entering={FadeInDown.delay(50).duration(350).springify()}
                >
                    LangTime
                </Animated.Text>

                {/* Action Buttons */}
                <Animated.View
                    style={styles.actionButtonsContainer}
                    entering={FadeInUp.delay(100).duration(400).springify()}
                >
                    <Animated.View style={createLinkStyle}>
                        <TouchableOpacity
                            style={styles.actionButtonLeft}
                            onPressIn={handleCreateLinkPressIn}
                            onPressOut={handleCreateLinkPressOut}
                            activeOpacity={1}
                        >
                            <Link color="#FFF" size={24} style={{ marginBottom: 8 }} />
                            <Text style={styles.actionButtonText}>Create Link</Text>
                        </TouchableOpacity>
                    </Animated.View>

                    <Animated.View style={newAgentStyle}>
                        <TouchableOpacity
                            style={styles.actionButtonRight}
                            onPress={handleNewAgentPress}
                            onPressIn={handleNewAgentPressIn}
                            onPressOut={handleNewAgentPressOut}
                            activeOpacity={1}
                        >
                            <Video color="#FFF" size={24} fill="#FFF" style={{ marginBottom: 8 }} />
                            <Text style={styles.actionButtonText}>New Agent</Text>
                        </TouchableOpacity>
                    </Animated.View>
                </Animated.View>

                {/* Call History List */}
                {(() => {
                    let globalIndex = 0;
                    return Array.from(groupedHistory.entries()).map(([dateKey, items], groupIndex) => (
                        <Animated.View
                            key={dateKey}
                            entering={FadeInUp.delay(groupIndex * 50).duration(250)}
                        >
                            {/* Section Header */}
                            <Animated.Text
                                style={styles.sectionHeader}
                                entering={FadeIn.delay(groupIndex * 50 + 100).duration(200)}
                            >
                                {dateKey}
                            </Animated.Text>

                            {/* History Items */}
                            {items.map((item, index) => {
                                const currentGlobalIndex = globalIndex++;
                                return (
                                    <AnimatedCallRow
                                        key={item.id}
                                        item={item}
                                        index={index}
                                        globalIndex={currentGlobalIndex}
                                        isEditMode={isEditMode}
                                        onRedial={handleRedial}
                                        onDelete={handleDelete}
                                        onViewGapWords={handleViewGapWords}
                                        isLast={index === items.length - 1}
                                    />
                                );
                            })}

                            {/* Bottom separator after group */}
                            <View style={styles.groupSeparator} />
                        </Animated.View>
                    ));
                })()}

                {/* Empty State */}
                {history.length === 0 && (
                    <Animated.View
                        style={styles.emptyState}
                        entering={FadeInUp.delay(200).duration(500).springify()}
                    >
                        <Video size={48} color={THEME.colors.textSecondary} style={{ marginBottom: 16 }} />
                        <Text style={styles.emptyStateTitle}>No Recent Sessions</Text>
                        <Text style={styles.emptyStateSubtitle}>
                            Tap "New Agent" to create your first language tutor
                        </Text>
                    </Animated.View>
                )}
            </ScrollView >

            {/* New Agent Sheet */}
            < NewAgentSheet
                isVisible={isNewAgentSheetVisible}
                onClose={() => setIsNewAgentSheetVisible(false)}
                onStartSession={handleStartSession}
            />
        </View >
    );
};

// ============================================================================
// AVATAR COLOR HELPER
// ============================================================================
const getAvatarColor = (language: string): string => {
    const colors: Record<string, string> = {
        spanish: '#FF6B6B',
        french: '#4ECDC4',
        german: '#FFE66D',
        italian: '#95E1D3',
        portuguese: '#FF9F43',
        japanese: '#EE6B9E',
        chinese: '#C44569',
        korean: '#6C5CE7',
        russian: '#00B894',
        arabic: '#FDCB6E',
    };
    return colors[language.toLowerCase()] || '#9DA0A5';
};

// ============================================================================
// STYLES
// ============================================================================
const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 20,
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
    editTextActive: {
        fontWeight: '600',
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
        backgroundColor: THEME.colors.surfaceHighlight,
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    timeText: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    infoButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(142, 142, 147, 0.15)',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    infoButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    deleteButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    deleteButtonContainer: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        zIndex: 1,
    },
    rowContent: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: '#38383A',
        marginLeft: 64,
        marginVertical: 4,
    },
    groupSeparator: {
        height: 20,
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
        paddingHorizontal: 40,
    },
    emptyStateTitle: {
        ...THEME.typography.title3,
        color: THEME.colors.textPrimary,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyStateSubtitle: {
        ...THEME.typography.body,
        color: THEME.colors.textSecondary,
        textAlign: 'center',
    },
});
