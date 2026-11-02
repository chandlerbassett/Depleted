import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// `record` subcommand. Captures one window plus system audio with ScreenCaptureKit and
// encodes it straight to an .mp4 with AVAssetWriter, which uses the VideoToolbox
// hardware encoder. Nothing goes through Chromium or FFmpeg.
//
// Lifecycle (all reported on stdout, see Output.swift):
//   started: first frame is in the file (or the buffer); the recording is live
//   kept:    with --buffer-secs, "keep" on stdin: the buffer is now the start of the file
//   stopped: "stop" on stdin, stdin closed, or SIGTERM/SIGINT; file is finalized. With
//            --buffer-secs and no "keep", nothing is saved ("discarded": true)
//   error:   capture failed; if frames were written, the file is still finalized
//            first and the event carries its path

struct RecordOptions {
    let outputURL: URL
    let fps: Int
    let bitrateKbps: Int
    let codec: AVVideoCodecType
    // Bounding box to scale into; nil means "native" (see Recorder.init)
    let maxSize: CGSize?
    let windowHint: String?
    // Rolling buffer length; nil records straight to the file
    let bufferSecs: Double?

    init(_ args: Args) {
        outputURL = URL(fileURLWithPath: args.required("output"))
        fps = max(1, min(120, args.int("fps", default: 30)))
        bitrateKbps = max(500, args.int("bitrate-kbps", default: 8000))
        switch args.string("codec") ?? "h264" {
        case "h264": codec = .h264
        case "hevc": codec = .hevc
        case let other: fail("--codec must be h264 or hevc, got \(other)", code: 2)
        }
        if let res = args.string("resolution"), res != "native" {
            let parts = res.lowercased().split(separator: "x").compactMap { Double($0) }
            guard parts.count == 2, parts[0] > 0, parts[1] > 0 else {
                fail("--resolution must be native or WIDTHxHEIGHT, got \(res)", code: 2)
            }
            maxSize = CGSize(width: parts[0], height: parts[1])
        } else {
            maxSize = nil
        }
        windowHint = args.string("window")
        let buffer = args.double("buffer-secs", default: 0)
        bufferSecs = buffer > 0 ? buffer : nil
    }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVAssetWriterDelegate, @unchecked Sendable {
    private let options: RecordOptions
    private let queue = DispatchQueue(label: "depleted.capture")
    private let size: CGSize
    private let filter: SCContentFilter
    private let config: SCStreamConfiguration
    // Built after super.init so it can take self as its delegate
    private var stream: SCStream!
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput
    private let buffer: SegmentBuffer?

    // Only touched on `queue`
    private var sessionStart: CMTime?
    private var lastVideoTime = CMTime.zero
    private var droppedFrames = 0
    private var stopping = false
    private var keepRequested = false

    init(options: RecordOptions, window: SCWindow, scale: CGFloat) {
        self.options = options

        // "native" is the window's size in points, not Retina pixels, capped at 4K. On a
        // 5K display that's 3360x1890; "--resolution 3840x2160" records 4K from the Retina
        // pixels instead. (On an M-series Mac Studio, 4K HEVC at 100 Mbps kept WoW's ~57fps
        // with no drops; full 6720x3780 just about kept up, so it isn't offered.)
        let pixels = CGSize(width: window.frame.width * scale, height: window.frame.height * scale)
        let box = options.maxSize
            ?? CGSize(width: min(window.frame.width, 3840), height: min(window.frame.height, 2160))
        size = Recorder.fit(pixels, into: box)

        config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
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

        try? FileManager.default.removeItem(at: options.outputURL)
        if let bufferSecs = options.bufferSecs {
            buffer = SegmentBuffer(seconds: bufferSecs, outputURL: options.outputURL)
            writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
            writer.outputFileTypeProfile = .mpeg4AppleHLS
            writer.preferredOutputSegmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
        } else {
            buffer = nil
            do {
                writer = try AVAssetWriter(outputURL: options.outputURL, fileType: .mp4)
            } catch {
                fail("Can't create \(options.outputURL.path): \(error.localizedDescription)")
            }
        }

        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: options.bitrateKbps * 1000,
            AVVideoExpectedSourceFrameRateKey: options.fps,
            // A keyframe every second keeps trimming and seeking accurate
            AVVideoMaxKeyFrameIntervalKey: options.fps,
            AVVideoAllowFrameReorderingKey: false,
        ]
        if options.codec == .h264 {
            compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
        }
        let videoSettings: [String: Any] = [
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
        guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
            fail("This Mac can't encode \(options.codec.rawValue) at \(Int(size.width))x\(Int(size.height))")
        }
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true

        audioInput = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 160_000,
            ]
        )
        audioInput.expectsMediaDataInRealTime = true

        writer.add(videoInput)
        writer.add(audioInput)
        super.init()
        if buffer != nil { writer.delegate = self }
        stream = SCStream(filter: filter, configuration: config, delegate: self)
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

    func start() async {
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await stream.startCapture()
        } catch {
            fail("Capture failed to start: \(error.localizedDescription)")
        }
        log("capturing \(Int(size.width))x\(Int(size.height)) @ \(options.fps)fps \(options.codec.rawValue) \(options.bitrateKbps)kbps")
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid, !stopping else { return }
        switch type {
        case .screen: appendVideo(sampleBuffer)
        case .audio: appendAudio(sampleBuffer)
        default: break  // .microphone (macOS 15+) is never requested
        }
    }

    private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        // ScreenCaptureKit also delivers idle/blank status frames with no image; skip them.
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
            let statusRaw = attachments.first?[.status] as? Int,
            SCFrameStatus(rawValue: statusRaw) == .complete
        else { return }

        let time = sampleBuffer.presentationTimeStamp
        if sessionStart == nil {
            // Segment boundaries count from here
            if buffer != nil { writer.initialSegmentStartTime = time }
            guard writer.startWriting() else {
                stopWithError("Encoder failed to start: \(writer.error?.localizedDescription ?? "unknown error")")
                return
            }
            writer.startSession(atSourceTime: time)
            sessionStart = time
            emit("started", [
                "path": options.outputURL.path,
                "bufferSecs": options.bufferSecs ?? 0,
                "width": Int(size.width),
                "height": Int(size.height),
                "codec": options.codec.rawValue,
            ])
        }

        if videoInput.isReadyForMoreMediaData {
            if !videoInput.append(sampleBuffer) {
                stopWithError("Encoder stopped: \(writer.error?.localizedDescription ?? "unknown error")")
                return
            }
            lastVideoTime = time
        } else {
            droppedFrames += 1
        }
    }

    private func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        guard let start = sessionStart, sampleBuffer.presentationTimeStamp >= start else { return }
        if audioInput.isReadyForMoreMediaData {
            _ = audioInput.append(sampleBuffer)
        }
    }

    // MARK: AVAssetWriterDelegate

    func assetWriter(
        _ writer: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        buffer?.add(segmentData, type: segmentType, report: segmentReport)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Usually the window was closed or the game quit
        queue.async { self.stopWithError("Capture stopped: \(error.localizedDescription)") }
    }

    // MARK: Keeping the buffer

    func requestKeep() {
        queue.async {
            guard let buffer = self.buffer, !self.keepRequested, !self.stopping, let start = self.sessionStart else {
                emit("error", ["message": "Nothing to keep: not buffering"])
                return
            }
            self.keepRequested = true
            let now = CMTimeGetSeconds(self.lastVideoTime)
            buffer.keep { keptStart in
                // How far before the "keep" the file starts
                emit("kept", ["path": self.options.outputURL.path, "keptSecs": max(0, now - (keptStart ?? CMTimeGetSeconds(start)))])
            }
        }
    }

    // MARK: Stopping

    func requestStop() {
        queue.async {
            guard !self.stopping else { return }
            self.stopping = true
            self.stream.stopCapture { _ in
                self.queue.async { self.finish(error: nil) }
            }
        }
    }

    // Must be called on `queue`
    private func stopWithError(_ message: String) {
        guard !stopping else { return }
        stopping = true
        stream.stopCapture { _ in }
        finish(error: message)
    }

    // Must be called on `queue`
    private func finish(error: String?) {
        guard let start = sessionStart, writer.status == .writing else {
            fail(error ?? "Stopped before any frames were captured")
        }
        if let buffer {
            finishBuffered(buffer, sessionStart: start, error: error)
            return
        }
        writer.endSession(atSourceTime: lastVideoTime)
        videoInput.markAsFinished()
        audioInput.markAsFinished()
        let durationSecs = CMTimeGetSeconds(CMTimeSubtract(lastVideoTime, start))
        writer.finishWriting {
            let path = self.options.outputURL.path
            if self.writer.status != .completed {
                let reason = self.writer.error?.localizedDescription ?? "unknown error"
                fail("Couldn't finalize \(path): \(reason)")
            }
            if let error {
                emit("error", ["message": error, "path": path, "durationSecs": durationSecs])
                log(error)
                exit(1)
            }
            emit("stopped", ["path": path, "durationSecs": durationSecs, "droppedFrames": self.droppedFrames])
            exit(0)
        }
    }

    // Must be called on `queue`
    private func finishBuffered(_ buffer: SegmentBuffer, sessionStart: CMTime, error: String?) {
        let path = options.outputURL.path
        guard keepRequested else {
            writer.cancelWriting()
            buffer.finish { _, _ in
                if let error { fail(error) }
                emit("stopped", ["path": path, "durationSecs": 0, "droppedFrames": self.droppedFrames, "discarded": true])
                exit(0)
            }
            return
        }
        writer.endSession(atSourceTime: lastVideoTime)
        videoInput.markAsFinished()
        audioInput.markAsFinished()
        let end = CMTimeGetSeconds(lastVideoTime)
        // The last segments reach the delegate before this completion handler runs
        writer.finishWriting {
            if self.writer.status != .completed {
                let reason = self.writer.error?.localizedDescription ?? "unknown error"
                log("Couldn't finish the last segment of \(path): \(reason)")
            }
            buffer.finish { writeError, keptStart in
                let durationSecs = end - (keptStart ?? CMTimeGetSeconds(sessionStart))
                if let message = error ?? writeError {
                    emit("error", ["message": message, "path": path, "durationSecs": durationSecs])
                    log(message)
                    exit(1)
                }
                emit("stopped", ["path": path, "durationSecs": durationSecs, "droppedFrames": self.droppedFrames])
                exit(0)
            }
        }
    }
}

func runRecord(_ args: Args) async {
    let options = RecordOptions(args)
    let content = await shareableContent()
    let window = resolveWindow(in: content, hint: options.windowHint)
    let recorder = Recorder(options: options, window: window, scale: pixelScale(for: window, in: content))

    // "keep" keeps the buffer. Stop on "stop", on stdin closing (the app went away), or on SIGTERM/SIGINT
    Thread.detachNewThread {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespaces)
            if command == "stop" { break }
            if command == "keep" { recorder.requestKeep() }
        }
        recorder.requestStop()
    }
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { recorder.requestStop() }
        source.resume()
        signalSources.append(source)
    }

    await recorder.start()
}

// Keeps the signal sources alive for the life of the process
var signalSources: [DispatchSourceSignal] = []
