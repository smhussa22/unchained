import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    TouchableOpacity,
    Dimensions,
    Platform,
    KeyboardAvoidingView,
    Modal,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Phone, ChevronDown, Check } from 'lucide-react-native';
import { THEME } from '../theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Available languages for the dropdown
const LANGUAGES = [
    { id: 'english', label: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
    { id: 'french', label: 'French', flag: '\u{1F1EB}\u{1F1F7}' },
    { id: 'spanish', label: 'Spanish', flag: '\u{1F1EA}\u{1F1F8}' },
    { id: 'arabic', label: 'Arabic', flag: '\u{1F1F8}\u{1F1E6}' },
    { id: 'japanese', label: 'Japanese', flag: '\u{1F1EF}\u{1F1F5}' },
];

interface AgentConfig {
    name: string;
    language: string;
}

interface NewAgentSheetProps {
    isVisible: boolean;
    onClose: () => void;
    onStartSession: (config: AgentConfig) => void;
}

// ============================================================================
// LANGUAGE DROPDOWN COMPONENT
// ============================================================================
interface LanguageDropdownProps {
    selectedLanguage: string;
    onSelect: (language: string) => void;
}

const LanguageDropdown: React.FC<LanguageDropdownProps> = ({
    selectedLanguage,
    onSelect,
}) => {
    const [isOpen, setIsOpen] = useState(false);

    const selectedItem = LANGUAGES.find(l => l.label === selectedLanguage);

    const handleSelect = (language: typeof LANGUAGES[0]) => {
        onSelect(language.label);
        setIsOpen(false);
    };

    const toggleDropdown = () => {
        setIsOpen(!isOpen);
    };

    return (
        <>
            {/* Dropdown Button */}
            <TouchableOpacity
                style={[
                    styles.dropdownButton,
                    isOpen && styles.dropdownButtonActive,
                ]}
                onPress={toggleDropdown}
                activeOpacity={0.7}
            >
                {selectedItem ? (
                    <View style={styles.selectedLanguage}>
                        <Text style={styles.languageFlag}>{selectedItem.flag}</Text>
                        <Text style={styles.languageLabel}>{selectedItem.label}</Text>
                    </View>
                ) : (
                    <Text style={styles.placeholderText}>Select a language</Text>
                )}
                <View style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}>
                    <ChevronDown
                        size={20}
                        color={THEME.colors.textSecondary}
                    />
                </View>
            </TouchableOpacity>

            {/* Dropdown Modal */}
            <Modal
                visible={isOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setIsOpen(false)}
            >
                <TouchableOpacity
                    style={styles.modalBackdrop}
                    activeOpacity={1}
                    onPress={() => setIsOpen(false)}
                >
                    <View style={styles.dropdownMenu}>
                        <BlurView
                            intensity={90}
                            tint="dark"
                            style={styles.dropdownMenuBlur}
                        >
                            {LANGUAGES.map((language, index) => (
                                <TouchableOpacity
                                    key={language.id}
                                    style={[
                                        styles.dropdownItem,
                                        index < LANGUAGES.length - 1 && styles.dropdownItemBorder,
                                        selectedLanguage === language.label && styles.dropdownItemSelected,
                                    ]}
                                    onPress={() => handleSelect(language)}
                                    activeOpacity={0.7}
                                >
                                    <Text style={styles.languageFlag}>{language.flag}</Text>
                                    <Text style={[
                                        styles.dropdownItemText,
                                        selectedLanguage === language.label && styles.dropdownItemTextSelected,
                                    ]}>
                                        {language.label}
                                    </Text>
                                    {selectedLanguage === language.label && (
                                        <Check size={18} color={THEME.colors.accent} />
                                    )}
                                </TouchableOpacity>
                            ))}
                        </BlurView>
                    </View>
                </TouchableOpacity>
            </Modal>
        </>
    );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export const NewAgentSheet: React.FC<NewAgentSheetProps> = ({
    isVisible,
    onClose,
    onStartSession,
}) => {
    const insets = useSafeAreaInsets();
    const [name, setName] = useState('');
    const [language, setLanguage] = useState('');

    // Sheet slide animation (functional navigation)
    const translateY = useSharedValue(SCREEN_HEIGHT);
    const backdropOpacity = useSharedValue(0);

    useEffect(() => {
        if (isVisible) {
            translateY.value = withSpring(0, {
                damping: 25,
                stiffness: 300,
                mass: 0.8,
            });
            backdropOpacity.value = withTiming(1, {
                duration: 200,
                easing: Easing.out(Easing.cubic),
            });
        } else {
            translateY.value = withTiming(SCREEN_HEIGHT, {
                duration: 300,
                easing: Easing.in(Easing.cubic),
            });
            backdropOpacity.value = withTiming(0, { duration: 200 });
        }
    }, [isVisible]);

    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: backdropOpacity.value,
    }));

    const handleStartSession = useCallback(() => {
        if (!name.trim() || !language) return;

        onStartSession({
            name: name.trim(),
            language: language,
        });

        // Reset inputs
        setName('');
        setLanguage('');
    }, [name, language, onStartSession]);

    const handleClose = useCallback(() => {
        onClose();
    }, [onClose]);

    const isFormValid = name.trim().length > 0 && language.length > 0;

    if (!isVisible) return null;

    return (
        <View style={styles.overlay}>
            {/* Backdrop */}
            <Animated.View style={[styles.backdrop, backdropStyle]}>
                <TouchableOpacity
                    style={StyleSheet.absoluteFill}
                    activeOpacity={1}
                    onPress={handleClose}
                />
            </Animated.View>

            {/* Sheet */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <Animated.View style={[styles.sheetContainer, sheetStyle]}>
                    <BlurView
                        intensity={THEME.blur.intensity}
                        tint={THEME.blur.tint}
                        style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}
                    >
                        {/* Handle */}
                        <View style={styles.handle} />

                        {/* Header */}
                        <View style={styles.header}>
                            <Text style={styles.title}>Create New Tutor</Text>
                            <TouchableOpacity
                                style={styles.closeButton}
                                onPress={handleClose}
                                activeOpacity={0.7}
                            >
                                <X size={20} color={THEME.colors.textSecondary} />
                            </TouchableOpacity>
                        </View>

                        {/* Input Fields */}
                        <View style={styles.inputsContainer}>
                            {/* Name Input */}
                            <View style={styles.inputWrapper}>
                                <Text style={styles.inputLabel}>Tutor Name</Text>
                                <View style={styles.textInputContainer}>
                                    <TextInput
                                        style={styles.textInput}
                                        placeholder="e.g., Sofia"
                                        placeholderTextColor="rgba(255, 255, 255, 0.35)"
                                        value={name}
                                        onChangeText={setName}
                                        autoCapitalize="words"
                                        autoCorrect={false}
                                    />
                                </View>
                            </View>

                            {/* Language Dropdown */}
                            <View style={styles.inputWrapper}>
                                <Text style={styles.inputLabel}>Language</Text>
                                <LanguageDropdown
                                    selectedLanguage={language}
                                    onSelect={setLanguage}
                                />
                            </View>
                        </View>

                        {/* Start Session Button */}
                        <TouchableOpacity
                            style={[
                                styles.startButton,
                                !isFormValid && styles.startButtonDisabled,
                            ]}
                            onPress={handleStartSession}
                            disabled={!isFormValid}
                            activeOpacity={0.7}
                        >
                            <Phone
                                size={18}
                                color="#FFF"
                                fill="#FFF"
                                style={{ marginRight: 8 }}
                            />
                            <Text style={styles.startButtonText}>Start Call</Text>
                        </TouchableOpacity>
                    </BlurView>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
};

const styles = StyleSheet.create({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 100,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    keyboardView: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheetContainer: {
        width: '100%',
    },
    sheet: {
        backgroundColor: 'rgba(28, 28, 30, 0.92)',
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        paddingHorizontal: THEME.spacing.lg,
        paddingTop: THEME.spacing.sm,
        overflow: 'hidden',
    },
    handle: {
        width: 36,
        height: 5,
        borderRadius: 2.5,
        backgroundColor: 'rgba(255, 255, 255, 0.3)',
        alignSelf: 'center',
        marginBottom: THEME.spacing.md,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: THEME.spacing.lg,
    },
    title: {
        ...THEME.typography.title2,
        color: THEME.colors.textPrimary,
    },
    closeButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputsContainer: {
        gap: THEME.spacing.md,
        marginBottom: THEME.spacing.xl,
    },
    inputWrapper: {
        gap: THEME.spacing.xs,
    },
    inputLabel: {
        ...THEME.typography.caption1,
        color: THEME.colors.textSecondary,
        marginLeft: THEME.spacing.sm,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    textInputContainer: {
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        borderRadius: THEME.borderRadius.md,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    textInput: {
        paddingHorizontal: THEME.spacing.md,
        paddingVertical: Platform.OS === 'ios' ? 16 : 12,
        ...THEME.typography.body,
        color: THEME.colors.textPrimary,
    },
    startButton: {
        backgroundColor: THEME.colors.accent,
        borderRadius: THEME.borderRadius.lg,
        paddingVertical: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    startButtonDisabled: {
        backgroundColor: 'rgba(52, 199, 89, 0.3)',
    },
    startButtonText: {
        ...THEME.typography.headline,
        color: '#FFF',
    },
    // Dropdown Styles
    dropdownButton: {
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        borderRadius: THEME.borderRadius.md,
        paddingHorizontal: THEME.spacing.md,
        paddingVertical: Platform.OS === 'ios' ? 16 : 12,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    dropdownButtonActive: {
        borderColor: THEME.colors.accent,
    },
    selectedLanguage: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    languageFlag: {
        fontSize: 20,
    },
    languageLabel: {
        ...THEME.typography.body,
        color: THEME.colors.textPrimary,
    },
    placeholderText: {
        ...THEME.typography.body,
        color: 'rgba(255, 255, 255, 0.35)',
    },
    modalBackdrop: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    dropdownMenu: {
        width: '80%',
        maxWidth: 320,
        borderRadius: THEME.borderRadius.lg,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 24,
        elevation: 20,
    },
    dropdownMenuBlur: {
        backgroundColor: 'rgba(40, 40, 40, 0.95)',
        overflow: 'hidden',
    },
    dropdownItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 20,
        gap: 12,
    },
    dropdownItemBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255, 255, 255, 0.1)',
    },
    dropdownItemSelected: {
        backgroundColor: 'rgba(52, 199, 89, 0.15)',
    },
    dropdownItemText: {
        ...THEME.typography.body,
        color: THEME.colors.textPrimary,
        flex: 1,
    },
    dropdownItemTextSelected: {
        color: THEME.colors.accent,
        fontWeight: '600',
    },
});
