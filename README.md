# AI Co-Reading — SillyTavern Extension

Co-read EPUB / TXT ebooks with your SillyTavern character. The AI splits the book into small chunks to keep prompts cheap, keeps a rolling summary for continuity, and can leave a note whenever a passage moves it.

**Status: early alpha.** Skeleton only — reader, summarizer, and note engine are being built.

## Install

In SillyTavern: **Extensions → Install extension** → paste this repo's URL.

## Features (planned)

- Import EPUB / TXT — stored locally in your browser (IndexedDB), never uploaded
- Right-side drawer that coexists with the chat, resizable
- Three-tier summarization: chunk → chapter → rolling book summary
- Character-initiated notes: after each chunk, the character decides whether the passage was worth commenting on
- User-initiated notes: click any paragraph to write your own or ask the character
- Notes scoped per (book, character) — different characters, different reading journeys
- Adjustable "reading pace" — smaller chunks mean denser summaries and notes
- Chinese / English UI, follows SillyTavern's language

## Development

```
manifest.json         # ST extension manifest
index.js              # Entry: drawer, tabs, i18n, settings
style.css             # Uses ST theme CSS vars for light/dark
storage/db.js         # IndexedDB wrapper
i18n/                 # zh-cn / en language files
```

License: MIT
