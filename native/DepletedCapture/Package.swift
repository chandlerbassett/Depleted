// swift-tools-version:5.7
// depleted-capture: the native capture + post-processing helper Depleted spawns on macOS.
// ScreenCaptureKit for capture, AVAssetWriter (VideoToolbox, hardware H.264/HEVC) for
// encoding, AVFoundation for trimming and thumbnails. See native/README.md.

import PackageDescription

let package = Package(
    name: "DepletedCapture",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "depleted-capture",
            path: "Sources/depleted-capture",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("ImageIO"),
            ]
        )
    ]
)
