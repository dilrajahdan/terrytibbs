# Security and privacy

Terry Tibbs loads only its local renderer. Node integration is disabled, context
isolation and sandboxing are enabled, IPC handlers validate their callers, and
new windows and renderer navigation are blocked.

With the default settings, the microphone is closed while idle. The optional
microphone-ready mode is described below. A selected device uses an exact ID and does
not fall back silently. The input test is limited to ten seconds, displays only
levels and device metadata, and stores no audio. AudioWorklet capture runs from
a bundled same-origin asset under the existing content security policy. Usable
partial audio from a failed recording may remain in memory for explicit retry;
Cancel discards the active capture, and Quit stops recording and testing inputs.

Speech is processed by the local whisper.cpp executable selected in Settings.
Choosing an executable is a trust decision: choose your installed whisper-cli.
When an installed sibling whisper-server is available, Terry keeps it running on
127.0.0.1 at a random local port, with an empty private static directory. Audio is
posted only to that loopback endpoint. The server stops when Terry quits or an
inference is cancelled. The optional cleanup service is fixed to 127.0.0.1:11434. Models flagged as cloud
or remote by Ollama are rejected. Do not configure a custom proxy under a local
model name that forwards requests elsewhere.

Model setup downloads 1.62 GB from Hugging Face and its storage CDN, pinned to
an upstream revision and checked against SHA-256. Speech needs no internet after
setup. Optional cleanup uses a local Ollama installation. There is no telemetry,
account, automatic updater or remote font/image loading.

Activation sounds use the fixed macOS `/usr/bin/afplay` executable with a literal
local file argument for previews and unmuted dictation. Muted dictation uses the
packaged `terry-audio` helper and AVAudioPlayer with the same validated local file. No shell commands or network media are used. Voice clips and Mac chime wait
for playback to finish, stop or fail, followed by a 150 ms settling pause when a
player ran. The generated 60 ms Quick buzz is nonverbal and never gates capture. Cancel and Quit terminate playback. Custom clips are user-supplied
local files; they are not included in redistributed packages.

Background muting creates a process-owned private Core Audio output tap with its
own cue-playing helper excluded. An inactive private aggregate attaches the tap
to activate muting. Terry never starts or reads that aggregate, creates an IOProc
or capture stream, or reads the other applications' audio. System volume and
mute settings are unchanged. A warm helper explicitly sets its tap to unmuted
while idle. Releasing a recording restores that unmuted state; errors, parent exit, EOF, Quit and a 150-second active-session watchdog
terminate the helper and destroy it. Process exit also releases it.
Production cannot select a different mute helper via environment variables.

Settings persist locally. The latest audio and transcript stay in app memory for
retry/copy until cleared, replaced or the app quits. Warm inference sends audio
in memory. The CLI fallback writes a temporary
WAV inside a private directory and removes it on normal completion, failure or
cancellation. An OS crash or force kill can leave temporary files in the macOS
temporary directory; this is not forensic secure deletion. Every completed dictation puts the transcript on the system clipboard, where
other software and clipboard managers may read it. The latest transcript deliberately
remains there after automatic paste. Clearing app memory does not clear the clipboard.
Automatic paste checks for an editable, non-secure focused field in the original
foreground app. Unknown accessibility roles fall back to clipboard-only output.

Microphone permission is required to record. Accessibility permission is required
for the native global key-down/key-up shortcut and automatic paste. The event tap
compares keys locally and emits only shortcut edges, never general keystrokes or typed text.
While recording a shortcut, the native listener also emits function-key candidates to the focused settings window. Closing a window does not quit the app;
choose **microphone menu → Quit Terry Tibbs** to stop it. No screen recording or automated sending is required. The
initial locally built app is unsigned and unnotarised; source builds are the
supported distribution until a signed release is prepared.

Report vulnerabilities privately to the repository owner using GitHub's private
vulnerability reporting when available. Do not attach private audio or transcripts
to public issues. If private reporting is unavailable, request a private channel
without publishing exploit details or user data.

Microphone readiness is explicit and opt-in. Its selected microphone remains open
with echo cancellation enabled while Terry is ready. Only a fixed 120 ms rolling
buffer exists inside the worklet; idle samples and levels never cross into the
renderer or main process, and are never saved or transcribed. Session IDs prevent
stale frames from entering a subsequent recording. Disable, input change, screen
lock, sleep and Quit close armed tracks, worklet ports and contexts.
