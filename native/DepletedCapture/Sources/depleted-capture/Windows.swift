import CoreGraphics
import Foundation
import ScreenCaptureKit

let wowBundleId = "com.blizzard.worldofwarcraft"

func shareableContent() async -> SCShareableContent {
    do {
        return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    } catch {
        fail(
            "Can't list windows (\(error.localizedDescription)). Check that Depleted has Screen Recording "
                + "permission in System Settings → Privacy & Security → Screen Recording."
        )
    }
}

// Picks the window to record: an exact title match for the user's manual choice if one
// was given, otherwise the WoW client (by bundle id, then by title). When several match,
// the biggest wins, which skips WoW's small helper windows.
func resolveWindow(in content: SCShareableContent, hint: String?) -> SCWindow {
    let windows = content.windows.filter { $0.frame.width >= 100 && $0.frame.height >= 100 }
    let biggest: ([SCWindow]) -> SCWindow? = { candidates in
        candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    if let hint, !hint.isEmpty, hint != "auto" {
        if let w = biggest(windows.filter { $0.title == hint }) { return w }
        log("window \"\(hint)\" not found, falling back to auto-detect")
    }

    if let w = biggest(windows.filter { $0.owningApplication?.bundleIdentifier == wowBundleId }) { return w }
    if let w = biggest(windows.filter { $0.title?.caseInsensitiveCompare("World of Warcraft") == .orderedSame }) {
        return w
    }
    if let w = biggest(windows.filter { $0.title?.localizedCaseInsensitiveContains("World of Warcraft") == true }) {
        return w
    }

    let visible = windows.compactMap { $0.title }.filter { !$0.isEmpty }
    fail("No World of Warcraft window found to capture. Visible windows: \(visible.joined(separator: ", "))")
}

// Backing scale of the display the window is mostly on (2 on Retina). SCDisplay sizes are
// in points, the display mode's pixelWidth is in pixels.
func pixelScale(for window: SCWindow, in content: SCShareableContent) -> CGFloat {
    let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
    let display = content.displays.first { $0.frame.contains(center) } ?? content.displays.first
    guard let display, let mode = CGDisplayCopyDisplayMode(display.displayID), display.width > 0 else { return 1 }
    return CGFloat(mode.pixelWidth) / CGFloat(display.width)
}

// `windows` subcommand: prints what the helper can see, for diagnostics.
func runListWindows() async {
    let content = await shareableContent()
    let rows: [[String: Any]] = content.windows.map { w in
        [
            "id": Int(w.windowID),
            "title": w.title ?? "",
            "app": w.owningApplication?.applicationName ?? "",
            "bundleId": w.owningApplication?.bundleIdentifier ?? "",
            "width": Int(w.frame.width),
            "height": Int(w.frame.height),
        ]
    }
    emit("windows", ["windows": rows])
}
