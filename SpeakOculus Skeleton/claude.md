
---

# claude.md

## Project Context: Speak Vision (Phase 1)

**Objective:** Build a "Trojan Horse" prototype for Speak.com to demonstrate a high-fidelity, low-latency Voice AI experience.
**Current Phase:** **Phase 1 - The Infrastructure Skeleton & Audio Bridge**.
**Goal:** Establish a bi-directional, real-time audio stream between a React Native mobile app and the OpenAI Realtime API via a secure Node.js Relay Server.

## Architectural Constraints (Strict)

1. **Latency:** Total round-trip latency must be minimized. We use WebSockets (`ws`/`wss`) exclusively. No HTTP polling.
2. **Audio Standard:**
* **Format:** PCM16 (16-bit Pulse Code Modulation).
* **Sample Rate:** **24,000 Hz** (Non-negotiable; required by OpenAI `gpt-4o-realtime`).
* **Channels:** Mono (1).


3. **Security:** OpenAI API Keys (`OPENAI_API_KEY`) must **never** be stored on the client. They reside solely on the Relay Server.
4. **Client Environment:** **Expo Development Build** (Prebuild). We cannot use "Expo Go" because we require native code for raw audio access.

---

## Technical Stack Selection

### 1. The Mobile Client (`/app`)

* **Framework:** React Native (Expo SDK 50+).
* **Build Type:** Development Build (`npx expo run:ios` / `npx expo run:android`).
* **Audio Input (Recording):** `react-native-audio-record`.
* *Why:* Standard `expo-av` cannot stream raw PCM bytes in memory without incurring ~500ms file-IO latency. This library allows direct buffer access.


* **Audio Output (Playback):** `expo-av` (acceptable for Phase 1, though we may migrate to a raw PCM player later).
* **Transport:** Native `WebSocket`.

### 2. The Relay Server (`/server`)

* **Runtime:** Node.js (TypeScript).
* **Library:** `ws`.
* **Role:** 1:1 Stateful Proxy. Maps one Mobile Client Socket to one OpenAI Socket.

---

## Implementation Protocol

### Step 1: Server Logic (`server/src/server.ts`)

The server acts as the "Middleman."

* **Port:** 8081.
* **Authentication:** Inject `Authorization: Bearer <KEY>` headers when connecting upstream to OpenAI.
* **Event Handling:**
* **Upstream (`input_audio_buffer.append`):** Forward Client -> OpenAI.
* **Downstream (`response.audio.delta`):** Forward OpenAI -> Client.
* **Interrupt (`input_audio_buffer.speech_started`):** Forward OpenAI -> Client (Trigger client-side flush).



### Step 2: Client Audio Engine (`app/App.tsx`)

The client must handle the "Stream Pump."

* **Initialization:** Configure `AudioRecord.init` with `{ sampleRate: 24000, bitsPerSample: 16, channels: 1 }`.
* **The Pump:** Listen to `AudioRecord.on('data', base64 => ...)` and immediately emit to WebSocket.
* **The Network Fix:** Use the **LAN IP Address** (e.g., `192.168.1.X:8081`), NOT `localhost`, to ensure the device can see the server.

---

## "Gotchas" & Best Practices (The Cheat Sheet)

1. **The "Expo Go" Trap:** Do not try to run this in the standard Expo Go app. It will crash because `react-native-audio-record` is native code. You **must** run `npx expo prebuild` and `npx expo run:ios` (or Android).
2. **The "Localhost" Trap:** The iOS Simulator/Android Emulator sees `localhost` as *itself*.
* *Fix:* Use your computer's local IP (Run `ipconfig` or `ifconfig`).
* *Android Emulator Exception:* You can use `10.0.2.2`.


3. **The "Sample Rate" Trap:** If you record at 44.1kHz and send it to OpenAI (which expects 24kHz), the AI will sound like a slow-motion demon. If you record at 16kHz, it will sound like a chipmunk. **Must be 24,000 Hz.**

---

