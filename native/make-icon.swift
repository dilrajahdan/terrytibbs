import AppKit
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 1, green: 0.835, blue: 0, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 28, y: 28, width: 968, height: 968), xRadius: 216, yRadius: 216).fill()
NSColor(calibratedRed: 0.09, green: 0.094, blue: 0.086, alpha: 1).setStroke()
let border = NSBezierPath(roundedRect: NSRect(x: 39, y: 39, width: 946, height: 946), xRadius: 205, yRadius: 205)
border.lineWidth = 18
border.stroke()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 425, weight: .black), .foregroundColor: NSColor(calibratedRed: 0.09, green: 0.094, blue: 0.086, alpha: 1)]
let text = NSString(string: "TT")
let textSize = text.size(withAttributes: attrs)
text.draw(at: NSPoint(x: (1024-textSize.width)/2, y: (1024-textSize.height)/2+6), withAttributes: attrs)
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
