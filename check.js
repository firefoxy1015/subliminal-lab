const API_KEY = 'sk-37b060cd778ee075ac3388fe421c6df1cc367f591238195c';
const BASE = 'https://api.lingkeai.ai';
const s = await fetch(`${BASE}/v1/skills/task-status?task_id=17963948`,
  { headers: { 'Authorization': `Bearer ${API_KEY}` } }).then(r=>r.json());
console.log(JSON.stringify(s, null, 2));
