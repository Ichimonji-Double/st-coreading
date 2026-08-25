// AI-initiated notes. After summarization, we ask the CHARACTER (via
// generateQuietPrompt, which keeps persona) to react to the chunk.
// The character returns strict JSON: { notes: [{ p: <idx>, text: "..." }] }.
// Empty array = nothing worth commenting on.

import { db, newId } from '../storage/db.js';
import { densityGuidance, DEFAULT_DENSITY } from '../context/density.js';

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

function buildNotePrompt({ bookTitle, chapterTitle, rollingSummary, chunk, isChinese, density }) {
    const numberedParas = chunk.paragraphs
        .map((p, i) => `[${i}] ${p}`)
        .join('\n\n');
    const guidance = densityGuidance(density, chunk.paragraphs.length - 1, isChinese);

    if (isChinese) {
        return [
            `我们正在共读《${bookTitle}》${chapterTitle ? `，当前章节：${chapterTitle}` : ''}。`,
            `请你带着自己一贯的性格和视角，读一下下面这段内容。`,
            rollingSummary ? `\n【故事至此的梗概】\n${rollingSummary}\n` : '',
            `【本段原文（每段前的 [数字] 是段落编号）】\n${numberedParas}`,
            `\n判断：这段里有没有让你觉得有意思、被打动、想吐槽、有共鸣、或者想说点什么的段落？`,
            `${guidance}`,
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
        `${guidance}`,
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

export async function generateNotesForChunk({ book, chapter, chunk, charId, charName, rollingSummary, density = DEFAULT_DENSITY }) {
    const chunkText = chunk.paragraphs.join(' ').slice(0, 200);
    const isChinese = /[㐀-鿿]/.test(chunkText);

    const prompt = buildNotePrompt({
        bookTitle: book.title,
        chapterTitle: chapter?.title || '',
        rollingSummary: rollingSummary || '',
        chunk,
        isChinese,
        density,
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

// User asked the character to comment on ONE specific paragraph. Returns
// the saved note record on success, or null if the LLM call failed.
export async function askCharacterAboutParagraph({ book, chapter, chunk, pIdx, charId, charName, rollingSummary }) {
    const paragraph = chunk.paragraphs[pIdx];
    if (!paragraph) return null;
    const before = pIdx > 0 ? chunk.paragraphs[pIdx - 1] : '';
    const after = pIdx < chunk.paragraphs.length - 1 ? chunk.paragraphs[pIdx + 1] : '';
    const isChinese = /[㐀-鿿]/.test(paragraph.slice(0, 200));

    const prompt = isChinese ? [
        `我们正在共读《${book.title}》${chapter?.title ? `，当前章节：${chapter.title}` : ''}。`,
        rollingSummary ? `\n【故事至此的梗概】\n${rollingSummary}\n` : '',
        `我刚看到下面这段觉得挺有意思，你怎么看？`,
        before ? `\n【上一段】\n${before}` : '',
        `\n【这一段（我指的就是它）】\n${paragraph}`,
        after ? `\n【下一段】\n${after}` : '',
        `\n用 1-3 句话跟我说说你的想法，直接说，别加"好的我来评论"这类开头。`,
    ].filter(Boolean).join('\n') : [
        `We're co-reading "${book.title}"${chapter?.title ? `, current chapter: ${chapter.title}` : ''}.`,
        rollingSummary ? `\n[Story so far]\n${rollingSummary}\n` : '',
        `This paragraph caught my eye — what do you think?`,
        before ? `\n[Previous paragraph]\n${before}` : '',
        `\n[This paragraph (the one I'm pointing at)]\n${paragraph}`,
        after ? `\n[Next paragraph]\n${after}` : '',
        `\nReply in 1-3 sentences. Skip preambles like "sure, my thoughts on this..." — just say what you think.`,
    ].filter(Boolean).join('\n');

    let response;
    try {
        response = await askCharacter(prompt);
    } catch (e) {
        console.error('[coread] askCharacterAboutParagraph failed', e);
        return null;
    }
    const text = String(response || '').trim();
    if (!text) return null;

    const note = {
        id: newId('nt_'),
        bookId: book.id,
        chapterId: chunk.chapterId,
        chunkId: chunk.id,
        paragraphIdx: pIdx,
        author: 'char',
        charId,
        charName: charName || 'Character',
        text,
        ts: Date.now(),
    };
    await db.put('notes', note);
    return note;
}

// Save a user-written note. Scoped to the current character session so the
// same-(book, char) filter used by getNotesForChunk / getNotesForBook picks
// it up. A different character on the same book gets a separate note stream.
export async function saveUserNote({ book, chunk, pIdx, text, charId }) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const note = {
        id: newId('nt_'),
        bookId: book.id,
        chapterId: chunk.chapterId,
        chunkId: chunk.id,
        paragraphIdx: pIdx,
        author: 'user',
        charId: charId || 'default',
        charName: 'You',
        text: clean,
        ts: Date.now(),
    };
    await db.put('notes', note);
    return note;
}

export async function deleteNote(noteId) {
    await db.delete('notes', noteId);
}
