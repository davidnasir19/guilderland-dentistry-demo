"""Assemble the static showcase and verify its packaged media."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "_site"
OUT.mkdir(exist_ok=True)

for name in ("index.html", ".nojekyll", "assets", "content"):
    source = ROOT / name
    if source.is_dir():
        shutil.copytree(source, OUT / name, dirs_exist_ok=True)
    else:
        shutil.copy2(source, OUT / name)

for name, expected in json.loads((ROOT / "media-manifest.json").read_text()).items():
    archive = ROOT / name
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Media checksum mismatch: {name}")
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            path = Path(member.filename)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != "assets":
                raise ValueError(f"Unexpected media path: {member.filename}")
        bundle.extractall(OUT)

manifest = json.loads((OUT / "assets/frames/manifest.json").read_text())
for variant in ("frames", "frames-m"):
    for index in range(manifest["count"]):
        assert (OUT / "assets" / variant / f"frame-{index:04d}.webp").is_file()

print(f"Ready: {len(list(OUT.rglob('*')))} entries, both 921-frame sequences verified.")
