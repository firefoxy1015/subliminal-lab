"""
Minimal Python implementation of ritual subliminal audio renderer.
See ../SKILL.md for the full design notes.

Usage:
    pip install httpx
    python render_python.py config.json
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx

API_KEY = os.environ.get("DATA999_KEY", "")
API_BASE = "https://api.ai6800.com/api"
FFMPEG = "ffmpeg"


def atempo_chain(mult: float) -> str:
    stages: List[str] = []
    r = mult
    while r > 2.0:
        stages.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        stages.append("atempo=0.5")
        r /= 0.5
    if abs(r - 1.0) > 0.001:
        stages.append(f"atempo={r:.4f}")
    return ",".join(stages)


async def run(args: List[str]) -> None:
    p = await asyncio.create_subprocess_exec(
        FFMPEG, *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await p.communicate()
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg {p.returncode}: {(err or b'').decode(errors='replace')[-1000:]}")


async def submit_and_poll(client: httpx.AsyncClient, body: Dict[str, Any], timeout: int = 300) -> str:
    r = await client.post(
        f"{API_BASE}/v1/media/generate",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json=body,
        timeout=35,
    )
    d = r.json()
    if d.get("code") != 200:
        raise RuntimeError(f"submit: {d}")
    task_id = d["data"].get("task_id") or d["data"].get("任务ids", [None])[0]
    if not task_id:
        raise RuntimeError(f"no task_id: {d}")
    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            s = (await client.get(
                f"{API_BASE}/v1/skills/task-status",
                params={"task_id": task_id},
                headers={"Authorization": f"Bearer {API_KEY}"},
                timeout=20,
            )).json()
        except Exception:
            continue
        if s.get("is_final"):
            if s.get("error"):
                raise RuntimeError(s["error"])
            return s.get("result_url") or s.get("result_urls", [None])[0]
    raise RuntimeError("polling timeout")


async def download(client: httpx.AsyncClient, url: str, out: Path) -> None:
    for attempt in range(4):
        try:
            r = await client.get(url, timeout=120)
            r.raise_for_status()
            if len(r.content) < 1000:
                raise RuntimeError("tiny payload")
            out.write_bytes(r.content)
            return
        except Exception:
            if attempt == 3:
                raise
            await asyncio.sleep(2 * (attempt + 1))


async def tts(client: httpx.AsyncClient, text: str, out: Path, voice: Dict[str, str]) -> None:
    url = await submit_and_poll(client, {
        "model": "doubao-tts-2.0",
        "prompt": text,
        "params": {
            "speech_rate": voice.get("speech_rate", "-25"),
            "emotion": voice.get("emotion", "calm"),
            "emotion_scale": voice.get("emotion_scale", "3"),
            "format": "mp3",
        },
        "count": 1,
    })
    await download(client, url, out)


async def ai_music(client: httpx.AsyncClient, prompt: str, out: Path) -> None:
    url = await submit_and_poll(client, {
        "model": "music-2.5+",
        "prompt": prompt,
        "params": {
            "is_instrumental": "instrumental",
            "sample_rate": "44100",
            "bitrate": "256000",
        },
        "count": 1,
    }, timeout=600)
    await download(client, url, out)


async def render(cfg: Dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    title = cfg.get("title", "ritual")
    duration = int(cfg["duration_sec"])
    mode = cfg["mode"]                                   # audible | silent
    affs: List[str] = cfg["affirmations"]
    voice = cfg.get("voice", {})
    speed = float(cfg.get("speed_mult", 3))
    layers = max(1, int(cfg.get("layers", 2)))
    voice_db = float(cfg.get("voice_db", -28))
    bg_db = float(cfg.get("bg_db", -5))
    solfeggio = cfg.get("solfeggio")
    music_prompt = cfg.get("music_prompt")

    async with httpx.AsyncClient() as client:
        # 1) TTS
        tts_files: List[Path] = []
        for i, a in enumerate(affs):
            f = out_dir / f"aff_{i}.mp3"
            if not f.exists():
                print(f"  TTS {i+1}/{len(affs)}: {a}")
                await tts(client, a, f, voice)
            tts_files.append(f)

        # 2) Concat with 1s gaps → cycle.wav
        gap = out_dir / "gap.wav"
        await run(["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", str(gap)])
        list_f = out_dir / "concat.list"
        parts: List[str] = []
        for i, f in enumerate(tts_files):
            if i > 0:
                parts.append(str(gap).replace("\\", "/"))
            parts.append(str(f).replace("\\", "/"))
        list_f.write_text("\n".join(f"file '{p}'" for p in parts), encoding="utf-8")
        cycle = out_dir / "cycle.wav"
        await run(["-y", "-f", "concat", "-safe", "0", "-i", str(list_f),
                   "-c:a", "pcm_s16le", str(cycle)])

        # 3) Hide (BEFORE looping — asetrate changes duration)
        hidden_cycle = out_dir / f"hidden_cycle_{mode}.wav"
        if mode == "audible":
            sped = out_dir / "sped.wav"
            await run([
                "-y", "-i", str(cycle),
                "-af", f"highpass=f=80,{atempo_chain(speed)},volume={voice_db}dB",
                "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", str(sped),
            ])
            inputs: List[str] = []
            for _ in range(layers):
                inputs += ["-i", str(sped)]
            lines: List[str] = []
            for i in range(layers):
                pan = 0.0 if layers == 1 else (-1 + 2 * i / (layers - 1))
                left = max(0.0, 1 - pan)
                right = max(0.0, 1 + pan)
                delay = i * 37
                lines.append(
                    f"[{i}:a]adelay={delay}|{delay},"
                    f"pan=stereo|c0={left:.3f}*c0|c1={right:.3f}*c0[v{i}]"
                )
            mix_labels = "".join(f"[v{i}]" for i in range(layers))
            filt = ";".join(lines) + (
                f";{mix_labels}amix=inputs={layers}:duration=longest,volume={layers}.0[mix]"
            )
            await run(["-y", *inputs, "-filter_complex", filt, "-map", "[mix]",
                       "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(hidden_cycle)])
        elif mode == "silent":
            await run([
                "-y", "-i", str(cycle),
                "-af", (f"highpass=f=200,lowpass=f=3500,{atempo_chain(speed)},"
                        "asetrate=44100*4,aresample=44100,highpass=f=16000,volume=-6dB"),
                "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(hidden_cycle),
            ])
        else:
            raise ValueError(f"unknown mode: {mode}")

        # 4) Loop to target duration
        hidden_full = out_dir / f"hidden_{mode}.wav"
        await run(["-y", "-stream_loop", "-1", "-i", str(hidden_cycle),
                   "-t", str(duration), "-ar", "44100", "-c:a", "pcm_s16le", str(hidden_full)])

        # 5) Background — AI music if prompt provided, else brown-noise rain
        bg = out_dir / "bg.wav"
        if music_prompt:
            raw = out_dir / "ai_music_raw.mp3"
            if not raw.exists():
                print(f"  AI music: {music_prompt[:60]}…")
                await ai_music(client, music_prompt, raw)
            await run(["-y", "-stream_loop", "-1", "-i", str(raw),
                       "-t", str(duration), "-af", f"volume={bg_db}dB",
                       "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(bg)])
        else:
            await run([
                "-y", "-f", "lavfi",
                "-i", (f"anoisesrc=color=brown:duration={duration}:sample_rate=44100:"
                       f"amplitude=0.6,lowpass=f=2000,volume={bg_db}dB"),
                "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(bg),
            ])

        # 6) Optional Solfeggio + final mix
        tracks = [str(bg), str(hidden_full)]
        if solfeggio:
            sf = out_dir / f"solfeggio_{solfeggio}.wav"
            await run([
                "-y", "-f", "lavfi",
                "-i", f"sine=frequency={solfeggio}:duration={duration}:sample_rate=44100",
                "-af", "volume=-28dB",
                "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(sf),
            ])
            tracks.append(str(sf))

        out_path = out_dir / f"{title}_{mode}.mp3"
        ff_inputs: List[str] = []
        for t in tracks:
            ff_inputs += ["-i", t]
        labels = "".join(f"[{i}:a]" for i in range(len(tracks)))
        await run([
            "-y", *ff_inputs, "-filter_complex",
            f"{labels}amix=inputs={len(tracks)}:duration=longest,"
            f"volume={len(tracks)}.0,alimiter=limit=0.95",
            "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
            str(out_path),
        ])
        return out_path


def main() -> None:
    if not API_KEY:
        sys.exit("ERROR: set DATA999_KEY environment variable")
    if len(sys.argv) < 2:
        sys.exit("usage: python render_python.py config.json")
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path("out") / cfg.get("title", "ritual")
    out = asyncio.run(render(cfg, out_dir))
    print(f"✅ {out}")


if __name__ == "__main__":
    main()
