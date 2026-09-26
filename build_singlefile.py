#!/usr/bin/env python3
"""Build a fully offline, directly openable HTML from the editable source tree.
Reads dev.html (multi-file page) and writes index.html.
Usage: python3 build_singlefile.py
"""
from pathlib import Path
import base64
import json
import re

ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / "dev.html").read_text(encoding="utf-8")
STYLE = (ROOT / "src/style.css").read_text(encoding="utf-8")
CORE = (ROOT / "assets/canvas-core.js").read_text(encoding="utf-8")
ART = (ROOT / "assets/f-art.js").read_text(encoding="utf-8")
DATA = (ROOT / "src/f-data.js").read_text(encoding="utf-8")
TIMELINE = (ROOT / "src/timeline.js").read_text(encoding="utf-8")
AUDIO = (ROOT / "src/audio.js").read_text(encoding="utf-8")
PHYSICS = (ROOT / "src/physics.js").read_text(encoding="utf-8")
RENDERER = (ROOT / "src/renderer.js").read_text(encoding="utf-8")
GAME = (ROOT / "src/game.js").read_text(encoding="utf-8")

audio = {}
for path in sorted((ROOT / "assets/audio").glob("*.mp3")):
    try:
        stem = int(path.stem)
    except:
        continue
    audio[stem] = "data:audio/mpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
wav = ROOT / "assets/audio/315.wav"
if wav.exists():
    audio[315] = "data:audio/wav;base64," + base64.b64encode(wav.read_bytes()).decode("ascii")

def inline_script(content):
    return "<script>\n" + re.sub(r"</script", r"<\\/script", content, flags=re.I) + "\n</script>"

page = re.sub(r'<link rel="stylesheet" href="src/style.css">',
              '<style>\n' + STYLE + '\n</style>', SOURCE, count=1)
page = re.sub(r'\s*<script defer src="assets/canvas-core.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="assets/f-art.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/f-data.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/timeline.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/audio.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/physics.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/renderer.js"></script>', '', page, count=1)
page = re.sub(r'\s*<script defer src="src/game.js"></script>', '', page, count=1)

scripts = '\n'.join((
    inline_script(CORE),
    inline_script(ART),
    inline_script(DATA),
    inline_script(TIMELINE),
    inline_script(AUDIO),
    inline_script(PHYSICS),
    inline_script(RENDERER),
    inline_script('window.TURBO_AUDIO = ' + json.dumps(audio, separators=(',', ':')) + ';'),
    inline_script(GAME)
))
page = page.replace('</body>', scripts + '\n</body>')
output = ROOT / 'index.html'
output.write_text(page, encoding="utf-8")
print(f"Created {output} ({output.stat().st_size:,} bytes; {len(audio)} embedded sounds)")
