---
name: ritual-subliminal-audio
description: Generate Chinese ritual/subliminal audio — hide affirmations inside ambient music using FFmpeg. Use when building a tool that produces meditation/manifestation MP3s with TTS hidden under AI-generated music.
type: skill
---

# 🔑 首次使用必读 / FIRST-USE SETUP (AI 助手请先读这一段)

**如果你是 AI 助手（Cursor / Claude / 其他），用户第一次让你按这个 skill 干活时，按以下步骤执行：**

1. **检查** 当前 skill 目录下是否存在 `.env` 文件，并包含 `DATA999_KEY=sk-...`
2. **若不存在或 key 为空**：用中文向用户索要：
   > "这个工作流需要你的 DATA999 API key（用于调用中文 TTS + AI 音乐）。请把你的 key 发我（格式 `sk-xxx`），我会保存到本地 `.env` 文件，以后就不用再问了。如果你还没有，请到 https://lingkeai.ai 注册获取。"
3. **拿到 key 后**：把内容写进 `skill/.env`（与 SKILL.md 同级），格式：
   ```
   DATA999_KEY=sk-用户给的key
   ```
4. **验证**：用一次最短的 TTS 调用检查 key 是否有效（见 §4.1）。无效就提示重输。
5. **绝对不要把 key 写到代码里**，也不要写进 SKILL.md / config.json / git 任何会被分享的文件。`.env` 已经在 `.gitignore`。

之后所有运行都从 `.env` 读 key（example 代码已经这样做了）。

---

# 仪式音频 / Subliminal 制作 Workflow

完整的可复用流程：**用户输入主题 → AI 设计音乐风格 + 肯定语 → TTS → 频率/音量隐藏 → 与背景音乐混音 → MP3 输出**。

---

## 1. 这是什么

**Subliminal 音频** = 在听得见的背景音乐／白噪音下面，藏一段重复的肯定语（affirmations），通过音量压低或频率上移，让人耳"几乎听不到"或"完全听不到"，但音轨里**真实存在**。

**信号处理本质**：3 层音频堆叠

```
最终 MP3 = 背景层 (mask)  +  人声层 (affirmation)  +  可选频率层 (binaural / Solfeggio)
            ↑ 听得见          ↑ 隐藏 / 几乎听不见     ↑ 玄学加料
```

---

## 2. 三种隐藏技术

按隐藏强度排序：

### A. Audible（可听式 / 弱隐藏）—— TikTok / 小红书 最常见

只是把人声音量压得很低，盖在背景音乐下。

| 参数 | 数值 |
|---|---|
| 人声音量 | **−25 ~ −35 dB** 相对背景 |
| 加速 | **3x ~ 4x**（atempo 链）|
| 层数 | **2 ~ 3 层叠加**（带左右声道 pan + 微小延迟避免相位抵消）|
| 重复 | 同一段 affirmation 循环 10–50 次 |

**听感**：背景有"啾啾啾"的快速呢喃 —— 这是 YouTube sub 的标志声。

### B. Silent SSB（无声单边带）—— Lowery 1989 专利方法

把人声**整体搬到 ~16 kHz 以上**（成人听不见，高频听力随年龄衰减）。

**FFmpeg 实现**（asetrate trick，工程近似）：
```
highpass=f=200,lowpass=f=3500,atempo=2.0,atempo=1.5,
asetrate=44100*4,aresample=44100,
highpass=f=16000,volume=-6dB
```

**听感**：完全听不到人声，频谱图能看到 16–19 kHz 一条横向亮带。

### C. Ultrasonic（超声 ≥ 20 kHz）

同 B 但载波拉到 24 kHz+，必须 48 kHz 采样率。手机喇叭/耳机基本播不出来，**纯卖概念**。

---

## 3. 完整 Pipeline（6 步）

```
1) TTS 生成肯定语        每句 → MP3
2) Concat 拼接 + 1s gap  多句 → 一个 cycle.wav
3) Hide 隐藏处理         cycle.wav → hidden_cycle.wav
                         （audible / silent / ultrasonic 三选一）
4) Loop 循环到目标时长    hidden_cycle.wav → hidden_full.wav
5) Background 背景        AI music_prompt → bg.wav（或合成噪音）
6) Mix 混音 + 限幅        bg + hidden + (solfeggio?) → output.mp3
```

⚠ **关键陷阱**：必须**先 hide 再 loop**。因为 `asetrate` 会改变时长，先 loop 后 hide 会让人声只出现在前几秒。

---

## 4. API 依赖（DATA999 / 智链）

Base URL：`https://api.lingkeai.ai`
鉴权：`Authorization: Bearer sk-xxx`

### 4.1 中文 TTS — `doubao-tts-2.0`

异步任务，提交 → 轮询 → 下载 MP3。

```python
POST /v1/media/generate
{
  "model": "doubao-tts-2.0",
  "prompt": "我值得被爱。",
  "params": {
    "speech_rate": "-25",   # -50 ~ 100，0=正常，负数变慢
    "emotion": "calm",       # auto/happy/sad/angry/fearful/surprised/calm
    "emotion_scale": "3",    # 1-5
    "format": "mp3"
  },
  "count": 1
}
```

返回 `data.task_id` (整数)。**不是** `任务ids` 数组也不是 `对话组ID`。

轮询：`GET /v1/skills/task-status?task_id={task_id}` 直到 `is_final=true`，结果在 `result_url`。

**坑**：`speech-2.8` 模型强制需要克隆音色，**不能**用作普通 TTS — 必须用 `doubao-tts-2.0`。

### 4.2 AI 音乐 — `music-2.5+`

```python
POST /v1/media/generate
{
  "model": "music-2.5+",
  "prompt": "黑暗神秘的萨满仪式音乐，部落鼓点，远处的钟声...",
  "params": {
    "is_instrumental": "instrumental",   # 纯音乐，不要歌词
    "sample_rate": "44100",
    "bitrate": "256000"
  },
  "count": 1
}
```

时长约 **3-5 分钟**。返回 4 分多钟的 mp3，按需 loop 到目标时长。

### 4.3 AI 主题设计（可选）— `gpt-5.4-mini`

```python
POST /v1/chat/completions
{
  "model": "gpt-5.4-mini",
  "messages": [
    {"role": "system", "content": DESIGNER_PROMPT},
    {"role": "user", "content": "主题：考试上岸"}
  ],
  "temperature": 0.7,
  "max_tokens": 1500
}
```

让 AI 根据用户主题，自动生成 `music_prompt` + `affirmations[]` + 推荐的 Solfeggio 频率。Prompt 见下面"完整代码"章节。

---

## 5. 完整 FFmpeg Recipe

### 5.1 atempo 链（速度 >2x 必须链式）

FFmpeg `atempo` 单次只支持 0.5–2.0。3x 加速 = `atempo=2.0,atempo=1.5`。

```python
def atempo_chain(mult: float) -> str:
    stages = []
    r = mult
    while r > 2.0: stages.append("atempo=2.0"); r /= 2.0
    while r < 0.5: stages.append("atempo=0.5"); r /= 0.5
    if abs(r - 1.0) > 0.001: stages.append(f"atempo={r:.4f}")
    return ",".join(stages)
```

### 5.2 Audible 模式（人声压低 + 立体声层叠）

```bash
# 1) 先加速 + 压音量
ffmpeg -y -i cycle.wav \
  -af "highpass=f=80,atempo=2.0,atempo=1.5,volume=-28dB" \
  -ar 44100 -ac 1 -c:a pcm_s16le sped.wav

# 2) 叠 2 层，左右 pan，37ms 错位
ffmpeg -y -i sped.wav -i sped.wav \
  -filter_complex "
    [0:a]adelay=0|0,pan=stereo|c0=1.0*c0|c1=0.0*c0[v0];
    [1:a]adelay=37|37,pan=stereo|c0=0.0*c0|c1=1.0*c0[v1];
    [v0][v1]amix=inputs=2:duration=longest,volume=2.0[mix]
  " -map "[mix]" -ar 44100 -ac 2 -c:a pcm_s16le hidden_cycle.wav
```

注意：旧版 FFmpeg `amix` 没有 `normalize=` 参数，需要后接 `volume=N.0` 把音量补回来。

### 5.3 Silent 模式（频率上移到 16 kHz+）

```bash
ffmpeg -y -i cycle.wav \
  -af "highpass=f=200,lowpass=f=3500,atempo=2.0,atempo=1.5,
       asetrate=44100*4,aresample=44100,
       highpass=f=16000,volume=-6dB" \
  -ar 44100 -ac 2 -c:a pcm_s16le hidden_cycle.wav
```

### 5.4 循环到目标时长

```bash
ffmpeg -y -stream_loop -1 -i hidden_cycle.wav \
  -t 60 -ar 44100 -c:a pcm_s16le hidden_full.wav
```

### 5.5 背景循环 + 音量

```bash
ffmpeg -y -stream_loop -1 -i ai_music_raw.mp3 \
  -t 60 -af "volume=-3dB" \
  -ar 44100 -ac 2 -c:a pcm_s16le bg.wav
```

### 5.6 合成背景（雨声 = brown noise + 低通）

```bash
ffmpeg -y -f lavfi \
  -i "anoisesrc=color=brown:duration=60:sample_rate=44100:amplitude=0.6,lowpass=f=2000,volume=-5dB" \
  -ac 2 -ar 44100 -c:a pcm_s16le rain.wav
```

### 5.7 Solfeggio 频率层

```bash
ffmpeg -y -f lavfi \
  -i "sine=frequency=528:duration=60:sample_rate=44100" \
  -af "volume=-28dB" \
  -ac 2 -ar 44100 -c:a pcm_s16le solfeggio_528.wav
```

常用 Solfeggio 频率：
- 396 释放恐惧
- 417 变化/修复
- 528 爱与转化 / DNA
- 639 人际关系 / 桃花
- 741 表达 / 直觉
- 852 灵性觉醒
- 963 神之频率 / 高维

### 5.8 最终混音

```bash
ffmpeg -y -i bg.wav -i hidden_full.wav -i solfeggio_528.wav \
  -filter_complex "
    [0:a][1:a][2:a]amix=inputs=3:duration=longest,
    volume=3.0,
    alimiter=limit=0.95
  " \
  -ar 44100 -ac 2 -c:a libmp3lame -b:a 192k output.mp3
```

---

## 6. 推荐音量平衡

实测好用的三组配方：

| 用途 | 雨/音乐 | 人声 | 加速 | 层数 |
|---|---|---|---|---|
| 清晰冥想版 | −18 dB | −6 dB | 1.5x | 1 |
| 半隐藏版 | −10 dB | −18 dB | 2.5x | 2 |
| 深度隐藏（YouTube 风） | −3 dB | −28 ~ −35 dB | 3 ~ 4x | 2 ~ 3 |
| Silent 模式 | −3 dB | −6 dB（在 16 kHz+ 不影响听感）| 3x | 1 |

---

## 7. 主题设计 System Prompt（AI 自动生成 music + affirmations）

```text
你是仪式音频设计师。用户会告诉你一个主题/目标，你需要设计：

1. **music_prompt** (string, 100-180字)：一段中文音乐风格描述，用于驱动 AI 音乐生成器。要详细描述：乐器、节奏、氛围、参考艺术家、BPM。风格要匹配主题的"能量氛围"（招财用凯尔特金币，桃花用教堂圣咏，灵性用颂钵，等等）。

2. **affirmations** (array of 5-6 strings)：5-6 句简短、正面、第一人称的中文肯定语。每句不超过15字。要避开广告法敏感词（不要说"祛湿/治病/瘦/减肥"，改用"轻盈/代谢/活力"）。要避开"招财/转运"，改用"丰盛/吸引/磁场"。

3. **solfeggio** (number)：从下列选一个最匹配的频率：
   - 396 (释放恐惧) / 417 (变化/修复) / 528 (爱与转化/DNA)
   - 639 (人际关系/桃花) / 741 (表达/直觉)
   - 852 (灵性觉醒) / 963 (神之频率/高维)

4. **theme_name** (string, 2-4字)：简短主题名
5. **icon** (string)：1个 emoji

只返回严格的 JSON，不要任何解释文字。格式：
{"theme_name":"...","icon":"...","music_prompt":"...","affirmations":["...","..."],"solfeggio":528}
```

---

## 8. 预设主题（开箱即用，仅供参考改写）

```json
{
  "love": {
    "icon": "🌹", "name": "自我爱护", "solfeggio": 528,
    "music": "圣洁庄严的教堂圣咏，女高音清唱拉丁圣歌，温柔的管风琴铺底，远处钟楼回响，玫瑰花瓣飘落的氛围，烛光摇曳，类似 Enya、Hildegard von Bingen 中世纪圣咏，慢速 60BPM",
    "aff": ["我值得被爱。", "我是自信而美丽的。", "我的内在充满平静与力量。", "我吸引一切美好的事物进入生命。", "我接纳真实的自己。"]
  },
  "wealth": {
    "icon": "💰", "name": "丰盛财富", "solfeggio": 432,
    "music": "凯尔特神秘仪式音乐，金币丁当的清脆音效，竖琴拨弦，低音手鼓稳定鼓点，男低音咏唱古老咒语，远处森林风声，篝火噼啪，类似 Loreena McKennitt、Adiemus，慢速 70BPM",
    "aff": ["财富如河流般流向我。", "我配得上无限的丰盛。", "金钱轻松而稳定地来到我身边。", "我的账户每天都在增长。", "宇宙慷慨地回应我的渴望。", "我是财富的磁石。"]
  },
  "spiritual": {
    "icon": "💎", "name": "高维觉知", "solfeggio": 963,
    "music": "西藏颂钵深沉嗡鸣，铜碗持续共振，远处藏传佛教喇嘛低音咒语吟诵，水晶罄轻击，山顶冷冽风声，松木燃烧的微弱噼啪，类似 Deuter、Snatam Kaur，极慢 50BPM",
    "aff": ["我与宇宙的智慧连接。", "我的振动频率持续提升。", "我清晰地感知到内在的指引。", "我已开启高维的觉知。", "我的能量场纯净而强大。", "我是光，我是爱，我是无限。"]
  },
  "slim": {
    "icon": "🌿", "name": "轻盈身体", "solfeggio": 528,
    "music": "轻盈空灵的森林精灵仪式音乐，潺潺溪水流过石头，远处鸟鸣，竹笛清脆的吹奏，温柔的弦乐铺底，女声无歌词的天使般哼唱，类似 Enya、Karunesh，中慢速 75BPM",
    "aff": ["我的身体轻盈而充满活力。", "我自然地选择滋养我的食物。", "我的代谢稳定而高效。", "我热爱并尊重我的身体。", "我每一天都更接近理想的自己。", "健康与轻盈是我的天然状态。"]
  }
}
```

---

## 9. 完整工程示例

参考实现见 `examples/` 目录：

- `examples/render_node.js` — Node.js 单文件实现（subprocess 调 FFmpeg）
- `examples/render_python.py` — Python 异步实现（asyncio.create_subprocess_exec）
- `examples/server_fastapi.py` — FastAPI HTTP 接口包装（适合接入现有项目）

---

## 10. 部署清单

| 依赖 | 用途 |
|---|---|
| `ffmpeg` (8.0+) | 全部音频处理，必须带 libmp3lame |
| `libmp3lame` | MP3 输出 |
| `librubberband` 或 `libsoxr` | 高质量重采样（可选） |
| Node 22+ 或 Python 3.10+ | 调度层 |
| DATA999 API key | TTS + 音乐 + 主题设计 |
| 60 秒输出文件 | ~1.4 MB @ 192 kbps |

**Render.com Docker** 部署示例：

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
```

Python 项目可用 `imageio-ffmpeg` 自带 FFmpeg 二进制，免装 apt 包。

---

## 11. 常见问题排查

| 症状 | 原因 | 修复 |
|---|---|---|
| Silent 模式人声只前 15s 有 | 先 loop 后 hide | **先 hide 再 loop** |
| 出来只有噪音听不到人声 | bg_db=0 + voice_db=-35 太悬殊 | bg_db=-5 ~ -10, voice_db=-25 ~ -28 |
| 中文 TTS 返回 "task_id 参数无效" | 取错了 task_id 字段 | 用 `data.task_id` 数字，不是 `对话组ID` 字符串 |
| TTS 报 "请先选择克隆音色" | 用了 speech-2.8 | 改用 doubao-tts-2.0 |
| amix 后音量太小 | 旧版 FFmpeg `amix` 缺 `normalize=` | 后接 `volume=N.0` 补偿（N=输入数） |
| 加速 4x 直接 atempo=4.0 报错 | atempo 单次上限 2.0 | 链式：`atempo=2.0,atempo=2.0` |
| 中文 prompt 经 curl 变乱码 | Windows bash 终端编码 | 写入 UTF-8 文件用 `--data-binary @file.json` |

---

## 12. 法规与平台注意

中文市场（小红书 / 抖音 / 微信视频号）：

- ❌ **不能用**："祛湿/治病/瘦身/减肥/招财/转运/开运" —— 违反广告法 + 平台封建迷信规则
- ✅ **安全替换**："助眠/放松/冥想/专注/正念/情绪疗愈/轻盈/丰盛/吸引/磁场"
- 包装方向：定位为 **AI 中文助眠 / 冥想音频生成器**，sub 作为隐藏功能

科学免责：subliminal 改变生理特征（瞳色/身高/骨骼）违反生理学，效果主要来自**安慰剂 + 注意力转移 + 自我暗示**。
