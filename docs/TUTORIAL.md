# Terry in 19 seconds

[Watch the 19-second tutorial](https://amopqrboxtncgxjaqitq.supabase.co/storage/v1/object/public/marketing/tutorials/terrytibbs/0.6.4/terry-tibbs-short.mp4?v=2) · [Download captions](tutorial-captions.srt)

**What does it do?** Turns speech into text on your Mac, copies it, and attempts to paste into the text box where you started. It never sends your message.

## First time

0. [Install Terry](INSTALL.md). Allow Microphone and Accessibility in **System Settings → Privacy & Security**.
1. Open **Terry → Settings → Record shortcut**. Press your chosen key and click **Use shortcut**. Or click **Use Globe / Fn**. Click **Save settings**.
2. Choose your microphone at the top of **Settings**. The selection saves immediately. Click **Test input**, speak and check the input meter responds.
3. Open **TextEdit → New Document** and click inside it.

## Your first sentence

1. Hold your chosen shortcut.
2. Speak when Terry shows it is listening.
3. Release. Wait for transcription. Check the words appear in TextEdit.
4. Repeat with a second sentence. Both should be present.

**Only copied?** Click in TextEdit and press **⌘V**. Check Accessibility is allowed, automatic paste is enabled, and the original app stays focused.

## Talk hands-free

1. Double-tap the shortcut. Check the lock icon appears.
2. Speak without holding anything.
3. Press the shortcut once more to finish and output the text.

**Changed your mind?** Escape cancels. Each recording is limited to two minutes.

## Where did the window go?

**Close to menu bar** hides the window and keeps Terry running. Click the TT + microphone icon in the Mac menu bar to open Terry again. **Quit Terry Tibbs** stops it completely.

## About the recording

The short video shows version 0.6.4 with an isolated demonstration profile and a separate local text editor. A prerecorded sample passes through the real capture and local Whisper Turbo pipeline. The production native helper pastes the result into the editor, and the test checks the actual inserted text for both hold/release and locked recording. Shortcut gestures enter at the test-only event boundary, so this does not demonstrate physical keyboard detection. Timing is edited.

The brief “Talk to me” opener uses a supplied clip. It is not bundled with the app or included in the MIT source licence. Tutorial narration uses ElevenLabs George; ordinary dictation remains offline.

## Video transcript

“Talk to me!”

Choose a shortcut. Save it.

Click a text box. Hold your shortcut, speak, then release. Your words appear.

Double-tap to lock. Talk hands-free. Press again to finish.

Free and open source. Install it now.

The final card links to the repository and labels installation as a Mac source install.
