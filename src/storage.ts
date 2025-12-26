// IndexedDB storage for documents

const DB_NAME = "estme-documents";
const DB_VERSION = 4;
const STORE_NAME = "documents";
const AUTOSAVE_STORE = "autosave";
const IMAGES_STORE = "images";

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
      const oldVersion = event.oldVersion;

      // Version 3: Migrate from id-based keyPath to name-based keyPath
      if (oldVersion < 3 && db.objectStoreNames.contains(STORE_NAME)) {
        // Need to migrate: read all data, delete store, recreate with new keyPath
        const tx = (event.target as IDBOpenDBRequest).transaction!;
        const oldStore = tx.objectStore(STORE_NAME);
        const getAllRequest = oldStore.getAll();
        getAllRequest.onsuccess = () => {
          const oldDocs = getAllRequest.result;
          db.deleteObjectStore(STORE_NAME);
          const newStore = db.createObjectStore(STORE_NAME, { keyPath: "name" });
          newStore.createIndex("id", "id", { unique: false });
          newStore.createIndex("updatedAt", "updatedAt", { unique: false });
          // Re-add all documents to the new store
          for (const doc of oldDocs) {
            newStore.add(doc);
          }
        };
      } else if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Fresh install
        const store = db.createObjectStore(STORE_NAME, { keyPath: "name" });
        store.createIndex("id", "id", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      // Add autosave store (version 2)
      if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
        db.createObjectStore(AUTOSAVE_STORE, { keyPath: "id" });
      }

      // Add images store (version 4)
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: "id" });
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

// Load document by name (primary key)
export async function loadDocument(name: string): Promise<StoredDocument | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

// Delete document by name (primary key)
export async function deleteDocument(name: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(name);
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

// Find a document by name - since name is now the primary key, this is just loadDocument
export async function findDocumentByName(name: string): Promise<StoredDocument | null> {
  return loadDocument(name);
}

// Load document by ID (uses the id index)
export async function loadDocumentById(id: string): Promise<StoredDocument | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("id");
    const request = index.get(id);
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

// Image storage types
export type StoredImage = {
  id: string;
  data: ArrayBuffer;
  mimeType: string;
};

// Save an image blob to IndexedDB
export async function saveImage(id: string, blob: Blob): Promise<void> {
  const db = await getDB();
  const data = await blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, "readwrite");
    const store = tx.objectStore(IMAGES_STORE);
    const entry: StoredImage = { id, data, mimeType: blob.type };
    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Load an image from IndexedDB
export async function loadImage(id: string): Promise<Blob | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, "readonly");
    const store = tx.objectStore(IMAGES_STORE);
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const result = request.result as StoredImage | undefined;
      if (result) {
        resolve(new Blob([result.data], { type: result.mimeType }));
      } else {
        resolve(null);
      }
    };
  });
}

// Delete an image from IndexedDB
export async function deleteImage(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, "readwrite");
    const store = tx.objectStore(IMAGES_STORE);
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
