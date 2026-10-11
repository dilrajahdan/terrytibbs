# Rebuild the tutorial

This tooling records the real development app with a temporary profile. It is not part of the installed app. The microphone is replaced with a known prerecorded speech sample and shortcuts enter at the test event boundary. It verifies real local inference and clipboard delivery, not physical keyboard events or paste into another application.

0. On a Mac, install the project dependencies and build the app. Have `ffmpeg`, `ffprobe`, Python with Pillow and a local Whisper model available. Supply `ELEVENLABS_API_KEY` through your local environment. Never put a key in this repository. Narration generation is a paid external service; only the public tutorial script and neutral demo sentence are sent. Ordinary Terry dictation remains offline.
1. Run `node scripts/tutorial/narrate.mjs`. It checks quota and caches voice clips in ignored `artifacts/tutorial`. Review `story.json` before generating.
2. Set `TERRY_DEMO_MODEL` to the absolute path of your local Turbo model. Run `node scripts/tutorial/capture.mjs --rehearse`, then `node scripts/tutorial/capture.mjs`.
3. Run `python3 scripts/tutorial/render.py`. The renderer uses ffmpeg and the macOS Arial font. It creates a narrated MP4 with burned captions plus `docs/tutorial-captions.srt`. Delete the ignored `walkthrough.webm` before rendering a new capture; otherwise the existing raw encode is reused.
4. Inspect each chapter, the audio and caption timing. Check settings show the intended control and the transcript matches the sample. Publish only the reviewed MP4 and poster to public media hosting. Update `docs/tutorial-media.json` and the README links.

All raw captures, speech files and temporary profiles stay outside Git. Do not record a personal profile. The video does not benchmark latency: gaps are edited and final frames are held for narration.
