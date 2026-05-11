# Subliminal Lab · 中文仪式音频生成器

AI 驱动的中文 subliminal/冥想/仪式音频生成器。
用户输入主题 → AI 设计音乐风格 + 肯定语 → 后端混音输出 MP3。

## 一键部署后端到 Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/firefoxy1015/subliminal-lab)

部署完后端会给你一个 `https://xxx.onrender.com` 网址。
访问根路径就是前端。

## 本地开发

```bash
npm install
node server.js
# 访问 http://localhost:3000
```

## 技术栈
- 后端: Node.js + Express + FFmpeg
- 前端: 单 HTML 文件 (vanilla JS)
- AI: data999 (GPT-5.4 mini / 豆包 TTS / 海螺音乐)
- 部署: Docker on Render

## API
- `POST /api/design` — AI 设计主题
- `POST /api/render` — 提交渲染任务
- `GET /api/status/:id` — 轮询进度
- `GET /api/download/:id` — 下载 MP3
