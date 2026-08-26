# 共读时光 · Co-Reading Time

A SillyTavern extension that lets you read EPUB / TXT ebooks alongside your character. The AI reads with you page by page, keeps a rolling summary so context stays cheap, and jots down notes whenever a passage moves it. You can also write your own notes, ask the character to comment on a specific paragraph, and export the whole reading journal.

一个 SillyTavern 扩展，让你和 AI 角色一起阅读 EPUB / TXT 电子书。AI 会跟着你翻页共读、维护滚动摘要保证上下文轻量，看到有意思的段落会主动写读书笔记。你也可以自己写笔记、指定某一段让角色评论，并把整本书的读书笔记导出。

---

## 主要功能 · Features

- **本地导入** EPUB / TXT — 全部存在浏览器 IndexedDB，**不上传任何服务器**
- **右侧可拖拽面板**，8 向缩放，边聊边读不打扰
- **自适应章节分块** — 按 token 预算切，"阅读节奏"滑块 400-2400 tok / 块可调
- **AI 主动共读**：每翻一页角色读一次原文 + 更新滚动摘要 + 选择性写读书笔记（一次 API 调用完成三件事）
- **笔记密度三档**：稀疏 / 中等 / 密集，角色批注不刷屏也不冷场
- **用户笔记**：点段落写自己的想法，可编辑可删除
- **让角色评论某段**：单段定向请求，角色只针对你指的那段回应
- **主聊天上下文注入**（可开关）：勾选后，跟角色聊天时自动带上"故事至此"和"当前段落"，讨论共读内容自然衔接。关闭面板即停止注入，无副作用。
- **每角色独立笔记流**：同一本书用不同角色读，笔记互不打扰
- **导出**：Markdown（贴 Notion/Obsidian 直接用）或 JSON（机器可读）
- **中英双语 UI**，跟随 ST 全局语言

---

## 安装 · Install

**方法 A（推荐）**：SillyTavern → Extensions → Install extension → 贴仓库 URL：

```
https://github.com/Ichimonji-Double/st-coreading
```

**方法 B（本地开发）**：把仓库 clone 到 `<SillyTavern>/public/scripts/extensions/third-party/st-coreading/`，或者用符号链接。

装完到 Extensions 面板里勾选 **共读时光 / Co-Reading Time** 启用。ST 顶栏扩展菜单里会多出一项 📖 **共读时光**，点开即用。

## 使用 · Quick start

1. 打开 **共读时光** 面板 → "书库" tab → **+ 导入书籍** → 选一个 .txt 或 .epub
2. 点书目 → 进入"阅读器"
3. 点 ▶ 翻页 —— 角色会在后台悄悄"读"这一块，写摘要，如果被触动会留笔记
4. 想自己写笔记 → 点任意段落弹出编辑框
5. 想跟角色**聊聊**这段 → "设置" tab 勾"聊天时注入当前阅读上下文" → 主聊天正常输入即可，角色会带着阅读上下文回复
6. 想导出 → "读书笔记" tab 顶部 **Markdown / JSON**

---

## 工作原理 · How it works

```
一本书
 └─ 章节（EPUB TOC / TXT 章节正则识别）
     └─ chunk（按 token 预算切，保留段落边界）
         └─ paragraph（读书笔记锚点）
```

**每翻一页发生什么**：

```
翻页 ▶
 └─ 一次 generateQuietPrompt 调用（角色 persona ON）
     └─ 角色返回 JSON: { summary, notes:[{p, text}] }
         ├─ summary → 追加到当前 session 的 rolling summary（超过 500 tok 会自动压缩）
         └─ notes → 存到对应段落
```

**主聊天注入**（可选，默认关）：

```
你在主聊天发消息
 └─ 触发 ST 正常生成（本来就要打的 1 次 API）
     └─ 我们通过 setExtensionPrompt 顺手把 rolling summary + 当前段落塞进 system context
         └─ 角色回复时"知道"你们在共读什么
```

安全阀：**只有面板打开时才注入**。关掉面板 → 立即清空注入，聊天回到普通模式，忘关设置也不会误伤。

---

## 数据与隐私 · Data & privacy

- 所有书本、章节、chunk、笔记、摘要都存在你**本机浏览器的 IndexedDB**
- 扩展本身不发任何网络请求（除了初次导入 EPUB 时从 [jsDelivr CDN](https://www.jsdelivr.com/) 加载 [JSZip](https://stuk.github.io/jszip/) 和 [epub.js](https://github.com/futurepress/epub.js/)）
- 所有摘要/笔记生成走的是**你在 SillyTavern 里已配置的 LLM 连接**（OpenAI/Claude/本地模型都行），扩展不接管、不代理
- 换设备 = 换个 IndexedDB。想搬迁 → 用 JSON 导出（笔记搬迁），书本需要重新导入

---

## 要求 · Requirements

- SillyTavern（近期版本；开发时测试于 2026 年 8 月主线）
- 一个可用的 LLM 后端（任意 chat completion 通道均可）
- 浏览器：Chrome / Firefox / Edge 等现代浏览器（支持 IndexedDB + ES modules）

## 代码结构 · Project layout

```
manifest.json         ST 扩展元数据
index.js              入口：drawer、tabs、i18n、设置、命令编排
style.css             使用 ST 主题变量，跟随明暗
storage/db.js         IndexedDB 封装
reader/
  parser.js           TXT / EPUB 解析（epub.js 从 CDN 懒加载）
  chunker.js          按 token 预算的段落保留分块
  viewer.js           阅读器 UI + 段落笔记渲染 + 跳转
context/
  summarizer.js       Fallback：raw 摘要 + rolling 压缩
  unified.js          主路径：单调用合并摘要 + 笔记
  density.js          笔记密度提示词
notes/
  generator.js        Fallback：单独笔记调用 + 用户笔记增删改
  exporter.js         Markdown / JSON 导出
i18n/
  zh-cn.json
  en.json
```

## 贡献 · Contributing

Issue / PR 都欢迎。如果发现 bug、想加功能、或者觉得中英文措辞可以更好，都请开 issue。

## 致谢 · Credits

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) — 强大的开源 LLM 前端
- [epub.js](https://github.com/futurepress/epub.js/) — EPUB 解析
- [JSZip](https://stuk.github.io/jszip/) — ZIP 处理
- 本扩展从 0 到 1 是与 Claude 在 Claude Code 里结对开发的成果 —— 讨论架构、写代码、debug、UX 打磨全流程 🤝

## License

MIT
