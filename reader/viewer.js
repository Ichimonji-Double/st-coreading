// Reader view: renders one chunk at a time with prev/next navigation.
// Emits events via the callback bag passed to mount().

import { db } from '../storage/db.js';
import { getNotesForChunk, deleteNote, updateNoteText } from '../notes/generator.js';

let state = {
    bookId: null,
    chapters: [],
    chunks: [],
    currentChunkIdx: 0,   // index into flat `chunks` array
    maxReadChunkIdx: 0,   // furthest chunk this (book, char) session has reached
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
    state = { bookId, chapters, chunks, currentChunkIdx: 0, maxReadChunkIdx: 0 };

    // Resume from session if any
    const sessions = await db.byIndex('sessions', 'bookId', bookId);
    const activeCharId = callbacks.getCharId?.() || 'default';
    const session = sessions.find(s => s.charId === activeCharId);
    if (session?.currentChunkId) {
        const idx = chunks.findIndex(c => c.id === session.currentChunkId);
        if (idx >= 0) state.currentChunkIdx = idx;
    }
    // Restore max-read. If missing (older session), infer from current position.
    // Also fall back to the highest chunk that has a stored summary, since
    // summaries are only created on forward navigation past a chunk.
    const inferredMax = Math.max(
        session?.maxReadChunkIdx ?? 0,
        state.currentChunkIdx,
        chunks.reduce((m, c, i) => (c.summary ? Math.max(m, i) : m), 0),
    );
    state.maxReadChunkIdx = Math.min(inferredMax, chunks.length - 1);
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
        maxReadChunkIdx: state.maxReadChunkIdx,
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
    const jumpHint = callbacks.getLabels?.()?.jumpHint || 'Click to jump to a page you\'ve read';
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
                <span class="coread-progress" title="${jumpHint}">
                    <span class="coread-progress-current"></span>
                    <span class="coread-progress-sep"> / </span>
                    <span class="coread-progress-total"></span>
                </span>
                <button class="coread-btn" data-act="next">▶</button>
            </div>
        </div>
    `);
    wrap.querySelector('.coread-chapter-title').textContent = chapter?.title || '';
    const metaTxt = chunk.summary ? '✓ summarized' : `~${chunk.tokenEst} tok`;
    wrap.querySelector('.coread-chunk-meta').textContent = metaTxt;
    wrap.querySelector('.coread-progress-current').textContent = String(state.currentChunkIdx + 1);
    wrap.querySelector('.coread-progress-total').textContent = String(state.chunks.length);

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
    wrap.querySelector('.coread-progress').addEventListener('click', openPageJump);

    host.appendChild(wrap);
    saveProgress();
    renderContext();
}

function openPageJump() {
    const progress = document.querySelector('#coread-drawer .coread-progress');
    if (!progress || progress.querySelector('input')) return;
    const total = state.chunks.length;
    const maxAllowed = state.maxReadChunkIdx + 1;
    const current = state.currentChunkIdx + 1;
    const labels = callbacks.getLabels?.() || {};

    const wrapper = document.createElement('span');
    wrapper.className = 'coread-progress-edit';
    wrapper.innerHTML = `
        <input type="number" class="coread-page-input" min="1" max="${maxAllowed}" value="${current}" />
        <span class="coread-progress-sep"> / ${total}</span>
    `;
    progress.replaceChildren(wrapper);
    const input = wrapper.querySelector('input');
    input.focus();
    input.select();

    const revert = () => {
        progress.innerHTML = `
            <span class="coread-progress-current">${state.currentChunkIdx + 1}</span>
            <span class="coread-progress-sep"> / </span>
            <span class="coread-progress-total">${total}</span>
        `;
    };

    const commit = () => {
        const target = Number(input.value);
        if (!Number.isInteger(target) || target < 1 || target > total) {
            flashInvalid(input, (labels.jumpInvalid || 'Enter a number between 1 and {max}').replace('{max}', total));
            return;
        }
        if (target > maxAllowed) {
            flashInvalid(input, (labels.jumpTooFar || 'You can only jump back (max: page {max})').replace('{max}', maxAllowed));
            return;
        }
        const newIdx = target - 1;
        if (newIdx === state.currentChunkIdx) {
            revert();
            return;
        }
        jumpToChunkIdx(newIdx);
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); revert(); }
    });
    input.addEventListener('blur', () => {
        // Small delay so click on flash message doesn't blur-then-revert
        setTimeout(() => {
            if (progress.querySelector('input') === input) revert();
        }, 100);
    });
}

function flashInvalid(input, message) {
    input.classList.add('coread-page-input-error');
    let hint = document.querySelector('#coread-drawer .coread-page-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'coread-page-hint';
        input.closest('.coread-progress-edit')?.appendChild(hint);
    }
    hint.textContent = message;
    hint.hidden = false;
    clearTimeout(flashInvalid._t);
    flashInvalid._t = setTimeout(() => {
        input.classList.remove('coread-page-input-error');
        if (hint) hint.hidden = true;
    }, 2400);
    input.focus();
    input.select();
}

function jumpToChunkIdx(newIdx) {
    if (newIdx < 0 || newIdx >= state.chunks.length) return;
    if (newIdx > state.maxReadChunkIdx) return;
    state.currentChunkIdx = newIdx;
    render();
    // Notify orchestrator so it can refresh injection / notes panels.
    // Backward-only jumps by definition don't need summarization, so we send
    // direction 'backward' regardless of relative position.
    callbacks.onChunkChange?.({
        from: null,
        to: state.chunks[newIdx],
        direction: 'backward',
    });
}

async function renderContext() {
    const body = document.querySelector('#coread-drawer .coread-ctx-body');
    if (!body) return;
    const chunk = state.chunks[state.currentChunkIdx];
    const activeCharId = callbacks.getCharId?.() || 'default';
    const session = await db.get('sessions', `${state.bookId}__${activeCharId}`);
    const rolling = session?.rollingSummary || '';
    const chunkSummary = chunk?.summary || '';
    const L = callbacks.getLabels?.() || {};
    const labelRolling = L.ctxRolling || 'Rolling summary';
    const labelChunk = L.ctxChunkSummary || 'Current chunk summary';
    const empty = L.ctxEmpty || '(empty)';
    const notYet = L.ctxNotYet || '(not yet summarized)';
    const editLabel = L.edit || 'Edit';

    body.innerHTML = `
        <div class="coread-ctx-block" data-kind="rolling">
            <div class="coread-ctx-head">
                <div class="coread-ctx-label">${escapeHtml(labelRolling)}</div>
                <button class="coread-ctx-edit" data-kind="rolling" title="${escapeHtml(editLabel)}">✎</button>
            </div>
            <div class="coread-ctx-text">${escapeHtml(rolling) || `<em>${escapeHtml(empty)}</em>`}</div>
        </div>
        <div class="coread-ctx-block" data-kind="chunk">
            <div class="coread-ctx-head">
                <div class="coread-ctx-label">${escapeHtml(labelChunk)}</div>
                <button class="coread-ctx-edit" data-kind="chunk" title="${escapeHtml(editLabel)}" ${chunk ? '' : 'disabled'}>✎</button>
            </div>
            <div class="coread-ctx-text">${escapeHtml(chunkSummary) || `<em>${escapeHtml(notYet)}</em>`}</div>
        </div>
    `;

    body.querySelectorAll('.coread-ctx-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const kind = btn.dataset.kind;
            beginContextEdit(kind, kind === 'rolling' ? rolling : chunkSummary);
        });
    });
}

function beginContextEdit(kind, current) {
    const block = document.querySelector(`#coread-drawer .coread-ctx-block[data-kind="${kind}"]`);
    if (!block || block.querySelector('.coread-ctx-textarea')) return;
    const L = callbacks.getLabels?.() || {};
    const textEl = block.querySelector('.coread-ctx-text');
    const editBtn = block.querySelector('.coread-ctx-edit');
    if (editBtn) editBtn.disabled = true;

    const editor = document.createElement('div');
    editor.className = 'coread-ctx-editor';
    editor.innerHTML = `
        <textarea class="coread-ctx-textarea" rows="6"></textarea>
        <div class="coread-ctx-editor-hint">${escapeHtml(L.ctxEditHint || '')}</div>
        <div class="coread-ctx-editor-actions">
            <button data-act="save" class="coread-btn coread-btn-primary">${escapeHtml(L.save || 'Save')}</button>
            <button data-act="cancel" class="coread-btn">${escapeHtml(L.cancel || 'Cancel')}</button>
        </div>
    `;
    editor.querySelector('textarea').value = current || '';
    textEl.replaceWith(editor);
    const ta = editor.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    editor.addEventListener('click', (e) => e.stopPropagation());
    editor.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const newText = ta.value.trim();
        try {
            await persistContextEdit(kind, newText);
        } catch (err) {
            console.error('[coread] context edit save failed', err);
        }
        renderContext();
        callbacks.onContextEdited?.();
    });
    editor.querySelector('[data-act="cancel"]').addEventListener('click', () => {
        renderContext();
    });
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); renderContext(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            editor.querySelector('[data-act="save"]').click();
        }
    });
}

async function persistContextEdit(kind, newText) {
    if (kind === 'rolling') {
        const activeCharId = callbacks.getCharId?.() || 'default';
        const sessionId = `${state.bookId}__${activeCharId}`;
        const session = (await db.get('sessions', sessionId)) || {
            id: sessionId, bookId: state.bookId, charId: activeCharId,
            currentChunkId: state.chunks[state.currentChunkIdx]?.id,
            rollingSummary: '', updatedAt: Date.now(),
        };
        session.rollingSummary = newText;
        session.updatedAt = Date.now();
        await db.put('sessions', session);
        return;
    }
    if (kind === 'chunk') {
        const chunk = state.chunks[state.currentChunkIdx];
        if (!chunk) return;
        chunk.summary = newText;
        if (newText) chunk.status = 'read';
        await db.put('chunks', chunk);
        return;
    }
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
            const card = buildNoteCard(n, chunk);
            p.insertAdjacentElement('afterend', card);
        }
    }
}

export function refreshParagraphNotes() {
    const chunk = state.chunks[state.currentChunkIdx];
    if (!chunk) return;
    renderParagraphNotes(chunk);
}

function buildNoteCard(n, chunk) {
    const isUser = n.author === 'user';
    const authorLabel = escapeHtml(n.charName || (isUser ? 'You' : 'Character'));
    const controls = isUser ? `
        <button class="coread-note-btn coread-note-edit" title="edit">✎</button>
        <button class="coread-note-btn coread-note-del" title="delete">✕</button>
    ` : '';
    const card = el(`
        <div class="coread-note-card ${isUser ? 'note-user' : 'note-char'}" data-note-id="${n.id}">
            <div class="coread-note-head">
                <span class="coread-note-author">${authorLabel}</span>
                <div class="coread-note-controls">${controls}</div>
                <span class="coread-note-anchor" title="paragraph ${n.paragraphIdx}">¶${n.paragraphIdx}</span>
            </div>
            <div class="coread-note-text"></div>
        </div>
    `);
    card.querySelector('.coread-note-text').textContent = n.text;
    if (isUser) wireNoteControls(card, n, chunk);
    return card;
}

function wireNoteControls(card, n, chunk) {
    const editBtn = card.querySelector('.coread-note-edit');
    const delBtn = card.querySelector('.coread-note-del');
    const labels = callbacks.getLabels?.() || {};

    editBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        beginInlineEdit(card, n, chunk);
    });

    delBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(labels.confirmDelete || 'Delete this note?')) return;
        await deleteNote(n.id);
        renderParagraphNotes(chunk);
        callbacks.onNotesChanged?.();
    });
}

function beginInlineEdit(card, n, chunk) {
    const textEl = card.querySelector('.coread-note-text');
    const original = n.text;
    const labels = callbacks.getLabels?.() || {};
    const editor = el(`
        <div class="coread-note-inline-edit">
            <textarea rows="2"></textarea>
            <div class="coread-note-editor-actions">
                <button data-act="save" class="coread-btn coread-btn-primary">${labels.save || 'Save'}</button>
                <button data-act="cancel" class="coread-btn">${labels.cancel || 'Cancel'}</button>
            </div>
        </div>
    `);
    editor.querySelector('textarea').value = original;
    textEl.replaceWith(editor);
    const ta = editor.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    editor.addEventListener('click', (e) => e.stopPropagation());
    editor.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) return;
        await updateNoteText(n.id, text);
        renderParagraphNotes(chunk);
        callbacks.onNotesChanged?.();
    });
    editor.querySelector('[data-act="cancel"]').addEventListener('click', () => {
        renderParagraphNotes(chunk);
    });
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); renderParagraphNotes(chunk); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            editor.querySelector('[data-act="save"]').click();
        }
    });
}

export function getCurrentChunkId() {
    return state.chunks[state.currentChunkIdx]?.id;
}

export function getCurrentChunk() {
    return state.chunks[state.currentChunkIdx] || null;
}

export function getOpenBookId() {
    return state.bookId || null;
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
    if (next > state.maxReadChunkIdx) state.maxReadChunkIdx = next;
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
