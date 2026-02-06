import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { ChevronLeft, BookOpen } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    FadeIn,
    FadeInUp,
    FadeInDown,
    SlideInRight,
    SlideOutRight,
    ZoomIn,
    Layout,
    Easing,
} from 'react-native-reanimated';
import { THEME } from '../theme';
import { AgentConfig } from './CallHistoryScreen';
import { GapWord, getGapWordsForAgent } from '../storage';

// ============================================================================
// TYPES
// ============================================================================
interface GapWordsScreenProps {
    agent: AgentConfig;
    onBack: () => void;
}

// ============================================================================
// HELPERS
// ============================================================================
const getInitials = (name: string): string => {
    return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('');
};

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

const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
};

// ============================================================================
// ANIMATED WORD ITEM COMPONENT
// ============================================================================
interface AnimatedWordItemProps {
    word: GapWord;
    index: number;
    isLast: boolean;
}

const AnimatedWordItem: React.FC<AnimatedWordItemProps> = ({ word, index, isLast }) => {
    const scale = useSharedValue(1);
    const bgOpacity = useSharedValue(0);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        backgroundColor: `rgba(52, 199, 89, ${bgOpacity.value})`,
    }));

    const handlePressIn = useCallback(() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 350 });
        bgOpacity.value = withTiming(0.08, { duration: 100 });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handlePressOut = useCallback(() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 350 });
        bgOpacity.value = withTiming(0, { duration: 150 });
    }, []);

    return (
        <Animated.View
            entering={FadeInUp.delay(300 + index * 40).duration(250).springify()}
            layout={Layout.springify()}
        >
            <Animated.View style={[styles.wordItem, animatedStyle]}>
                <TouchableOpacity
                    onPressIn={handlePressIn}
                    onPressOut={handlePressOut}
                    activeOpacity={1}
                    style={styles.wordItemTouchable}
                >
                    <View style={styles.wordContent}>
                        <Text style={styles.targetWord}>{word.target_word}</Text>
                        <Text style={styles.nativeWord}>{word.native_word}</Text>
                    </View>
                    <Text style={styles.wordTimestamp}>{formatDate(word.timestamp)}</Text>
                </TouchableOpacity>
            </Animated.View>
            {!isLast && <View style={styles.separator} />}
        </Animated.View>
    );
};

// ============================================================================
// COMPONENT
// ============================================================================
export const GapWordsScreen: React.FC<GapWordsScreenProps> = ({
    agent,
    onBack,
}) => {
    const insets = useSafeAreaInsets();
    const [gapWords, setGapWords] = useState<GapWord[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadWords = async () => {
            const words = await getGapWordsForAgent(agent.name);
            // Sort by most recent first
            words.sort((a, b) => b.timestamp - a.timestamp);
            setGapWords(words);
            setLoading(false);
        };
        loadWords();
    }, [agent.name]);

    // Back button press animation
    const backButtonScale = useSharedValue(1);

    const backButtonStyle = useAnimatedStyle(() => ({
        transform: [{ scale: backButtonScale.value }],
    }));

    const handleBackPressIn = useCallback(() => {
        backButtonScale.value = withSpring(0.92, { damping: 15, stiffness: 300 });
    }, []);

    const handleBackPressOut = useCallback(() => {
        backButtonScale.value = withSpring(1, { damping: 15, stiffness: 300 });
    }, []);

    const handleBack = useCallback(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onBack();
    }, [onBack]);

    return (
        <Animated.View
            style={styles.container}
            entering={SlideInRight.duration(300).springify().damping(18)}
            exiting={SlideOutRight.duration(250)}
        >
            {/* Background */}
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
                {/* Header with Back Button */}
                <Animated.View
                    style={styles.header}
                    entering={FadeInDown.delay(100).duration(250).springify()}
                >
                    <Animated.View style={backButtonStyle}>
                        <TouchableOpacity
                            style={styles.backButton}
                            onPress={handleBack}
                            onPressIn={handleBackPressIn}
                            onPressOut={handleBackPressOut}
                            activeOpacity={1}
                        >
                            <ChevronLeft size={28} color={THEME.colors.accent} />
                            <Text style={styles.backText}>Back</Text>
                        </TouchableOpacity>
                    </Animated.View>
                </Animated.View>

                {/* Agent Card - Zoom In Animation */}
                <Animated.View
                    style={styles.agentCard}
                    entering={ZoomIn.delay(150).duration(350).springify().damping(14)}
                >
                    <View style={[styles.avatar, { backgroundColor: getAvatarColor(agent.language) }]}>
                        <Text style={styles.avatarText}>{getInitials(agent.name)}</Text>
                    </View>
                    <Text style={styles.agentName}>{agent.name}</Text>
                    <Text style={styles.agentLanguage}>{agent.language} Tutor</Text>
                </Animated.View>

                {/* Section Title */}
                <Animated.Text
                    style={styles.sectionTitle}
                    entering={FadeIn.delay(250).duration(200)}
                >
                    Missed Words
                </Animated.Text>

                {/* Gap Words List */}
                {loading ? (
                    <Animated.View
                        style={styles.emptyState}
                        entering={FadeIn.duration(200)}
                    >
                        <Text style={styles.emptyStateText}>Loading...</Text>
                    </Animated.View>
                ) : gapWords.length === 0 ? (
                    <Animated.View
                        style={styles.emptyState}
                        entering={FadeInUp.delay(300).duration(400).springify()}
                    >
                        <BookOpen size={48} color={THEME.colors.textSecondary} style={{ marginBottom: 16 }} />
                        <Text style={styles.emptyStateTitle}>No Missed Words Yet</Text>
                        <Text style={styles.emptyStateText}>
                            Words you miss during conversations with {agent.name} will appear here.
                        </Text>
                    </Animated.View>
                ) : (
                    <Animated.View
                        style={styles.wordList}
                        entering={FadeInUp.delay(200).duration(300)}
                    >
                        {gapWords.map((word, index) => (
                            <AnimatedWordItem
                                key={`${word.native_word}-${word.timestamp}`}
                                word={word}
                                index={index}
                                isLast={index === gapWords.length - 1}
                            />
                        ))}
                    </Animated.View>
                )}
            </ScrollView>
        </Animated.View>
    );
};

// ============================================================================
// STYLES
// ============================================================================
const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 25,
    },
    contentContainer: {
        paddingHorizontal: THEME.spacing.md,
    },
    header: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 20,
    },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: -8,
    },
    backText: {
        ...THEME.typography.body,
        color: THEME.colors.accent,
    },
    agentCard: {
        alignItems: 'center',
        marginBottom: 32,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
    },
    avatarText: {
        ...THEME.typography.largeTitle,
        color: '#FFF',
        fontSize: 28,
    },
    agentName: {
        ...THEME.typography.title2,
        color: THEME.colors.textPrimary,
        marginBottom: 4,
    },
    agentLanguage: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    sectionTitle: {
        ...THEME.typography.title3,
        color: THEME.colors.textPrimary,
        marginBottom: 16,
    },
    wordList: {
        backgroundColor: THEME.colors.surfaceHighlight,
        borderRadius: THEME.borderRadius.md,
        overflow: 'hidden',
    },
    wordItem: {
        borderRadius: THEME.borderRadius.sm,
        overflow: 'hidden',
    },
    wordItemTouchable: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
    },
    wordContent: {
        flex: 1,
    },
    targetWord: {
        ...THEME.typography.headline,
        color: THEME.colors.textPrimary,
        marginBottom: 2,
    },
    nativeWord: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    wordTimestamp: {
        ...THEME.typography.caption1,
        color: THEME.colors.textSecondary,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: '#38383A',
        marginLeft: 16,
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
    emptyStateText: {
        ...THEME.typography.body,
        color: THEME.colors.textSecondary,
        textAlign: 'center',
    },
});
