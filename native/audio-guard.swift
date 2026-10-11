import Foundation
import CoreAudio
import AVFoundation
import Darwin

// A private process tap mutes other applications for an active recording lease.
// A private tap-only aggregate owns the tap, which is explicitly unmuted in
// standby. The aggregate is never started, and no IOProc or system-audio buffer
// is created or read.
// The helper is excluded so it can play the user-selected activation cue.
// System volume and mute settings are never read or changed.
// Apple: https://developer.apple.com/documentation/coreaudio/catapdescription
// Apple: https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps

private func emit(_ value: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    data.append(0x0a)
    do { try FileHandle.standardOutput.write(contentsOf: data) }
    catch { exit(1) } // Process death also releases the process-owned private tap.
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
}

private func ownAudioProcess() -> AudioObjectID? {
    var address = propertyAddress(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var pid = getpid()
    var process = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &process)
    return status == noErr && process != kAudioObjectUnknown ? process : nil
}

// Generated locally, with no sample file or leading silence. A short downward
// pulse with a soft attack/release gives a quiet retro buzz without a hard click.
private func activationBuzz() -> AVAudioPCMBuffer? {
    let rate = 48_000
    let count = 2_880 // 60 ms
    guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1),
          let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
          let samples = pcm.floatChannelData?[0] else { return nil }
    pcm.frameLength = AVAudioFrameCount(count)
    var phase = 0.0
    for frame in 0..<count {
        let time = Double(frame) / Double(rate)
        let progress = Double(frame) / Double(count - 1)
        let frequency = 1_300.0 - 500.0 * progress
        phase += 2 * Double.pi * frequency / Double(rate)
        let attack = min(1, time / 0.003)
        let release = min(1, (0.06 - time) / 0.012)
        let wave = sin(phase) + 0.22 * sin(phase * 3) + 0.08 * sin(phase * 5)
        samples[frame] = Float(wave * attack * release * 0.085)
    }
    return pcm
}

@available(macOS 14.2, *)
private final class AudioGuard: NSObject, AVAudioPlayerDelegate {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var tapUUID = UUID()
    private var process = AudioObjectID(kAudioObjectUnknown)
    private var player: AVAudioPlayer?
    private var buzzEngine: AVAudioEngine?
    private var buzzNode: AVAudioPlayerNode?
    private var buzzBuffer: AVAudioPCMBuffer?
    private var outputChangeObserver: NSObjectProtocol?
    private var cueID: String?
    private var cueTimer: DispatchWorkItem?
    private var signals: [DispatchSourceSignal] = []
    private var healthTimer: DispatchSourceTimer?
    private var input = Data()
    private var finished = false
    private var active = false
    private var expectedMuted = false
    private var activeSince: TimeInterval?
    private let parentPID = getppid()

    func start(standby: Bool) {
        // Resolving our PID registers this Core Audio client without opening a mic
        // or emitting an audible priming sound.
        guard let ownProcess = ownAudioProcess() else {
            fail("Could not identify Terry's audio process. Background audio was not muted.")
            return
        }
        process = ownProcess
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [process])
        description.name = "Terry Tibbs temporary background mute"
        description.uuid = tapUUID
        description.isPrivate = true
        description.isExclusive = true
        active = !standby
        expectedMuted = !standby
        description.muteBehavior = expectedMuted ? .muted : .unmuted
        let status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr, tap != kAudioObjectUnknown else {
            fail("macOS could not mute background audio (Core Audio \(status)).")
            return
        }
        // On macOS 15, creating the tap alone leaves the original apps audible.
        // Adding it to an aggregate activates .muted even without starting IO.
        // No output sub-device is rerouted and TapAutoStart is explicitly off.
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Terry Tibbs temporary mute owner",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUUID.uuidString]]
        ]
        let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregate)
        guard aggregateStatus == noErr, aggregate != kAudioObjectUnknown else {
            fail("macOS could not activate background audio muting (Core Audio \(aggregateStatus)).")
            return
        }
        guard tapIsHealthy() else {
            fail("macOS did not confirm the background audio mute.")
            return
        }

        do {
            guard let buffer = activationBuzz() else {
                fail("The quick activation sound could not be prepared.")
                return
            }
            let engine = AVAudioEngine()
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: buffer.format)
            engine.prepare()
            try engine.start()
            // Running an empty output node keeps the output path ready. Nothing
            // is recorded, and no audible priming sound is played in standby.
            node.play()
            buzzEngine = engine
            buzzNode = node
            buzzBuffer = buffer
            outputChangeObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in self?.restartBuzzOutput() }
        } catch {
            fail("The quick activation sound could not be prepared.")
            return
        }
        if active { activeSince = ProcessInfo.processInfo.systemUptime }

        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signals.append(source)
        }
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard getppid() == self.parentPID else { self.stop(); return }
            guard self.tapIsHealthy() else {
                self.fail("Background audio muting stopped. Recording was cancelled.")
                return
            }
            if let since = self.activeSince,
               ProcessInfo.processInfo.systemUptime - since >= 150 {
                self.fail("Background audio muting reached its safety time limit.")
            }
        }
        timer.resume()
        healthTimer = timer
        emit(["type": active ? "ready" : "standby", "tapId": tap, "muted": expectedMuted])
    }

    private func tapIsHealthy() -> Bool {
        guard tap != kAudioObjectUnknown, aggregate != kAudioObjectUnknown else { return false }
        var aggregateAddress = propertyAddress(kAudioAggregateDevicePropertyTapList)
        var tapList: Unmanaged<CFArray>?
        var tapListSize = UInt32(MemoryLayout<Unmanaged<CFArray>?>.size)
        guard AudioObjectGetPropertyData(aggregate, &aggregateAddress, 0, nil, &tapListSize, &tapList) == noErr,
              let uuids = tapList?.takeRetainedValue() as? [String],
              uuids == [tapUUID.uuidString] else { return false }
        var address = propertyAddress(kAudioTapPropertyDescription)
        var description: Unmanaged<CATapDescription>?
        var size = UInt32(MemoryLayout<Unmanaged<CATapDescription>?>.size)
        let status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &description)
        guard status == noErr, let result = description?.takeRetainedValue() else { return false }
        return result.isPrivate && result.isExclusive
            && result.muteBehavior == (expectedMuted ? .muted : .unmuted)
            && result.processes == [process]
    }

    private func setMuted(_ muted: Bool) -> Bool {
        if expectedMuted == muted { return tapIsHealthy() }
        // Removing the tap from an aggregate changed metadata but left real
        // speakers muted in physical testing. Explicit .unmuted restores them.
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [process])
        description.name = "Terry Tibbs temporary background mute"
        description.uuid = tapUUID
        description.isPrivate = true
        description.isExclusive = true
        description.muteBehavior = muted ? .muted : .unmuted
        var value = Unmanaged.passUnretained(description)
        var address = propertyAddress(kAudioTapPropertyDescription)
        let status = AudioObjectSetPropertyData(tap, &address, 0, nil,
                                                UInt32(MemoryLayout.size(ofValue: value)), &value)
        guard status == noErr else { return false }
        expectedMuted = muted
        return tapIsHealthy()
    }

    private func activate(_ command: [String: Any]) {
        guard command["mute"] == nil || command["mute"] is Bool else {
            fail("Invalid background mute command.")
            return
        }
        let muted = command["mute"] as? Bool ?? true
        if command["cue"] != nil {
            guard command["cue"] as? String == "buzz",
                  let id = command["id"] as? String, !id.isEmpty, id.utf8.count <= 128 else {
                fail("Invalid activation sound command.")
                return
            }
        }
        if !active { activeSince = ProcessInfo.processInfo.systemUptime }
        active = true
        if command["cue"] as? String == "buzz", let id = command["id"] as? String {
            // The warm output node renders on its audio thread while Core Audio
            // changes the mute route below. Scheduling the cue first avoids
            // waiting for that potentially slow synchronous property update.
            play(["cue": "buzz", "id": id])
        }
        guard setMuted(muted) else {
            fail("macOS could not confirm background audio muting. Recording was cancelled.")
            return
        }
        emit(["type": "ready", "tapId": tap, "muted": muted])
    }

    private func release() {
        completeCue(ok: false, message: "The activation sound was cancelled.")
        guard setMuted(false) else {
            fail("macOS could not release background audio muting.")
            return
        }
        active = false
        activeSince = nil
        emit(["type": "standby", "tapId": tap, "muted": false])
    }

    private func receive(_ data: Data) {
        guard !finished else { return }
        guard !data.isEmpty else { stop(); return }
        input.append(data)
        guard input.count <= 16_384 else { fail("Invalid audio helper command."); return }
        while let newline = input.firstIndex(of: 0x0a) {
            let line = input.prefix(upTo: newline)
            input.removeSubrange(...newline)
            guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let action = command["action"] as? String else {
                fail("Invalid audio helper command.")
                return
            }
            switch action {
            case "activate": activate(command)
            case "release": release()
            case "play": play(command)
            case "stop": stop()
            case "status": emit(["type": "status", "muted": expectedMuted,
                                  "active": active, "healthy": tapIsHealthy()])
            default: fail("Unknown audio helper command.")
            }
            if finished { return }
        }
    }

    private func play(_ command: [String: Any]) {
        let path = command["path"] as? String
        let isBuzz = command["cue"] as? String == "buzz"
        guard let id = command["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
              (isBuzz && path == nil) || (command["cue"] == nil && path.map { ($0 as NSString).isAbsolutePath } == true) else {
            fail("Invalid activation sound command.")
            return
        }
        guard active else {
            emit(["type": "cue-complete", "id": id, "ok": false,
                  "message": "The activation sound needs an active recording session."])
            return
        }
        guard cueID == nil else {
            emit(["type": "cue-complete", "id": id, "ok": false,
                  "message": "An activation sound is already playing."])
            return
        }
        cueID = id
        do {
            if isBuzz, let node = buzzNode, let buffer = buzzBuffer,
               buzzEngine?.isRunning == true {
                node.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    DispatchQueue.main.async {
                        guard self?.cueID == id else { return }
                        self?.completeCue(ok: true)
                    }
                }
                if !node.isPlaying { node.play() }
            } else if let path {
                let attributes = try FileManager.default.attributesOfItem(atPath: path)
                let bytes = (attributes[.size] as? NSNumber)?.int64Value ?? Int64.max
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      bytes > 0, bytes <= 5 * 1024 * 1024 else {
                    completeCue(ok: false, message: "The activation sound is not a supported local file.")
                    return
                }
                let newPlayer = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
                guard newPlayer.prepareToPlay() else {
                    completeCue(ok: false, message: "The activation sound could not be played.")
                    return
                }
                newPlayer.delegate = self
                newPlayer.numberOfLoops = 0
                player = newPlayer
                guard newPlayer.play() else {
                    completeCue(ok: false, message: "The activation sound could not be played.")
                    return
                }
            } else {
                completeCue(ok: false, message: "The quick activation sound could not be played.")
                return
            }
            let timeout = DispatchWorkItem { [weak self] in
                self?.completeCue(ok: false, message: "The activation sound took too long and was stopped.")
            }
            cueTimer = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
        } catch {
            completeCue(ok: false, message: "The activation sound could not be played.")
        }
    }

    private func completeCue(ok: Bool, message: String? = nil) {
        guard let id = cueID else { return }
        cueID = nil
        cueTimer?.cancel()
        cueTimer = nil
        player?.stop()
        player?.delegate = nil
        player = nil
        buzzNode?.stop()
        if buzzEngine?.isRunning == true { buzzNode?.play() }
        var result: [String: Any] = ["type": "cue-complete", "id": id, "ok": ok]
        if let message { result["message"] = message }
        // This acknowledgement always means playback has stopped. The caller
        // chooses the settling/capture policy appropriate to this cue.
        emit(result)
    }

    private func restartBuzzOutput() {
        guard !finished, let engine = buzzEngine, !engine.isRunning else { return }
        completeCue(ok: false, message: "The audio output changed while the activation sound was playing.")
        do {
            try engine.start()
            buzzNode?.play()
        } catch {
            fail("The quick activation sound could not use the current audio output.")
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        completeCue(ok: flag, message: flag ? nil : "The activation sound could not be played.")
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        completeCue(ok: false, message: "The activation sound could not be decoded.")
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        emit(["type": "error", "message": message])
        stop(exitCode: 1)
    }

    private func stop(exitCode: Int32 = 0) {
        guard !finished else { return }
        finished = true
        FileHandle.standardInput.readabilityHandler = nil
        cueTimer?.cancel()
        player?.stop()
        player?.delegate = nil
        player = nil
        if let observer = outputChangeObserver { NotificationCenter.default.removeObserver(observer) }
        outputChangeObserver = nil
        buzzNode?.stop()
        buzzEngine?.stop()
        buzzNode = nil
        buzzEngine = nil
        buzzBuffer = nil
        healthTimer?.cancel()
        for source in signals { source.cancel() }
        if aggregate != kAudioObjectUnknown {
            let status = AudioHardwareDestroyAggregateDevice(aggregate)
            aggregate = AudioObjectID(kAudioObjectUnknown)
            if status != noErr {
                emit(["type": "error", "message": "Closing the background mute owner (Core Audio \(status))."])
            }
        }
        if tap != kAudioObjectUnknown {
            let status = AudioHardwareDestroyProcessTap(tap)
            tap = AudioObjectID(kAudioObjectUnknown)
            if status != noErr {
                emit(["type": "error", "message": "Closing the background mute helper (Core Audio \(status))."])
            }
        }
        exit(exitCode)
    }
}

signal(SIGPIPE, SIG_IGN)
if #available(macOS 14.2, *) {
    let guardSession = AudioGuard()
    guardSession.start(standby: CommandLine.arguments.contains("--standby"))
    withExtendedLifetime(guardSession) { RunLoop.main.run() }
} else {
    emit(["type": "error", "message": "Background audio muting requires macOS 14.2 or later."])
    exit(1)
}
