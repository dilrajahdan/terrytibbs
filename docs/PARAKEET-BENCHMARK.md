# Compare Parakeet with Whisper locally

[Benchmarks](BENCHMARKS.md) · [Models and hardware](MODELS-AND-HARDWARE.md)

```text
Same public WAVs → Whisper Turbo   → word errors + opening words + time
                 → Parakeet TDT v3 → word errors + opening words + time
```

This is a developer experiment, not a second engine installed in Terry. It does not change the selected model, open a microphone, read app settings or touch the clipboard. Downloads fetch public models and public speech; recognition runs on the Mac. No audio is uploaded.

## Reproduce

0. Use an Apple Silicon Mac, Xcode/Swift 6.0 or newer, the repository's developer dependencies, Homebrew `whisper.cpp`, `ffmpeg` and the installed `ggml-large-v3-turbo.bin`. Allow several GB of free disk space for source caches, models and two public speech archives. Run these commands from the repository root. Avoid builds and other heavy work during the timed comparison.
1. Download and verify the public recordings:

   ```sh
   python3 scripts/prepare-model-comparison.py
   ```

   This fetches the approximately 346 MB `test-clean` and 328 MB `test-other` archives from [OpenSLR's LibriSpeech corpus](https://www.openslr.org/12), verifies the publisher's archive checksums, and selects 20 recordings before recognition. LibriSpeech is read English speech derived from LibriVox audiobooks, prepared by Vassil Panayotov with Daniel Povey, and distributed under CC BY 4.0. The script also fetches the existing checksum-verified whisper.cpp JFK control. Downloads and selected WAVs stay in ignored `artifacts/model-comparison`.
2. Build the benchmark-only Swift helper and download its model:

   ```sh
   swift build --package-path scripts/parakeet-benchmark \
     --scratch-path artifacts/model-comparison/swift-build -c release
   artifacts/model-comparison/swift-build/release/TerryParakeetBenchmark \
     download "$PWD/artifacts/model-comparison/models"
   ```

   The package pins [FluidAudio 0.17.7](https://github.com/FluidInference/FluidAudio/tree/503b4bd1bbf7220882de39fe8ae6716aae4132da). The helper pins [Parakeet TDT 0.6B v3 CoreML](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml/tree/7dd20fe6b1797d35f5e3307e8b1732d9a178edfe), using its int8 encoder and default CPU/Neural Engine configuration. The model is a FluidInference conversion of NVIDIA's Parakeet and carries CC BY 4.0 attribution. Downloading is a separate command; recognition enables FluidAudio's offline mode and points its registry at a disabled loopback endpoint, so a missing asset fails instead of fetching it during inference.
3. Run the paired comparison:

   ```sh
   npx tsx scripts/benchmark-models.ts \
     "$HOME/Library/Application Support/Terry Tibbs/models/ggml-large-v3-turbo.bin"
   ```

   The script starts its own local Whisper server and Parakeet helper. Both must reproduce the JFK control before any results are accepted. It then runs three rounds on the same 20 WAVs, alternates engine order, and reverses clip order in the middle round. Only its own processes are stopped afterwards.
4. Open **artifacts/model-comparison/results.json**. Check `controlPassed: true`, 120 measured rows, 20 distinct clip IDs and 20 speakers, plus six summary rows. `results-public.json` omits transcripts and filesystem paths. A failed control or missing report means no accepted comparison. Zero `wordErrors` means no mismatched normalised words on those particular recordings, not perfect everyday accuracy.

## What the numbers mean

- **Warm time:** from the caller requesting a transcript to receiving it, including file read, PCM conversion and local IPC/HTTP. Includes the app's existing Whisper transcription wrapper. Excludes capture, speech detection, activation sound, text cleanup, clipboard and paste. It is not release-to-paste time.
- **Startup:** process launch and model loading, reported separately. The first control transcription is also separate. File caches are not flushed, so these are process-start observations, not cold-boot measurements.
- **Word error rate:** word substitutions, deletions and insertions divided by reference words. Case and most punctuation are ignored; apostrophes inside words are retained and hyphens split. Digits and written numbers are not treated as equivalent. Inspect raw transcripts before interpreting a formatting difference as misrecognition.
- **Opening words:** exact first-word and first-three-word matches. These measure recognition of already-recorded speech. They cannot prove a physical shortcut captures the beginning of a live utterance.
- **Repeated runs:** accuracy uses only the first round. Three repeats help observe timing variation; they do not turn 20 clips into 60 independent recordings. The report flags whether normalised transcripts remained stable across repeats.

The sampler takes 10 evenly spaced numeric speaker IDs from each subset, then each speaker's first numeric utterance lasting 3–15 seconds. No clips are chosen based on which model wins. Source and WAV SHA-256 values are recorded in the manifest and checked before recognition.

This test is broader than the earlier JFK experiment, but it is still a small audiobook sample. It does not establish performance on natural mumbling, the user's accent, specialised names, background music or a live microphone. These are common public benchmarks and may overlap model training. Keep the production engine until representative, deliberately recorded local speech shows a useful accuracy improvement without unacceptable delay.
