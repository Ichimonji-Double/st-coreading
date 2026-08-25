// AI-initiated notes. After summarization, we ask the CHARACTER (via
// generateQuietPrompt, which keeps persona) to react to the chunk.
// The character returns strict JSON: { notes: [{ p: <idx>, text: "..." }] }.
// Empty array = nothing worth commenting on.

import { db, newId } from '../storage/db.js';

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

async function askCharacter(prompt) {
    const ctx = getContext();
    if (!ctx) throw new Error('SillyTavern context not available');
    if (typeof ctx.generateQuietPrompt === 'function') {
        try {
            return await ctx.generateQuietPrompt(prompt, false, true, null, 'CoReader');
        } catch (e) {
            console.warn('[coread] quiet positional failed, trying object', e);
            return await ctx.generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, quietName: 'CoReader' });
        }
    }
    throw new Error('generateQuietPrompt not available');
}

function buildNotePrompt({ bookTitle, chapterTitle, rollingSummary, chunk, isChinese }) {
    const numberedParas = chunk.paragraphs
        .map((p, i) => `[${i}] ${p}`)
        .join('\n\n');

    if (isChinese) {
        return [
            `我们正在共读《${bookTitle}》${chapterTitle ? `，当前章节：${chapterTitle}` : ''}。`,
            `请你带着自己一贯的性格和视角，读一下下面这段内容。`,
            rollingSummary ? `\n【故事至此的梗概】\n${rollingSummary}\n` : '',
            `【本段原文（每段前的 [数字] 是段落编号）】\n${numberedParas}`,
            `\n判断：这段里有没有让你觉得有意思、被打动、想吐槽、有共鸣、或者想说点什么的段落？`,
            `- 有的话，从 0-${chunk.paragraphs.length - 1} 号段落里挑 1-3 段（宁缺毋滥，别硬凑），每段写 1-2 句你真实的反应（就是随手写的读书笔记，不用完整）。`,
            `- 没有的话，返回空数组。`,
            `\n只返回严格的 JSON，不要 markdown 代码块围栏，不要解释：`,
            `{"notes":[{"p":<段落编号>,"text":"<你的笔记>"}]}`,
            `如果没触动：{"notes":[]}`,
        ].filter(Boolean).join('\n');
    }
    return [
        `We're co-reading "${bookTitle}"${chapterTitle ? `, current chapter: ${chapterTitle}` : ''}.`,
        `Read the passage below as yourself, with your usual voice.`,
        rollingSummary ? `\n[Story so far]\n${rollingSummary}\n` : '',
        `[Passage — each paragraph is prefixed with its index]\n${numberedParas}`,
        `\nDo any paragraphs strike you — interesting, moving, worth reacting to, or something you want to say?`,
        `- If yes: pick 1-3 paragraphs from 0-${chunk.paragraphs.length - 1} (be selective, don't force it) and write 1-2 sentences of genuine reaction per paragraph. Casual, like a margin note.`,
        `- If no: return an empty array.`,
        `\nReturn strict JSON only — no markdown fences, no explanation:`,
        `{"notes":[{"p":<paragraph-index>,"text":"<your note>"}]}`,
        `Nothing struck you: {"notes":[]}`,
    ].filter(Boolean).join('\n');
}

// Robust JSON extraction — characters may wrap in fences or add commentary.
function extractJson(response) {
    if (!response) return null;
    let s = response.trim();
    // Strip markdown fences
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    // Find outermost {…}
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    const jsonSlice = s.slice(first, last + 1);
    try {
        return JSON.parse(jsonSlice);
    } catch (e) {
        console.warn('[coread] failed to parse note JSON', e, jsonSlice.slice(0, 200));
        return null;
    }
}

export async function generateNotesForChunk({ book, chapter, chunk, charId, charName, rollingSummary }) {
    const chunkText = chunk.paragraphs.join(' ').slice(0, 200);
    const isChinese = /[㐀-鿿]/.test(chunkText);

    const prompt = buildNotePrompt({
        bookTitle: book.title,
        chapterTitle: chapter?.title || '',
        rollingSummary: rollingSummary || '',
        chunk,
        isChinese,
    });

    const raw = await askCharacter(prompt);
    const parsed = extractJson(raw);
    if (!parsed?.notes || !Array.isArray(parsed.notes)) {
        console.log('[coread] no valid notes returned', raw?.slice(0, 200));
        return [];
    }

    const saved = [];
    for (const n of parsed.notes) {
        const pidx = Number(n.p);
        const text = String(n.text || '').trim();
        if (!Number.isInteger(pidx) || pidx < 0 || pidx >= chunk.paragraphs.length) continue;
        if (!text) continue;
        const noteRec = {
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
        };
        await db.put('notes', noteRec);
        saved.push(noteRec);
    }
    return saved;
}

export async function getNotesForChunk(bookId, charId, chunkId) {
    const all = await db.byIndex('notes', 'chunkId', chunkId);
    return all.filter(n => n.bookId === bookId && n.charId === charId);
}

export async function getNotesForBook(bookId, charId) {
    const all = await db.byIndex('notes', 'bookId', bookId);
    return all.filter(n => n.charId === charId).sort((a, b) => a.ts - b.ts);
}
