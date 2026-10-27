import Foundation

// depleted-capture <command> [--key value ...]
//
//   record     --output <file.mp4> [--fps 30] [--bitrate-kbps 8000] [--codec h264|hevc]
//              [--resolution native|WIDTHxHEIGHT] [--window <title>]
//   trim       --input <file> --output <file.mp4> --start <secs> [--duration <secs>]
//   thumbnail  --input <file> --output <file.jpg> [--at <secs>]
//   windows    list capturable windows
//   version

let helperVersion = "1.0.0"

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("usage: depleted-capture record|trim|thumbnail|windows|version", code: 2) }
let args = Args(argv.dropFirst(2))

switch argv[1] {
case "record":
    Task { await runRecord(args) }
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
