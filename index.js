import { db } from './storage/db.js';

const EXT_ID = 'st-coreading';

const DEFAULTS = {
    paceTokens: 1200,
    autoNote: true,
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

    drawer.querySelector('#coread-import-btn').addEventListener('click', () => {
        console.log('[coread] import clicked — parser hook TODO');
    });

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
            <div class="coread-book-row" data-id="${b.id}" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#333)">
                <span>${b.title}</span>
                <span style="opacity:.5;font-size:11px">${b.format}</span>
            </div>
        `).join('');
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
