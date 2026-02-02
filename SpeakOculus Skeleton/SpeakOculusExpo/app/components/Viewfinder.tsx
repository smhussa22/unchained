import React, { useEffect } from 'react';
import { View, StyleSheet, Dimensions, Text, Platform, TouchableOpacity } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

const { width, height } = Dimensions.get('window');

interface ViewfinderProps {
    isCameraOn: boolean;
}

export const Viewfinder = ({ isCameraOn }: ViewfinderProps) => {
    const [permission, requestPermission] = useCameraPermissions();

    useEffect(() => {
        if (permission) {
            console.log('[Viewfinder] Camera Permission:', permission.status, permission.granted);
        }
    }, [permission]);

    const handleRequestPermission = async () => {
        console.log('[Viewfinder] Requesting permission...');
        const result = await requestPermission();
        console.log('[Viewfinder] Request result:', result);
    };

    if (!permission) {
        // Permission loading
        return <View style={styles.container} />;
    }

    // On Web, we bypass this check and let the CameraView try to load,
    // which often triggers the permission prompt better than the hook logic.
    if (Platform.OS !== 'web' && !permission.granted) {
        return (
            <View style={[styles.container, styles.cameraOff]}>
                <TouchableOpacity onPress={handleRequestPermission} style={styles.permissionButton}>
                    <Text style={styles.permissionText}>Tap to enable camera</Text>
                    <Text style={styles.permissionSubText}>Permissions are required for the viewfinder</Text>
                </TouchableOpacity>
            </View>
        );
    }

    if (!isCameraOn) {
        return (
            <View style={[styles.container, styles.cameraOff]}>
                <View style={styles.placeholder} />
                <Text style={styles.statusText}>Camera Off</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <CameraView
                style={styles.camera}
                facing="front"
                mute={true} // Prevent audio feedback loops if mic is active
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#000',
        zIndex: -1,
    },
    camera: {
        width: width,
        height: height,
    },
    cameraOff: {
        backgroundColor: '#1C1C1E',
        alignItems: 'center',
        justifyContent: 'center',
    },
    permissionButton: {
        padding: 20,
        alignItems: 'center',
    },
    permissionText: {
        color: '#34C759',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
    },
    permissionSubText: {
        color: '#888',
        fontSize: 14,
    },
    statusText: {
        color: '#666',
        marginTop: 20,
    },
    placeholder: {
        // Empty
    }
});
