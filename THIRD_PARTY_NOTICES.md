# Third-party notices

The application source is MIT licensed. Dependencies retain their own licences;
`package-lock.json` records the installed versions and licence metadata. Packaged
Electron includes its licence and Chromium third-party notices.

- Electron: MIT, https://github.com/electron/electron
- Vue: MIT, https://github.com/vuejs/core
- whisper.cpp (separately installed): MIT, https://github.com/ggml-org/whisper.cpp
- Whisper model weights: MIT, https://github.com/openai/whisper and https://huggingface.co/openai/whisper-large-v3-turbo
- GGML conversion distributed by ggerganov: https://huggingface.co/ggerganov/whisper.cpp
- Ollama (optional separate install): https://github.com/ollama/ollama. Each chosen language model has its own licence.

Default speech model: ggml-large-v3-turbo.bin, 1,624,555,275 bytes.
Upstream revision: 5359861c739e955e79d9a303bcbc70fb988958b1.
SHA-256: 1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69.

No celebrity likeness, third-party character artwork or television audio is
included in the source or app package. User-selected local audio retains its own rights and is not covered by the source MIT licence. The optional Mac chime uses a sound already installed by macOS. The working project name does not imply an endorsement or affiliation.

## Bundled voice-activity detector

Silero VAD 6.2.0 is MIT licensed: https://github.com/snakers4/silero-vad.
GGML conversion: https://huggingface.co/ggml-org/whisper-vad.
File: ggml-silero-v6.2.0.bin, 885,098 bytes.
Revision: 9ffd54a1e1ee413ddf265af9913beaf518d1639b.
SHA-256: 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987.
Downloaded and checked at build time, included in the app, used offline through
whisper.cpp's separately installed whisper-vad-speech-segments executable.
It classifies speech before recognition and does not remove or trim audio.
The full upstream licence is in resources/SILERO-LICENSE.txt.

## Optional benchmark dependencies

These are downloaded only by the developer comparison scripts. They are not
bundled in the application or used by ordinary dictation.

- FluidAudio 0.17.7: Apache 2.0, https://github.com/FluidInference/FluidAudio.
- Parakeet TDT 0.6B v3: NVIDIA model, CC BY 4.0, https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3.
- FluidInference CoreML conversion: CC BY 4.0, https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml.
- LibriSpeech: Vassil Panayotov with Daniel Povey, CC BY 4.0, https://www.openslr.org/12. Derived from LibriVox audiobooks. Recordings remain outside the source export.

Pinned revisions, checksums and reproduction steps are in
[the comparison guide](docs/PARAKEET-BENCHMARK.md) and its linked results.
