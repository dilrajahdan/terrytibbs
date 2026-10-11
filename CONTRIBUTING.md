# Contributing

Start with [installation](docs/INSTALL.md), then [models and hardware](docs/MODELS-AND-HARDWARE.md).
Use an Apple Silicon Mac, macOS 15 or newer for the current Homebrew route,
Node.js 22.12 or newer and Xcode Command Line Tools. Run `npm ci`,
`npm run setup`, then `npm run dev`. The installation guide also covers a
smaller-model route. Model downloads and optional Ollama are separate from source dependencies.

Before a pull request, run `npm test` and `npm run build`. Include a real user-path
check for recording, cancellation, transcription, copy or paste changes. Do not
claim a physical microphone test when using a synthetic device. Never commit
recordings, transcripts, model weights, private settings or credentials.

Keep changes focused. Explain the problem, changed behaviour and observed tests.
Keep cloud inference, telemetry and proprietary media out of the default app.
See SECURITY.md for the privacy and reporting policy.

For model or performance changes, follow [the benchmark procedure](docs/BENCHMARKS.md).
Include the chip, memory, macOS, engine version, model filename/checksum,
sample provenance, raw run timings and test conditions. Separate public fixtures
from opt-in personal speech. Keep hardware recommendations labelled provisional
until the actual recording-to-insertion path passes on that hardware.

Documentation graphs are generated from committed JSON using
`scripts/render-doc-charts.py`. See the benchmark guide for regeneration commands.
Keep the adjacent data tables usable without images. Do not turn an upstream
GPU benchmark into a Mac performance claim or mix download size with runtime RAM.

Before a public binary release: confirm the private security-reporting
channel, review dependency advisories, configure Developer ID signing and
notarisation, and exercise the installer on a clean target Mac. Check the public repository Actions tab for CI results on the exact commit. Packaging currently sets signing identity to null and the
package manifest is private to prevent accidental npm publication.
