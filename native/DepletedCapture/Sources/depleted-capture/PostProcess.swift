import AVFoundation
import CoreMedia
import Foundation
import ImageIO

// `trim` and `thumbnail` subcommands: the post-processing StorageManager used to run
// FFmpeg for. Both write `done` on success.

// Cuts [start, start+duration) out of the input without re-encoding.
func runTrim(_ args: Args) async {
    let input = URL(fileURLWithPath: args.required("input"))
    let output = URL(fileURLWithPath: args.required("output"))
    let start = max(0, args.double("start", default: 0))
    var duration = args.double("duration", default: 0)

    let asset = AVURLAsset(url: input)
    let total: Double
    do {
        total = CMTimeGetSeconds(try await asset.load(.duration))
    } catch {
        fail("Can't read \(input.path): \(error.localizedDescription)")
    }
    if duration <= 0 || start + duration > total { duration = max(0, total - start) }
    guard duration > 0 else { fail("Nothing to trim: start \(start)s is past the end (\(total)s)") }

    guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
        fail("Can't create an export session for \(input.path)")
    }
    try? FileManager.default.removeItem(at: output)
    export.outputURL = output
    export.outputFileType = .mp4
    export.timeRange = CMTimeRange(
        start: CMTime(seconds: start, preferredTimescale: 600),
        duration: CMTime(seconds: duration, preferredTimescale: 600)
    )

    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        export.exportAsynchronously { done.resume() }
    }
    guard export.status == .completed else {
        fail("Trim failed: \(export.error?.localizedDescription ?? "status \(export.status.rawValue)")")
    }
    emit("done", ["path": output.path, "durationSecs": duration])
}

// Saves one frame as a JPEG, by default 5 seconds in (or halfway, for short clips).
func runThumbnail(_ args: Args) async {
    let input = URL(fileURLWithPath: args.required("input"))
    let output = URL(fileURLWithPath: args.required("output"))
    let at = args.double("at", default: 5)

    let asset = AVURLAsset(url: input)
    let total: Double
    do {
        total = CMTimeGetSeconds(try await asset.load(.duration))
    } catch {
        fail("Can't read \(input.path): \(error.localizedDescription)")
    }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1280, height: 720)
    let time = CMTime(seconds: min(at, max(0, total / 2)), preferredTimescale: 600)

    let image: CGImage
    do {
        image = try await generator.image(at: time).image
    } catch {
        fail("Thumbnail failed: \(error.localizedDescription)")
    }

    try? FileManager.default.removeItem(at: output)
    guard let dest = CGImageDestinationCreateWithURL(output as CFURL, "public.jpeg" as CFString, 1, nil) else {
        fail("Can't write \(output.path)")
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fail("Can't write \(output.path)") }
    emit("done", ["path": output.path])
}
