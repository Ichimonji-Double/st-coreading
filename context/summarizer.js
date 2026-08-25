// Chunk summarization via SillyTavern's generation API.
// After the user turns the page, we summarize the chunk they just finished
// and update the session's rolling summary.

import { db } from '../storage/db.js';

const SUMMARY_TOKEN_TARGET = 150;
const ROLLING_TOKEN_BUDGET = 500;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

// Try several known signatures across ST versions.
async function callLLM(prompt) {
    const ctx = getContext();
    if (!ctx) throw new Error('SillyTavern context not available');

    if (typeof ctx.generateQuietPrompt === 'function') {
        // Positional signature: (quietPrompt, quietToLoud, skipWIAN, quietImage, quietName, responseLength)
        // Do NOT override responseLength — extended-thinking presets (Claude) require
        // max_tokens > thinking.budget_tokens, so trust the user's preset.
        try {
            const result = await ctx.generateQuietPrompt(prompt, false, true, null, 'CoReader');
            if (typeof result === 'string' && result.trim()) return result.trim();
        } catch (e) {
            console.warn('[coread] generateQuietPrompt positional failed, trying object arg', e);
            try {
                const result = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, quietName: 'CoReader' });
                if (typeof result === 'string' && result.trim()) return result.trim();
            } catch (e2) {
                console.warn('[coread] generateQuietPrompt object failed', e2);
            }
        }
    }

    if (typeof ctx.generateRaw === 'function') {
        try {
            const result = await ctx.generateRaw({ prompt, systemPrompt: '' });
            if (typeof result === 'string' && result.trim()) return result.trim();
        } catch (e) {
            console.warn('[coread] generateRaw failed', e);
        }
    }

    throw new Error('No usable ST generation API found');
}

function buildSummaryPrompt({ bookTitle, chapterTitle, rollingSummary, prevSummary, chunkText, isChinese }) {
    if (isChinese) {
        return [
            `你正在与用户共读《${bookTitle}》。`,
            chapterTitle ? `当前章节：${chapterTitle}` : '',
            rollingSummary ? `\n【全书至此的梗概】\n${rollingSummary}` : '',
            prevSummary ? `\n【上一段落摘要】\n${prevSummary}` : '',
            `\n【本段原文】\n${chunkText}`,
            `\n请用不超过 ${SUMMARY_TOKEN_TARGET} tokens（约 100 字）概括【本段】的关键情节推进、人物动向或核心信息，只输出摘要正文，不要开头语、不要引号、不要"总结："之类的标签。`,
        ].filter(Boolean).join('\n');
    }
    return [
        `You are co-reading "${bookTitle}" with the user.`,
        chapterTitle ? `Current chapter: ${chapterTitle}` : '',
        rollingSummary ? `\n[Story so far]\n${rollingSummary}` : '',
        prevSummary ? `\n[Previous passage summary]\n${prevSummary}` : '',
        `\n[Current passage]\n${chunkText}`,
        `\nWrite a summary of the CURRENT passage in ~${SUMMARY_TOKEN_TARGET} tokens focused on plot progression, character moves, or core information. Output only the summary text — no preamble, no quotes, no "Summary:" label.`,
    ].filter(Boolean).join('\n');
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

async function compressRollingSummary(rolling, isChinese) {
    if (estimateTokens(rolling) <= ROLLING_TOKEN_BUDGET) return rolling;
    const prompt = isChinese
        ? `以下是一部书的分段摘要拼接，请合并压缩到 ${ROLLING_TOKEN_BUDGET} tokens（约 ${Math.round(ROLLING_TOKEN_BUDGET * 0.7)} 字）以内，保留关键情节、人物、伏笔，去除冗余：\n\n${rolling}`
        : `Below is a concatenation of chunk summaries from a book. Compress it to under ${ROLLING_TOKEN_BUDGET} tokens, keeping key plot points, characters, and setups. Remove redundancy:\n\n${rolling}`;
    try {
        return await callLLM(prompt);
    } catch (e) {
        console.warn('[coread] rolling compression failed, truncating instead', e);
        // Naive fallback: keep the tail
        return rolling.slice(-ROLLING_TOKEN_BUDGET * 3);
    }
}

// Public: summarize a chunk if not already summarized, update session rolling summary.
// Returns { chunkSummary, rollingSummary }.
export async function summarizeChunk({ bookId, charId, chunk, chapter, book }) {
    if (chunk.summary) return { chunkSummary: chunk.summary };

    const sessionId = `${bookId}__${charId}`;
    const session = (await db.get('sessions', sessionId)) || {
        id: sessionId, bookId, charId, currentChunkId: chunk.id, rollingSummary: '', updatedAt: Date.now(),
    };
    const prevChunkSummary = await getPrevChunkSummary(bookId, chunk.idx);

    const chunkText = chunk.paragraphs.join('\n\n');
    const isChinese = /[㐀-鿿]/.test(chunkText.slice(0, 200));

    const prompt = buildSummaryPrompt({
        bookTitle: book.title,
        chapterTitle: chapter?.title || '',
        rollingSummary: session.rollingSummary || '',
        prevSummary: prevChunkSummary || '',
        chunkText,
        isChinese,
    });

    const summary = await callLLM(prompt);

    // Persist chunk summary
    chunk.summary = summary;
    chunk.status = 'read';
    await db.put('chunks', chunk);

    // Update rolling summary (append + compress if over budget)
    const appended = session.rollingSummary
        ? `${session.rollingSummary}\n${summary}`
        : summary;
    const nextRolling = await compressRollingSummary(appended, isChinese);
    session.rollingSummary = nextRolling;
    session.updatedAt = Date.now();
    await db.put('sessions', session);

    return { chunkSummary: summary, rollingSummary: nextRolling };
}

async function getPrevChunkSummary(bookId, currentIdx) {
    if (currentIdx <= 0) return '';
    const chunks = await db.byIndex('chunks', 'bookId', bookId);
    const prev = chunks.find(c => c.idx === currentIdx - 1);
    return prev?.summary || '';
}
