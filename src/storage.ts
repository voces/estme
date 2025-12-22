// IndexedDB storage for documents

const DB_NAME = "estme-documents";
const DB_VERSION = 2;
const STORE_NAME = "documents";
const AUTOSAVE_STORE = "autosave";

export type StoredDocument = {
  id: string;
  name: string;
  data: unknown;
  updatedAt: number;
  createdAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("name", "name", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      // Add autosave store (version 2)
      if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
        db.createObjectStore(AUTOSAVE_STORE, { keyPath: "id" });
      }
    };
  });

  return dbPromise;
}

export async function saveDocument(doc: StoredDocument): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(doc);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function loadDocument(id: string): Promise<StoredDocument | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function listDocuments(): Promise<StoredDocument[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("updatedAt");
    const request = index.openCursor(null, "prev"); // Most recent first
    const results: StoredDocument[] = [];

    request.onerror = () => reject(request.error);
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
  });
}

// Generate a unique ID
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Find a document by name (returns first match, or null if not found)
export async function findDocumentByName(name: string): Promise<StoredDocument | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("name");
    const request = index.get(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

// Autosave entry type
export type AutosaveEntry = {
  id: string; // Always "current" for now
  documentId: string | null;
  documentName: string;
  data: unknown;
  timestamp: number;
};

export async function saveAutosave(entry: AutosaveEntry): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, "readwrite");
    const store = tx.objectStore(AUTOSAVE_STORE);
    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function loadAutosave(): Promise<AutosaveEntry | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, "readonly");
    const store = tx.objectStore(AUTOSAVE_STORE);
    const request = store.get("current");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

export async function clearAutosave(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, "readwrite");
    const store = tx.objectStore(AUTOSAVE_STORE);
    const request = store.delete("current");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Current document ID persistence
const CURRENT_DOC_KEY = "estme-current-document-id";

export function getCurrentDocumentId(): string | null {
  try {
    return localStorage.getItem(CURRENT_DOC_KEY);
  } catch {
    return null;
  }
}

export function setCurrentDocumentId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(CURRENT_DOC_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_DOC_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}
