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

// Only the WoW client's own windows are ever recorded. The bundle id is the retail
// client's, compared ignoring case; a suffixed id ("<id>.<something>") counts too, for
// other WoW clients. A title alone is never
// enough: any app can name a window "World of Warcraft", and the window hint comes from a
// config file that other programs running as the user could edit.
func isWowWindow(_ window: SCWindow) -> Bool {
    guard let id = window.owningApplication?.bundleIdentifier?.lowercased() else { return false }
    return id == wowBundleId || id.hasPrefix(wowBundleId + ".")
}

// Picks the window to record, from the WoW client's windows only: an exact title match
// for the user's manual choice if one was given, otherwise the biggest WoW window (which
// skips WoW's small helper windows).
// WoW's small helper windows aren't worth recording or offering
func isRecordableSize(_ window: SCWindow) -> Bool {
    window.frame.width >= 100 && window.frame.height >= 100
}

func resolveWindow(in content: SCShareableContent, hint: String?) -> SCWindow {
    let sized = content.windows.filter(isRecordableSize)
    let wow = sized.filter(isWowWindow)
    let biggest: ([SCWindow]) -> SCWindow? = { candidates in
        candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    if let hint, !hint.isEmpty, hint != "auto" {
        if let w = biggest(wow.filter { $0.title == hint }) { return w }
        // No title here: the hint may name some other app's window
        log("the chosen window is not an open World of Warcraft window, falling back to auto-detect")
    }

    if let w = biggest(wow) { return w }

    // Only a count: other windows' titles can be browser tabs or document names, and the
    // message ends up in the log people attach to issues
    let others = sized.count
    fail(
        "No World of Warcraft window found to capture (\(others) other window\(others == 1 ? "" : "s") open). "
            + "Start the game and make sure its window isn't minimized."
    )
}

// Backing scale of the display the window is mostly on (2 on Retina). SCDisplay sizes are
// in points, the display mode's pixelWidth is in pixels.
func pixelScale(for window: SCWindow, in content: SCShareableContent) -> CGFloat {
    let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
    let display = content.displays.first { $0.frame.contains(center) } ?? content.displays.first
    guard let display, let mode = CGDisplayCopyDisplayMode(display.displayID), display.width > 0 else { return 1 }
    return CGFloat(mode.pixelWidth) / CGFloat(display.width)
}

// `windows` subcommand: the WoW client's windows the helper can see. The app uses it to
// list WoW windows in Settings; other apps' windows are left out.
func runListWindows() async {
    let content = await shareableContent()
    let rows: [[String: Any]] = content.windows.filter { isWowWindow($0) && isRecordableSize($0) }.map { w in
        [
            "id": Int(w.windowID),
            "title": w.title ?? "",
            "bundleId": w.owningApplication?.bundleIdentifier ?? "",
            "width": Int(w.frame.width),
            "height": Int(w.frame.height),
        ]
    }
    emit("windows", ["windows": rows])
}
