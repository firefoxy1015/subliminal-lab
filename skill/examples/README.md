# Examples

## Quick start

```bash
pip install httpx

# 1. set your API key (one of these):
#    a) cp ../.env.example ../.env  → edit .env, paste your sk-... key
#    b) export DATA999_KEY=sk-xxx
# get a key at https://lingkeai.ai

python render_python.py config.example.json
```

Output: `out/self-love/self-love_silent.mp3` (60s, ~1.4MB)

## Files

- `render_python.py` — Single-file reference renderer (async, ~250 lines)
- `config.example.json` — Sample input config
- `designer_prompt.txt` — System prompt for the AI theme designer

## Requirements

- Python 3.10+
- `httpx` (`pip install httpx`)
- `ffmpeg` 8.0+ on PATH (with libmp3lame)
- DATA999 API key (`https://api.lingkeai.ai`)

## Config schema

```json
{
  "title": "string (filename safe)",
  "mode": "audible | silent",
  "duration_sec": 30-600,
  "bg_db": -3,                 // background volume in dB
  "speed_mult": 3,             // affirmation speed multiplier (1-8)
  "layers": 2,                 // audible mode: stacked voice layers
  "voice_db": -28,             // affirmation volume (audible) or boost (silent)
  "solfeggio": 528,            // null/396/417/528/639/741/852/963
  "music_prompt": "string",    // if set: AI-gen music; else: brown noise rain
  "voice": {
    "speech_rate": "-25",      // -50..100, negative = slower
    "emotion": "calm",
    "emotion_scale": "3"
  },
  "affirmations": ["第一句", "第二句", "..."]
}
```

## Cursor / IDE integration

This skill folder is self-contained. To use in Cursor:
1. Copy `skill/SKILL.md` + `skill/examples/` into your project
2. Reference `SKILL.md` in `.cursor/rules` or just open it in chat:
   - "Read SKILL.md and implement the ritual audio renderer"
3. The AI will follow the documented pipeline and FFmpeg recipes
