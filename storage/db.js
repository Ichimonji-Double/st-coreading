const DB_NAME = 'st-coreading';
const DB_VERSION = 1;

const STORES = {
    books: { keyPath: 'id', indexes: [['importedAt', 'importedAt']] },
    chapters: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
    chunks: { keyPath: 'id', indexes: [['bookId', 'bookId'], ['chapterId', 'chapterId']] },
    sessions: { keyPath: 'id', indexes: [['bookId', 'bookId'], ['charId', 'charId']] },
    notes: { keyPath: 'id', indexes: [['bookId', 'bookId'], ['charId', 'charId'], ['chunkId', 'chunkId']] },
};

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            for (const [name, spec] of Object.entries(STORES)) {
                if (db.objectStoreNames.contains(name)) continue;
                const store = db.createObjectStore(name, { keyPath: spec.keyPath });
                for (const [idxName, idxKey] of spec.indexes || []) {
                    store.createIndex(idxName, idxKey, { unique: false });
                }
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function tx(storeName, mode = 'readonly') {
    return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function req(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export const db = {
    async put(store, value) {
        return req((await tx(store, 'readwrite')).put(value));
    },
    async get(store, key) {
        return req((await tx(store)).get(key));
    },
    async delete(store, key) {
        return req((await tx(store, 'readwrite')).delete(key));
    },
    async all(store) {
        return req((await tx(store)).getAll());
    },
    async byIndex(store, indexName, value) {
        const s = await tx(store);
        return req(s.index(indexName).getAll(value));
    },
    async clearBook(bookId) {
        for (const name of ['chunks', 'chapters', 'notes', 'sessions']) {
            const items = await this.byIndex(name, 'bookId', bookId);
            for (const item of items) await this.delete(name, item.id);
        }
        await this.delete('books', bookId);
    },
};

export function newId(prefix = '') {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
