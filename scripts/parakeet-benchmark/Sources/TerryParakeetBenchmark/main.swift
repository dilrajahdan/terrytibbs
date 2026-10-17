// Benchmark-only helper. No microphone, clipboard, settings or production integration.
import Foundation
import FluidAudio

private let modelRepository = "FluidInference/parakeet-tdt-0.6b-v3-coreml"
private let modelRevision = "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe"

private struct Request: Decodable {
    let id: String
    let wav: String
}

private func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

@main struct Benchmark {
    static func main() async {
        do {
            let arguments = CommandLine.arguments
            guard arguments.count == 3, ["download", "serve"].contains(arguments[1]) else {
                throw NSError(domain: "benchmark", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "Usage: TerryParakeetBenchmark <download|serve> /absolute/model-cache"])
            }
            let cache = URL(fileURLWithPath: arguments[2], isDirectory: true)
            let folder = cache.appendingPathComponent(Repo.parakeetV3.folderName, isDirectory: true)
            ModelRegistry.revisionOverrides = [modelRepository: modelRevision]
            if arguments[1] == "download" {
                try emit(["type": "downloading", "model": modelRepository, "revision": modelRevision])
                // Explicitly pin the vocabulary too; the SDK's fallback uses its mutable default revision.
                let vocabularyURL = URL(string: "https://huggingface.co/\(modelRepository)/resolve/\(modelRevision)/parakeet_vocab.json")!
                let (vocabulary, response) = try await URLSession.shared.data(from: vocabularyURL)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    throw NSError(domain: "benchmark", code: 3, userInfo: [NSLocalizedDescriptionKey: "Pinned vocabulary download failed"])
                }
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try vocabulary.write(to: folder.appendingPathComponent("parakeet_vocab.json"), options: .atomic)
                _ = try await AsrModels.download(to: folder, version: .v3, encoderPrecision: .int8)
                try vocabulary.write(to: folder.appendingPathComponent("parakeet_vocab.json"), options: .atomic)
                try emit(["type": "downloaded", "model": modelRepository, "revision": modelRevision])
                return
            }
            // The recognition process has no remote model endpoint. All assets must already exist.
            ModelHub.offlineMode = true
            ModelRegistry.baseURL = "http://127.0.0.1:9"
            guard AsrModels.modelsExist(at: folder, version: .v3, encoderPrecision: .int8) else {
                throw NSError(domain: "benchmark", code: 2, userInfo: [NSLocalizedDescriptionKey: "Run download first"])
            }
            let revision = try String(contentsOf: folder.appendingPathComponent(".fluidaudio-revision"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard revision == modelRevision else {
                throw NSError(domain: "benchmark", code: 4, userInfo: [NSLocalizedDescriptionKey: "Cached model revision differs. Download into an empty benchmark cache."])
            }
            let start = ContinuousClock.now
            let models = try await AsrModels.load(from: folder, version: .v3, encoderPrecision: .int8)
            let recognizer = AsrManager()
            try await recognizer.loadModels(models)
            try emit(["type": "ready", "loadMs": milliseconds(start.duration(to: .now)), "model": modelRepository,
                      "revision": modelRevision, "encoderPrecision": "int8"])
            while let line = readLine() {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                let start = ContinuousClock.now
                do {
                    // FluidAudio performs file loading and sample conversion inside this timed call.
                    var decoder = TdtDecoderState.make(decoderLayers: await recognizer.decoderLayerCount)
                    let result = try await recognizer.transcribe(URL(fileURLWithPath: request.wav), decoderState: &decoder, language: .english)
                    try emit(["type": "result", "id": request.id, "text": result.text,
                              "recognizerMs": milliseconds(start.duration(to: .now))])
                } catch {
                    try emit(["type": "error", "id": request.id, "error": error.localizedDescription])
                }
            }
            await recognizer.cleanup()
        } catch {
            try? emit(["type": "error", "error": error.localizedDescription])
            exit(1)
        }
    }
    private static func milliseconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
    }
}
