Here is the **Comprehensive `claude.md` System Bible**.

It aggregates every specific detail from your **Frontend Summary** (FaceTime UI, Square Orb, Glassmorphism) and your **Backend Summary** (AWS EC2, PM2, PCM16 Relay) into a single source of truth.

---

# claude.md

## 1. Project Overview & Architecture

**Objective:** Build "Speak Vision," a high-fidelity real-time Voice AI client that mimics a FaceTime call with an AI agent.
**Current Phase:** **Phase 1.5 - The "Blind" Merge**. We are integrating the polished "FaceTime" UI with the deployed AWS Audio Backend. *Vision features are temporarily disabled.*

### System Topology

```mermaid
graph LR
    A[React Native App] -- WebSocket (PCM16 / 24kHz) --> B[AWS EC2 Relay]
    B -- WebSocket (JSON / Audio Delta) --> C[OpenAI Realtime API]
    
    subgraph Client [Frontend / App.tsx]
        D[Microphone (AudioRecord)] --> E[RMS Calc] --> F[ActiveOrb (UI)]
        C1[AudioContext] <--> G[Speaker]
    end
    
    subgraph Server [Backend / server.ts]
        H[Port 8082]
        I[PM2 Process]
    end

```

---

## 2. Frontend Specifications (The "FaceTime" UI)

### Core Stack

* **Framework:** React Native (Expo SDK 50+).
* **Animation:** `react-native-reanimated` (SharedValues drive all motion).
* **Audio:** `react-native-audio-record` (Input), `expo-av` (Output).
* **Visuals:** `expo-blur` (Glassmorphism), `lucide-react-native` (Icons).

### Visual Language

* **Theme:** "Dark Mode FaceTime"
* **Background:** `#000000` (Pure Black).
* **Accent:** `#34C759` (FaceTime Green).
* **Surface:** `rgba(30, 30, 30, 0.90)` with High Blur (Glass).


* **Typography:** System Sans-Serif (Clean, legible).

### Component Dictionary

| Component | Visual Description | Behavior / State Mapping |
| --- | --- | --- |
| **ActiveOrb** | **Large Square Viewfinder (280px, Radius 40px)**. <br>

<br>Replaces the old circle orb. | **Idle:** Transparent/Breathing Grey.<br>

<br>**Listening:** Solid Green Frame (`#34C759`).<br>

<br>**Speaking:** Pulsing Green + **Square Ripples** (Driven by RMS).<br>

<br>**Processing:** Pulsing White. |
| **Viewfinder** | Full-screen `CameraView` layer. | Sits at `zIndex: -1`. Provides AR immersion. |
| **ControlSheet** | Floating Glassmorphism Pill (Bottom). | **Mic:** Toggles input stream.<br>

<br>**Flip:** Toggles Front/Back Camera.<br>

<br>**End Call:** Destructive (Red). Closes Socket. |
| **CallHistory** | "Home Screen" List. | Slides down when connection starts (Transition Animation). |

### Audio Pipeline (Client-Side)

1. **Input:** `react-native-audio-record` captures PCM16 at **24,000 Hz**.
2. **VAD (Client):** "Dirty" RMS check. If volume > threshold while AI is speaking -> **Optimistic Interrupt** (Clear Queue).
3. **Visualization:** Raw PCM bytes -> Calculate RMS (0-1) -> Update `ActiveOrb` SharedValue.

---

## 3. Backend Specifications (The Relay)

### Infrastructure

* **Host:** AWS EC2 (us-east-1).
* **Endpoint:** `ws://98.92.191.197:8082` (Plain TCP / Cleartext).
* **Process Manager:** `PM2` (Service name: `speak-relay`).
* **Directory:** `~/speak-relay/`.

### Relay Logic (`server.ts`)

* **Role:** 1:1 Stateful Proxy. No database.
* **Upstream:** Connects to `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15`.
* **Auth:** `Authorization: Bearer <OPENAI_API_KEY>` (Loaded from `.env`).
* **Audio Handling:**
* **Format:** PCM16, 24kHz, Mono.
* **Passthrough:** No transcoding. Relay blindly forwards Base64 chunks.
* **Events:** Listens for `input_audio_buffer.speech_started` from OpenAI and broadcasts to client immediately.



### Deployment Quirks

* **`.env` Location:** Must exist in `dist/` after build or be resolved from root.
* **Traffic:** Inbound Port 8082 must be open (Security Group).

---

## 4. Integration Logic (The "Glue")

### The Handshake Protocol

1. **App:** User taps "Call" -> Slides UI -> Opens WebSocket to `98.92.191.197:8082`.
2. **App:** `socket.onopen` -> UI Status Pill turns **Yellow**.
3. **Relay:** Connects to OpenAI -> Sends `session.update`.
4. **App:** Receives `session.created` -> UI Status Pill turns **Green**.

### The "Pulse" (Audio-Visual Sync)

To make the "Square Ripples" work, the `App.tsx` must perform this loop every ~40ms:

```typescript
AudioRecord.on('data', (base64) => {
  // 1. Send to AWS
  socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
  
  // 2. Drive Animation
  const volume = calculateRMS(base64); // Helper function
  orbSharedValue.value = withTiming(volume, { duration: 50 });
});

```

### The "Barge-In" (Latency Optimization)

* **Trigger:** OpenAI sends `input_audio_buffer.speech_started`.
* **Action:** App **immediately** calls `AudioContext.stop()` and clears the buffer.
* **Visual:** `ActiveOrb` switches from **Speaking** (Ripples) to **Listening** (Solid Frame).

---

## 5. Critical Constraints

1. **Android Cleartext:** `app.json` MUST include `usesCleartextTraffic: true` or the AWS connection will fail silently.
2. **No Vision Yet:** The "Processing" state and `vision.capture` events are **disabled** for this phase. Focus strictly on Audio Latency.
3. **TSConfig:** Server must NOT extend `expo/tsconfig.base` to avoid module resolution errors.

---

## 6. Local Testing (Relay on Your Machine)

To test the app against the relay running locally:

1. **Start the relay** (from repo root):
   ```bash
   cd server
   cp .env.example .env   # if needed; add OPENAI_API_KEY
   npm run dev
   ```
   Server listens on `0.0.0.0:8082`.

2. **Point the app at the local relay** in `app/App.tsx`:
   * Set `USE_LOCAL_RELAY = true`.
   * **Physical Android (USB):** Set `USE_ADB_REVERSE = true`, then run once with device connected: `adb reverse tcp:8082 tcp:8082`. App connects to `127.0.0.1:8082` on device (forwards to host).
   * **Android Emulator:** Set `USE_ADB_REVERSE = false`; app uses `10.0.2.2:8082` when `LOCAL_RELAY_IP` is `'localhost'`.
   * **iOS Simulator or physical device:** Set `LOCAL_RELAY_IP` to your computer’s LAN IP (e.g. `'192.168.1.100'`). Find it with `ipconfig getifaddr en0` (Mac) or `ifconfig` / network settings.

3. **Run the app** (Expo dev build): `npx expo run:ios` or `npx expo run:android`.

4. **Switch back to production:** Set `USE_LOCAL_RELAY = false` so the app uses the EC2 relay URL.

---