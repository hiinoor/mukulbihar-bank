# Mukulbihar Bank Voice

A local, no-paid-service banking voice prototype. It answers general questions with a local language model and handles fictional account data, spoken OTP verification, balance and recent transaction requests, card blocking, and an English/Hindi switch.

## Run

Requires Node.js 24 or newer. The voice setup script is currently tested on macOS Apple Silicon with Python 3.12 and Apple command line tools. Chrome or Safari is recommended for microphone access and spoken replies. Speech recognition runs locally through Whisper, so the browser's speech recognition service is no longer needed.

Set up the free multilingual Whisper model and the English/Hindi Piper voices once. Install Ollama and pull the local Qwen model once. Then run the voice and model services in separate terminals:

```bash
npm run voice:setup
npm run voice:serve
```

```bash
npm run model:pull
npm run model:serve
```

In another terminal, start the bank app:

```bash
npm start
```

Open `http://127.0.0.1:3000`. In another terminal, run:

```bash
npm run otp
```

The command prints the fictional account number, current six-digit OTP, and a TOTP setup key/URI. For a quick demo, use the current OTP. To use an authenticator app, add the setup key manually as a time-based code; the website then accepts codes from the app. The setup key and OTP are shown only in the developer terminal, never on the banking page.

Press **Start conversation**, then ask a general question by voice or text. You can do this before or after verification; general replies are kept to one or two short sentences. Recording stops automatically after a pause; tap again to stop manually. For account numbers and OTPs, check the recognized digits in the input and press **Send**. After OTP verification, the assistant welcomes the customer by the name stored in the customer table. To get your balance, 1–5 recent transactions, or block the card, verify with the spoken OTP first. Card blocking requires a separate “confirm” response. The user-facing interface never describes the records as test data; they are fictional and local to this project.

The browser captures 16 kHz WAV audio, and the bank server sends it only to local Whisper at `127.0.0.1:8081`. Spoken replies come from local Piper voices on `127.0.0.1:5001` and `:5002`. If Piper is unavailable, the browser voice is used as a fallback. The text interface works if microphone access is unavailable. No paid API is used. LiveKit transport is a later phase; see [PLAN.md](PLAN.md).

The local voice services must stay running while using the microphone. If Whisper is unavailable, the page shows an error and text input still works. The small multilingual model is set to CPU on this 16 GB Mac so it can run alongside Ollama without exhausting graphics memory; the first launch may take several seconds to load.

## Local LLM

The default `npm start` connects to Ollama and uses `qwen3:4b-instruct` for open-ended questions. Banking operations are handled by backend code so the model cannot invent a balance or block a card by itself. The model is approximately 2.5 GB and requires an initial download. No paid API is used.

The model also understands alternate phrasings for the supported bank requests. Recent general conversation is kept in the session for follow-up questions. It has no live web access and may be wrong about unfamiliar facts. `npm run start:basic` runs the bank commands without general Q&A if Ollama is unavailable. The model never receives the OTP or a banking database row.

## Project layout

- `web/` — browser interface, microphone capture, spoken replies, and language switch.
- The browser page uses the supplied visual design with live backend responses; its balance, transaction, and card controls call the same authenticated APIs as typed or spoken requests.
- `src/server.js` — HTTP session and banking tool orchestration.
- `scripts/setup-voice.sh` — installs local Whisper recognition and Piper voices.
- `scripts/serve-voice.js` — runs Whisper and both Piper voices locally.
- `src/bank.js` — SQLite schema, fictional seed data, and authorized account operations.
- `src/otp.js` — TOTP generation and verification.
- `scripts/show-otp.js` — developer-only account and OTP setup details.
- `test/` — authentication and banking action flow checks.

## Boundaries

The server binds to localhost. Bank records and TOTP secrets are fictional. The one-account login is a project demonstration, not a production identity system. Before any public use, add enrollment, stronger authentication, persistent sessions, HTTPS, and a security review. The current `data/` folder is ignored by Git.
