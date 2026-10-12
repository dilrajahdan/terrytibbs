# Using Terry every day

[Home](../README.md) · [Install](INSTALL.md) · [Choose a model](MODELS-AND-HARDWARE.md)

```text
Terry menu → Open Terry Tibbs
  Ready             [Start dictation] [Settings]
  Listening, locked [Stop dictation]  [Cancel]
  Transcribing      Processing on this Mac
  Latest transcript [Copy transcript] [Retry] [× Clear transcript]
                    [View raw transcription] → [Copy raw]

Close window → menu-bar shortcut stays available
Terry menu → Quit Terry Tibbs → stop Terry and unload the speech model
```

## Your first successful dictation

0. Finish [installation and permissions](INSTALL.md#first-launch-and-permissions). Open **TextEdit → File → New** and click inside the empty document.
1. Hold the saved shortcut. The initial default is **Option + Space**. Wait for the microphone bars, then say a short sentence. A voice clip or chime delays capture even with microphone readiness enabled.
2. Release the shortcut. Keep TextEdit focused while Terry transcribes.
3. Check, in order: recording appears, then processing, then your words appear at the cursor. Nothing should be submitted or sent. Compare names and numbers yourself.
4. Double-tap the shortcut quickly. The lock should appear immediately. Wait for the microphone bars before speaking, then press the shortcut once more. Check that recording finishes and text appears in TextEdit.
5. Start another recording and press **Escape**. Check that the indicator disappears and no new text is inserted. An empty new result is a pass for cancellation.

The on-screen **Start dictation** button starts a locked recording. It is useful for checking the microphone, but starting inside Terry does not select another app as the paste destination.

A silent attempt shows **No speech** and leaves the clipboard and previous transcript unchanged. Terry checks for speech before using your vocabulary prompt. The detector classifies the recording without cutting its beginning or end. It can still mistake speech from a nearby person or television for yours.

## Your clipboard stays yours

Automatic paste temporarily borrows the clipboard. About 0.6 seconds after sending paste, Terry restores the previous clipboard, including rich text, images and copied-file references. It snapshots immediately before delivery, so anything you copy while transcription is running is preserved. If you copy something new during the brief paste window, that newer copy wins.

The transcript remains in Terry. Use **Copy transcript** when you explicitly want it on the clipboard. **Copied only**, import, retry and disabling automatic paste still leave the transcription on the clipboard for manual pasting. Those explicit copy/fallback paths do not restore the old clipboard.

Paste events cannot prove that every app consumed the text. Very slow or unusual editors may need **Copy transcript** and a manual paste.

## Choose your key

0. Open **Terry menu → Settings → How you dictate**.
1. Choose **Record shortcut**, press and release a key or combination, choose **Use shortcut**, then **Save settings**.
2. For the Apple **Globe / Fn** key, use **Use Globe / Fn** directly, then save. This key may not reach the ordinary recorder. Function keys can also depend on the keyboard's Fn setting.
3. Return to TextEdit and repeat hold/release and double-tap/press checks separately. A shortcut that conflicts with another app is a reason to choose another key.

## Choose and check your microphone

0. Connect the microphone you intend to use.
1. Open **Terry menu → Settings → How you dictate → Microphone**, select it, then **Save settings**.
2. Choose **Test input** and speak normally. Check the reported device name and that the meter responds to your voice. The test lasts up to ten seconds and does not save or transcribe audio.
3. Stop the test and dictate into TextEdit. Check that the first and last words survive. A meter proves input activity, not transcription quality.

**System default** follows macOS. A specifically selected microphone must remain connected; Terry reports its loss instead of silently selecting another device. On another Mac, select the microphone again. Device IDs do not transfer reliably.

## Sounds and first words

| Setting | What to expect |
|---|---|
| **Off** | No activation sound. Capture starts opening at the trigger. |
| **Quick buzz** | A generated 60 ms cue. Capture does not wait for playback. |
| **Mac chime** or **Terry voice** | Playback finishes, followed by a 150 ms settling pause, before capture begins. Wait for the microphone bars. |
| **Keep microphone ready** | Explicit opt-in to keep the selected mic active between dictations. At most 500 ms of rolling idle audio stays inside the worklet; unused audio is discarded. |

With readiness off, macOS must open the microphone on each activation. The cue is not proof that the first audio frame has arrived. Readiness closes on disable, device change, lock, sleep and Quit, and prepares again after unlock when enabled. The system microphone indicator may remain visible while ready mode is enabled.

For voice clips, select a local folder under **Activation sound → Terry voice**. Choose one **Voice clip** or **Rotate all clips**, then save. Filename order controls rotation. Supported formats: MP3, WAV, M4A, AIFF and CAF. Playback is capped at four seconds; the folder is limited to 50 clips of up to 5 MB each. Previews do not advance rotation. Clips are not included with the app.

**Mute other audio while dictating** silences other apps, whose playback timelines continue. Output returns when recording ends. The Core Audio transition can take roughly 700 ms on the tested setup. Quick buzz and capture do not wait for that transition, so some initial background sound can remain. Terry does not record other apps' output through the muting tap.

## Improve wrong words and names

0. Keep **Local cleanup → Clean up my transcript** off while diagnosing recognition.
1. Set **Speech engine → Language → English** for English-only speech. Use automatic detection with a multilingual model when appropriate.
2. In **How you dictate → Vocabulary**, enter a short comma-separated list of correct names and terms. For example: `Alex, Example Studio, TypeScript`. Save. The limit is 1,000 characters.
3. Repeat the same sentence with the same microphone. Expand **View raw transcription** and compare the words, especially names and numbers. Hints influence recognition; they are not guaranteed replacements or model training. Terry does not learn automatically when you edit pasted text.
4. If mistakes persist, follow the [model comparison procedure](BENCHMARKS.md#compare-models-on-your-own-mac). Change one factor at a time.

Missing first words usually need a capture/readiness check. Wrong words in the middle need a model, vocabulary or microphone-quality comparison. Cleanup may improve readability but can change wording; it cannot recover audio that was never captured.

## When something goes wrong

| What you see | Next action |
|---|---|
| **Copied only** | Open the main window and read the reason attached to the transcript. Confirm Accessibility permission and the original app's editable field. Paste manually with Command + V if needed. |
| **Paste sent**, but no insertion | The event was sent; destination acceptance is not guaranteed. Test an empty TextEdit document as a control, then retry the target app. |
| Speech detection is unavailable | Run `brew upgrade whisper-cpp` in Terminal, then rebuild/reinstall Terry. The app requires `whisper-vad-speech-segments` beside `whisper-cli`; it does not bypass a broken detector. |
| No microphone activity | Run **Test input**, confirm the actual device name and check **System Settings → Privacy & Security → Microphone**. |
| Wrong/missing model | In **Speech engine**, choose the installed `whisper-cli` and compatible GGML `.bin` model. A safetensors file is not interchangeable. |
| Sound remains muted | Cancel and use **Terry menu → Quit Terry Tibbs** to release the owned helper, then reopen. Record macOS and engine versions when reporting a repeatable problem. |
| Interrupted recording | Use **Retry audio** when available. Retry copies its result and does not automatically paste into a newly focused app. |

**× (Clear transcript)** removes the retained app result/audio, not the system clipboard or another app's pasted text. Closing the window leaves Terry running. Use **Terry menu → Quit Terry Tibbs** to stop it.
