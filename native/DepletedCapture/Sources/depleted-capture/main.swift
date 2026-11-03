import Foundation

// depleted-capture <command> [--key value ...]
//
//   record     --output <file.mp4> [--fps 30] [--bitrate-kbps 8000] [--codec h264|hevc]
//              [--resolution native|WIDTHxHEIGHT] [--window <title>]
//   buffer     [--buffer-secs 90] [record options, no --output]
//              rolling pre-roll buffer; "start <path>" / "stop" / "quit" on stdin
//   trim       --input <file> --output <file.mp4> --start <secs> [--duration <secs>]
//   thumbnail  --input <file> --output <file.jpg> [--at <secs>]
//   windows    list capturable windows
//   version

let helperVersion = "1.2.0"

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("usage: depleted-capture record|buffer|trim|thumbnail|windows|version", code: 2) }
let args = Args(argv.dropFirst(2))

switch argv[1] {
case "record":
    Task { await runRecord(args) }
case "buffer":
    Task { await runBuffer(args) }
case "trim":
    Task {
        await runTrim(args)
        exit(0)
    }
case "thumbnail":
    Task {
        await runThumbnail(args)
        exit(0)
    }
case "windows":
    Task {
        await runListWindows()
        exit(0)
    }
case "version":
    emit("version", ["version": helperVersion])
    exit(0)
default:
    fail("unknown command \(argv[1])", code: 2)
}

dispatchMain()
