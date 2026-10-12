# Quiet speech accuracy check

Executing worktree: `terrytibbs-worktrees/quiet-speech-check`, 12 October 2026.

Keep Turbo, English and cleanup off. Compare the existing recognition path with inexpensive amplitude adjustment on an independent public speech recording, including quiet and muffled derivatives. Measure word errors and warm request latency together. Do not ship an audio transformation without a measured benefit. Artificial degradation does not establish accuracy for a user's mumbling; request a real error example for that boundary.

Outcome: all 18 recognition runs had zero word errors; median latency was 399–405 ms. No measured accuracy benefit, so no production processing, model or settings change. Results and reproducible benchmark are retained. Actual mumbled speech remains an untested boundary.
