// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TerryParakeetBenchmark",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "503b4bd1bbf7220882de39fe8ae6716aae4132da")
    ],
    targets: [
        .executableTarget(name: "TerryParakeetBenchmark", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])
    ]
)
