# Mukulbihar Bank voice project plan

## Goal

A browser-based banking assistant that feels natural in U.S. English or Hindi. It verifies the customer with a spoken OTP, reads a balance and 1–5 recent transactions, and blocks a card only after explicit confirmation. All banking records are fictional and stored locally.

## Phase 1 — runnable prototype (implemented)

- Responsive web interface with microphone, text fallback, voice replies, and language switch.
- Local Node.js server and SQLite database. No paid API or telephony account.
- Account identification and TOTP verification; OTP never reaches the optional LLM.
- Deterministic, authorized balance, transaction, and card tools.
- Local Ollama Qwen conversation for general questions and alternate phrasings, available before and after verification.
- Automated API flow test.

## Phase 2 — improved local voice (partly implemented)

- Use whisper.cpp with the multilingual small model behind a local STT adapter (implemented).
- Capture microphone audio as 16 kHz WAV and stop automatically after speech (implemented).
- Require review of recognized account and OTP digits before submission (implemented).
- Use local Piper voices for `en_US` and `hi_IN`, with browser speech as fallback (implemented).
- Install and warm Qwen3 4B Instruct in Ollama (implemented); measure end-to-end response delay on the target machine.
- Validate Hindi, Hinglish, account digits, and OTP recognition with recorded test utterances.

## Phase 3 — LiveKit web transport

- Run LiveKit Server locally or on an authorized host.
- Replace the direct browser voice path with a LiveKit room and an agent worker that calls the same banking service.
- Issue short-lived room tokens from the authenticated backend.
- Add server-side call/session mapping, interruption handling, and observability that excludes OTP audio and digits.

## Release checks

- Test two simultaneous sessions so a customer cannot access another customer’s account.
- Test wrong/replayed OTPs, expired sessions, 1–5 transaction limits, cancelled card blocks, and repeated block calls.
- Measure end-of-speech to first-audio delay separately for English and Hindi.
- Keep any public demonstration restricted to fictional accounts.
