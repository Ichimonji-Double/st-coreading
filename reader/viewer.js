// Reader view: renders one chunk at a time with prev/next navigation.
// Emits events via the callback bag passed to mount().

import { db } from '../storage/db.js';
import { getNotesForChunk } from '../notes/generator.js';

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
            <details class="coread-ctx">
                <summary>AI context</summary>
                <div class="coread-ctx-body"></div>
            </details>
            <div class="coread-reader-body"></div>
            <div class="coread-reader-nav">
                <button class="coread-btn" data-act="prev">◀</button>
                <span class="coread-progress"></span>
                <button class="coread-btn" data-act="next">▶</button>
            </div>
        </div>
    `);
    wrap.querySelector('.coread-chapter-title').textContent = chapter?.title || '';
    const metaTxt = chunk.summary ? '✓ summarized' : `~${chunk.tokenEst} tok`;
    wrap.querySelector('.coread-chunk-meta').textContent = metaTxt;
    wrap.querySelector('.coread-progress').textContent =
        `${state.currentChunkIdx + 1} / ${state.chunks.length}`;

    const body = wrap.querySelector('.coread-reader-body');
    chunk.paragraphs.forEach((p, i) => {
        const para = el(`<p class="coread-paragraph" data-pidx="${i}"></p>`);
        para.textContent = p;
        para.addEventListener('click', (e) => {
            e.stopPropagation();
            openNoteEditor(para, chunk, i, p);
        });
        body.appendChild(para);
    });

    // Overlay any existing notes as inline cards after their paragraphs
    renderParagraphNotes(chunk).catch(e => console.warn('[coread] notes render', e));

    wrap.querySelector('[data-act="prev"]').addEventListener('click', () => turn(-1));
    wrap.querySelector('[data-act="next"]').addEventListener('click', () => turn(1));

    host.appendChild(wrap);
    saveProgress();
    renderContext();
}

async function renderContext() {
    const body = document.querySelector('#coread-drawer .coread-ctx-body');
    if (!body) return;
    const chunk = state.chunks[state.currentChunkIdx];
    const activeCharId = callbacks.getCharId?.() || 'default';
    const session = await db.get('sessions', `${state.bookId}__${activeCharId}`);
    const rolling = session?.rollingSummary || '';
    const chunkSummary = chunk?.summary || '';
    body.innerHTML = `
        <div class="coread-ctx-block">
            <div class="coread-ctx-label">Rolling summary</div>
            <div class="coread-ctx-text">${escapeHtml(rolling) || '<em>empty</em>'}</div>
        </div>
        <div class="coread-ctx-block">
            <div class="coread-ctx-label">Current chunk summary</div>
            <div class="coread-ctx-text">${escapeHtml(chunkSummary) || '<em>not yet summarized</em>'}</div>
        </div>
    `;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function refreshContext() {
    renderContext();
}

async function renderParagraphNotes(chunk) {
    // Idempotent: clear any previously-rendered note cards + markers first,
    // so callers can invoke this multiple times without producing duplicates.
    document.querySelectorAll('#coread-drawer .coread-note-card').forEach(c => c.remove());
    document.querySelectorAll('#coread-drawer .coread-paragraph.has-note')
        .forEach(p => p.classList.remove('has-note'));

    const charId = callbacks.getCharId?.() || 'default';
    const notes = await getNotesForChunk(state.bookId, charId, chunk.id);
    if (!notes.length) return;
    const notesByPara = new Map();
    for (const n of notes) {
        if (!notesByPara.has(n.paragraphIdx)) notesByPara.set(n.paragraphIdx, []);
        notesByPara.get(n.paragraphIdx).push(n);
    }
    const paras = document.querySelectorAll('#coread-drawer .coread-paragraph');
    for (const p of paras) {
        const idx = Number(p.dataset.pidx);
        const noteList = notesByPara.get(idx);
        if (!noteList) continue;
        p.classList.add('has-note');
        for (const n of noteList) {
            const card = el(`
                <div class="coread-note-card ${n.author === 'char' ? 'note-char' : 'note-user'}">
                    <div class="coread-note-head">
                        <span class="coread-note-author">${escapeHtml(n.charName || (n.author === 'user' ? 'You' : 'Character'))}</span>
                        <span class="coread-note-anchor" title="paragraph ${n.paragraphIdx}">¶${n.paragraphIdx}</span>
                    </div>
                    <div class="coread-note-text"></div>
                </div>
            `);
            card.querySelector('.coread-note-text').textContent = n.text;
            p.insertAdjacentElement('afterend', card);
        }
    }
}

export function refreshParagraphNotes() {
    const chunk = state.chunks[state.currentChunkIdx];
    if (!chunk) return;
    renderParagraphNotes(chunk);
}

export function getCurrentChunkId() {
    return state.chunks[state.currentChunkIdx]?.id;
}

export async function jumpToParagraph(chunkId, paragraphIdx) {
    const idx = state.chunks.findIndex(c => c.id === chunkId);
    if (idx < 0) return false;
    if (idx !== state.currentChunkIdx) {
        state.currentChunkIdx = idx;
        render();
        // render is sync but notes render is async; give it a tick
        await new Promise(r => setTimeout(r, 50));
        await renderParagraphNotes(state.chunks[idx]);
    }
    const para = document.querySelector(`#coread-drawer .coread-paragraph[data-pidx="${paragraphIdx}"]`);
    if (!para) return false;
    para.scrollIntoView({ behavior: 'smooth', block: 'center' });
    para.classList.add('coread-jump-flash');
    setTimeout(() => para.classList.remove('coread-jump-flash'), 1600);
    return true;
}

export function currentChunkIdxInBook(chunkId) {
    return state.chunks.findIndex(c => c.id === chunkId);
}

let openEditorPidx = -1;

function findEditorAnchor(paraEl) {
    // Insert after the paragraph's last existing note card (if any), so the
    // editor visually reads "add a new note after these".
    let last = paraEl;
    let next = paraEl.nextElementSibling;
    while (next && next.classList.contains('coread-note-card')) {
        last = next;
        next = next.nextElementSibling;
    }
    return last;
}

function closeNoteEditor() {
    document.querySelectorAll('#coread-drawer .coread-note-editor').forEach(e => e.remove());
    openEditorPidx = -1;
}

function openNoteEditor(paraEl, chunk, pIdx, paraText) {
    if (openEditorPidx === pIdx) return; // already open here
    closeNoteEditor();
    openEditorPidx = pIdx;

    const labels = callbacks.getLabels?.() || {};
    const editor = el(`
        <div class="coread-note-editor">
            <textarea rows="2" placeholder="${labels.placeholder || 'Write your note...'}"></textarea>
            <div class="coread-note-editor-actions">
                <button data-act="save" class="coread-btn coread-btn-primary">${labels.save || 'Save'}</button>
                <button data-act="ask" class="coread-btn">${labels.ask || 'Ask character'}</button>
                <button data-act="cancel" class="coread-btn coread-btn-icon" title="${labels.cancel || 'Cancel'}">✕</button>
            </div>
            <div class="coread-note-editor-status" hidden></div>
        </div>
    `);
    const anchor = findEditorAnchor(paraEl);
    anchor.insertAdjacentElement('afterend', editor);
    const ta = editor.querySelector('textarea');
    ta.focus();

    const setStatus = (text) => {
        const s = editor.querySelector('.coread-note-editor-status');
        if (text) { s.textContent = text; s.hidden = false; }
        else { s.hidden = true; }
    };

    editor.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        await callbacks.onSaveUserNote?.({ chunk, pIdx, text });
        closeNoteEditor();
        renderParagraphNotes(chunk);
        callbacks.onNotesChanged?.();
    });

    editor.querySelector('[data-act="ask"]').addEventListener('click', async () => {
        editor.querySelectorAll('button, textarea').forEach(b => b.disabled = true);
        setStatus(labels.asking || 'Character is thinking...');
        try {
            await callbacks.onAskCharacter?.({ chunk, pIdx, paraText });
        } finally {
            closeNoteEditor();
            renderParagraphNotes(chunk);
            callbacks.onNotesChanged?.();
        }
    });

    editor.querySelector('[data-act="cancel"]').addEventListener('click', closeNoteEditor);
    editor.addEventListener('click', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeNoteEditor(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            editor.querySelector('[data-act="save"]').click();
        }
    });
}

// Close editor on outside click
document.addEventListener('click', (e) => {
    if (openEditorPidx < 0) return;
    const drawer = document.getElementById('coread-drawer');
    if (drawer && drawer.contains(e.target)) return;
    closeNoteEditor();
});

function turn(delta) {
    const next = state.currentChunkIdx + delta;
    if (next < 0 || next >= state.chunks.length) return;
    const fromChunk = state.chunks[state.currentChunkIdx];
    state.currentChunkIdx = next;
    render();
    callbacks.onChunkChange?.({
        from: fromChunk,
        to: state.chunks[next],
        direction: delta > 0 ? 'forward' : 'backward',
    });
}

export function setReaderStatus(text) {
    const meta = document.querySelector('#coread-drawer .coread-chunk-meta');
    if (meta && text) meta.textContent = text;
}

export function refreshCurrentChunkMeta() {
    const chunk = state.chunks[state.currentChunkIdx];
    const meta = document.querySelector('#coread-drawer .coread-chunk-meta');
    if (!chunk || !meta) return;
    meta.textContent = chunk.summary ? '✓ summarized' : `~${chunk.tokenEst} tok`;
}

export function isOpen() {
    return !!state.bookId;
}

export function closeBook() {
    state = { bookId: null, chapters: [], chunks: [], currentChunkIdx: 0 };
    const host = document.querySelector('[data-panel="reader"]');
    if (host) host.innerHTML = `<div class="coread-empty">Empty.</div>`;
}
