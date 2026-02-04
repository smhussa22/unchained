
# claude.md

## Project Context: Speak Vision (Phase 2.1 - Backend Direct Injection)

**Current Status:**

* **Frontend:** The app now captures images (512x512, Q=0.4) and emits `{ type: 'vision.direct_injection', image: <BASE64> }` when stable.
* **Backend:** Node.js Relay (AWS) currently only forwards audio. It ignores the vision event.

**Goal:**
Upgrade `server.ts` to handle the `vision.direct_injection` event. instead of using a sidecar model (GPT-5 Nano), we will inject the image **directly into the active OpenAI Realtime Session** as a user message.

---

## Technical Specifications (Backend)

### 1. The Event Handler

The server must listen for the custom `vision.direct_injection` event from the client.

* **Payload:** `{ type: 'vision.direct_injection', image: '...' }` (Base64 string).
* **Action:** Construct a `conversation.item.create` event to send to OpenAI.

### 2. The Injection Payload (Realtime API Standard)

The OpenAI Realtime API expects a specific structure for multimodal inputs.

* **Event Type:** `conversation.item.create`.
* **Item:**
* `type`: `'message'`
* `role`: `'user'`
* `content`: Array of parts:
1. `{ type: 'input_text', text: 'I am showing you something. Describe it briefly and ask me a question about it.' }`
2. `{ type: 'input_image', image_url: { url: 'data:image/jpeg;base64,...' } }` (Verify exact spec via documentation).





### 3. The Response Trigger

After injecting the item, the server must immediately send a `response.create` event.

* *Why:* This forces the model to acknowledge the image *now* rather than waiting for the user to speak again.

### 4. Bandwidth Safety (The "Audio Pause")

**Risk:** Sending a 40KB image packet might block the WebSocket execution loop, causing the *outgoing* audio stream to stutter.

* **Optimization:**
1. Set a flag `isUploadingVision = true`.
2. Temporarily buffer/drop incoming audio packets from the client for ~50ms during the write operation.
3. Set `isUploadingVision = false` immediately after.



---



```