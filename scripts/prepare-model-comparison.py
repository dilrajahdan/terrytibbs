#!/usr/bin/env python3
"""Fetch public LibriSpeech test speech. Never reads a microphone or personal audio.

Uses 10 evenly spaced speakers per test subset, then the first 3-15 second
utterance in numeric chapter/utterance order. Selection happens before recognition.
Only downloads/caches beneath ignored artifacts/model-comparison.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "artifacts/model-comparison"
SUBSETS = {
    "test-clean": "32fa31d27d2e1cad72775fee3f4849a9",
    "test-other": "fb5a50374b501bb3bac4815ee91d3135",
}


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(url, destination, expected, algorithm="sha256"):
    if destination.exists() and digest(destination, algorithm) == expected:
        return
    temporary = destination.with_suffix(destination.suffix + ".part")
    subprocess.run(["curl", "--fail", "--location", "--retry", "2", "--output", str(temporary), url], check=True)
    if digest(temporary, algorithm) != expected:
        raise ValueError("Public fixture checksum mismatch: " + destination.name)
    temporary.replace(destination)


def numeric_id(identifier):
    return tuple(int(part) for part in identifier.split("-"))


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    clips = CACHE / "clips"
    clips.mkdir(exist_ok=True)
    samples = []
    for subset, checksum in SUBSETS.items():
        archive = CACHE / (subset + ".tar.gz")
        url = "https://openslr.elda.org/resources/12/" + archive.name
        download(url, archive, checksum, "md5")  # Publisher's archive checksum; selected files also get SHA-256.
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            references = {}
            flacs = {}
            for member in members:
                if member.name.endswith(".trans.txt"):
                    for line in source.extractfile(member).read().decode("utf-8").splitlines():
                        identifier, text = line.split(" ", 1)
                        references[identifier] = text
                if member.name.endswith(".flac"):
                    flacs[Path(member.name).stem] = member
            speakers = sorted({int(identifier.split("-")[0]) for identifier in flacs})
            selected_speakers = [speakers[i * (len(speakers) - 1) // 9] for i in range(10)]
            for speaker in selected_speakers:
                candidates = sorted((identifier for identifier in flacs if int(identifier.split("-")[0]) == speaker), key=numeric_id)
                for identifier in candidates:
                    original = clips / (identifier + ".flac")
                    original.write_bytes(source.extractfile(flacs[identifier]).read())
                    duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", str(original)], text=True))
                    if not 3 <= duration <= 15:
                        original.unlink()
                        continue
                    wav = clips / (identifier + ".wav")
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(original), "-ar", "16000", "-ac", "1",
                        "-c:a", "pcm_s16le", "-map_metadata", "-1", str(wav)], check=True)
                    samples.append({"id": identifier, "subset": subset, "speaker": speaker, "reference": references[identifier],
                        "durationMs": round(duration * 1000), "wav": "clips/" + wav.name,
                        "sourceSha256": digest(original), "wavSha256": digest(wav), "sourceArchive": url})
                    break
                else:
                    raise ValueError("No eligible recording for speaker " + str(speaker))
    control = CACHE / "jfk.wav"
    download("https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav", control,
        "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e")
    manifest = {"schema": 1, "source": "https://www.openslr.org/12", "license": "CC BY 4.0",
        "selection": "10 evenly spaced numeric speaker IDs per subset; first numeric utterance lasting 3-15 s; chosen before recognition",
        "archiveMd5": SUBSETS, "control": {"wav": "jfk.wav", "sha256": digest(control),
            "reference": "and so my fellow americans ask not what your country can do for you ask what you can do for your country"},
        "samples": samples}
    (CACHE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"samples": len(samples), "speakers": len({item["speaker"] for item in samples}),
        "seconds": sum(item["durationMs"] for item in samples) / 1000, "manifest": "artifacts/model-comparison/manifest.json"}))


if __name__ == "__main__":
    main()
