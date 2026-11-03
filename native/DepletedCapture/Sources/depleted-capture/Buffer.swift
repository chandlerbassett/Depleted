import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// `buffer` subcommand: a rolling pre-roll buffer, so a recording can start before the
// moment the app asked for it (a raid pull timer, a key going in).
//
//   depleted-capture buffer --buffer-dir <dir> [--buffer-secs 90] [record options]
//
// Capture and encoding run the whole time, but nothing grows: the encoder writes
// fragmented MP4 in ~1 s segments (AVAssetWriter's HLS output), each segment goes to
// a file in --buffer-dir, and segments older than --buffer-secs are deleted. Commands,
// one per line on stdin:
//
//   start <path>   begin a recording at <path> that opens with everything in the buffer
//   stop           end the recording; capture and the buffer keep running
//   quit           end any recording and exit (so do closing stdin and SIGTERM/SIGINT)
//
// While recording, segments are appended to <path> as they arrive. On stop, the file is
// rewritten as a plain MP4 whose timeline starts at zero (no re-encode).
//
// Events on stdout (see Output.swift):
//   buffering  the first frame is encoded; the buffer is filling
//   started    {path, bufferedSecs}: how much footage before now the recording opens with
//   stopped    {path, durationSecs, droppedFrames}: the file is finished
//   error      {message, path?}: a failed command, or capture died (path = the recording
//              it finished first, if one was running)

private struct Segment {
    let url: URL
    let start: CMTime
    let end: CMTime
}

private final class ActiveRecording {
    let url: URL
    let handle: FileHandle
    let start: CMTime
    let droppedAtStart: Int
    var wroteInit = false
    var end: CMTime
    // Set by `stop`: the recording ends with the first segment that reaches this time
    var stopAt: CMTime?

    init(url: URL, handle: FileHandle, start: CMTime, droppedAtStart: Int) {
        self.url = url
        self.handle = handle
        self.start = start
        self.end = start
        self.droppedAtStart = droppedAtStart
    }
}

// How long `stop` waits for the segment holding its last frames before closing anyway
private let stopFlushTimeoutSecs = 4.0

final class BufferRecorder: NSObject, SCStreamOutput, SCStreamDelegate, AVAssetWriterDelegate, @unchecked Sendable {
    private let options: RecordOptions
    private let bufferDir: URL
    private let bufferSecs: Double
    private let size: CGSize
    private let filter: SCContentFilter
    private let config: SCStreamConfiguration
    private var stream: SCStream!
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput

    // Capture side, only touched on `queue`
    private let queue = DispatchQueue(label: "depleted.buffer.capture")
    private var sessionStart: CMTime?
    private var droppedFrames = 0
    private var stopping = false

    // Segments and the recording file, only touched on `io`
    private let io = DispatchQueue(label: "depleted.buffer.io")
    private var initSegment: Data?
    private var ring: [Segment] = []
    private var segmentCount = 0
    private var lastSegmentEnd: CMTime?
    private var recording: ActiveRecording?
    // Remuxes still running; quitting waits for them
    private let remuxes = DispatchGroup()

    init(options: RecordOptions, bufferDir: URL, bufferSecs: Double, window: SCWindow, scale: CGFloat) {
        self.options = options
        self.bufferDir = bufferDir
        self.bufferSecs = bufferSecs
        let setup = CaptureSetup(options: options, window: window, scale: scale)
        size = setup.size
        config = setup.config
        filter = setup.filter

        // Old segments from a helper that was killed are no use now
        try? FileManager.default.removeItem(at: bufferDir)
        do {
            try FileManager.default.createDirectory(at: bufferDir, withIntermediateDirectories: true)
        } catch {
            fail("Can't create the buffer folder \(bufferDir.path): \(error.localizedDescription)")
        }

        // No output file: segments come to the delegate as they're cut
        writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 1, preferredTimescale: 1)
        let inputs = setup.addInputs(to: writer)
        videoInput = inputs.video
        audioInput = inputs.audio
        super.init()
        writer.delegate = self
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
        log(
            "buffering \(Int(bufferSecs))s at \(Int(size.width))x\(Int(size.height)) @ \(options.fps)fps "
                + "\(options.codec.rawValue) \(options.bitrateKbps)kbps in \(bufferDir.path)")
    }

    // MARK: Capture

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid, !stopping else { return }
        switch type {
        case .screen: appendVideo(sampleBuffer)
        case .audio: appendAudio(sampleBuffer)
        default: break
        }
    }

    private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        guard isCompleteFrame(sampleBuffer) else { return }
        let time = sampleBuffer.presentationTimeStamp
        if sessionStart == nil {
            writer.initialSegmentStartTime = time
            guard writer.startWriting() else {
                shutDown(error: "Encoder failed to start: \(writer.error?.localizedDescription ?? "unknown error")")
                return
            }
            writer.startSession(atSourceTime: time)
            sessionStart = time
            emit("buffering", [
                "width": Int(size.width),
                "height": Int(size.height),
                "codec": options.codec.rawValue,
                "bufferSecs": bufferSecs,
            ])
        }
        if videoInput.isReadyForMoreMediaData {
            if !videoInput.append(sampleBuffer) {
                shutDown(error: "Encoder stopped: \(writer.error?.localizedDescription ?? "unknown error")")
            }
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

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Usually the window was closed or the game quit
        queue.async { self.shutDown(error: "Capture stopped: \(error.localizedDescription)") }
    }

    // MARK: Segments

    func assetWriter(
        _ writer: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        let video = segmentReport?.trackReports.first { $0.mediaType == .video }
        let arrived = hostNow()
        io.async {
            switch segmentType {
            case .initialization:
                self.initSegment = segmentData
                // A recording started before the encoder's first output gets it now
                if let rec = self.recording, !rec.wroteInit {
                    self.write(segmentData, to: rec)
                    rec.wroteInit = true
                }
            case .separable:
                let start = video?.earliestPresentationTimeStamp ?? self.lastSegmentEnd ?? arrived
                let end = video.map { CMTimeAdd($0.earliestPresentationTimeStamp, $0.duration) } ?? arrived
                self.addSegment(segmentData, start: start, end: end)
            @unknown default:
                break
            }
        }
    }

    // On `io`
    private func addSegment(_ data: Data, start: CMTime, end: CMTime) {
        lastSegmentEnd = end
        segmentCount += 1
        let url = bufferDir.appendingPathComponent(String(format: "segment-%08d.m4s", segmentCount))
        do {
            try data.write(to: url)
            ring.append(Segment(url: url, start: start, end: end))
        } catch {
            log("couldn't write a buffer segment: \(error.localizedDescription)")
        }
        // Keep just enough that the oldest segment still covers bufferSecs before now
        while ring.count > 1, CMTimeGetSeconds(CMTimeSubtract(end, ring[1].start)) >= bufferSecs {
            try? FileManager.default.removeItem(at: ring.removeFirst().url)
        }

        guard let rec = recording, rec.wroteInit else { return }
        write(data, to: rec)
        rec.end = end
        if let stopAt = rec.stopAt, end >= stopAt { finishRecording(rec) }
    }

    // On `io`
    private func write(_ data: Data, to rec: ActiveRecording) {
        do {
            try rec.handle.write(contentsOf: data)
        } catch {
            log("couldn't write to \(rec.url.path): \(error.localizedDescription)")
        }
    }

    // MARK: Commands

    func startRecording(path: String) {
        io.async {
            guard self.recording == nil else {
                emit("error", ["message": "Already recording to \(self.recording!.url.path)", "fatal": false])
                return
            }
            let url = URL(fileURLWithPath: path)
            let handle: FileHandle
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: url)
                guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                handle = try FileHandle(forWritingTo: url)
            } catch {
                emit("error", ["message": "Can't create \(path): \(error.localizedDescription)", "fatal": false])
                return
            }

            let now = hostNow()
            let start = self.ring.first?.start ?? self.lastSegmentEnd ?? now
            let rec = ActiveRecording(
                url: url, handle: handle, start: start, droppedAtStart: self.queue.sync { self.droppedFrames })
            self.recording = rec
            if let initSegment = self.initSegment {
                self.write(initSegment, to: rec)
                rec.wroteInit = true
                for segment in self.ring {
                    if let data = try? Data(contentsOf: segment.url) {
                        self.write(data, to: rec)
                        rec.end = segment.end
                    }
                }
            }
            let bufferedSecs = max(0, CMTimeGetSeconds(CMTimeSubtract(now, start)))
            emit("started", ["path": path, "bufferedSecs": bufferedSecs])
        }
    }

    func stopRecording() {
        io.async {
            guard let rec = self.recording else {
                emit("error", ["message": "Not recording", "fatal": false])
                return
            }
            guard rec.stopAt == nil else { return }
            rec.stopAt = hostNow()
            // The segment with the last frames comes within a second or so; don't wait
            // forever if frames stopped coming (window minimized, game paused on a menu)
            self.io.asyncAfter(deadline: .now() + stopFlushTimeoutSecs) {
                if self.recording === rec { self.finishRecording(rec) }
            }
        }
    }

    // On `io`. Closes the file and rewrites it from zero in the background; the buffer
    // keeps running meanwhile.
    private func finishRecording(_ rec: ActiveRecording, then: (() -> Void)? = nil) {
        if recording === rec { recording = nil }
        try? rec.handle.close()
        let durationSecs = max(0, CMTimeGetSeconds(CMTimeSubtract(rec.end, rec.start)))
        let dropped = max(0, queue.sync { droppedFrames } - rec.droppedAtStart)
        remuxes.enter()
        Task {
            await normalizeTimeline(rec.url)
            emit("stopped", ["path": rec.url.path, "durationSecs": durationSecs, "droppedFrames": dropped])
            then?()
            self.remuxes.leave()
        }
    }

    // MARK: Shutting down

    func quit() {
        queue.async { self.shutDown(error: nil) }
    }

    // On `queue`. Stops capture, lets the encoder hand over its last segment, finishes any
    // recording and exits.
    private func shutDown(error: String?) {
        guard !stopping else { return }
        stopping = true
        stream.stopCapture { _ in
            self.queue.async {
                guard self.sessionStart != nil, self.writer.status == .writing else {
                    self.io.async { self.exitAfterRecording(error: error) }
                    return
                }
                self.videoInput.markAsFinished()
                self.audioInput.markAsFinished()
                self.writer.finishWriting {
                    // Queued behind the final segment, which the writer hands over first
                    self.io.async { self.exitAfterRecording(error: error) }
                }
            }
        }
    }

    // On `io`
    private func exitAfterRecording(error: String?) {
        let finish = {
            self.remuxes.notify(queue: self.io) {
                try? FileManager.default.removeItem(at: self.bufferDir)
                if let error {
                    log(error)
                    exit(1)
                }
                exit(0)
            }
        }
        guard let rec = recording else {
            if let error { emit("error", ["message": error]) }
            finish()
            return
        }
        if let error {
            // Tell the app which file was saved before the error, as `record` does
            emit("error", ["message": error, "path": rec.url.path])
        }
        finishRecording(rec, then: nil)
        finish()
    }
}

private func hostNow() -> CMTime {
    CMClockGetTime(CMClockGetHostTimeClock())
}

// Rewrites a recording (fragmented MP4 whose timestamps are host-clock times) as a plain
// MP4 starting at zero, without re-encoding. If that fails the fragmented file is kept;
// it still plays.
private func normalizeTimeline(_ url: URL) async {
    let temp = url.deletingPathExtension().appendingPathExtension("remux.mp4")
    do {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
            + (try await asset.loadTracks(withMediaType: .audio))
        var ranges: [(AVAssetTrack, CMTimeRange)] = []
        var first: CMTime?
        for track in tracks {
            let range = try await track.load(.timeRange)
            guard CMTimeGetSeconds(range.duration) > 0 else { continue }
            ranges.append((track, range))
            first = first.map { CMTimeMinimum($0, range.start) } ?? range.start
        }
        guard let first else { throw CocoaError(.fileReadCorruptFile) }

        let composition = AVMutableComposition()
        for (track, range) in ranges {
            guard
                let target = composition.addMutableTrack(
                    withMediaType: track.mediaType, preferredTrackID: kCMPersistentTrackID_Invalid)
            else { continue }
            try target.insertTimeRange(range, of: track, at: CMTimeSubtract(range.start, first))
        }

        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try? FileManager.default.removeItem(at: temp)
        export.outputURL = temp
        export.outputFileType = .mp4
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            export.exportAsynchronously { done.resume() }
        }
        guard export.status == .completed else {
            throw export.error ?? CocoaError(.fileWriteUnknown)
        }
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
    } catch {
        try? FileManager.default.removeItem(at: temp)
        log("kept \(url.lastPathComponent) as fragmented MP4, rewriting it failed: \(error.localizedDescription)")
    }
}

func runBuffer(_ args: Args) async {
    let options = RecordOptions(args)
    let bufferDir = URL(fileURLWithPath: args.required("buffer-dir"))
    let bufferSecs = max(5, min(600, args.double("buffer-secs", default: 90)))
    let content = await shareableContent()
    let window = resolveWindow(in: content, hint: options.windowHint)
    let recorder = BufferRecorder(
        options: options, bufferDir: bufferDir, bufferSecs: bufferSecs, window: window,
        scale: pixelScale(for: window, in: content))

    Thread.detachNewThread {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespaces)
            if command.hasPrefix("start ") {
                let path = String(command.dropFirst("start ".count)).trimmingCharacters(in: .whitespaces)
                if path.isEmpty {
                    emit("error", ["message": "start needs a path", "fatal": false])
                } else {
                    recorder.startRecording(path: path)
                }
            } else if command == "stop" {
                recorder.stopRecording()
            } else if command == "quit" {
                break
            } else if !command.isEmpty {
                emit("error", ["message": "unknown command \(command)", "fatal": false])
            }
        }
        recorder.quit()
    }
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { recorder.quit() }
        source.resume()
        signalSources.append(source)
    }

    await recorder.start()
}
