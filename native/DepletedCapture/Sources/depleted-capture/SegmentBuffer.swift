import AVFoundation
import Foundation

// The rolling buffer behind `record --buffer-secs`. AVAssetWriter hands over the
// recording as fragmented MP4: one initialization segment, then media segments that
// each start on a keyframe. Until keep(), segments are spilled to <output>.buffer/ and
// any older than the buffer length are deleted. keep() writes the initialization
// segment and the held segments into the output file, and later segments are appended
// to it. Players and AVAssetExportSession start the file's timeline at its first
// fragment, so dropped fragments leave no gap.
final class SegmentBuffer: @unchecked Sendable {
    private let seconds: Double
    private let outputURL: URL
    private let dir: URL
    private let io = DispatchQueue(label: "depleted.capture.segments")

    // Only touched on `io`
    private var header: Data?
    // Times are presentation times in seconds, on the capture clock
    private var held: [(url: URL, start: Double, end: Double)] = []
    private var nextIndex = 0
    private var output: FileHandle?
    private var keptStart: Double?
    private var failure: String?

    init(seconds: Double, outputURL: URL) {
        self.seconds = seconds
        self.outputURL = outputURL
        dir = URL(fileURLWithPath: outputURL.path + ".buffer")
        try? FileManager.default.removeItem(at: dir)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            fail("Can't create \(dir.path): \(error.localizedDescription)")
        }
    }

    func add(_ data: Data, type: AVAssetSegmentType, report: AVAssetSegmentReport?) {
        // An audio-only tail segment has no video report
        let track = report?.trackReports.first { $0.mediaType == .video } ?? report?.trackReports.first
        let times = track.map {
            (start: CMTimeGetSeconds($0.earliestPresentationTimeStamp),
             end: CMTimeGetSeconds(CMTimeAdd($0.earliestPresentationTimeStamp, $0.duration)))
        }
        io.async { [self] in
            if type == .initialization {
                header = data
                if output != nil { write(data) }
                return
            }
            if output != nil {
                write(data)
                return
            }
            let url = dir.appendingPathComponent(String(format: "%06d.m4s", nextIndex))
            nextIndex += 1
            do {
                try data.write(to: url)
            } catch {
                failure = "Can't write the buffer: \(error.localizedDescription)"
                return
            }
            let start = times?.start ?? held.last?.end ?? 0
            let end = times?.end ?? start
            held.append((url, start, end))
            // Keep the newest segment that starts at least `seconds` back, and everything after it
            while held.count > 1, held[1].start <= end - seconds {
                try? FileManager.default.removeItem(at: held.removeFirst().url)
            }
        }
    }

    // Starts the output file with what's held. `done` gets the presentation time the file
    // starts at, or nil when no segment was complete yet (it then starts at the first frame).
    func keep(_ done: @escaping (Double?) -> Void) {
        io.async { [self] in
            FileManager.default.createFile(atPath: outputURL.path, contents: nil)
            guard let handle = try? FileHandle(forWritingTo: outputURL) else {
                fail("Can't create \(outputURL.path)")
            }
            output = handle
            if let header { write(header) }
            for segment in held {
                if let data = try? Data(contentsOf: segment.url) {
                    write(data)
                } else {
                    failure = "Lost a buffered segment: \(segment.url.lastPathComponent)"
                }
            }
            keptStart = held.first?.start
            held = []
            try? FileManager.default.removeItem(at: dir)
            done(keptStart)
        }
    }

    // After the writer has finished (or been cancelled). Without keep() nothing is saved.
    // `done` gets a write error, if there was one, and the file's start as for keep().
    func finish(_ done: @escaping (String?, Double?) -> Void) {
        io.async { [self] in
            if let output {
                try? output.synchronize()
                try? output.close()
            } else {
                try? FileManager.default.removeItem(at: dir)
            }
            done(failure, keptStart)
        }
    }

    // Must be called on `io`
    private func write(_ data: Data) {
        do {
            try output?.write(contentsOf: data)
        } catch {
            failure = "Can't write \(outputURL.path): \(error.localizedDescription)"
        }
    }
}
