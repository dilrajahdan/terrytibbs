# Local Whisper warm engine

Terry can keep the installed `whisper-server` process warm between dictations.
The server is started with the configured large-v3-turbo model, binds only to
`127.0.0.1` on an ephemeral port, and serves an empty private static directory.
The app sends the same 16 kHz mono WAV, language, vocabulary prompt, no-
timestamps setting, greedy/beam defaults and flash-attention setting used by
the existing CLI path. The server response is JSON and only its `text` field is
accepted.

The warm engine is an optimization. If its process disappears or the loopback
request cannot connect, `transcribeWav` falls back to the existing literal-argv
CLI. Cancellation, invalid audio responses and inference failures propagate to
the caller. Temporary request audio is held in memory by the HTTP client and is
not written to a server log or static directory.

The handle's `running` property is false after an explicit stop or child exit;
the app can use it to discard a dead handle and start a fresh warm-up before the
next recording.

The official whisper.cpp server contract is the multipart `POST /inference`
endpoint with `file`, `language`, `prompt`, `no_timestamps`,
`temperature`, `temperature_inc` and `response_format` fields. The server's
`GET /health` endpoint reports readiness after the model has loaded.

The server must be stopped during app shutdown. `stopWhisperServer` accepts a
ready handle or the promise returned by `warmWhisperServer`. When given a
warming promise, pass the same startup `AbortController`; the wrapper aborts
the warm-up and waits for its child and private directory cleanup. For a ready
handle it aborts active requests, sends `SIGTERM` only to the child process it
started, waits up to one second, then uses `SIGKILL` if that same child is still
alive, and removes the private empty static directory.

Every request sends language, temperature, temperature increment and prompt,
including an empty prompt, so request settings cannot bleed between dictations.
Aborting a transcription closes the HTTP request. whisper.cpp observes that
disconnect through its request abort callback, and Terry also stops the owned
server child before rejecting so a later dictation can warm a clean replacement.
Concurrent stop calls share the same cleanup promise.

## Local benchmark

On the documented Apple M2 Max machine, using the installed large-v3-turbo
model and the real 11-second `artifacts/jfk.wav` sample, a cold warm-engine
startup after the model was already in the OS cache took 1.174 seconds. The
first server request took 616 ms and the repeated request took 433 ms. Both
returned exactly the same text as each other and as a direct `whisper-cli` run.
The direct CLI run took 2.13 seconds in the same cached state. These numbers
are a local sample benchmark, not a claim about microphone latency or every
speech pattern.

The installed server defaults `no_context` to true while the CLI does not expose
that switch. The server path explicitly matches the CLI beam size, best-of,
temperature, language, prompt, no-timestamps and flash-attention settings, but
long multi-segment accuracy should be rechecked before treating it as fully
equivalent for every recording.
