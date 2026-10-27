import Foundation

// The helper talks to the Electron main process with one JSON object per stdout line.
// Every line has an "event" key; NativeCaptureRecorder.ts parses them.

private let stdoutLock = NSLock()

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var payload = fields
    payload["event"] = event
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    stdoutLock.unlock()
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[depleted-capture] \(message)\n".utf8))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit("error", ["message": message])
    log(message)
    exit(code)
}

// Minimal "--key value" argument parsing; flags without a value aren't used.
struct Args {
    private var values: [String: String] = [:]

    init(_ argv: ArraySlice<String>) {
        var it = argv.makeIterator()
        while let arg = it.next() {
            guard arg.hasPrefix("--") else { continue }
            values[String(arg.dropFirst(2))] = it.next() ?? ""
        }
    }

    func string(_ key: String) -> String? { values[key] }

    func required(_ key: String) -> String {
        guard let v = values[key], !v.isEmpty else { fail("missing --\(key)", code: 2) }
        return v
    }

    func int(_ key: String, default def: Int) -> Int {
        guard let v = values[key] else { return def }
        guard let n = Int(v) else { fail("--\(key) must be an integer, got \(v)", code: 2) }
        return n
    }

    func double(_ key: String, default def: Double) -> Double {
        guard let v = values[key] else { return def }
        guard let n = Double(v) else { fail("--\(key) must be a number, got \(v)", code: 2) }
        return n
    }
}
