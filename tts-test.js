const API_KEY = 'sk-37b060cd778ee075ac3388fe421c6df1cc367f591238195c';
const BASE = 'https://api.lingkeai.ai';
const r = await fetch(`${BASE}/v1/media/generate`, {
  method:'POST',
  headers:{'Authorization':`Bearer ${API_KEY}`,'Content-Type':'application/json'},
  body: JSON.stringify({
    model:'doubao-tts-2.0',
    prompt:'我值得被爱。我是自信而美丽的。我的内在充满平静与力量。',
    params:{speech_rate:'-25',emotion:'calm',emotion_scale:'3',format:'mp3'},
    count:1
  })
});
const j = await r.json();
console.log('submit:', JSON.stringify(j));
const tid = j.data?.task_id || j.data?.['任务ids']?.[0];
console.log('task_id:', tid);
for (let i=0; i<30; i++) {
  await new Promise(r=>setTimeout(r,3000));
  const s = await fetch(`${BASE}/v1/skills/task-status?task_id=${tid}`, {
    headers:{'Authorization':`Bearer ${API_KEY}`}
  }).then(r=>r.json());
  console.log(i, JSON.stringify(s).slice(0,500));
  if (s.is_final) {
    const url = s.result_url || s.result_urls?.[0] || s.data?.result_url;
    if (url) {
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      (await import('node:fs/promises')).writeFile('test-doubao.mp3', buf);
      console.log('SAVED', buf.length, 'bytes');
    }
    break;
  }
}
