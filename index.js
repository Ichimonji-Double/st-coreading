import { db, newId } from './storage/db.js';
import { parseFile } from './reader/parser.js';
import { buildChunkRecords } from './reader/chunker.js';
import { openBook, setReaderStatus, refreshCurrentChunkMeta, refreshContext, refreshParagraphNotes, getCurrentChunkId, getCurrentChunk, getOpenBookId, jumpToParagraph, currentChunkIdxInBook } from './reader/viewer.js';
import { summarizeChunk } from './context/summarizer.js';
import { readChunkUnified } from './context/unified.js';
import { generateNotesForChunk, getNotesForBook, askCharacterAboutParagraph, saveUserNote, deleteNote, updateNoteText } from './notes/generator.js';
import { exportNotesAs } from './notes/exporter.js';

const EXT_ID = 'st-coreading';

const DEFAULTS = {
    paceTokens: 1200,
    autoNote: true,
    noteDensity: 'medium', // 'sparse' | 'medium' | 'dense'
    injectContextToChat: false,
    drawerWidth: 420,
    drawerHeight: null,   // null = full viewport height
    drawerLeft: null,     // null = docked to right edge
    drawerTop: null,      // null = top
};

const CHAT_PROMPT_NAME = 'coread-context';

let settings = { ...DEFAULTS };
let i18nDict = {};

async function loadI18n() {
    const lang = document.documentElement.lang?.startsWith('zh') ? 'zh-cn' : 'en';
    try {
        const url = new URL(`i18n/${lang}.json`, import.meta.url);
        const res = await fetch(url);
        i18nDict = await res.json();
    } catch (e) {
        console.warn('[coread] i18n load failed', e);
        i18nDict = {};
    }
}

function t(key) {
    return i18nDict[key] || key;
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(`${EXT_ID}:settings`);
        if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
}

function saveSettings() {
    localStorage.setItem(`${EXT_ID}:settings`, JSON.stringify(settings));
}

function buildDrawer() {
    const drawer = document.createElement('div');
    drawer.id = 'coread-drawer';
    drawer.innerHTML = `
        <header class="coread-drag-handle">
            <span>${t('coread.title')}</span>
            <button class="coread-close" title="${t('coread.action.close')}">✕</button>
        </header>
        <nav class="coread-tabs">
            <button data-tab="library" class="active">${t('coread.library')}</button>
            <button data-tab="reader">${t('coread.reader')}</button>
            <button data-tab="notes">${t('coread.notes')}</button>
            <button data-tab="settings">${t('coread.settings')}</button>
        </nav>
        <div class="coread-panel active" data-panel="library">
            <button class="coread-btn" id="coread-import-btn">＋ ${t('coread.import')}</button>
            <p class="hint" style="font-size:11px;opacity:.55;margin-top:6px">${t('coread.import.hint')}</p>
            <div id="coread-book-list" style="margin-top:12px"></div>
        </div>
        <div class="coread-panel" data-panel="reader">
            <div class="coread-empty">${t('coread.empty.reader')}</div>
        </div>
        <div class="coread-panel" data-panel="notes">
            <div class="coread-empty">${t('coread.empty.notes')}</div>
        </div>
        <div class="coread-panel" data-panel="settings">
            <div class="coread-field">
                <label>${t('coread.settings.pace')}: <span id="coread-pace-val">${settings.paceTokens}</span> tok</label>
                <input type="range" id="coread-pace" min="400" max="2400" step="100" value="${settings.paceTokens}">
                <div style="display:flex;justify-content:space-between;font-size:11px;opacity:.55">
                    <span>${t('coread.settings.pace.short')}</span>
                    <span>${t('coread.settings.pace.long')}</span>
                </div>
                <div class="hint">${t('coread.settings.pace.hint')}</div>
            </div>
            <div class="coread-field">
                <label>
                    <input type="checkbox" id="coread-auto-note" ${settings.autoNote ? 'checked' : ''}>
                    ${t('coread.settings.autoNote')}
                </label>
            </div>
            <div class="coread-field">
                <label>
                    <input type="checkbox" id="coread-inject-context" ${settings.injectContextToChat ? 'checked' : ''}>
                    ${t('coread.settings.injectContext')}
                </label>
                <div class="hint">${t('coread.settings.injectContext.hint')}</div>
            </div>
            <div class="coread-field">
                <label>${t('coread.settings.density')}</label>
                <div class="coread-segmented" id="coread-density">
                    <button data-val="sparse" ${settings.noteDensity === 'sparse' ? 'class="active"' : ''}>${t('coread.settings.density.sparse')}</button>
                    <button data-val="medium" ${settings.noteDensity === 'medium' ? 'class="active"' : ''}>${t('coread.settings.density.medium')}</button>
                    <button data-val="dense" ${settings.noteDensity === 'dense' ? 'class="active"' : ''}>${t('coread.settings.density.dense')}</button>
                </div>
                <div class="hint">${t('coread.settings.density.hint')}</div>
            </div>
        </div>
    `;
    document.body.appendChild(drawer);

    drawer.querySelector('.coread-close').addEventListener('click', () => {
        drawer.classList.remove('open');
        updateChatInjection();
    });

    drawer.querySelectorAll('nav.coread-tabs button').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.tab;
            drawer.querySelectorAll('nav.coread-tabs button').forEach(b => b.classList.toggle('active', b === btn));
            drawer.querySelectorAll('.coread-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
        });
    });

    const paceInput = drawer.querySelector('#coread-pace');
    const paceVal = drawer.querySelector('#coread-pace-val');
    paceInput.addEventListener('input', () => {
        settings.paceTokens = Number(paceInput.value);
        paceVal.textContent = settings.paceTokens;
        saveSettings();
    });

    drawer.querySelector('#coread-auto-note').addEventListener('change', (e) => {
        settings.autoNote = e.target.checked;
        saveSettings();
    });

    drawer.querySelector('#coread-inject-context').addEventListener('change', (e) => {
        settings.injectContextToChat = e.target.checked;
        saveSettings();
        updateChatInjection();
    });

    drawer.querySelectorAll('#coread-density button').forEach(btn => {
        btn.addEventListener('click', () => {
            settings.noteDensity = btn.dataset.val;
            drawer.querySelectorAll('#coread-density button').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            saveSettings();
        });
    });

    drawer.querySelector('#coread-import-btn').addEventListener('click', () => handleImport());

    // Resize handles: W (left edge), E (right edge), S (bottom edge), SE (corner)
    const handles = ['w', 'e', 's', 'se', 'sw', 'n', 'ne', 'nw'];
    for (const dir of handles) {
        const h = document.createElement('div');
        h.className = `coread-resize-handle coread-resize-${dir}`;
        h.dataset.dir = dir;
        drawer.appendChild(h);
    }

    applyDrawerBounds(drawer);
    initDrag(drawer);
    initResize(drawer);
    initDockButton(drawer);
    window.addEventListener('resize', () => applyDrawerBounds(drawer));

    renderBookList();
    return drawer;
}

const MIN_W = 320;
const MIN_H = 260;

function applyDrawerBounds(drawer) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let w = settings.drawerWidth || 420;
    let h = settings.drawerHeight ?? vh;
    let left = settings.drawerLeft ?? (vw - w);
    let top = settings.drawerTop ?? 0;
    w = Math.max(MIN_W, Math.min(vw, w));
    h = Math.max(MIN_H, Math.min(vh, h));
    left = Math.max(0, Math.min(vw - w, left));
    top = Math.max(0, Math.min(vh - h, top));
    drawer.style.width = w + 'px';
    drawer.style.height = h + 'px';
    drawer.style.left = left + 'px';
    drawer.style.top = top + 'px';
}

function initDrag(drawer) {
    const header = drawer.querySelector('header.coread-drag-handle');
    let start = null;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.coread-close')) return;
        const r = drawer.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
        drawer.classList.add('coread-dragging');
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const newLeft = Math.max(0, Math.min(window.innerWidth - start.w, start.left + dx));
        const newTop = Math.max(0, Math.min(window.innerHeight - start.h, start.top + dy));
        drawer.style.left = newLeft + 'px';
        drawer.style.top = newTop + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!start) return;
        drawer.classList.remove('coread-dragging');
        settings.drawerLeft = parseInt(drawer.style.left, 10);
        settings.drawerTop = parseInt(drawer.style.top, 10);
        start = null;
        saveSettings();
    });
}

function initResize(drawer) {
    let start = null;
    drawer.querySelectorAll('.coread-resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            const r = drawer.getBoundingClientRect();
            start = {
                x: e.clientX, y: e.clientY,
                left: r.left, top: r.top, w: r.width, h: r.height,
                dir: handle.dataset.dir,
            };
            drawer.classList.add('coread-resizing');
            e.preventDefault();
        });
    });
    document.addEventListener('mousemove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        let { left, top, w, h, dir } = start;
        if (dir.includes('e')) w = Math.max(MIN_W, Math.min(window.innerWidth - left, start.w + dx));
        if (dir.includes('w')) {
            const newW = Math.max(MIN_W, start.w - dx);
            const newLeft = Math.min(start.left + (start.w - newW), start.left + start.w - MIN_W);
            w = newW; left = Math.max(0, newLeft);
        }
        if (dir.includes('s')) h = Math.max(MIN_H, Math.min(window.innerHeight - top, start.h + dy));
        if (dir.includes('n')) {
            const newH = Math.max(MIN_H, start.h - dy);
            const newTop = Math.min(start.top + (start.h - newH), start.top + start.h - MIN_H);
            h = newH; top = Math.max(0, newTop);
        }
        drawer.style.width = w + 'px';
        drawer.style.height = h + 'px';
        drawer.style.left = left + 'px';
        drawer.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!start) return;
        drawer.classList.remove('coread-resizing');
        settings.drawerWidth = parseInt(drawer.style.width, 10);
        settings.drawerHeight = parseInt(drawer.style.height, 10);
        settings.drawerLeft = parseInt(drawer.style.left, 10);
        settings.drawerTop = parseInt(drawer.style.top, 10);
        start = null;
        saveSettings();
    });
}

function initDockButton(drawer) {
    // Add a small "dock to right" button in the header (reset position/size)
    const header = drawer.querySelector('header.coread-drag-handle');
    const dockBtn = document.createElement('button');
    dockBtn.className = 'coread-dock-btn';
    dockBtn.title = 'Dock to right';
    dockBtn.textContent = '⇥';
    dockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        settings.drawerWidth = 420;
        settings.drawerHeight = null;
        settings.drawerLeft = null;
        settings.drawerTop = null;
        saveSettings();
        applyDrawerBounds(drawer);
    });
    // Insert before the close button
    header.insertBefore(dockBtn, header.querySelector('.coread-close'));
}

async function renderBookList() {
    const container = document.getElementById('coread-book-list');
    if (!container) return;
    const books = await db.all('books');
    if (!books.length) {
        container.innerHTML = `<div class="coread-empty">${t('coread.empty.library')}</div>`;
        return;
    }
    container.innerHTML = books
        .sort((a, b) => b.importedAt - a.importedAt)
        .map(b => `
            <div class="coread-book-row" data-id="${b.id}">
                <span class="coread-book-title">${escapeHtml(b.title)}</span>
                <span class="coread-book-meta">${b.format} · ${b.totalChunks || 0} chunks</span>
                <button class="coread-book-delete" data-id="${b.id}" title="${t('coread.action.delete')}">✕</button>
            </div>
        `).join('');

    container.querySelectorAll('.coread-book-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('coread-book-delete')) return;
            openBookInReader(row.dataset.id);
        });
    });
    container.querySelectorAll('.coread-book-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const book = await db.get('books', id);
            if (!book) return;
            if (!confirm(`Delete "${book.title}"?`)) return;
            await db.clearBook(id);
            renderBookList();
        });
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function switchTab(name) {
    document.querySelectorAll('#coread-drawer nav.coread-tabs button')
        .forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('#coread-drawer .coread-panel')
        .forEach(p => p.classList.toggle('active', p.dataset.panel === name));
}

// Update the reading-context injection into the ST chat pipeline.
// Guardrails: only inject when BOTH the "inject" setting is ON AND the
// drawer is currently open AND a book is open in the reader. Any of those
// false → clear the extension prompt so the next chat is context-free.
// Resolve ST's setExtensionPrompt across versions. Newer builds may expose it
// on the top-level SillyTavern object rather than through getContext().
function resolveSetExtensionPrompt() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (ctx && typeof ctx.setExtensionPrompt === 'function') {
        return { fn: (...a) => ctx.setExtensionPrompt(...a), src: 'ctx.setExtensionPrompt', promptStore: ctx.extensionPrompts };
    }
    if (typeof globalThis.SillyTavern?.setExtensionPrompt === 'function') {
        return { fn: (...a) => globalThis.SillyTavern.setExtensionPrompt(...a), src: 'SillyTavern.setExtensionPrompt', promptStore: globalThis.SillyTavern.extensionPrompts };
    }
    if (typeof globalThis.setExtensionPrompt === 'function') {
        return { fn: (...a) => globalThis.setExtensionPrompt(...a), src: 'globalThis.setExtensionPrompt', promptStore: globalThis.extension_prompts };
    }
    return null;
}

async function updateChatInjection() {
    const api = resolveSetExtensionPrompt();
    if (!api) {
        console.warn('[coread] inject NOAPI — setExtensionPrompt not found on ST context or global; injection disabled');
        return;
    }

    const drawer = document.getElementById('coread-drawer');
    const drawerOpen = drawer?.classList.contains('open');
    const chunk = getCurrentChunk();
    const bookId = getOpenBookId();

    if (!settings.injectContextToChat || !drawerOpen || !chunk || !bookId) {
        api.fn(CHAT_PROMPT_NAME, '');
        console.log('[coread] inject CLEAR', {
            via: api.src,
            reason: !settings.injectContextToChat ? 'setting off'
                : !drawerOpen ? 'drawer closed'
                : !bookId ? 'no book open'
                : !chunk ? 'no current chunk'
                : 'unknown',
        });
        return;
    }

    const book = await db.get('books', bookId);
    if (!book) {
        console.warn('[coread] inject: no book record for bookId', bookId);
        api.fn(CHAT_PROMPT_NAME, '');
        return;
    }
    const session = await db.get('sessions', `${bookId}__${getCharId()}`);
    const rolling = session?.rollingSummary || '';
    const chunkText = (chunk.paragraphs || []).join('\n\n');
    const sample = chunkText.slice(0, 200);
    const isChinese = /[㐀-鿿]/.test(sample) || /[㐀-鿿]/.test(book.title || '');

    const prompt = isChinese ? [
        `[共读时光 · 背景上下文 — 我们正在共读《${book.title}》]`,
        rolling ? `\n【故事至此】\n${rolling}` : '',
        `\n【用户当前读到的段落】\n${chunkText}`,
        `\n注：以上内容是用户此刻正在阅读的书本上下文，不是用户直接说的话。用户之后跟你说的话可能会引用或讨论"这段"、"刚才那段"、"这本书"，请以此为参考。`,
    ].filter(Boolean).join('\n') : [
        `[Co-Reading Time · background context — we're reading "${book.title}" together]`,
        rolling ? `\n[Story so far]\n${rolling}` : '',
        `\n[Passage the user is currently on]\n${chunkText}`,
        `\nNote: the above is what the user is reading right now, not something the user just said. When the user references "this passage", "just now", or "this book", use the above as context.`,
    ].filter(Boolean).join('\n');

    // Position 0 = IN_PROMPT (after character defs); role 0 = system; depth 0.
    // Explicit full args in case a preset relies on non-default defaults.
    api.fn(CHAT_PROMPT_NAME, prompt, 0, 0, false, 0);

    console.log('[coread] inject SET', {
        via: api.src,
        book: book.title,
        chunkIdx: chunk.idx,
        paras: chunk.paragraphs?.length ?? 0,
        chunkTextLen: chunkText.length,
        rollingLen: rolling.length,
        promptLen: prompt.length,
        firstLine: prompt.split('\n')[0],
    });
    const store = api.promptStore;
    const readback = store?.[CHAT_PROMPT_NAME];
    console.log('[coread] inject READBACK', {
        storeExists: !!store,
        entryExists: !!readback,
        len: typeof readback === 'string' ? readback.length : (readback?.value?.length ?? 'n/a'),
    });
}

async function openBookInReader(bookId) {
    switchTab('reader');
    const book = await db.get('books', bookId);
    await openBook(bookId, {
        getCharId,
        getLabels: () => ({
            placeholder: t('coread.editor.placeholder'),
            save: t('coread.action.save'),
            ask: t('coread.action.askChar'),
            cancel: t('coread.action.cancel'),
            asking: t('coread.editor.asking'),
            confirmDelete: t('coread.confirm.deleteNote'),
        }),
        onSaveUserNote: async ({ chunk, pIdx, text }) => {
            await saveUserNote({ book, chunk, pIdx, text, charId: getCharId() });
        },
        onAskCharacter: async ({ chunk, pIdx }) => {
            const chapter = await db.get('chapters', chunk.chapterId);
            const charId = getCharId();
            const charName = getCharName();
            const session = await db.get('sessions', `${book.id}__${charId}`);
            await askCharacterAboutParagraph({
                book, chapter, chunk, pIdx, charId, charName,
                rollingSummary: session?.rollingSummary || '',
            });
        },
        onNotesChanged: () => renderNotesPanel(bookId, getCharId()),
        onChunkChange: ({ from, to, direction }) => {
            if (direction === 'forward' && from && !from.summary) {
                runChunkSummary(book, from).catch(e => console.error('[coread] summary failed', e));
            }
            updateChatInjection();
        },
    });
    renderNotesPanel(bookId, getCharId());
    updateChatInjection();
}

function getCharId() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx) return 'default';
    // characterId may live on ctx directly or under ctx.characterId
    return String(ctx.characterId ?? ctx.characters?.[ctx.characterId]?.avatar ?? 'default');
}

async function runChunkSummary(book, chunk) {
    if (chunk.summary) return;
    const chapter = await db.get('chapters', chunk.chapterId);
    const charId = getCharId();
    const charName = getCharName();
    setReaderStatus(t('coread.status.reading'));

    try {
        if (!settings.autoNote) {
            // Notes disabled — just a plain summary via raw (no character involvement)
            await summarizeChunk({ bookId: book.id, charId, chunk, chapter, book });
        } else {
            // Primary: one merged call — character produces summary + notes together
            const result = await readChunkUnified({ book, chapter, chunk, charId, charName, density: settings.noteDensity });

            if (!result.ok) {
                // Safety net: fall back to two-call flow
                console.warn('[coread] unified failed, falling back to split calls:', result.reason);
                const { rollingSummary } = await summarizeChunk({
                    bookId: book.id, charId, chunk, chapter, book,
                });
                setReaderStatus(t('coread.status.thinking'));
                try {
                    await generateNotesForChunk({
                        book, chapter, chunk, charId, charName, rollingSummary, density: settings.noteDensity,
                    });
                } catch (e) {
                    console.error('[coread] fallback note generation failed', e);
                }
            } else {
                console.log(`[coread] unified read ok — ${result.notes} note(s)`);
            }
        }
    } catch (e) {
        console.error('[coread] chunk read failed', e);
    } finally {
        refreshCurrentChunkMeta();
        refreshContext();
        refreshParagraphNotes();
        renderNotesPanel(book.id, charId);
        updateChatInjection();
    }
}

function getCharName() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx) return 'Character';
    const idx = ctx.characterId;
    return ctx.characters?.[idx]?.name || ctx.name2 || 'Character';
}

async function renderNotesPanel(bookId, charId) {
    const host = document.querySelector('#coread-drawer [data-panel="notes"]');
    if (!host) return;
    const notes = await getNotesForBook(bookId, charId);
    if (!notes.length) {
        host.innerHTML = `<div class="coread-empty">${t('coread.empty.notes')}</div>`;
        return;
    }
    // Group by chapter
    const chapters = await db.byIndex('chapters', 'bookId', bookId);
    const chapterMap = new Map(chapters.map(c => [c.id, c]));
    const book = await db.get('books', bookId);
    const charName = getCharName();
    const byChapter = new Map();
    for (const n of notes) {
        if (!byChapter.has(n.chapterId)) byChapter.set(n.chapterId, []);
        byChapter.get(n.chapterId).push(n);
    }
    const sortedChapterIds = [...byChapter.keys()].sort(
        (a, b) => (chapterMap.get(a)?.idx ?? 0) - (chapterMap.get(b)?.idx ?? 0)
    );

    const exportBar = `
        <div class="coread-export-bar">
            <span class="coread-export-label">${t('coread.export.title')}</span>
            <button class="coread-btn coread-export-md">${t('coread.export.md')}</button>
            <button class="coread-btn coread-export-json">${t('coread.export.json')}</button>
        </div>
    `;

    host.innerHTML = exportBar + sortedChapterIds.map(cid => {
        const chapter = chapterMap.get(cid);
        const items = byChapter.get(cid).map(n => {
            const chunkIdxDisplay = chapter?.chunkIds?.indexOf(n.chunkId);
            const chunkLabel = chunkIdxDisplay >= 0 ? `#${chunkIdxDisplay + 1}·¶${n.paragraphIdx}` : `¶${n.paragraphIdx}`;
            const isUser = n.author === 'user';
            const controls = isUser ? `
                <button class="coread-note-btn coread-note-edit" data-id="${n.id}" title="${t('coread.action.edit')}">✎</button>
                <button class="coread-note-btn coread-note-del" data-id="${n.id}" title="${t('coread.action.delete')}">✕</button>
            ` : '';
            return `
            <div class="coread-note-item ${isUser ? 'note-user-item' : ''}" data-note-id="${n.id}" data-chunk-id="${n.chunkId}" data-p-idx="${n.paragraphIdx}" title="Click to jump to source">
                <div class="coread-note-head">
                    <span class="coread-note-author">${escapeHtml(n.charName || 'Character')}</span>
                    <div class="coread-note-controls">${controls}</div>
                    <span class="coread-note-anchor">${chunkLabel}</span>
                </div>
                <div class="coread-note-text">${escapeHtml(n.text)}</div>
            </div>
        `;
        }).join('');
        return `
            <div class="coread-notes-group">
                <div class="coread-notes-chapter">${escapeHtml(chapter?.title || 'Unknown chapter')}</div>
                ${items}
            </div>
        `;
    }).join('');

    // Wire export buttons
    host.querySelector('.coread-export-md')?.addEventListener('click', () => {
        exportNotesAs('md', { book, charName, charId, notes, chapters });
    });
    host.querySelector('.coread-export-json')?.addEventListener('click', () => {
        exportNotesAs('json', { book, charName, charId, notes, chapters });
    });

    // Wire click → jump to source (skip when clicking on the inline controls)
    host.querySelectorAll('.coread-note-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            if (e.target.closest('.coread-note-btn') || e.target.closest('.coread-note-inline-edit')) return;
            const chunkId = item.dataset.chunkId;
            const pIdx = Number(item.dataset.pIdx);
            switchTab('reader');
            await new Promise(r => setTimeout(r, 30));
            await jumpToParagraph(chunkId, pIdx);
        });
    });

    // Wire delete
    host.querySelectorAll('.coread-note-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(t('coread.confirm.deleteNote'))) return;
            await deleteNote(btn.dataset.id);
            renderNotesPanel(bookId, charId);
            refreshParagraphNotes();
        });
    });

    // Wire inline edit
    host.querySelectorAll('.coread-note-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = btn.closest('.coread-note-item');
            const textEl = item.querySelector('.coread-note-text');
            if (item.querySelector('.coread-note-inline-edit')) return;
            const original = textEl.textContent;
            const editor = document.createElement('div');
            editor.className = 'coread-note-inline-edit';
            editor.innerHTML = `
                <textarea rows="2"></textarea>
                <div class="coread-note-editor-actions">
                    <button data-act="save" class="coread-btn coread-btn-primary">${t('coread.action.save')}</button>
                    <button data-act="cancel" class="coread-btn">${t('coread.action.cancel')}</button>
                </div>
            `;
            editor.querySelector('textarea').value = original;
            textEl.replaceWith(editor);
            const ta = editor.querySelector('textarea');
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            editor.addEventListener('click', (ev) => ev.stopPropagation());
            editor.querySelector('[data-act="save"]').addEventListener('click', async () => {
                const text = ta.value.trim();
                if (!text) return;
                await updateNoteText(btn.dataset.id, text);
                renderNotesPanel(bookId, charId);
                refreshParagraphNotes();
            });
            editor.querySelector('[data-act="cancel"]').addEventListener('click', () => {
                renderNotesPanel(bookId, charId);
            });
            ta.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') { ev.preventDefault(); renderNotesPanel(bookId, charId); }
                if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    editor.querySelector('[data-act="save"]').click();
                }
            });
        });
    });
}

async function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.epub';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const status = showStatus(t('coread.status.parsing'));
        try {
            const parsed = await parseFile(file);
            const bookId = newId('bk_');
            const { chapters, chunks } = buildChunkRecords(parsed, bookId, settings.paceTokens, newId);
            await db.put('books', {
                id: bookId,
                title: parsed.title,
                author: parsed.author,
                format: parsed.format,
                importedAt: Date.now(),
                totalChunks: chunks.length,
                totalChapters: chapters.length,
            });
            for (const ch of chapters) await db.put('chapters', ch);
            for (const ck of chunks) await db.put('chunks', ck);
            status.remove();
            await renderBookList();
        } catch (err) {
            console.error('[coread] import failed', err);
            status.remove();
            alert('Import failed: ' + err.message);
        }
    });
    input.click();
}

function showStatus(text) {
    const box = document.createElement('div');
    box.className = 'coread-status';
    box.textContent = text;
    document.getElementById('coread-drawer')?.appendChild(box);
    return box;
}

function buildToggleButton(drawer) {
    const target = document.getElementById('extensionsMenu')
        || document.getElementById('top-bar')
        || document.body;

    const inMenu = target.id === 'extensionsMenu';
    const btn = document.createElement('div');
    btn.id = 'coread-toggle-btn';
    btn.title = t('coread.toggle');
    if (inMenu) {
        // Match SillyTavern's extension menu item styling (icon + label)
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.tabIndex = 0;
        btn.innerHTML = `
            <div class="fa-fw fa-solid fa-book-open-reader extensionsMenuExtensionButton"></div>
            <span>${t('coread.title')}</span>
        `;
    } else {
        btn.innerHTML = `<i class="fa-solid fa-book-open-reader"></i>`;
    }
    btn.addEventListener('click', () => {
        drawer.classList.toggle('open');
        updateChatInjection();
    });
    target.appendChild(btn);
}

async function init() {
    loadSettings();
    await loadI18n();
    await db.all('books').catch(e => console.error('[coread] db init failed', e));
    const drawer = buildDrawer();
    buildToggleButton(drawer);
    console.log('[coread] extension loaded');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
