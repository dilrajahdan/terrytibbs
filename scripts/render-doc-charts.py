"""Render shareable documentation charts from committed data, without network access."""
import json
from pathlib import Path
import statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
INK, PAPER, GREY, BLUE, GOLD = "#171816", "#f6f4ed", "#5b6056", "#267386", "#bf9600"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 12, "text.color": INK,
    "axes.labelcolor": INK, "xtick.color": GREY, "ytick.color": INK,
    "figure.facecolor": PAPER, "axes.facecolor": PAPER,
    "svg.fonttype": "none", "svg.hashsalt": "terry-docs-v1",
})

def frame(title, subtitle, footer, height=5.6):
    fig, ax = plt.subplots(figsize=(10, height))
    fig.subplots_adjust(left=.24, right=.9, top=.75, bottom=.24)
    fig.text(.045, .93, title, fontsize=22, weight="bold", ha="left")
    fig.text(.045, .855, subtitle, fontsize=11, color=GREY, va="top", linespacing=1.5)
    fig.text(.045, .065, footer, fontsize=10, color=GREY, va="bottom", linespacing=1.5)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#c4c6bc")
    ax.tick_params(axis="y", length=0, pad=12)
    ax.grid(axis="x", color="#dedfd6", linewidth=.8)
    ax.set_axisbelow(True)
    return fig, ax

def save(fig, name, description):
    fig.savefig(OUT / f"{name}.png", dpi=180, metadata={"Description": description})
    fig.savefig(OUT / f"{name}.svg", metadata={"Date": None, "Title": description})
    plt.close(fig)

models = json.loads((ROOT / "docs/data/models.json").read_text())
rows = models["models"]
fig, ax = frame("How much do the models download?",
    "Standard Whisper GGML files. Smaller bars mean less download space.\nThis is not an accuracy or total-memory chart.",
    "Source: pinned ggerganov/whisper.cpp files · Checked 10 October 2026\nExact bytes and source revision: docs/data/models.json")
names = [r["name"] for r in rows]
values = [r["bytes"] / 1e9 for r in rows]
ax.barh(names, values, color=[GOLD if r == "large-v3-turbo" else BLUE for r in names], height=.58)
ax.invert_yaxis()
ax.set_xlim(0, 3.6)
ax.set_xlabel("Download size (decimal GB)", labelpad=10)
for i, value in enumerate(values):
    ax.text(value + .05, i, f"{value:.2f} GB", va="center", fontsize=11)
save(fig, "model-downloads", "Whisper GGML download sizes, in decimal GB. Turbo is 1.62 GB; full large-v3 is 3.10 GB.")

timings = json.loads((ROOT / "docs/data/turbo-timings.json").read_text())
assert timings["referenceWordsMatch"] is True
cli, warm = timings["cliMs"], timings["warmMs"]
assert len(cli) >= 3 and len(warm) >= 3 and min(cli + warm) > 0
fig, ax = frame("Keeping Whisper loaded reduces the wait",
    f'{timings["chip"]} · {timings["memoryBytes"] // 2**30} GB · macOS {timings["macOS"]} · Turbo\n11-second public speech sample. Bars show median time; dots show every run.',
    f'Measured {timings["recordedAt"][:10]} · Normal desktop workload · OS model cache already warm\nRequest processing only. Excludes recording, microphone opening and pasting.')
for i, (label, runs, color) in enumerate([
    (f"New CLI process\n{len(cli)} runs", cli, GREY),
    (f"Model kept loaded\n{len(warm)} runs", warm, BLUE),
]):
    values = [v / 1000 for v in runs]
    median = statistics.median(values)
    ax.barh(i, median, color=color, height=.5)
    offsets = [(j - (len(values)-1)/2) * .045 for j in range(len(values))]
    ax.scatter(values, [i+o for o in offsets], color=INK, s=24, zorder=3, edgecolors=PAPER, linewidth=.7)
    ax.text(median + .14, i, f"{median:.3f} s", va="center", weight="bold")
ax.set_yticks([0, 1], [f"New CLI process\n{len(cli)} runs", f"Model kept loaded\n{len(warm)} runs"])
ax.invert_yaxis()
ax.set_ylim(1.6, -.6)
ax.set_xlim(0, max(cli + warm) / 1000 * 1.3)
ax.set_xlabel("Processing time (seconds, lower is faster)", labelpad=10)
save(fig, "local-transcription", "Measured Turbo transcription processing times on one M2 Max. Bars are medians and dots show individual runs; not a MacBook Neo prediction.")
print("Rendered model-downloads and local-transcription as PNG and SVG.")
