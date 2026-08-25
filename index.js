import { db, newId } from './storage/db.js';
import { parseFile } from './reader/parser.js';
import { buildChunkRecords } from './reader/chunker.js';
import { openBook, setReaderStatus, refreshCurrentChunkMeta, refreshContext, refreshParagraphNotes, getCurrentChunkId, jumpToParagraph, currentChunkIdxInBook } from './reader/viewer.js';
import { summarizeChunk } from './context/summarizer.js';
import { readChunkUnified } from './context/unified.js';
import { generateNotesForChunk, getNotesForBook, askCharacterAboutParagraph, saveUserNote } from './notes/generator.js';

const EXT_ID = 'st-coreading';

const DEFAULTS = {
    paceTokens: 1200,
    autoNote: true,
    noteDensity: 'medium', // 'sparse' | 'medium' | 'dense'
    drawerWidth: 420,
};

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
    drawer.style.width = settings.drawerWidth + 'px';
    drawer.innerHTML = `
        <div class="coread-resize"></div>
        <header>
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

    drawer.querySelector('.coread-close').addEventListener('click', () => drawer.classList.remove('open'));

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

    initResize(drawer);
    renderBookList();
    return drawer;
}

function initResize(drawer) {
    const handle = drawer.querySelector('.coread-resize');
    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = drawer.getBoundingClientRect().width;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const w = Math.max(320, Math.min(window.innerWidth * 0.7, startW + (startX - e.clientX)));
        drawer.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        settings.drawerWidth = parseInt(drawer.style.width, 10);
        saveSettings();
    });
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
        },
    });
    renderNotesPanel(bookId, getCharId());
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
    const byChapter = new Map();
    for (const n of notes) {
        if (!byChapter.has(n.chapterId)) byChapter.set(n.chapterId, []);
        byChapter.get(n.chapterId).push(n);
    }
    const sortedChapterIds = [...byChapter.keys()].sort(
        (a, b) => (chapterMap.get(a)?.idx ?? 0) - (chapterMap.get(b)?.idx ?? 0)
    );

    host.innerHTML = sortedChapterIds.map(cid => {
        const chapter = chapterMap.get(cid);
        const items = byChapter.get(cid).map(n => {
            const chunkIdxDisplay = chapter?.chunkIds?.indexOf(n.chunkId);
            const chunkLabel = chunkIdxDisplay >= 0 ? `#${chunkIdxDisplay + 1}·¶${n.paragraphIdx}` : `¶${n.paragraphIdx}`;
            return `
            <div class="coread-note-item" data-chunk-id="${n.chunkId}" data-p-idx="${n.paragraphIdx}" title="Click to jump to source">
                <div class="coread-note-head">
                    <span class="coread-note-author">${escapeHtml(n.charName || 'Character')}</span>
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

    // Wire click → jump to source paragraph in reader
    host.querySelectorAll('.coread-note-item').forEach(item => {
        item.addEventListener('click', async () => {
            const chunkId = item.dataset.chunkId;
            const pIdx = Number(item.dataset.pIdx);
            switchTab('reader');
            // wait for reader tab to be visible
            await new Promise(r => setTimeout(r, 30));
            await jumpToParagraph(chunkId, pIdx);
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
    const btn = document.createElement('div');
    btn.id = 'coread-toggle-btn';
    btn.title = t('coread.toggle');
    btn.innerHTML = `<i class="fa-solid fa-book-open-reader"></i>`;
    btn.addEventListener('click', () => drawer.classList.toggle('open'));

    const target = document.getElementById('extensionsMenu')
        || document.getElementById('top-bar')
        || document.body;
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
