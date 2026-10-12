# Preserve the clipboard after dictation paste

Executing worktree: `../terrytibbs-worktrees/preserve-clipboard`.
Date: 2026-10-12.

Move automatic paste's temporary clipboard write into the native helper. Snapshot every pasteboard item/type immediately before delivery, restore after the paste grace period only if the change counter still belongs to Terry. Keep explicit Copy, import and clipboard-only fallback behaviour. Never put snapshot contents on disk, in logs or command arguments. Verify real insertion and restoration, empty/rich/image clipboards, repeated dictation, and a newer copy winning the restoration race. Package and update the local installation after checks.

Verification: 94 unit tests passed with one existing skipped test; the new cancellation-specific paste test also passed. Native insertion plus byte-for-byte clipboard checks passed for large rich/multi-item data, existing file URL, image, empty clipboard, repeated delivery and newer-copy races. A full speech/hold attempt inserted correctly and restored the previous clipboard. The locked speech run was interrupted by foreground switching to another app, so that combined end-to-end check remains unverified. Version 0.6.5 was packaged, installed and reopened; settings hash and installed helper bytes match.
