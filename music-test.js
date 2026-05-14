const API_KEY = 'sk-37b060cd778ee075ac3388fe421c6df1cc367f591238195c';
const BASE = 'https://api.lingkeai.ai';
// Check music-2.5+ param schema
const r = await fetch(`${BASE}/v1/skills/models/music-2.5+`, {
  headers:{'Authorization':`Bearer ${API_KEY}`}
});
console.log(JSON.stringify(await r.json(), null, 2));
