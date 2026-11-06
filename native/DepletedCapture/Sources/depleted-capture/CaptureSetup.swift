import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// What `record` and `buffer` share: the capture size, the ScreenCaptureKit stream
// configuration, and the encoder settings for the AVAssetWriter inputs.
struct CaptureSetup {
    let size: CGSize
    let config: SCStreamConfiguration
    let filter: SCContentFilter
    let videoSettings: [String: Any]
    let audioSettings: [String: Any]

    init(options: RecordOptions, window: SCWindow, scale: CGFloat) {
        // "native" is the window's size in points, not Retina pixels, capped at 4K. On a
        // 5K display that's 3360x1890; "--resolution 3840x2160" records 4K from the Retina
        // pixels instead. (On an M-series Mac Studio, 4K HEVC at 100 Mbps kept WoW's ~57fps
        // with no drops; full 6720x3780 just about kept up, so it isn't offered.)
        let pixels = CGSize(width: window.frame.width * scale, height: window.frame.height * scale)
        let box = options.maxSize
            ?? CGSize(width: min(window.frame.width, 3840), height: min(window.frame.height, 2160))
        size = CaptureSetup.fit(pixels, into: box)

        config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        // Ask for frames a bit faster than the target rate and let FramePacer pick one per
        // frame slot. At exactly 1/fps, a window update that lands a hair early (16.5 ms
        // after the last one on a 60 Hz display) is skipped and the next frame comes a whole
        // refresh later, which cost ~5-7 fps at 60 (#78).
        config.minimumFrameInterval = CMTime(
            value: 3, timescale: CMTimeScale(4 * options.fps))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        // Convert to sRGB / BT.709 to match the file's color tags. Left at its defaults,
        // ScreenCaptureKit hands over pixels in the window's own color space (WoW's is
        // BT.2020 primaries), which players then read as BT.709, so it looks washed out.
        config.colorSpaceName = CGColorSpace.sRGB
        config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        config.queueDepth = 8
        config.showsCursor = true
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true

        filter = SCContentFilter(desktopIndependentWindow: window)

        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: options.bitrateKbps * 1000,
            AVVideoExpectedSourceFrameRateKey: options.fps,
            // A keyframe every second keeps trimming and seeking accurate, and lets the
            // rolling buffer cut segments about every second or two
            AVVideoMaxKeyFrameIntervalKey: options.fps,
            AVVideoAllowFrameReorderingKey: false,
        ]
        if options.codec == .h264 {
            compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
        }
        videoSettings = [
            AVVideoCodecKey: options.codec,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        audioSettings = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 160_000,
        ]
    }

    // Adds the video and audio inputs to a writer that hasn't started yet.
    func addInputs(to writer: AVAssetWriter) -> (video: AVAssetWriterInput, audio: AVAssetWriterInput) {
        guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
            let codec = (videoSettings[AVVideoCodecKey] as? AVVideoCodecType)?.rawValue ?? "?"
            fail("This Mac can't encode \(codec) at \(Int(size.width))x\(Int(size.height))")
        }
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        video.expectsMediaDataInRealTime = true
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audio.expectsMediaDataInRealTime = true
        writer.add(video)
        writer.add(audio)
        return (video, audio)
    }

    // Scales into the bounding box keeping aspect ratio; encoders need even dimensions.
    static func fit(_ native: CGSize, into box: CGSize?) -> CGSize {
        var w = native.width
        var h = native.height
        if let box, w > box.width || h > box.height {
            let s = min(box.width / w, box.height / h)
            w *= s
            h *= s
        }
        let even = { (v: CGFloat) -> CGFloat in max(2, CGFloat(Int(v.rounded()) & ~1)) }
        return CGSize(width: even(w), height: even(h))
    }
}

// ScreenCaptureKit also delivers idle/blank status frames with no image; only complete
// frames go to the encoder.
func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
        let statusRaw = attachments.first?[.status] as? Int
    else { return false }
    return SCFrameStatus(rawValue: statusRaw) == .complete
}

// Lets through about one frame per 1/fps. ScreenCaptureKit is asked for frames up to a
// third faster than that (see CaptureSetup), so on a 120 or 144 Hz display this keeps the
// file at the chosen rate, while a frame that comes a little early or late on a 60 Hz
// display is still kept. Frames are kept on a fixed grid rather than "at least 1/fps since
// the last one", so jitter can't make every other frame miss its slot.
struct FramePacer {
    private let interval: Double
    private let tolerance: Double
    private var due: Double?

    init(fps: Int) {
        interval = 1 / Double(fps)
        tolerance = interval / 4
    }

    mutating func admit(_ time: CMTime) -> Bool {
        let t = CMTimeGetSeconds(time)
        guard let due else {
            self.due = t + interval
            return true
        }
        if t < due - tolerance { return false }
        // More than a frame behind (the game hitched, or nothing changed on screen):
        // restart the grid from this frame instead of letting a burst through to catch up
        self.due = t > due + interval ? t + interval : due + interval
        return true
    }
}
