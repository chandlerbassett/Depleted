import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// `record` subcommand. Captures one window plus system audio with ScreenCaptureKit and
// encodes it straight to an .mp4 with AVAssetWriter, which uses the VideoToolbox
// hardware encoder. Nothing goes through Chromium or FFmpeg.
//
// Lifecycle (all reported on stdout, see Output.swift):
//   started  — first frame is in the file; the recording is live
//   stopped  — "stop" on stdin, stdin closed, or SIGTERM/SIGINT; file is finalized
//   error    — capture failed; if frames were written, the file is still finalized
//              first and the event carries its path

struct RecordOptions {
    let fps: Int
    let bitrateKbps: Int
    let codec: AVVideoCodecType
    // Bounding box to scale into; nil means "native" (see Recorder.init)
    let maxSize: CGSize?
    let windowHint: String?

    init(_ args: Args) {
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
    }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let options: RecordOptions
    private let outputURL: URL
    private let queue = DispatchQueue(label: "depleted.capture")
    private let size: CGSize
    private let filter: SCContentFilter
    private let config: SCStreamConfiguration
    // Built after super.init so it can take self as its delegate
    private var stream: SCStream!
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput

    // Only touched on `queue`
    private var sessionStart: CMTime?
    private var lastVideoTime = CMTime.zero
    private var droppedFrames = 0
    private var stopping = false

    init(options: RecordOptions, outputURL: URL, window: SCWindow, scale: CGFloat) {
        self.options = options
        self.outputURL = outputURL
        let setup = CaptureSetup(options: options, window: window, scale: scale)
        size = setup.size
        config = setup.config
        filter = setup.filter

        try? FileManager.default.removeItem(at: outputURL)
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            fail("Can't create \(outputURL.path): \(error.localizedDescription)")
        }
        let inputs = setup.addInputs(to: writer)
        videoInput = inputs.video
        audioInput = inputs.audio
        super.init()
        stream = SCStream(filter: filter, configuration: config, delegate: self)
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
        guard isCompleteFrame(sampleBuffer) else { return }

        let time = sampleBuffer.presentationTimeStamp
        if sessionStart == nil {
            guard writer.startWriting() else {
                stopWithError("Encoder failed to start: \(writer.error?.localizedDescription ?? "unknown error")")
                return
            }
            writer.startSession(atSourceTime: time)
            sessionStart = time
            emit("started", [
                "path": outputURL.path,
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

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Usually the window was closed or the game quit
        queue.async { self.stopWithError("Capture stopped: \(error.localizedDescription)") }
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
        writer.endSession(atSourceTime: lastVideoTime)
        videoInput.markAsFinished()
        audioInput.markAsFinished()
        let durationSecs = CMTimeGetSeconds(CMTimeSubtract(lastVideoTime, start))
        writer.finishWriting {
            let path = self.outputURL.path
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
}

func runRecord(_ args: Args) async {
    let options = RecordOptions(args)
    let outputURL = URL(fileURLWithPath: args.required("output"))
    let content = await shareableContent()
    let window = resolveWindow(in: content, hint: options.windowHint)
    let recorder = Recorder(
        options: options, outputURL: outputURL, window: window, scale: pixelScale(for: window, in: content))

    // Stop on "stop", on stdin closing (the app went away), or on SIGTERM/SIGINT
    Thread.detachNewThread {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
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
