# Install Terry on another Mac

[Home](../README.md) · [Models and hardware](MODELS-AND-HARDWARE.md) · [Everyday use](USER-GUIDE.md)

This guide builds the current app from source. A signed public installer is not available from this checkout. You need internet for initial downloads; ordinary dictation works offline afterwards.


## Shortest source installation

0. Complete the platform and developer-tool prerequisites below, download the public source ZIP and open Terminal in its extracted folder. This command uses Turbo; use the smaller-model route for an 8 GB trial.
1. Run `npm run install:mac`. It performs `npm ci`, setup, packaging, copies the app to `~/Applications`, and opens it. It refuses to overwrite an existing installation. Use `npm run install:mac -- --check` to check prerequisites without installing.
2. Complete first-launch permissions below. Check the microphone menu icon, then hold/release twice in TextEdit and check both sentences paste. macOS privacy consent cannot be silently automated.

## DMG preview installation

0. The current DMG is ARM64, unsigned and unnotarised. The target Mac still needs Homebrew whisper.cpp (including its VAD executable) and a model. The app bundle does not include that runtime. See [release limitations](RELEASE.md).
1. Build with `npm ci` then `npm run dist`, or obtain the maintainer's verified preview DMG. Open the DMG in Finder, drag **Terry Tibbs.app** onto **Applications**, eject the disk, and open the installed copy.
2. Configure the target Mac's own engine/model and grant the permissions below. A successful Finder copy alone does not mean dictation is ready.

## Before you begin

0. On the target Mac, open **Apple menu → About This Mac** and check the chip, memory and macOS version. Use Apple Silicon and macOS 15 or newer for the current supported Homebrew route. MacBook Neo is a trial target with 8 GB, covered below. Plan for at least 10 GB free space for dependencies, build output and a model; developer tools may need additional space. This is a planning allowance, not measured minimum disk usage. In Terminal, check:

   ```sh
   uname -m
   sw_vers -productVersion
   ```

   `uname -m` should print `arm64`. If it prints `x86_64` on Apple Silicon, use a native Terminal, not Rosetta. Intel Macs are outside the current Terry setup. The app's background muting feature itself requires macOS 14.2, but this guide uses the newer [Homebrew-supported OS baseline](https://docs.brew.sh/Installation).

## Get the source onto the new Mac

1. After installing the prerequisites below, clone the public repository in Terminal:

   ```sh
   git clone https://github.com/DilrajAhdan/terrytibbs.git
   cd terrytibbs
   npm run install:mac
   ```

   Alternatively, choose **Code → Download ZIP** at [the repository](https://github.com/DilrajAhdan/terrytibbs), extract it, open Terminal in the extracted folder and run `npm run install:mac`. This uses Turbo. Follow the manual smaller-model route below for an 8 GB trial. Manual installation steps refer to the folder you extracted or cloned, not a required fixed folder name.

## Install the tools

2. On the target Mac, open **Terminal** and install the Apple developer tools:

   ```sh
   xcode-select --install
   ```

   Complete the macOS installer, then check:

   ```sh
   xcode-select -p
   swiftc --version
   ```

   An existing-tools message is fine if both checks succeed. Install Homebrew using its instructions at [brew.sh](https://brew.sh), including the shell setup it displays. Then run:

   ```sh
   /opt/homebrew/bin/brew install node@22 whisper.cpp
   export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
   node --version
   npm --version
   /opt/homebrew/bin/whisper-cli --help
   ```

   Node must be 22.12 or newer. Keep using this Terminal for the remaining commands; the `export` applies to this session. The engine package is now called **whisper.cpp**; **whisper-cpp** is its former name. [Official Homebrew formula](https://formulae.brew.sh/formula/whisper.cpp)

3. Enter the extracted source and install its pinned JavaScript dependencies:

   ```sh
   cd /path/to/your/terrytibbs
   npm ci
   ```

   Choose **one** model route below. On the Neo, start with the smaller-model route. You do not need Python, PyTorch, an OpenAI account or Ollama for this installation.

## Default model route: Turbo

4. Run:

   ```sh
   npm run setup
   ```

   This builds native helpers and downloads the pinned 1.62 GB Turbo model, checking its SHA-256. It uses the already installed engine, or installs the Homebrew package if missing. Wait for **Model verified** or **Whisper Turbo is already downloaded and verified**, followed by **Setup complete**. Continue to step 5 below.

## MacBook Neo: use a smaller model first

4. Skip `npm run setup` for this route because it always downloads Turbo. Download `small.en` instead using this complete block in Terminal:

   ```sh
   (
     set -eu
     terry_models="$HOME/Library/Application Support/Terry Tibbs/models"
     mkdir -p "$terry_models"
     cd "$terry_models"
     curl --fail --location --retry 3 \
       --output ggml-small.en.bin.partial \
       'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en.bin'
     printf '%s  %s\n' \
       'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' \
       'ggml-small.en.bin.partial' | shasum -a 256 --check
     mv ggml-small.en.bin.partial ggml-small.en.bin
   )
   ```

   Expect **ggml-small.en.bin.partial: OK** before the file is renamed. A failed download/check must be retried, not selected in Terry. The download is 487,614,201 bytes. It is English-only. Upstream file identity is recorded in [the model guide](MODELS-AND-HARDWARE.md). The next packaging step also builds the native helpers, so skipping setup does not skip them.

   This is a conservative starting suggestion for the Neo, not a measured performance guarantee. If slow, compare `base.en`; if accuracy is insufficient, compare Turbo while watching memory pressure. Keep cleanup off for the first trial.

## Build and install the app

5. Still in the source folder, run:

   ```sh
   npm run package
   open release/mac-arm64
   ```

   Check that Finder shows **Terry Tibbs.app**. Drag it into **Applications**, then open the Applications copy. Quit an older Terry before replacing it. Keep a copy of the previous app if you need to roll back.

   This build is unsigned and unnotarised. If macOS blocks the trusted source build, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it, and confirm the displayed app is the one you built. Do not disable Gatekeeper globally. See [Apple's instructions](https://support.apple.com/en-gb/102445).

   The app is not self-contained: the target Mac needs its own installed `whisper-cli`, its Homebrew libraries and a model. Copying a Homebrew executable from another Mac is not an installation. Build again on the target Mac if you are transferring source rather than the app bundle.

## First launch and permissions

6. Click the microphone icon in the macOS menu bar to open the Terry menu. Open **Terry menu → Settings → Speech engine**. Check **Whisper command** points to `/opt/homebrew/bin/whisper-cli`. Choose it if needed. For Neo's smaller-model route, choose **Model file → Choose**, press **Command + Shift + G**, enter `~/Library/Application Support/Terry Tibbs/models`, and select **ggml-small.en.bin**. Select **English** and save. The default route should already point to Turbo.
7. Under **How you dictate → Microphone**, leave **System default** selected and choose **Test input**. Grant the microphone prompt, speak and check the level meter. Choose **Stop test → Refresh inputs**, then select the target Mac's actual named microphone. Choose **Off** or **Quick buzz**, leave **Keep microphone ready** off until you explicitly want an idle active microphone, and save. Leave **Local cleanup → Clean up my transcript** off. Choose **Record shortcut**, press and release the preferred shortcut, select **Use shortcut**, and save. For Globe/Fn, use **Use Globe / Fn** directly.
8. Open **Terry menu → Settings → Mac permissions → Accessibility** and allow Terry in **System Settings → Privacy & Security → Accessibility**. If the helper is separately listed or macOS requests Input Monitoring, grant the specifically named Terry helper/app, then reopen Terry if needed. Development runs may be named Electron; prefer the packaged app. No Screen Recording permission is required.
9. Check, in order, in a new **TextEdit** document: hold/release inserts a sentence; double-tap shows a lock immediately and the next press finishes and inserts; Escape cancels with no insertion; closing Terry's window leaves the shortcut available; **Terry menu → Quit Terry Tibbs** stops it. An empty result is a pass only for the cancellation check. If it only copies, follow [paste troubleshooting](USER-GUIDE.md#when-something-goes-wrong).
10. On the Neo, open **Activity Monitor → Memory**, keep your usual apps open, and repeat a few short and longer dictations. Record the selected model, waiting time, wrong words and memory pressure. This physical check is still needed before calling the Neo installation validated.

## Transfer, updates and removal

Transfer the source or trusted app bundle and, optionally, verified model files. Set microphone, shortcut and permissions afresh on the new Mac; do not copy the old Mac's complete settings file. Copy vocabulary text deliberately through Settings if wanted. Models live in `~/Library/Application Support/Terry Tibbs/models`.

To update a source build, keep a backup of the old app, obtain the new source, run `npm ci` and `npm run package`, quit Terry, then replace the Applications copy. Model downloads need not be repeated when the same verified file is already present. Test recording and pasting again; macOS may require permission renewal after an unsigned rebuild.

To remove Terry, quit it and move its app to the Bin. Its model/settings folder remains until you deliberately remove it. Deleting that folder also removes your vocabulary and local preferences. This does not uninstall shared Homebrew dependencies or erase text already on the clipboard or in other apps.

### Speech detector requirement (0.6.2+)

The build downloads and verifies the 885 KB Silero detector, then includes it in the app. Dictation stays offline. The tested Homebrew whisper.cpp version is 1.9.4 and includes `whisper-vad-speech-segments`. If an older installation lacks that command, run `brew upgrade whisper.cpp` before building. If you choose a custom Whisper executable, the detector command must be alongside it.

Check a spoken sentence first, then trigger and finish without speaking. The second attempt should show **No speech**, leave the previous transcript visible and leave your clipboard unchanged. Empty output is the passing result for the silent attempt.
