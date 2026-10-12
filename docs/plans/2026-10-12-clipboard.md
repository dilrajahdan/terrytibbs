# Preserve the clipboard after dictation paste

Executing worktree: `../terrytibbs-worktrees/preserve-clipboard`.
Date: 2026-10-12.

Move automatic paste's temporary clipboard write into the native helper. Snapshot every pasteboard item/type immediately before delivery, restore after the paste grace period only if the change counter still belongs to Terry. Keep explicit Copy, import and clipboard-only fallback behaviour. Never put snapshot contents on disk, in logs or command arguments. Verify real insertion and restoration, empty/rich/image clipboards, repeated dictation, and a newer copy winning the restoration race. Package and update the local installation after checks.
