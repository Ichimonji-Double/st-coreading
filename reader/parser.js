// Book parsers: TXT (native) + EPUB (via epub.js loaded on demand).
// Output shape:
//   { title, author, format, chapters: [{ title, text }] }

const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const EPUBJS_CDN = 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js';

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

let epubJsPromise = null;
function loadEpubJs() {
    if (globalThis.ePub && globalThis.JSZip) return Promise.resolve(globalThis.ePub);
    if (epubJsPromise) return epubJsPromise;
    epubJsPromise = (async () => {
        if (!globalThis.JSZip) await loadScript(JSZIP_CDN);
        if (!globalThis.ePub) await loadScript(EPUBJS_CDN);
        if (!globalThis.ePub) throw new Error('epub.js loaded but ePub is undefined');
        return globalThis.ePub;
    })();
    return epubJsPromise;
}

// Chinese chapter heading: 第一章 / 第1章 / 第 十 回 / 第123节
// English: Chapter 1, CHAPTER I, Prologue, Epilogue
const CN_CHAPTER = /^\s*第\s*[一二三四五六七八九十百千万零〇0-9]+\s*[章回节卷篇部]\b.*$/;
const EN_CHAPTER = /^\s*(chapter|prologue|epilogue|part|book)\s+[ivxlcdm0-9]+\b.*$/i;

function isChapterHeading(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 80) return false;
    return CN_CHAPTER.test(trimmed) || EN_CHAPTER.test(trimmed);
}

export function parseTxt(text, filename) {
    // Normalize newlines
    const src = text.replace(/\r\n?/g, '\n').replace(/　/g, '  ');
    const lines = src.split('\n');

    const chapters = [];
    let current = { title: filename.replace(/\.txt$/i, ''), buf: [] };

    for (const line of lines) {
        if (isChapterHeading(line)) {
            if (current.buf.length) {
                chapters.push({ title: current.title, text: current.buf.join('\n').trim() });
            }
            current = { title: line.trim(), buf: [] };
        } else {
            current.buf.push(line);
        }
    }
    if (current.buf.length) {
        chapters.push({ title: current.title, text: current.buf.join('\n').trim() });
    }

    // If no chapter headings detected, keep the whole book as one chapter
    if (chapters.length === 0) {
        chapters.push({ title: filename.replace(/\.txt$/i, ''), text: src.trim() });
    }

    return {
        title: filename.replace(/\.txt$/i, ''),
        author: '',
        format: 'txt',
        chapters,
    };
}

function looksLikeMetadataPage(text) {
    const sample = text.slice(0, 600);
    const hits = [
        /版权(所有|页)|保留(所有|一切)?权利|©|copyright/i,
        /出版(社|发行)|ISBN[:：]?\s*[\d-]+/,
        /All rights reserved/i,
        /印次|印张|印数|字数|开本/,
    ].reduce((n, re) => n + (re.test(sample) ? 1 : 0), 0);
    // Multiple metadata markers in a short section → probably copyright/imprint page
    return hits >= 2 && text.length < 800;
}

async function extractEpubSectionText(book, item) {
    const doc = await book.load(item.href);
    // doc is an XHTML Document
    const body = doc?.body || doc?.documentElement;
    if (!body) return '';
    // Replace <br> with newlines, block elements with double newlines
    const clone = body.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote').forEach(el => {
        el.appendChild(document.createTextNode('\n\n'));
    });
    return clone.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

export async function parseEpub(arrayBuffer, filename) {
    const ePub = await loadEpubJs();
    const book = ePub(arrayBuffer);
    await book.ready;

    const meta = book.package?.metadata || {};
    const title = meta.title || filename.replace(/\.epub$/i, '');
    const author = meta.creator || '';

    // Build a toc-title map so spine items get nice titles
    const toc = await book.loaded.navigation.then(n => n.toc).catch(() => []);
    const hrefTitle = new Map();
    const walk = (nodes) => {
        for (const n of nodes) {
            if (n.href) hrefTitle.set(n.href.split('#')[0], n.label?.trim() || '');
            if (n.subitems?.length) walk(n.subitems);
        }
    };
    walk(toc);

    const spineItems = book.spine?.spineItems || [];
    const chapters = [];
    const MIN_CHAPTER_CHARS = 200; // filter out cover, copyright, nav, colophon
    for (let i = 0; i < spineItems.length; i++) {
        const item = spineItems[i];
        // Skip obvious non-content items by filename hint
        const href = (item.href || '').toLowerCase();
        if (/(^|\/)(nav|toc|cover|copyright|colophon|title[-_]?page|imprint)\b/.test(href)) continue;
        let text = '';
        try {
            text = await extractEpubSectionText(book, item);
        } catch (e) {
            console.warn('[coread] failed to load epub section', item.href, e);
        }
        if (!text || text.length < MIN_CHAPTER_CHARS) continue;
        // Skip if content is mostly metadata patterns (copyright statements)
        if (looksLikeMetadataPage(text)) continue;
        const titleFromToc = hrefTitle.get(item.href) || hrefTitle.get(item.canonical);
        chapters.push({
            title: titleFromToc || `Chapter ${chapters.length + 1}`,
            text,
        });
    }

    book.destroy?.();

    return { title, author, format: 'epub', chapters };
}

export async function parseFile(file) {
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'txt') {
        const text = await file.text();
        return parseTxt(text, name);
    }
    if (ext === 'epub') {
        const buf = await file.arrayBuffer();
        return parseEpub(buf, name);
    }
    throw new Error(`Unsupported file type: .${ext}`);
}
