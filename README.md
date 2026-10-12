# Terry Tibbs

**Speak instead of typing.** Free, local dictation for your Mac.

Hold a key. Say your words. Let go. Terry pastes the text into the text box where you started, then restores your previous clipboard. It never presses Send.

No account. No subscription. Dictation works offline after the first setup and model download.

## Watch it work

[![Watch the 19-second Terry Tibbs tutorial: narration and captions](https://amopqrboxtncgxjaqitq.supabase.co/storage/v1/object/public/marketing/tutorials/terrytibbs/0.6.4/terry-tibbs-short.jpg?v=2)](https://amopqrboxtncgxjaqitq.supabase.co/storage/v1/object/public/marketing/tutorials/terrytibbs/0.6.4/terry-tibbs-short.mp4?v=2)

**[▶ Watch the 19-second tutorial](https://amopqrboxtncgxjaqitq.supabase.co/storage/v1/object/public/marketing/tutorials/terrytibbs/0.6.4/terry-tibbs-short.mp4?v=2)** · [Prefer reading? Quick tutorial + transcript](docs/TUTORIAL.md)

## Use it in three steps

0. **First time?** [Install Terry](#install), allow **Microphone** and **Accessibility**, then open **Settings → Record shortcut**. Choose a key, click **Use shortcut**, then **Save settings**.
1. **Click a text box.** An email, a note or a chat message.
2. **Hold your shortcut and speak** when Terry shows it is listening.
3. **Let go.** Wait for transcription. Terry attempts to paste your words into the original app, then restores your previous clipboard.

| Want to… | Do this |
|---|---|
| Talk without holding a key | **Double-tap** your shortcut. Look for the lock. |
| Finish a locked recording | **Press once more.** |
| Cancel | Press **Escape**. |
| Get Terry out of the way | **Close to menu bar**. It keeps running. |
| Open it again | Click the **microphone icon** in the Mac menu bar. |
| Stop Terry completely | Menu bar → **Quit Terry Tibbs**. |

**Says “Copied only”?** Click your text box and press **⌘V**. Your text is on the clipboard. For automatic paste, enable Accessibility and keep the original app focused. Password fields and some apps cannot accept automatic paste.

**Check it:** try two short sentences in **TextEdit**. Both should appear. Then double-tap, speak, and press once to finish. Check the lock appears and the third sentence reaches the document.

## Install

**[Download the 0.6.6 Mac preview](https://github.com/DilrajAhdan/terrytibbs/releases/tag/v0.6.6)** · [Changelog](CHANGELOG.md)

The DMG saves you building the app. It is unsigned and unnotarised, and needs Homebrew whisper.cpp plus a model. **[DMG installation steps →](docs/INSTALL.md#dmg-preview-installation)**

Prefer building from source?

0. You need an **ARM64 Mac, macOS 15+, Homebrew, Xcode Command Line Tools and Node.js 22.12+**. Allow around **10 GB free disk space**, plus developer tools. Internet is needed for setup. [Exact prerequisite commands →](docs/INSTALL.md)
1. In **Terminal**, paste:

   ```sh
   git clone https://github.com/DilrajAhdan/terrytibbs.git
   cd terrytibbs
   npm run install:mac
   ```

2. Terry installs into **~/Applications** and opens. Grant permissions and choose your shortcut. Check the microphone icon appears in the menu bar.

The install command downloads the **1.62 GB Whisper Turbo model**. It refuses to overwrite an existing app. **On an 8 GB Mac, use the [smaller-model installation](docs/INSTALL.md#macbook-neo-use-a-smaller-model-first) instead.** This is one install command after prerequisites and cloning, not a zero-setup installer.

**Building a DMG yourself?** Run `npm ci` then `npm run dist`. [Installer limitations →](docs/RELEASE.md)

## Make it work better for you

- **Wrong microphone?** Settings → choose your microphone → **Test input** → Save settings.
- **Names come out wrong?** Add names and specialist words to **Vocabulary**. These are hints, not guaranteed spellings.
- **Missing the beginning?** Use activation sound **Off** or **Quick buzz**. Voice clips deliberately delay recording. Optional **Keep microphone ready** can reduce startup delay.
- **Music in the background?** Enable background audio muting. The muting transition is not instantaneous.
- **Long thought?** Each dictation can last up to **two minutes**.

[Full everyday guide →](docs/USER-GUIDE.md)

## Which model? Which Mac?

| Your Mac | Starting point |
|---|---|
| M-series, **16 GB or more** | **Whisper large-v3-turbo**, the default |
| **8 GB**, including MacBook Neo | Trial **small.en** for English, cleanup off |
| Plenty of spare memory | Compare full **large-v3** with Turbo on your own speech |

These are starting recommendations. M2 Max has been tested; MacBook Neo has not. A bigger model does not guarantee better results. Intel, Windows and Linux are outside the current app's supported setup.

[Model graphs and hardware details →](docs/MODELS-AND-HARDWARE.md) · [Measured benchmarks →](docs/BENCHMARKS.md)

## Where does my speech go?

**Speech → local speech detector → local Whisper model → clipboard → paste.**

No cloud speech service is used. Optional text cleanup uses local Ollama and is off by default. Terry keeps the latest recording and transcript in memory for retry and copying. A temporary WAV may be created by the CLI fallback and is removed on completion, failure or cancellation. Clipboard text remains until replaced.

[Privacy and security →](SECURITY.md)

## Help build it

[Developer setup and contributing](CONTRIBUTING.md) · [Release readiness](docs/RELEASE.md) · [Report an issue](https://github.com/DilrajAhdan/terrytibbs/issues)

[MIT licensed](LICENSE). Models and dependencies retain their own licences. No celebrity audio or imagery is bundled. Terry is not affiliated with Wispr Flow or any television character. [Third-party notices →](THIRD_PARTY_NOTICES.md)
