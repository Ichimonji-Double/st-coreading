// Unified "character reads a chunk" call — one LLM round produces both a
// summary and (optional) notes. Framed as a natural conversational request
// so strong-persona characters don't reject it as prompt injection.
// If the JSON contract fails, the caller falls back to the split-call path
// (summarizer.summarizeChunk + notes/generator.generateNotesForChunk).

import { db, newId } from '../storage/db.js';
import { densityGuidance, DEFAULT_DENSITY } from './density.js';

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

async function askCharacter(prompt) {
    const ctx = getContext();
    if (!ctx) throw new Error('SillyTavern context not available');
    if (typeof ctx.generateQuietPrompt !== 'function') {
        throw new Error('generateQuietPrompt not available');
    }
    try {
        return await ctx.generateQuietPrompt(prompt, false, true, null, 'CoReader');
    } catch (e) {
        return await ctx.generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, quietName: 'CoReader' });
    }
}

function buildUnifiedPrompt({ bookTitle, chapterTitle, rollingSummary, chunk, isChinese, density }) {
    const numberedParas = chunk.paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n');
    const guidance = densityGuidance(density, chunk.paragraphs.length - 1, isChinese);

    if (isChinese) {
        return [
            `我们正在共读《${bookTitle}》${chapterTitle ? `，当前章节：${chapterTitle}` : ''}。`,
            rollingSummary ? `\n【故事至此的梗概】\n${rollingSummary}\n` : '',
            `【刚才读的这段，每段前的 [数字] 是段落编号】\n${numberedParas}`,
            `\n带着你自己的性格和视角读完这段，然后跟我说两件事：`,
            `\n1. **发生了什么**：用 100 字左右复述这段的关键情节推进、人物动向或核心信息，就像你合上书跟朋友说"我刚读到..."那样的口吻。别加评价，只讲事实。`,
            `2. **你的读后感（可选）**：${guidance}`,
            `\n只返回 JSON，别加代码块围栏，别加任何解释文字：`,
            `{"summary":"<发生了什么>","notes":[{"p":<段落编号>,"text":"<你的反应>"}]}`,
        ].filter(Boolean).join('\n');
    }
    return [
        `We're co-reading "${bookTitle}"${chapterTitle ? `, current chapter: ${chapterTitle}` : ''}.`,
        rollingSummary ? `\n[Story so far]\n${rollingSummary}\n` : '',
        `[Passage — each paragraph is prefixed with its index]\n${numberedParas}`,
        `\nRead this as yourself, then tell me two things:`,
        `\n1. **What happened**: recap the key plot/character/info moves in ~100 tokens, in your voice — the way you'd tell a friend "I just read where..." Just facts, no judgment.`,
        `2. **Your reactions (optional)**: ${guidance}`,
        `\nReturn JSON only, no markdown fences, no explanation text:`,
        `{"summary":"<what happened>","notes":[{"p":<paragraph-index>,"text":"<your reaction>"}]}`,
    ].filter(Boolean).join('\n');
}

function extractJson(response) {
    if (!response) return null;
    let s = response.trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    try {
        return JSON.parse(s.slice(first, last + 1));
    } catch (e) {
        console.warn('[coread] unified JSON parse failed', e, s.slice(0, 200));
        return null;
    }
}

function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, other = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (
            (code >= 0x3040 && code <= 0x30ff) ||
            (code >= 0x3400 && code <= 0x9fff) ||
            (code >= 0xac00 && code <= 0xd7af)
        ) cjk++;
        else other++;
    }
    return Math.ceil(cjk + other / 3.5);
}

// Rolling summary compression — same policy as summarizer.js, kept here so
// the unified path doesn't require a round-trip through that module's API.
const ROLLING_TOKEN_BUDGET = 500;
async function compressRolling(rolling, isChinese) {
    if (estimateTokens(rolling) <= ROLLING_TOKEN_BUDGET) return rolling;
    const ctx = getContext();
    if (!ctx?.generateRaw) return rolling.slice(-ROLLING_TOKEN_BUDGET * 3);
    const prompt = isChinese
        ? `以下是一部书的分段摘要拼接，请合并压缩到 ${ROLLING_TOKEN_BUDGET} tokens（约 ${Math.round(ROLLING_TOKEN_BUDGET * 0.7)} 字）以内，保留关键情节、人物、伏笔：\n\n${rolling}`
        : `Below is a concatenation of chunk summaries. Compress to under ${ROLLING_TOKEN_BUDGET} tokens, keeping key plot, characters, and setups:\n\n${rolling}`;
    try {
        const out = await ctx.generateRaw({ prompt, systemPrompt: 'You are a concise summarization assistant.' });
        return (typeof out === 'string' && out.trim()) ? out.trim() : rolling.slice(-ROLLING_TOKEN_BUDGET * 3);
    } catch (e) {
        console.warn('[coread] rolling compression failed', e);
        return rolling.slice(-ROLLING_TOKEN_BUDGET * 3);
    }
}

// Public: run one merged LLM call. On success, persist summary+rolling+notes.
// Returns { ok: true, summary, notes: N } or { ok: false, reason, raw }.
export async function readChunkUnified({ book, chapter, chunk, charId, charName, density = DEFAULT_DENSITY }) {
    const sessionId = `${book.id}__${charId}`;
    const session = (await db.get('sessions', sessionId)) || {
        id: sessionId, bookId: book.id, charId, currentChunkId: chunk.id, rollingSummary: '', updatedAt: Date.now(),
    };

    const chunkText = chunk.paragraphs.join(' ').slice(0, 300);
    const isChinese = /[㐀-鿿]/.test(chunkText);

    const prompt = buildUnifiedPrompt({
        bookTitle: book.title,
        chapterTitle: chapter?.title || '',
        rollingSummary: session.rollingSummary || '',
        chunk,
        isChinese,
        density,
    });

    let raw;
    try {
        raw = await askCharacter(prompt);
    } catch (e) {
        console.warn('[coread] unified: LLM call failed', e);
        return { ok: false, reason: 'llm-error' };
    }

    const parsed = extractJson(raw);
    const summary = parsed?.summary && typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (!summary) {
        console.warn('[coread] unified: no valid summary in response', raw?.slice?.(0, 200));
        return { ok: false, reason: 'no-summary', raw };
    }

    // Persist chunk summary
    chunk.summary = summary;
    chunk.status = 'read';
    await db.put('chunks', chunk);

    // Update rolling summary
    const appended = session.rollingSummary ? `${session.rollingSummary}\n${summary}` : summary;
    session.rollingSummary = await compressRolling(appended, isChinese);
    session.currentChunkId = chunk.id;
    session.updatedAt = Date.now();
    await db.put('sessions', session);

    // Persist notes (if any)
    let savedNotes = 0;
    if (Array.isArray(parsed.notes)) {
        for (const n of parsed.notes) {
            const pidx = Number(n.p);
            const text = String(n.text || '').trim();
            if (!Number.isInteger(pidx) || pidx < 0 || pidx >= chunk.paragraphs.length) continue;
            if (!text) continue;
            await db.put('notes', {
                id: newId('nt_'),
                bookId: book.id,
                chapterId: chunk.chapterId,
                chunkId: chunk.id,
                paragraphIdx: pidx,
                author: 'char',
                charId,
                charName: charName || 'Character',
                text,
                ts: Date.now(),
            });
            savedNotes++;
        }
    }

    return { ok: true, summary, notes: savedNotes };
}
