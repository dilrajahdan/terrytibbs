// Integration fixture. Keeps the user's full original pasteboard in memory only.
import AppKit
let board = NSPasteboard.general
func snapshot() -> [[String: Data]] {
    (board.pasteboardItems ?? []).map { item in Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type.rawValue, $0) } }) }
}
func restore(_ values: [[String: Data]]) {
    let items = values.map { value -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in value { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
        return item
    }
    board.clearContents()
    if !items.isEmpty { board.writeObjects(items) }
}
let original = snapshot()
var expected = original
func emit(_ value: [String: Any]) { let d = try! JSONSerialization.data(withJSONObject: value); print(String(data: d, encoding: .utf8)!); fflush(stdout) }
emit(["ready": true])
while let line = readLine() {
    if line == "restore" { restore(original); emit(["restored": snapshot() == original]); break }
    if line == "check" { emit(["matches": snapshot() == expected, "expected": expected.map { $0.mapValues { $0.count } }, "actual": snapshot().map { $0.mapValues { $0.count } }]); continue }
    if line == "new" { board.clearContents(); board.setString("New copy during paste", forType: .string); expected = snapshot(); emit(["seeded": true]); continue }
    if line == "same" { let text = board.string(forType: .string) ?? ""; board.clearContents(); board.setString(text, forType: .string); expected = snapshot(); emit(["seeded": true]); continue }
    if line == "empty" { restore([]) }
    if line == "rich" { restore([
        ["public.utf8-plain-text": Data(String(repeating: "Original large clipboard. ", count: 80000).utf8), "public.html": Data("<b>Keep this rich content</b>".utf8), "public.rtf": Data("{\\rtf1 Original clipboard}".utf8), "dev.terry.fixture": Data(repeating: 42, count: 65536)],
        ["public.file-url": Data("file:///System/Library/CoreServices/SystemVersion.plist".utf8)]
    ]) }
    if line == "image" { restore([["public.png": Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7aYAAAAASUVORK5CYII=")!]]) }
    expected = snapshot(); emit(["seeded": true])
}
