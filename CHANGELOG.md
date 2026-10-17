# Changelog

## 0.6.7 · 17 October 2026

- **Microphone recovery:** opt-in readiness reconnects after an idle disconnect, mute or audio-context interruption. Retries are bounded; reconnecting a device and a visible retry action can restart preparation. Permission denial stops automatic attempts. Warm starts retain the existing capture path and half-second buffer.
- **Know your input:** Microphone is the first Settings section, with a direct menu-bar entry and a Change microphone button. Selection saves immediately. The actual opened input is distinguished from a previous test result. A missing named microphone never silently falls back.
- **Local correction learning:** edit the latest transcript, review the proposed word replacements and choose what to remember. Manage or pause saved corrections in Settings. Whole-word matching adds no model call; raw transcription is retained. Saving a correction does not repaste or change the clipboard.
- **Model comparison:** reproducible, offline Parakeet TDT v3 versus Whisper Turbo benchmark tooling and results. This release keeps Whisper as the production engine; the comparison does not silently change anyone's model.
- Recognition/UI tests now use an isolated in-memory clipboard. Native paste and clipboard restoration have a separate integration check.

## 0.6.6 · 12 October 2026

- Quick buzz and silent activation send the capture command before opening the recording overlay.
- With **Keep microphone ready** enabled, the memory-only rolling buffer now retains up to 500 ms rather than 120 ms. This protects opening syllables when the start command is delayed. It may include speech from just before the press.
- Readiness remains opt-in. Turning it off, locking the Mac or quitting stops the idle microphone. Cold microphone startup and voice-clip playback still require waiting for listening readiness.

## 0.6.5 · 12 October 2026

### Keep what you copied

Automatic dictation paste now saves the existing clipboard, pastes your transcript and restores the original clipboard after a 600 ms grace period. This includes rich text, images, file references and multiple clipboard items. The saved contents stay in memory.

If you copy something else during that interval, Terry keeps your newer copy. Cancelling a transcription does not interrupt an already-started clipboard restoration.

**Exceptions:** “Copied only” fallback, auto-paste disabled, explicit Copy, import and retry still put the transcript on the clipboard for manual pasting. Very slow editors may need manual Copy. An app/helper crash during delivery can prevent restoration.

### Install

First downloadable **ARM64 preview DMG**, with SHA-256 checksums and [installation instructions](docs/INSTALL.md#dmg-preview-installation). macOS 15+ required. The preview is unsigned and unnotarised. Install Homebrew whisper.cpp separately and download a speech model in Terry. No Node.js or app compilation is needed for the DMG route.

### Verification boundaries

Native clipboard tests covered rich text, a large text payload, images, file references, empty and repeated delivery, and newer copies made during delivery. Speech-to-text insertion through the hold/release path was exercised in an owned editor. The full locked-recording clipboard check and physical shortcut sequence in third-party apps remain unverified for this change. Fresh-Mac and MacBook Neo installation are not yet validated.

## 0.6.4 · Source preview

Short narrated tutorial and usage-first README, with installation, model and hardware guides. Source history before 0.6.5 did not have a downloadable GitHub installer.
