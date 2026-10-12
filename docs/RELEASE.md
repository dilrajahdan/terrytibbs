# Public release: what works and what is missing

## The installation we should offer

```text
DMG: download → drag to Applications → open
CLI: Homebrew cask → open
                       ↓
           choose model and download once
                       ↓
          allow Microphone + Accessibility
                       ↓
           microphone icon → hold to talk
```

The best ordinary-user route is a signed, notarised DMG containing the app and speech runtime. A Homebrew cask can install that same app with one command once a real repository, hosted releases and cask exist. The [public source repository](https://github.com/DilrajAhdan/terrytibbs) is available. An [unsigned ARM64 preview DMG is available for 0.6.6](https://github.com/DilrajAhdan/terrytibbs/releases/tag/v0.6.6), with checksums and [installation instructions](INSTALL.md#dmg-preview-installation). There is no live Homebrew cask. Do not advertise an invented `brew install` command.

The current `npm run install:mac` is a developer shortcut from an extracted source folder. It requires Homebrew, Node.js and Apple developer tools first. It installs dependencies, verifies the Turbo model, builds and copies Terry to `~/Applications`, and opens it. It does not bypass macOS consent, log in for the user or overwrite an existing app.

## Requirements and model choices

| Machine | Starting model | Status |
|---|---|---|
| ARM64 Mac, 8 GB RAM | `small.en` (488 MB), or `base.en` if needed | Provisional entry-level target, not a validated minimum |
| M-series Mac, 16 GB+ | `large-v3-turbo` (1.62 GB) | Recommended first comparison; workload affects speed |
| M-series Mac, 24 GB+ with spare capacity | Compare Turbo and `large-v3` (3.10 GB) | Larger model can cost latency; no accuracy guarantee |
| MacBook Neo, A18 Pro, 8 GB | Trial `small.en`, cleanup off | Specifications confirmed by Apple; Terry performance untested |
| Intel Mac, Windows or Linux | None for this app release | Unsupported |

Use macOS 15+ for the supported installation route. Plan for 10 GB free disk space for source/build/dependencies/model; developer tools may require more. This is a planning allowance, not measured installed size or a tested hard minimum. A working microphone and permission to grant Microphone and Accessibility access are required. Some keyboard configurations may also request Input Monitoring. Internet is required for installation/model downloads, not ordinary dictation.

Apple's [Neo specifications](https://www.apple.com/macbook-neo/specs/) list A18 Pro and 8 GB memory. [Homebrew installation requirements](https://docs.brew.sh/Installation) and the [whisper.cpp formula](https://formulae.brew.sh/formula/whisper.cpp) define the dependency route. Hardware/model suggestions are engineering starting points, not cross-device benchmarks. See [model sizes and graphs](MODELS-AND-HARDWARE.md) and [measured timings](BENCHMARKS.md).

## Current limitations

- DMGs are unsigned and unnotarised. Gatekeeper may block first launch, and updates can require permission renewal. Do not disable Gatekeeper globally.
- The app needs a separate whisper.cpp runtime, including `whisper-vad-speech-segments`, plus model weights. Copying the DMG alone is insufficient on a fresh Mac.
- There is no automatic updater, launch-at-login setup, public cask or public release pipeline yet.
- Two minutes maximum per dictation. Text appears after recognition, not as a live streaming transcript.
- Recognition can mishear names and background speech. Vocabulary hints are not a guarantee. Silence detection reduces invented text but cannot promise perfect classification.
- Paste is conditional on the original app remaining focused and exposing an editable, non-password field. Otherwise the result stays on the clipboard. Terminal and unusual custom editors need their own checks.
- Native keyboard behaviour varies. A keyboard-only Fn layer cannot be assumed to emit a usable standalone key. Physical Bluetooth and reconnect checks remain necessary.
- Ordinary dictation needs no account, Python, PyTorch or Ollama. Optional local cleanup adds resource use and can rewrite words; leave it off initially.
- Custom voice clips are not distributed. The short generated buzz is the portable cue. Microphone-ready mode is optional and off by default.

## Privacy preparation

Use `npm run export:public` to create `release/Terry-Tibbs-public-source.zip` from committed files. The exporter allows application code, tests, build scripts, licences and selected public documentation. Internal plans, private verification notes, app settings, recordings, build artifacts and Git history are excluded. Examples in the public code/docs are neutral.

The development Git history contains personal author metadata and old private paths. **Do not push that history to a public remote.** Start the public repository from the reviewed export with a chosen public author identity (for example the account's GitHub no-reply identity). Keep the private development repository intact.

The exporter checks local home paths, credential patterns and optional locally supplied private search terms. This is a useful gate, not proof against every secret or sensitive image. Review the final source ZIP and packaged app, including image metadata and dependency licences, before publication. `.gitignore` does not remove files from past commits.

## Public launch gates

1. Source published as DilrajAhdan/terrytibbs using a GitHub no-reply author identity. Private vulnerability reporting is enabled on GitHub.
2. Keep private development history out of the public repository. Verify public CI on the exact release commit.
3. Bundle a pinned ARM64 whisper.cpp runtime and its required libraries, with licences/checksums. Offer a smaller first-run model option for 8 GB hardware.
4. Configure Developer ID signing, hardened runtime and Apple notarisation for app and helpers. These require the owner's Apple credentials; current builds explicitly disable signing.
5. Test download, Gatekeeper launch, permissions, model download, two successive dictations, lock/unlock, silence, restart, upgrade and uninstall on a fresh Mac with no Homebrew or Node installed.
6. Publish the notarised DMG with SHA-256, then a Homebrew cask pointing to that immutable release. Only then advertise the real one-command installation.

Source publication and a polished consumer release are separate milestones. The source can be reviewed and shared before the zero-dependency DMG is ready, provided the preview limitations are prominent.

## Local preparation evidence, 11 October 2026

- ARM64 preview DMG built and its disk-image checksum verified. It remains unsigned; no clean-machine Gatekeeper or zero-dependency install success is claimed.
- Public source export excludes Git history and private/internal documents. Known maintainer names, account terms and author email addresses were supplied to the export scanner; no matches remained in the exported files. Local home-path and selected credential-pattern checks passed. The export omits resource forks, extended attributes and quarantine metadata.
- Exported source passed TypeScript checking using already installed dependencies. Main test run: 94 passed, one environment-dependent skip; app/Swift build passed. The installer prerequisite check passed on the development Mac. Fresh-machine installation is still unverified.
- `npm audit` reported eight moderate findings, no high or critical findings, in the development/build dependency tree. Reviewed for the 0.6.5 preview: all eight trace to the build-tool dependency `sprintf-js` and [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), which reports no patched version. The affected formatting code is not included in the packaged app archive. `npm audit --omit=dev` reports zero findings. The preview retains the locked build tooling; this is not a comprehensive security audit.
- Final source ZIP: 100 files, no broken local Markdown links. Packaged disk image: 263 regular files scanned for known personal terms. Four substring hits in upstream Electron locale packs were manually checked as ordinary translated words; no maintainer details were found in those hits or Terry's own app/helper content. App and Applications shortcut were present; minimum OS metadata is 15.0.0. This is a scoped privacy review, not a universal absence-of-secrets guarantee.

## 0.6.5 clipboard preservation

Automatic native paste now restores the previous pasteboard after a 600 ms consumption grace period, guarded by the macOS change counter. Native integration checks cover large rich text, custom data, multiple items including an existing file URL, PNG data, empty content, repeated paste and a newer copy (including identical text). Clipboard-only fallback and explicit Copy retain their existing behaviour.

Full speech capture plus hold delivery and clipboard restoration was observed. The combined locked-recording/native-paste check could not complete while the foreground switched to another app; native clipboard preservation and gesture routing were tested separately. The user's physical shortcut sequence remains a manual boundary.

## 0.6.5 downloadable preview evidence, 12 October 2026

- Clean `npm ci`, type checking, native compilation and ARM64 DMG build completed.
- Unit suite: 95 passed, one skipped, zero failed.
- Mounted DMG contains Terry Tibbs 0.6.5 and the Applications shortcut. Its native clipboard helper matches the locally installed, exercised 0.6.5 helper.
- Packaged app archive contains compiled application files and package metadata, with no settings, recordings, development dependencies or personal-path matches. The model detector and its licence are bundled separately.
- SHA-256 checksums accompany the preview. The DMG is unsigned and unnotarised; a fresh-Mac installation remains unverified.

## 0.6.6 opening-word capture evidence

An opt-in ready microphone now retains at most 500 ms in its audio-thread ring. Quick buzz and silent activation send capture before overlay work. Cold-start device latency is not eliminated.

The old buffer failed a sample-preservation regression with 350 ms of delayed delivery. The updated buffer passes. The real speech integration check trims the fixture to its opening speech, starts it at the trigger, checks the opening words with an overlapping buzz, then checks a deliberately delayed start command through the real Whisper recogniser. Unit suite: 96 passed, one skipped. This test uses a software microphone and tiny.en, not the user's physical microphone, hardware shortcut or Turbo model. Native paste behaviour is unchanged from 0.6.5.
