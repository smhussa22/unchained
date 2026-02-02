

## Project Context: "Speak Vision" (Phase 1)

We are building a **Proof-of-Work** demonstration for Speak.com.
**Goal:** Create a high-fidelity, low-latency "Audio Bridge" between a React Native mobile app and the OpenAI Realtime API.
**Current Focus:** **Phase 1 (The Skeleton)**. We need to set up the environment, the Relay Server, and the Front-end Client to establish a bi-directional audio stream.

**Constraints:**

* **Latency:** Must use WebSockets (no HTTP polling).
* **Audio Format:** PCM16 (16-bit), 24,000 Hz, Mono.
* **Security:** API Keys must stay on the server.

---

## Technical Stack

* **Frontend:** React Native (Expo SDK 50+).
* **Backend:** Node.js + TypeScript + `ws` (WebSocket library).
* **AI:** OpenAI Realtime API (`wss://api.openai.com/v1/realtime`).

---

## Instruction Set 1: Project Scaffolding

Please execute the following directory structure and initialization commands.

### 1.1 Directory Structure

Create a monorepo-style structure:

```text
/speak-vision
  /app          (React Native Expo)
  /server       (Node.js Relay)

```

### 1.2 Server Initialization

1. Initialize `/server` with `package.json`.
2. Install dependencies: `npm install ws dotenv uuid`.
3. Install dev dependencies: `npm install -D typescript @types/ws @types/node @types/uuid ts-node`.
4. Create a `tsconfig.json` configured for Node.js execution.

### 1.3 Client Initialization

1. Initialize `/app` using `npx create-expo-app@latest -t blank-typescript`.
2. Install essential UI/Audio packages: `npx expo install expo-av expo-file-system`.
3. (Note: We will address raw PCM streaming libraries in the coding step, sticking to standard Expo for now to test connectivity).

---

## Instruction Set 2: The Relay Server (`/server`)

Generate a robust `server.ts` file that acts as a secure proxy.

**Requirements:**

1. **WebSocket Server:** Listen on port 8081.
2. **Authentication:** Load `OPENAI_API_KEY` from a `.env` file.
3. **Connection Logic:**
* When a Client connects, immediately open a *new* WebSocket connection to `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`.
* Pass the `Authorization: Bearer <KEY>` and `OpenAI-Beta: realtime=v1` headers to OpenAI.


4. **Event Relay (Pass-through):**
* **Client -> OpenAI:** Forward all messages as JSON string.
* **OpenAI -> Client:** Forward all messages as JSON string.


5. **Logging:** Add `console.log` for:
* "Client Connected"
* "OpenAI Connected"
* "Session Created"
* "Error" events.



---

## Instruction Set 3: The Frontend Client (`/app`)

Generate the `App.tsx` code for the mobile client.

**Requirements:**

1. **UI Layout:**
* A clean, dark-themed UI (Background: #111).
* A large status indicator (Text: "Disconnected" | "Connecting..." | "Live").
* A "Connect" button.
* A "Push to Talk" button (Placeholder for VAD later).


2. **WebSocket Logic:**
* Use the native `WebSocket` API.
* Connect to `ws://localhost:8081` (Assume iOS Simulator/Android Emulator local networking).


3. **Permission Handling:**
* On mount, request Microphone permissions using `Audio.requestPermissionsAsync()`.


4. **Audio Setup (Configuration Only):**
* Configure `Audio.setAudioModeAsync()` for `allowsRecordingIOS: true` and `playsInSilentModeIOS: true`.
* *Do not implement the full streaming loop yet.* Just set up the mode.



---

## Deliverables

Please provide:

1. The `server.ts` code.
2. The `App.tsx` code.
3. A terminal command list to run both environments simultaneously.