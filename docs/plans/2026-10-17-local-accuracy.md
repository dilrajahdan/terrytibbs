# Local dictation reliability and accuracy

Executing worktree: `terrytibbs-worktrees/local-accuracy`, 17 October 2026.

1. Repair opt-in microphone readiness after idle track/context interruptions with bounded retry, cancellation and permission handling. Make the selected and actual microphone visible; test device switching and unavailable inputs.
2. Benchmark local Parakeet through FluidAudio against the existing Whisper Turbo on identical real speech. Publish reproducible word-error and latency results with their limits. Keep the current default unless evidence supports changing it.
3. Add local, user-confirmed correction learning and management. Apply precise corrections without a model call or cloud processing; avoid background field surveillance and blanket sentence rewrites.
4. Exercise capture, recovery, input selection, correction persistence and actual dictation delivery. Inspect settings at desktop and narrow widths, preserve clipboard behaviour, run regression checks, build the installer and inspect its contents.
5. Update user documentation, changelog, GitHub and the preview installer after verification. Keep unsigned-preview and physical-device boundaries explicit.

Constraints: no cloud audio/text upload, no silent model switch, no latency claims from throughput alone, no personal recordings/settings in Git, no private development history. Test app data and pasteboard must be isolated from daily use.

Verification on 17 October: 112 unit checks and all 11 app regression tests passed. Native Turbo speech-to-paste passed for hold and lock with clipboard restoration. Mounted ARM64 0.6.7 installed and named USB input opened in the real UI. Parakeet comparison is published as benchmark evidence only; equal strict accuracy on the sample does not justify changing the default. See `docs/RELEASE.md` for remaining physical-device and fresh-Mac boundaries.
