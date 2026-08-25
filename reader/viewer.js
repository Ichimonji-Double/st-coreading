// Reader view: renders one chunk at a time with prev/next navigation.
// Emits events via the callback bag passed to mount().

import { db } from '../storage/db.js';

let state = {
    bookId: null,
    chapters: [],
    chunks: [],
    currentChunkIdx: 0, // index into flat `chunks` array
};

let callbacks = {};

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

export async function openBook(bookId, cbs = {}) {
    callbacks = cbs;
    const [chapters, chunks] = await Promise.all([
        db.byIndex('chapters', 'bookId', bookId),
        db.byIndex('chunks', 'bookId', bookId),
    ]);
    chapters.sort((a, b) => a.idx - b.idx);
    chunks.sort((a, b) => a.idx - b.idx);
    state = { bookId, chapters, chunks, currentChunkIdx: 0 };

    // Resume from session if any
    const sessions = await db.byIndex('sessions', 'bookId', bookId);
    const activeCharId = callbacks.getCharId?.() || 'default';
    const session = sessions.find(s => s.charId === activeCharId);
    if (session?.currentChunkId) {
        const idx = chunks.findIndex(c => c.id === session.currentChunkId);
        if (idx >= 0) state.currentChunkIdx = idx;
    }
    render();
}

function currentChapter() {
    const ck = state.chunks[state.currentChunkIdx];
    if (!ck) return null;
    return state.chapters.find(c => c.id === ck.chapterId);
}

async function saveProgress() {
    const activeCharId = callbacks.getCharId?.() || 'default';
    const sessionId = `${state.bookId}__${activeCharId}`;
    const existing = await db.get('sessions', sessionId);
    await db.put('sessions', {
        id: sessionId,
        bookId: state.bookId,
        charId: activeCharId,
        currentChunkId: state.chunks[state.currentChunkIdx]?.id,
        rollingSummary: existing?.rollingSummary || '',
        updatedAt: Date.now(),
    });
}

function render() {
    const host = document.querySelector('[data-panel="reader"]');
    if (!host) return;

    if (!state.chunks.length) {
        host.innerHTML = `<div class="coread-empty">No content.</div>`;
        return;
    }
    const chunk = state.chunks[state.currentChunkIdx];
    const chapter = currentChapter();

    host.innerHTML = '';
    const wrap = el(`
        <div class="coread-reader">
            <div class="coread-reader-head">
                <div class="coread-chapter-title"></div>
                <div class="coread-chunk-meta"></div>
            </div>
            <div class="coread-reader-body"></div>
            <div class="coread-reader-nav">
                <button class="coread-btn" data-act="prev">◀</button>
                <span class="coread-progress"></span>
                <button class="coread-btn" data-act="next">▶</button>
            </div>
        </div>
    `);
    wrap.querySelector('.coread-chapter-title').textContent = chapter?.title || '';
    wrap.querySelector('.coread-chunk-meta').textContent = `~${chunk.tokenEst} tok`;
    wrap.querySelector('.coread-progress').textContent =
        `${state.currentChunkIdx + 1} / ${state.chunks.length}`;

    const body = wrap.querySelector('.coread-reader-body');
    chunk.paragraphs.forEach((p, i) => {
        const para = el(`<p class="coread-paragraph" data-pidx="${i}"></p>`);
        para.textContent = p;
        para.addEventListener('click', () => callbacks.onParagraphClick?.(chunk, i, p));
        body.appendChild(para);
    });

    wrap.querySelector('[data-act="prev"]').addEventListener('click', () => turn(-1));
    wrap.querySelector('[data-act="next"]').addEventListener('click', () => turn(1));

    host.appendChild(wrap);
    saveProgress();
}

function turn(delta) {
    const next = state.currentChunkIdx + delta;
    if (next < 0 || next >= state.chunks.length) return;
    state.currentChunkIdx = next;
    render();
    callbacks.onChunkChange?.(state.chunks[next]);
}

export function isOpen() {
    return !!state.bookId;
}

export function closeBook() {
    state = { bookId: null, chapters: [], chunks: [], currentChunkIdx: 0 };
    const host = document.querySelector('[data-panel="reader"]');
    if (host) host.innerHTML = `<div class="coread-empty">Empty.</div>`;
}
