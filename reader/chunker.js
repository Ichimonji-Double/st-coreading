// Split parsed book into paragraph-preserving chunks respecting a target token budget.
// Rough token estimate: CJK ≈ 1 char/token, ASCII ≈ 4 chars/token. We use a blended
// estimate that overshoots slightly (safer for context budgeting).

export function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, other = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        // CJK Unified + Hiragana/Katakana + Hangul rough ranges
        if (
            (code >= 0x3040 && code <= 0x30ff) ||
            (code >= 0x3400 && code <= 0x9fff) ||
            (code >= 0xac00 && code <= 0xd7af) ||
            (code >= 0xf900 && code <= 0xfaff)
        ) cjk++;
        else other++;
    }
    return Math.ceil(cjk + other / 3.5);
}

function splitParagraphs(text) {
    return text
        .split(/\n\s*\n+/)
        .map(p => p.replace(/\s+\n/g, '\n').trim())
        .filter(Boolean);
}

// Very long single paragraph → hard-split at sentence boundaries so no chunk overflows.
function splitLongParagraph(para, maxTokens) {
    const sentences = para.split(/(?<=[。！？!?…]|(?<!\d)\.(?!\d))\s*/).filter(Boolean);
    const out = [];
    let buf = '';
    for (const s of sentences) {
        if (estimateTokens(buf + s) > maxTokens && buf) {
            out.push(buf.trim());
            buf = s;
        } else {
            buf += s;
        }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.length ? out : [para];
}

export function chunkChapter(chapterText, maxTokens) {
    const paragraphs = splitParagraphs(chapterText);
    const chunks = [];
    let current = { paragraphs: [], tokens: 0 };

    const flush = () => {
        if (current.paragraphs.length) {
            chunks.push({
                paragraphs: current.paragraphs,
                tokenEst: current.tokens,
            });
        }
        current = { paragraphs: [], tokens: 0 };
    };

    for (const p of paragraphs) {
        const t = estimateTokens(p);
        if (t > maxTokens) {
            // Oversized paragraph — flush current, split it
            flush();
            const parts = splitLongParagraph(p, maxTokens);
            for (const part of parts) {
                chunks.push({ paragraphs: [part], tokenEst: estimateTokens(part) });
            }
            continue;
        }
        if (current.tokens + t > maxTokens && current.paragraphs.length) {
            flush();
        }
        current.paragraphs.push(p);
        current.tokens += t;
    }
    flush();
    return chunks;
}

// Given a parsed book and pace, produce the flat records we store in IndexedDB.
export function buildChunkRecords(book, bookId, maxTokens, newId) {
    const chapters = [];
    const chunks = [];
    let chunkIdxGlobal = 0;

    for (let ci = 0; ci < book.chapters.length; ci++) {
        const ch = book.chapters[ci];
        const chapterId = newId('ch_');
        const chunkIds = [];
        const rawChunks = chunkChapter(ch.text, maxTokens);
        for (let i = 0; i < rawChunks.length; i++) {
            const chunkId = newId('ck_');
            chunkIds.push(chunkId);
            chunks.push({
                id: chunkId,
                bookId,
                chapterId,
                idx: chunkIdxGlobal++,
                localIdx: i,
                paragraphs: rawChunks[i].paragraphs,
                tokenEst: rawChunks[i].tokenEst,
                summary: null,
                status: 'unread',
            });
        }
        chapters.push({
            id: chapterId,
            bookId,
            idx: ci,
            title: ch.title,
            chunkIds,
        });
    }
    return { chapters, chunks };
}
