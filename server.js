// HTTP API for subliminal-lab
//
// Routes:
//   POST /api/render           { ...config }  → { job_id }
//   GET  /api/status/:id                       → { state, pct, step, error?, download_url? }
//   GET  /api/download/:id                     → audio/mpeg
//   GET  /api/healthz                          → "ok"
//
// In-memory job queue with concurrency cap (single worker).
// For production we'd swap this for CF Queues / Redis, but the interface stays.

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const MAX_DURATION = Number(process.env.MAX_DURATION || 600);  // 10 min cap

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// ---------- job store ----------

const jobs = new Map();  // id → { state, pct, step, cfg, outPath, error, createdAt }
const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    runJob(job);
  }
}

async function runJob(job) {
  running++;
  job.state = 'running';
  job.startedAt = Date.now();
  try {
    const outPath = await render(job.cfg, {
      baseDir: __dirname,
      onProgress: (p) => {
        job.pct = p.pct;
        job.step = p.step;
      },
    });
    job.outPath = outPath;
    job.state = 'done';
    job.pct = 100;
    job.finishedAt = Date.now();
    console.log(`[job ${job.id}] done in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`);
  } catch (e) {
    job.state = 'error';
    job.error = e.message;
    console.error(`[job ${job.id}] error:`, e.message);
  } finally {
    running--;
    pump();
  }
}

// ---------- request validation ----------

function validateCfg(body) {
  const errs = [];
  if (!body || typeof body !== 'object') return ['body must be JSON object'];

  if (typeof body.title !== 'string' || !/^[a-zA-Z0-9\u4e00-\u9fa5_\-]{1,40}$/.test(body.title)) {
    errs.push('title: 1-40 chars, alphanumeric/hyphen/underscore/汉字');
  }
  if (!['audible', 'silent', 'ultrasonic'].includes(body.mode)) {
    errs.push('mode: audible|silent|ultrasonic');
  }
  if (!Number.isFinite(body.duration_sec) || body.duration_sec < 10 || body.duration_sec > MAX_DURATION) {
    errs.push(`duration_sec: 10-${MAX_DURATION}`);
  }
  if (!Array.isArray(body.affirmations) || body.affirmations.length === 0 || body.affirmations.length > 20) {
    errs.push('affirmations: array of 1-20 strings');
  } else if (body.affirmations.some(a => typeof a !== 'string' || a.length > 200)) {
    errs.push('each affirmation must be a string ≤200 chars');
  }
  if (body.music_prompt && (typeof body.music_prompt !== 'string' || body.music_prompt.length > 500)) {
    errs.push('music_prompt must be a string ≤500 chars');
  }
  return errs;
}

// ---------- routes ----------

app.get('/api/healthz', (_req, res) => res.send('ok'));

// ---------- AI theme designer ----------
// User describes a goal (e.g. "考试上岸") → returns music_prompt + affirmations + solfeggio

const API_KEY = process.env.AI_API_KEY || 'sk-37b060cd778ee075ac3388fe421c6df1cc367f591238195c';
const AI_BASE = 'https://api.ai6800.com/api';

const DESIGNER_PROMPT = `你是仪式音频设计师。用户会告诉你一个主题/目标，你需要设计：

1. **music_prompt** (string, 100-180字)：一段中文音乐风格描述，用于驱动 AI 音乐生成器。要详细描述：乐器、节奏、氛围、参考艺术家、BPM。风格要匹配主题的"能量氛围"（招财用凯尔特金币，桃花用教堂圣咏，灵性用颂钵，等等）。

2. **affirmations** (array of 5-6 strings)：5-6 句简短、正面、第一人称的中文肯定语。每句不超过15字。要避开广告法敏感词（不要说"祛湿/治病/瘦/减肥"，改用"轻盈/代谢/活力"）。要避开"招财/转运"，改用"丰盛/吸引/磁场"。

3. **solfeggio** (number)：从下列选一个最匹配的频率：
   - 396 (释放恐惧)
   - 417 (变化/修复)
   - 528 (爱与转化/DNA)
   - 639 (人际关系/桃花)
   - 741 (表达/直觉)
   - 852 (灵性觉醒)
   - 963 (神之频率/高维)

4. **theme_name** (string, 2-4字)：简短主题名
5. **icon** (string)：1个 emoji

只返回严格的 JSON，不要任何解释文字。格式：
{"theme_name":"...","icon":"...","music_prompt":"...","affirmations":["...","..."],"solfeggio":528}`;

app.post('/api/design', async (req, res) => {
  const goal = (req.body?.goal || '').toString().trim();
  if (!goal || goal.length > 100) {
    return res.status(400).json({ error: 'goal: 1-100 chars required' });
  }
  try {
    const r = await fetch(`${AI_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [
          { role: 'system', content: DESIGNER_PROMPT },
          { role: 'user', content: `主题：${goal}` },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });
    const j = await r.json();
    let text = j.choices?.[0]?.message?.content || '';
    // strip code fences if AI added them
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      console.error('AI design parse fail:', text.slice(0, 500));
      return res.status(502).json({ error: 'AI returned malformed JSON', raw: text.slice(0, 300) });
    }
    // basic validation
    if (!parsed.music_prompt || !Array.isArray(parsed.affirmations) || !parsed.solfeggio) {
      return res.status(502).json({ error: 'AI response missing required fields', got: parsed });
    }
    res.json(parsed);
  } catch (e) {
    console.error('design error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/render', (req, res) => {
  const errs = validateCfg(req.body);
  if (errs.length) return res.status(400).json({ errors: errs });

  // Force a unique title per job to avoid cache collisions across users
  const id = randomUUID();
  const cfg = { ...req.body, title: `job-${id.slice(0, 8)}-${req.body.title}` };

  const job = {
    id,
    state: 'queued',
    pct: 0,
    step: 'queued',
    cfg,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(job);
  pump();

  res.json({ job_id: id, queue_position: queue.length });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const out = {
    state: job.state,
    pct: job.pct,
    step: job.step,
  };
  if (job.state === 'error') out.error = job.error;
  if (job.state === 'done') out.download_url = `/api/download/${job.id}`;
  res.json(out);
});

app.get('/api/download/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.state !== 'done') return res.status(404).json({ error: 'not ready' });
  try {
    await fs.access(job.outPath);
  } catch {
    return res.status(410).json({ error: 'file expired' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(job.outPath)}"`);
  // Stream from disk
  const { createReadStream } = await import('node:fs');
  createReadStream(job.outPath).pipe(res);
});

// ---------- janitor: prune old jobs ----------
const TTL_MS = 60 * 60 * 1000;  // 1 hour
setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) {
      jobs.delete(id);
      if (job.outPath) {
        try { await fs.unlink(job.outPath); } catch {}
      }
    }
  }
}, 5 * 60 * 1000);

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`subliminal-lab API on :${PORT} (max concurrent=${MAX_CONCURRENT}, max duration=${MAX_DURATION}s)`);
});
