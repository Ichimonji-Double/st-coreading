// Export notes for a (book, character) pair to Markdown or JSON, then
// trigger a browser download.

function sanitizeFilename(name) {
    return String(name || 'notes')
        .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'notes';
}

function todayStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function chunkLabelFor(note, chapter) {
    const ci = chapter?.chunkIds?.indexOf(note.chunkId);
    if (ci >= 0) return `#${ci + 1}·¶${note.paragraphIdx}`;
    return `¶${note.paragraphIdx}`;
}

// Build a Markdown document for the given notes, grouped by chapter.
export function buildMarkdown({ book, charName, notes, chapters }) {
    const chapterMap = new Map(chapters.map(c => [c.id, c]));
    const grouped = new Map();
    for (const n of notes) {
        if (!grouped.has(n.chapterId)) grouped.set(n.chapterId, []);
        grouped.get(n.chapterId).push(n);
    }
    const orderedChapterIds = [...grouped.keys()].sort(
        (a, b) => (chapterMap.get(a)?.idx ?? 0) - (chapterMap.get(b)?.idx ?? 0)
    );

    const lines = [];
    lines.push(`# 《${book.title}》读书笔记`);
    lines.push('');
    if (book.author) lines.push(`- 作者：${book.author}`);
    lines.push(`- 共读角色：${charName || 'Character'}`);
    lines.push(`- 笔记条数：${notes.length}`);
    lines.push(`- 导出时间：${new Date().toISOString()}`);
    lines.push('');

    for (const cid of orderedChapterIds) {
        const chapter = chapterMap.get(cid);
        lines.push(`## ${chapter?.title || '未命名章节'}`);
        lines.push('');
        const chapterNotes = grouped.get(cid);
        // Preserve source order: sort by chunk global idx, then paragraph, then ts
        chapterNotes.sort((a, b) => {
            const ac = chapter?.chunkIds?.indexOf(a.chunkId) ?? 0;
            const bc = chapter?.chunkIds?.indexOf(b.chunkId) ?? 0;
            if (ac !== bc) return ac - bc;
            if (a.paragraphIdx !== b.paragraphIdx) return a.paragraphIdx - b.paragraphIdx;
            return (a.ts || 0) - (b.ts || 0);
        });
        for (const n of chapterNotes) {
            const author = n.author === 'user' ? '你' : (n.charName || 'Character');
            const anchor = chunkLabelFor(n, chapter);
            const editedMark = n.editedTs ? ' *(edited)*' : '';
            lines.push(`**${author}** · \`${anchor}\`${editedMark}`);
            lines.push('');
            // Escape triple backticks accidentally in note text
            const text = String(n.text || '').replace(/```/g, '``​`');
            lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
            lines.push('');
        }
    }
    return lines.join('\n');
}

export function buildJson({ book, charName, charId, notes, chapters }) {
    const chapterMap = new Map(chapters.map(c => [c.id, c]));
    return JSON.stringify({
        book: {
            id: book.id,
            title: book.title,
            author: book.author || '',
            format: book.format,
        },
        character: { id: charId, name: charName || 'Character' },
        exportedAt: new Date().toISOString(),
        noteCount: notes.length,
        notes: notes.map(n => {
            const chapter = chapterMap.get(n.chapterId);
            return {
                id: n.id,
                chapter: chapter?.title || '',
                chapterIdx: chapter?.idx ?? null,
                chunkIdxInChapter: chapter?.chunkIds?.indexOf(n.chunkId) ?? null,
                paragraphIdx: n.paragraphIdx,
                author: n.author,
                authorName: n.author === 'user' ? 'You' : (n.charName || 'Character'),
                text: n.text,
                ts: n.ts,
                editedTs: n.editedTs || null,
            };
        }),
    }, null, 2);
}

export function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportNotesAs(format, { book, charName, charId, notes, chapters }) {
    const base = `${sanitizeFilename(book.title)}-${sanitizeFilename(charName || 'char')}-${todayStamp()}`;
    if (format === 'json') {
        downloadTextFile(`${base}.json`, buildJson({ book, charName, charId, notes, chapters }), 'application/json');
    } else {
        downloadTextFile(`${base}.md`, buildMarkdown({ book, charName, notes, chapters }), 'text/markdown');
    }
}
