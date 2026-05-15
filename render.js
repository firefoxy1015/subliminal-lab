// Subliminal audio renderer — prototype v0.1
// Pipeline: affirmations[] → TTS (DATA999 speech-2.8) → loop → hide → mix bg → MP3
//
// Usage:  node render.js demo.json
//
// Modes:
//   audible    人声压低 -25dB 藏在背景里（最常见）
//   silent     人声搬到 17.5kHz 以上（成人听不见，Lowery 专利方法的近似）
//   ultrasonic 人声搬到 22kHz 以上（手机基本播不出，纯概念）

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'sk-37b060cd778ee075ac3388fe421c6df1cc367f591238195c';
const API_BASE = 'https://api.lingkeai.ai';

// ---------- utilities ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => reject(new Error(`${cmd} spawn error: ${e.message}\nargs: ${args.slice(0, 8).join(' ')}…`)));
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\nargs: ${args.slice(0, 8).join(' ')}…\nstderr: ${err.slice(-1500)}`));
    });
  });
}

const log = (...a) => console.log('•', ...a);

// ---------- TTS via DATA999 speech-2.8 ----------

async function tts(text, voiceParams, outPath) {
  log(`TTS: "${text}"`);
  const submit = await fetch(`${API_BASE}/v1/media/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'doubao-tts-2.0',
      prompt: text,
      params: {
        speech_rate: voiceParams.speech_rate ?? '-25',  // 慢一点更助眠
        emotion: voiceParams.emotion ?? 'calm',
        emotion_scale: voiceParams.emotion_scale ?? '3',
        format: 'mp3',
      },
      count: 1,
    }),
  }).then(r => r.json());

  if (submit.code !== 200) throw new Error('TTS submit failed: ' + JSON.stringify(submit));
  const taskId = submit.data?.task_id || submit.data?.['任务ids']?.[0];
  if (!taskId) throw new Error('No task_id in response: ' + JSON.stringify(submit));

  log(`  task ${taskId}, polling…`);
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise(r => setTimeout(r, 4000));
    const status = await fetch(
      `${API_BASE}/v1/skills/task-status?task_id=${taskId}`,
      { headers: { 'Authorization': `Bearer ${API_KEY}` } }
    ).then(r => r.json());

    if (status.is_final) {
      if (status.error) throw new Error('TTS task error: ' + status.error);
      const url = status.result_url || status.result_urls?.[0] || status.data?.result_url;
      if (!url) throw new Error('No result url: ' + JSON.stringify(status));
      log(`  done → ${url}`);
      // Download with retries (transient TLS resets happen)
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
          if (buf.length < 1000) throw new Error('Tiny payload, likely error: ' + buf.toString().slice(0, 200));
          await fs.writeFile(outPath, buf);
          return outPath;
        } catch (e) {
          lastErr = e;
          log(`  download retry ${attempt + 1}: ${e.message}`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      throw lastErr;
    }
  }
  throw new Error('TTS polling timeout');
}

// ---------- AI music generation via music-2.5+ ----------

async function aiMusic(prompt, outPath) {
  log(`AI music: "${prompt.slice(0, 60)}…"`);
  const submit = await fetch(`${API_BASE}/v1/media/generate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'music-2.5+',
      prompt,
      params: {
        is_instrumental: 'instrumental',
        sample_rate: '44100',
        bitrate: '256000',
      },
      count: 1,
    }),
  }).then(r => r.json());
  if (submit.code !== 200) throw new Error('Music submit failed: ' + JSON.stringify(submit));
  const taskId = submit.data?.task_id || submit.data?.['任务ids']?.[0];
  if (!taskId) throw new Error('No task_id: ' + JSON.stringify(submit));
  log(`  music task ${taskId}, polling…`);
  const start = Date.now();
  while (Date.now() - start < 600_000) {
    await new Promise(r => setTimeout(r, 5000));
    let s;
    try {
      s = await fetch(`${API_BASE}/v1/skills/task-status?task_id=${taskId}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}` } }).then(r => r.json());
    } catch (e) {
      log(`  poll error (will retry): ${e.message}`);
      continue;
    }
    if (s.is_final) {
      if (s.error) throw new Error('Music task error: ' + s.error);
      const url = s.result_url || s.result_urls?.[0];
      if (!url) throw new Error('No music url: ' + JSON.stringify(s));
      log(`  music done → ${url}`);
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
          if (buf.length < 5000) throw new Error('Tiny payload');
          await fs.writeFile(outPath, buf);
          return outPath;
        } catch (e) {
          log(`  music dl retry ${attempt + 1}: ${e.message}`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      throw new Error('Music download failed');
    }
    log(`  ${s.progress ?? 0}% ${s.status ?? ''}`);
  }
  throw new Error('Music polling timeout');
}

// ---------- background generators (synthesized, no API call) ----------

async function makeBackground(kind, durationSec, outPath, bgDb = -10) {
  log(`Generating background: ${kind} (${durationSec}s, ${bgDb}dB)`);
  // Smooth fade in/out: max 3s, or 1/8 of duration (whichever smaller).
  // Avoids the harsh "cut on" / "cut off" feel at start/end.
  const fadeSec = Math.min(3.0, durationSec / 8);
  const fadeOutStart = Math.max(0, durationSec - fadeSec);
  const fade = `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fadeOutStart}:d=${fadeSec}`;
  let filter;
  switch (kind) {
    case 'rain':
      filter = `anoisesrc=color=brown:duration=${durationSec}:sample_rate=44100:amplitude=0.6,lowpass=f=2000,volume=${bgDb}dB,${fade}`;
      break;
    case 'white':
      filter = `anoisesrc=color=white:duration=${durationSec}:sample_rate=44100:amplitude=0.3,volume=${bgDb}dB,${fade}`;
      break;
    case 'pink':
      filter = `anoisesrc=color=pink:duration=${durationSec}:sample_rate=44100:amplitude=0.5,volume=${bgDb}dB,${fade}`;
      break;
    case 'binaural':
      filter = `sine=frequency=200:duration=${durationSec}[l];sine=frequency=207:duration=${durationSec}[r];[l][r]amerge=inputs=2,volume=${bgDb}dB,${fade}`;
      break;
    default:
      filter = `anoisesrc=color=brown:duration=${durationSec}:sample_rate=44100:amplitude=0.5,lowpass=f=2000,volume=${bgDb}dB,${fade}`;
  }
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', filter,
    '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outPath,
  ]);
  return outPath;
}

// ---------- affirmation processing ----------

// Loop & pad an affirmation track to fill `targetSec`, with 1s gap between repeats
async function loopToLength(inputs, targetSec, outPath) {
  // Concat all inputs with 1s silence between → one cycle file → loop until target
  const listFile = outPath + '.list';
  const gapFile = outPath + '.gap.wav';
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', gapFile,
  ]);

  const parts = [];
  inputs.forEach((f, i) => {
    if (i > 0) parts.push(gapFile);
    parts.push(f);
  });
  await fs.writeFile(listFile, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));

  if (targetSec === 0) {
    // Just produce one cycle, no looping
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', outPath]);
  } else {
    const cycleFile = outPath + '.cycle.wav';
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', cycleFile]);
    await run('ffmpeg', [
      '-y', '-stream_loop', '-1', '-i', cycleFile, '-t', String(targetSec),
      '-c:a', 'pcm_s16le', outPath,
    ]);
    try { await fs.unlink(cycleFile); } catch {}
  }

  for (const f of [listFile, gapFile]) {
    try { await fs.unlink(f); } catch {}
  }
  return outPath;
}

// Build a chain of atempo filters (FFmpeg's atempo only supports 0.5-2.0 per stage).
function atempoChain(mult) {
  const stages = [];
  let remaining = mult;
  while (remaining > 2.0) { stages.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { stages.push('atempo=0.5'); remaining /= 0.5; }
  if (Math.abs(remaining - 1.0) > 0.001) stages.push(`atempo=${remaining.toFixed(4)}`);
  return stages.join(',');
}

// Apply hiding technique. Real YouTube/小红书 sub formula:
//   speed up affirmations 4x (default), reduce to -35 dB, stack 2-3 layers
//   with stereo pan, so it sounds like a faint "buzzy chatter" under the BGM.
async function hide(inputPath, mode, outPath, opts = {}) {
  const speedMult = opts.speed_mult ?? 4;
  const layers = Math.max(1, opts.layers ?? 3);
  const voiceDb = opts.voice_db ?? -35;
  log(`Hiding (mode=${mode}, speed=${speedMult}x, layers=${layers}, vol=${voiceDb}dB)`);

  if (mode === 'audible') {
    // 1) Speed up + clean voice → single processed track
    const spedPath = outPath + '.sped.wav';
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-af', `highpass=f=80,${atempoChain(speedMult)},volume=${voiceDb}dB`,
      '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', spedPath,
    ]);

    // 2) Stack `layers` copies with stereo pan + tiny offsets so they don't phase-cancel
    const inputs = [];
    for (let i = 0; i < layers; i++) {
      inputs.push('-i', spedPath);
    }
    // Build filter: each input gets a pan position spread evenly across L↔R
    const lines = [];
    for (let i = 0; i < layers; i++) {
      // Pan from -1 (full L) through 0 (center) to +1 (full R)
      const pan = layers === 1 ? 0 : (-1 + (2 * i) / (layers - 1));
      const left = Math.max(0, 1 - pan).toFixed(3);
      const right = Math.max(0, 1 + pan).toFixed(3);
      // small async delay so layers don't perfectly overlap
      const delayMs = i * 37;
      lines.push(`[${i}:a]adelay=${delayMs}|${delayMs},pan=stereo|c0=${left}*c0|c1=${right}*c0[v${i}]`);
    }
    const mixLabels = Array.from({ length: layers }, (_, i) => `[v${i}]`).join('');
    const filter = lines.join(';') + `;${mixLabels}amix=inputs=${layers}:duration=longest:normalize=0[mix]`;

    await run('ffmpeg', [
      '-y', ...inputs,
      '-filter_complex', filter, '-map', '[mix]',
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outPath,
    ]);
    try { await fs.unlink(spedPath); } catch {}
    return outPath;
  }

  // For silent / ultrasonic, keep the frequency-shift approach (already proven).
  let filter, sampleRate;
  if (mode === 'silent') {
    filter = `highpass=f=200,lowpass=f=3500,${atempoChain(speedMult)},asetrate=44100*4,aresample=44100,highpass=f=16000,volume=-6dB`;
    sampleRate = '44100';
  } else if (mode === 'ultrasonic') {
    filter = `highpass=f=200,lowpass=f=3500,${atempoChain(speedMult)},asetrate=44100*5,aresample=48000,highpass=f=20000,volume=-3dB`;
    sampleRate = '48000';
  } else {
    throw new Error('Unknown mode: ' + mode);
  }
  await run('ffmpeg', [
    '-y', '-i', inputPath, '-af', filter,
    '-ar', sampleRate, '-ac', '2', '-c:a', 'pcm_s16le', outPath,
  ]);
  return outPath;
}

// Generate a pure-tone Solfeggio / frequency layer (very quiet, -28 dB default)
async function makeFrequencyLayer(freq, durationSec, outPath) {
  log(`Solfeggio layer: ${freq} Hz`);
  await run('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:duration=${durationSec}:sample_rate=44100`,
    '-af', 'volume=-28dB',
    '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outPath,
  ]);
  return outPath;
}

// ---------- final mix ----------

async function mix(tracks, outPath, sampleRate = 44100) {
  log(`Mixing ${tracks.length} tracks → MP3`);
  const inputs = [];
  tracks.forEach(t => { inputs.push('-i', t); });
  const labels = tracks.map((_, i) => `[${i}:a]`).join('');
  const filter = `${labels}amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95`;
  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filter,
    '-ar', String(sampleRate),
    '-ac', '2',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outPath,
  ]);
  return outPath;
}

// ---------- main / exported renderer ----------

export async function render(cfg, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const baseDir = opts.baseDir || __dirname;
  log('Config:', cfg.title, '| mode=' + cfg.mode, '| duration=' + cfg.duration_sec + 's');

  const cacheDir = path.join(baseDir, 'cache', cfg.title);
  const outDir = path.join(baseDir, 'output');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  onProgress({ step: 'init', pct: 0 });

  // 1) TTS each affirmation
  const ttsFiles = [];
  for (let i = 0; i < cfg.affirmations.length; i++) {
    const f = path.join(cacheDir, `aff_${i}.mp3`);
    try { await fs.access(f); log(`  cached aff_${i}`); }
    catch { await tts(cfg.affirmations[i], cfg.voice || {}, f); }
    ttsFiles.push(f);
    onProgress({ step: 'tts', pct: Math.round(((i + 1) / cfg.affirmations.length) * 30) });
  }

  // 2) Concat affirmations into one cycle (no loop yet)
  const cyclePath = path.join(cacheDir, 'cycle.wav');
  await loopToLength(ttsFiles, /*just one cycle=*/ 0, cyclePath);

  // 3) Apply hiding mode on the short cycle (asetrate changes duration so hide first)
  const hiddenCyclePath = path.join(cacheDir, `hidden_cycle_${cfg.mode}.wav`);
  await hide(cyclePath, cfg.mode, hiddenCyclePath, {
    speed_mult: cfg.speed_mult ?? 4,
    layers: cfg.layers ?? 3,
    voice_db: cfg.voice_db ?? -35,
  });

  // 4) Loop the hidden cycle to target duration
  const hiddenPath = path.join(cacheDir, `hidden_${cfg.mode}.wav`);
  const sampleRate = cfg.mode === 'ultrasonic' ? 48000 : 44100;
  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-i', hiddenCyclePath,
    '-t', String(cfg.duration_sec),
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le', hiddenPath,
  ]);

  // 5) Background — AI music if music_prompt provided, else synthesized noise
  // Smooth fade in/out so it doesn't start/end abruptly.
  const fadeSec = Math.min(3.0, cfg.duration_sec / 8);
  const fadeOutStart = Math.max(0, cfg.duration_sec - fadeSec);
  const fade = `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fadeOutStart}:d=${fadeSec}`;
  let bgPath;
  if (cfg.music_prompt) {
    const rawMusicPath = path.join(cacheDir, 'ai_music_raw.mp3');
    try { await fs.access(rawMusicPath); log('  cached AI music'); }
    catch { await aiMusic(cfg.music_prompt, rawMusicPath); }
    // Loop/trim to target duration, apply bg_db + fade
    bgPath = path.join(cacheDir, `bg_music_${cfg.bg_db ?? -10}.wav`);
    await run('ffmpeg', [
      '-y', '-stream_loop', '-1', '-i', rawMusicPath,
      '-t', String(cfg.duration_sec),
      '-af', `volume=${cfg.bg_db ?? -10}dB,${fade}`,
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', bgPath,
    ]);
  } else {
    bgPath = path.join(cacheDir, `bg_${cfg.background}_${cfg.bg_db ?? -10}.wav`);
    await makeBackground(cfg.background, cfg.duration_sec, bgPath, cfg.bg_db ?? -10);
  }

  // 6) Optional Solfeggio frequency layer
  const tracks = [bgPath, hiddenPath];
  if (cfg.solfeggio) {
    const sf = path.join(cacheDir, `solfeggio_${cfg.solfeggio}.wav`);
    await makeFrequencyLayer(cfg.solfeggio, cfg.duration_sec, sf);
    tracks.push(sf);
  }

  // 7) Mix
  onProgress({ step: 'mixing', pct: 90 });
  const outPath = path.join(outDir, `${cfg.title}_${cfg.mode}.mp3`);
  await mix(tracks, outPath, sampleRate);

  onProgress({ step: 'done', pct: 100 });
  log('\n✅ Output:', outPath);
  return outPath;
}

// CLI mode (preserved for backwards compatibility)
const isCLI = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isCLI || process.argv[1]?.endsWith('render.js')) {
  const cfgPath = process.argv[2] || 'demo.json';
  fs.readFile(cfgPath, 'utf8')
    .then(s => render(JSON.parse(s)))
    .catch(e => { console.error('\n❌', e.message); process.exit(1); });
}
