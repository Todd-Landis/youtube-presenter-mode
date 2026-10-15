// Draws the extension's PNG icons. Usage: swift scripts/make-icons.swift extension/icons
import AppKit

func draw(size: Int, toolbar: Bool, to path: String) {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let glyph: NSColor
    let screen: NSRect
    let stand: NSRect
    let line: CGFloat
    if toolbar {
        glyph = NSColor(white: 0.15, alpha: 1)
        screen = NSRect(x: s * 0.08, y: s * 0.27, width: s * 0.84, height: s * 0.58)
        stand = NSRect(x: s * 0.3, y: s * 0.1, width: s * 0.4, height: s * 0.08)
        line = max(1.5, s * 0.1)
    } else {
        let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.22, yRadius: s * 0.22)
        NSGradient(starting: NSColor(red: 0.20, green: 0.21, blue: 0.26, alpha: 1),
                   ending: NSColor(red: 0.08, green: 0.08, blue: 0.11, alpha: 1))!.draw(in: bg, angle: -90)
        glyph = .white
        screen = NSRect(x: s * 0.18, y: s * 0.33, width: s * 0.64, height: s * 0.44)
        stand = NSRect(x: s * 0.38, y: s * 0.22, width: s * 0.24, height: s * 0.05)
        line = s * 0.05
    }
    glyph.setStroke()
    glyph.setFill()
    let tv = NSBezierPath(roundedRect: screen.insetBy(dx: line / 2, dy: line / 2), xRadius: line * 1.2, yRadius: line * 1.2)
    tv.lineWidth = line
    tv.stroke()
    NSBezierPath(roundedRect: stand, xRadius: stand.height / 2, yRadius: stand.height / 2).fill()

    let play = NSBezierPath()
    let cx = screen.midX + screen.width * 0.03, cy = screen.midY, r = screen.height * (toolbar ? 0.26 : 0.24)
    play.move(to: NSPoint(x: cx - r * 0.8, y: cy - r))
    play.line(to: NSPoint(x: cx - r * 0.8, y: cy + r))
    play.line(to: NSPoint(x: cx + r, y: cy))
    play.close()
    (toolbar ? glyph : NSColor(red: 1, green: 0.27, blue: 0.23, alpha: 1)).setFill()
    play.fill()

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "extension/icons"
for size in [48, 96, 128, 256, 512] { draw(size: size, toolbar: false, to: "\(out)/icon-\(size).png") }
for size in [16, 32] { draw(size: size, toolbar: true, to: "\(out)/toolbar-\(size).png") }
print("icons written to \(out)")
