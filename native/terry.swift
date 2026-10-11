import AppKit
import ApplicationServices
import Darwin

private let outputLock = NSLock()
// Identify our own paste events so a user-chosen Command+V shortcut cannot
// intercept the output it just produced. This is event routing, not authorisation.
private let terryPasteEventTag: Int64 = 0x5454525950415354

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          var line = String(data: data, encoding: .utf8)?.data(using: .utf8) else { return }
    line.append(0x0a)
    outputLock.lock()
    FileHandle.standardOutput.write(line)
    outputLock.unlock()
}

enum FocusEditability: String { case editable, secure, unavailable }

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func focusedElement(pid: pid_t) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.25)
    guard let value = attribute(application, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func focusEditability(pid: pid_t, prepare: Bool = true) -> FocusEditability {
    guard AXIsProcessTrusted() else { return .unavailable }
    if prepare {
        // Electron documents this opt-in for assistive applications. It enables
        // its AX tree, without modifying text, focus or any macOS permission.
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.25)
        AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }
    guard let element = focusedElement(pid: pid) else { return .unavailable }
    let role = attribute(element, kAXRoleAttribute as String) as? String ?? ""
    let subrole = attribute(element, kAXSubroleAttribute as String) as? String ?? ""
    if subrole == (kAXSecureTextFieldSubrole as String) { return .secure }
    let textRoles = Set([kAXTextFieldRole as String, kAXTextAreaRole as String, kAXComboBoxRole as String])
    guard textRoles.contains(role) else { return .unavailable }
    if let enabled = attribute(element, kAXEnabledAttribute as String) as? Bool, !enabled { return .unavailable }
    var valueSettable = DarwinBoolean(false)
    var selectionSettable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
    AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &selectionSettable)
    return valueSettable.boolValue || selectionSettable.boolValue ? .editable : .unavailable
}

// Key state is distinct from the aggregate flags attached to synthetic V events.
// Check both physical keys in each family, rather than trusting a stale flag.
func physicalModifierFlags(isDown: (CGKeyCode) -> Bool = { CGEventSource.keyState(.hidSystemState, key: $0) }) -> CGEventFlags {
    var flags: CGEventFlags = []
    for (left, right, mask): (CGKeyCode, CGKeyCode, CGEventFlags) in [
        (55, 54, .maskCommand), (59, 62, .maskControl),
        (58, 61, .maskAlternate), (56, 60, .maskShift)
    ] {
        if isDown(left) || isDown(right) { flags.insert(mask) }
    }
    return flags
}

enum ModifierFamily: String, Hashable, CaseIterable { case command, control, option, shift, fn }

struct Shortcut {
    let keyCode: CGKeyCode?
    let families: Set<ModifierFamily>
    let specificModifiers: [ModifierFamily: CGKeyCode]
}

let modifierKeyCodes: [CGKeyCode: ModifierFamily] = [
    55: .command, 54: .command, 59: .control, 62: .control, 58: .option, 61: .option,
    56: .shift, 60: .shift, 63: .fn
]

let modifierNames: [String: (ModifierFamily, CGKeyCode?)] = [
    "command": (.command, nil), "cmd": (.command, nil), "commandorcontrol": (.command, nil), "super": (.command, nil),
    "leftcommand": (.command, 55), "rightcommand": (.command, 54),
    "control": (.control, nil), "ctrl": (.control, nil), "leftcontrol": (.control, 59), "rightcontrol": (.control, 62),
    "option": (.option, nil), "alt": (.option, nil), "leftoption": (.option, 58), "rightoption": (.option, 61),
    "shift": (.shift, nil), "leftshift": (.shift, 56), "rightshift": (.shift, 60), "fn": (.fn, 63)
]

let regularKeyCodes: [String: CGKeyCode] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
    "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
    "Space": 49,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
    "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
    "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90
]

func parseShortcut(_ raw: String) -> Shortcut? {
    let parts = raw.split(separator: "+", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
    guard !parts.isEmpty, !parts.contains(where: { $0.isEmpty }) else { return nil }
    var families = Set<ModifierFamily>()
    var specific: [ModifierFamily: CGKeyCode] = [:]
    var keyCode: CGKeyCode?
    for part in parts {
        if let modifier = modifierNames[part.lowercased()] {
            guard !families.contains(modifier.0) else { return nil }
            families.insert(modifier.0)
            if let code = modifier.1 { specific[modifier.0] = code }
            continue
        }
        let canonical = part.caseInsensitiveCompare("space") == .orderedSame ? "Space" : part.uppercased()
        guard keyCode == nil, let code = regularKeyCodes[canonical] else { return nil }
        keyCode = code
    }
    if keyCode == nil && specific.isEmpty { return nil }
    if families.isEmpty, let keyPart = parts.first, !keyPart.uppercased().hasPrefix("F") { return nil }
    return Shortcut(keyCode: keyCode, families: families, specificModifiers: specific)
}

func familyIsActive(_ family: ModifierFamily, flags: CGEventFlags, pressed: Set<CGKeyCode>) -> Bool {
    switch family {
    case .command: return flags.contains(.maskCommand)
    case .control: return flags.contains(.maskControl)
    case .option: return flags.contains(.maskAlternate)
    case .shift: return flags.contains(.maskShift)
    case .fn: return flags.contains(.maskSecondaryFn) || pressed.contains(63)
    }
}

final class HotkeyWatcher {
    let shortcut: Shortcut
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var runLoop: CFRunLoop?
    var pressedModifiers = Set<CGKeyCode>()
    var suppressedKeys = Set<CGKeyCode>()
    var currentFlags: CGEventFlags = []
    var active = false
    var suspended = false
    var disabledCount = 0
    var captureFnHeld = false
    var captureUsedKey = false

    init(shortcut: Shortcut) { self.shortcut = shortcut }

    func start() -> Bool {
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
            | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                eventsOfInterest: mask, callback: hotkeyCallback,
                                userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap else {
            emit(["type": "unavailable", "message": "Allow Terry Tibbs in Accessibility and Input Monitoring, then try again."])
            return false
        }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        guard let source else {
            emit(["type": "unavailable", "message": "The shortcut monitor could not start."])
            return false
        }
        runLoop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            emit(["type": "unavailable", "message": "Allow Terry Tibbs in Accessibility and Input Monitoring, then try again."])
            return false
        }
        emit(["type": "ready"])
        return true
    }

    func matchesModifiers() -> Bool {
        // Fn is often a hardware layer used to produce F-key events. Treat it as a
        // required modifier only when the saved shortcut names it explicitly.
        let activeFamilies = Set(ModifierFamily.allCases.filter {
            ($0 != .fn || shortcut.families.contains(.fn)) && familyIsActive($0, flags: currentFlags, pressed: pressedModifiers)
        })
        guard activeFamilies == shortcut.families else { return false }
        for (family, code) in shortcut.specificModifiers {
            guard pressedModifiers.contains(code) else { return false }
            if pressedModifiers.contains(where: { modifierKeyCodes[$0] == family && $0 != code }) { return false }
        }
        return true
    }

    func sendRelease(cancel: Bool, message: String? = nil) {
        guard active else { return }
        active = false
        var value: [String: Any] = ["type": cancel ? "cancel" : "up"]
        if let message { value["message"] = message }
        emit(value)
    }

    func setSuspended(_ paused: Bool) {
        if paused != suspended {
            suspended = paused
            if paused { sendRelease(cancel: true, message: "Shortcut capture was suspended.") }
            pressedModifiers.removeAll()
            suppressedKeys.removeAll()
            currentFlags = []
        }
        captureFnHeld = false
        captureUsedKey = false
        // The caller must not install or remove its local key listeners until
        // the global event tap has actually changed state. Acknowledge no-ops too.
        emit(["type": "suspended", "paused": paused])
    }

    func stop() {
        sendRelease(cancel: true, message: "The shortcut monitor stopped.")
        if let tap { CFMachPortInvalidate(tap) }
        if let runLoop { CFRunLoopStop(runLoop) }
    }

    func recoverTap(reason: String) {
        if active { sendRelease(cancel: true, message: reason) }
        else { emit(["type": "cancel", "message": reason]) }
        pressedModifiers.removeAll()
        suppressedKeys.removeAll()
        currentFlags = []
        disabledCount += 1
        guard disabledCount <= 3, let tap else {
            emit(["type": "unavailable", "message": "The shortcut monitor was disabled repeatedly."])
            stop()
            return
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        if !CGEvent.tapIsEnabled(tap: tap) {
            emit(["type": "unavailable", "message": "The shortcut monitor could not be re-enabled."])
            stop()
        }
    }

    // Only function keys are observed here, and only during explicit shortcut
    // recording. Ordinary typing stays with the focused renderer's recorder.
    func captureFunctionKey(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        if type == .flagsChanged && code == 63 {
            let down = event.flags.contains(.maskSecondaryFn)
            if !down && captureFnHeld && !captureUsedKey {
                emit(["type": "candidate", "shortcut": "Fn"])
            }
            captureFnHeld = down
            if down { captureUsedKey = false }
            return nil
        }
        if type == .keyDown { captureUsedKey = true }
        guard let key = regularKeyCodes.first(where: { $0.value == code && $0.key.hasPrefix("F") && $0.key.count > 1 })?.key else {
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            var parts: [String] = []
            if event.flags.contains(.maskCommand) { parts.append("Command") }
            if event.flags.contains(.maskControl) { parts.append("Control") }
            if event.flags.contains(.maskAlternate) { parts.append("Option") }
            if event.flags.contains(.maskShift) { parts.append("Shift") }
            // macOS also sets SecondaryFn on standalone hardware F keys.
            // It must not turn F13 into an unusable Fn+F13 shortcut.
            parts.append(key)
            emit(["type": "candidate", "shortcut": parts.joined(separator: "+")])
        }
        return nil
    }

    func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout {
            recoverTap(reason: "The shortcut monitor timed out and was reset.")
            return Unmanaged.passUnretained(event)
        }
        if type == .tapDisabledByUserInput {
            recoverTap(reason: "The shortcut monitor was disabled and was reset.")
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == terryPasteEventTag { return Unmanaged.passUnretained(event) }
        if suspended { return captureFunctionKey(type: type, event: event) }

        let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        currentFlags = event.flags
        if type == .flagsChanged, let family = modifierKeyCodes[code] {
            if pressedModifiers.contains(code) { pressedModifiers.remove(code) }
            else if familyIsActive(family, flags: currentFlags, pressed: pressedModifiers) { pressedModifiers.insert(code) }

            let wasActive = active
            let matches = matchesModifiers()
            if shortcut.keyCode == nil {
                if matches && !active { active = true; emit(["type": "down"]) }
                else if active && !matches { sendRelease(cancel: false) }
                let required = shortcut.families.contains(family)
                return required && (wasActive || active || shortcut.specificModifiers[family] == code) ? nil : Unmanaged.passUnretained(event)
            }
            if active && !matches { sendRelease(cancel: false) }
            // A keyed chord's modifier down was already delivered before the
            // key made the shortcut identifiable, so its modifier up must pass too.
            return Unmanaged.passUnretained(event)
        }

        guard let shortcutCode = shortcut.keyCode, code == shortcutCode else { return Unmanaged.passUnretained(event) }
        if type == .keyDown {
            let repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            if repeated { return suppressedKeys.contains(code) ? nil : Unmanaged.passUnretained(event) }
            guard matchesModifiers() else { return Unmanaged.passUnretained(event) }
            suppressedKeys.insert(code)
            if !active { active = true; emit(["type": "down"]) }
            return nil
        }
        if type == .keyUp, suppressedKeys.remove(code) != nil {
            sendRelease(cancel: false)
            return nil
        }
        return Unmanaged.passUnretained(event)
    }
}

func hotkeyCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                    userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    return Unmanaged<HotkeyWatcher>.fromOpaque(userInfo).takeUnretainedValue().handle(type: type, event: event)
}

let action = CommandLine.arguments.dropFirst().first ?? "status"
if action == "request-accessibility" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["trusted": AXIsProcessTrustedWithOptions(options)])
} else if action == "status" || action == "frontmost" {
    let app = NSWorkspace.shared.frontmostApplication
    let pid = app?.processIdentifier ?? 0
    let focus = pid > 0 ? focusEditability(pid: pid) : .unavailable
    emit(["trusted": AXIsProcessTrusted(), "pid": pid, "name": app?.localizedName ?? "",
          "bundleId": app?.bundleIdentifier ?? "", "editable": focus == .editable, "focus": focus.rawValue])
} else if action == "paste", CommandLine.arguments.count == 3,
          let pid = Int32(CommandLine.arguments[2]) {
    guard AXIsProcessTrusted() else { emit(["ok": false, "reason": "accessibility"]); exit(2) }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        emit(["ok": false, "reason": "focus_changed"]); exit(3)
    }
    var focus = focusEditability(pid: pid)
    // AXManualAccessibility may build the web editor tree asynchronously.
    if focus == .unavailable {
        for _ in 0..<4 {
            usleep(25_000)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
                emit(["ok": false, "reason": "focus_changed"]); exit(3)
            }
            focus = focusEditability(pid: pid, prepare: false)
            if focus != .unavailable { break }
        }
    }
    switch focus {
    case .editable: break
    case .secure: emit(["ok": false, "reason": "secure_field"]); exit(4)
    case .unavailable: emit(["ok": false, "reason": "non_editable"]); exit(4)
    }
    // Never activate another application or send Return. Paste only at the original editable focus.
    // Check physical hardware state: session flags can retain an intercepted
    // shortcut or synthetic Command+V even after the physical key is released.
    // Never let a genuinely held modifier turn paste into another action.
    let modifiers: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
    for _ in 0..<10 {
        if physicalModifierFlags().intersection(modifiers).isEmpty { break }
        usleep(20_000)
    }
    guard physicalModifierFlags().intersection(modifiers).isEmpty else {
        emit(["ok": false, "reason": "modifiers_held"]); exit(6)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          focusEditability(pid: pid, prepare: false) == .editable else {
        emit(["ok": false, "reason": "focus_changed"]); exit(3)
    }
    let source = CGEventSource(stateID: .privateState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false),
          let pressCommand = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: true),
          let releaseCommand = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: false) else {
        emit(["ok": false, "reason": "event_failed"]); exit(5)
    }
    // Balance our synthetic Command flag so subsequent dictations start cleanly.
    pressCommand.type = .flagsChanged
    pressCommand.flags = .maskCommand
    pressCommand.setIntegerValueField(.eventSourceUserData, value: terryPasteEventTag)
    releaseCommand.type = .flagsChanged
    releaseCommand.setIntegerValueField(.eventSourceUserData, value: terryPasteEventTag)
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.setIntegerValueField(.eventSourceUserData, value: terryPasteEventTag)
    up.setIntegerValueField(.eventSourceUserData, value: terryPasteEventTag)
    pressCommand.post(tap: .cghidEventTap)
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
    releaseCommand.flags = []
    releaseCommand.post(tap: .cghidEventTap)
    usleep(30_000)
    emit(["ok": true])
} else if action == "watch-hotkey", CommandLine.arguments.count == 3,
          let shortcut = parseShortcut(CommandLine.arguments[2]) {
    signal(SIGPIPE, SIG_IGN)
    let watcher = HotkeyWatcher(shortcut: shortcut)
    guard watcher.start() else { exit(2) }
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine(strippingNewline: true) {
            guard line.utf8.count <= 4_096, let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let paused = object["suspend"] as? Bool else { continue }
            DispatchQueue.main.async { watcher.setSuspended(paused) }
        }
        DispatchQueue.main.async { watcher.stop() }
    }
    CFRunLoopRun()
} else {
    emit(["ok": false, "reason": "invalid_command"])
    exit(1)
}
