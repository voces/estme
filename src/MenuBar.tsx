import { useEffect, useRef, useState } from "react";
import { store, useStore } from "./store/index.ts";
import { saveDocument, loadDocument, listDocuments, deleteDocument, generateId, findDocumentByName, getCurrentDocumentId, setCurrentDocumentId, StoredDocument, saveAutosave, loadAutosave, clearAutosave } from "./storage.ts";
import { importSvg } from "./svgImport.ts";
import { exportToThreeJS } from "./export.ts";
import styles from "./MenuBar.module.css";

export const MenuBar = () => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [savedDocuments, setSavedDocuments] = useState<StoredDocument[]>([]);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const documentName = useStore((s) => s.documentName);
  const documentId = useStore((s) => s.documentId);
  const isDirty = useStore((s) => s.isDirty);
  const isLoadingDocument = useStore((s) => s.isLoadingDocument);

  // Load the current document on initial mount
  useEffect(() => {
    const loadInitialDocument = async () => {
      try {
        // First check for autosave (unsaved changes from previous session)
        const autosave = await loadAutosave();
        if (autosave) {
          // Load autosave - use the saved documentId to maintain identity
          const data = autosave.data as Parameters<typeof store.loadDocument>[0];
          // Pass the exact documentId from autosave (could be null for never-saved docs)
          store.loadDocument(data, autosave.documentId);
          // Name is already in the data, but ensure it matches what was autosaved
          if (autosave.documentName && autosave.documentName !== data.name) {
            store.setDocumentName(autosave.documentName);
          }
          store.markDirty();
          return;
        }

        // No autosave, try to load the last opened document
        const currentId = getCurrentDocumentId();
        if (currentId) {
          const doc = await loadDocument(currentId);
          if (doc) {
            store.loadDocument(doc.data as Parameters<typeof store.loadDocument>[0], doc.id);
            return;
          }
        }
        // No current document or it doesn't exist - create a new one with ID
        store.newDocument();
      } catch (err) {
        console.error("Failed to load initial document:", err);
        // Create a new document on error
        store.newDocument();
      }
    };
    loadInitialDocument();
  }, []); // Only run once on mount

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };

    if (openMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [openMenu]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if we're in an input/textarea or dialog is open
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (showOpenDialog) return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (e.key === "s") {
          e.preventDefault();
          handleSaveToStorage();
        } else if (e.key === "o") {
          e.preventDefault();
          handleOpenFromStorage();
        } else if (e.key === "n") {
          e.preventDefault();
          handleNew();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showOpenDialog]);

  // Update browser tab title
  useEffect(() => {
    const prefix = isDirty ? "* " : "";
    document.title = `${prefix}${documentName} - estme`;
  }, [documentName, isDirty]);

  // Autosave when dirty (debounced, triggered on any store change)
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleStoreChange = () => {
      const state = store.getState();
      // Don't autosave while initial document is loading
      if (state.isLoadingDocument) {
        if (timeoutId) clearTimeout(timeoutId);
        return;
      }
      if (!state.isDirty) {
        // Don't autosave if not dirty, but don't clear either
        // Autosave is only cleared on explicit save
        if (timeoutId) clearTimeout(timeoutId);
        return;
      }

      // Clear any pending autosave
      if (timeoutId) clearTimeout(timeoutId);

      // Debounce autosave to avoid excessive writes
      timeoutId = setTimeout(() => {
        const data = store.getDocumentData();
        const currentState = store.getState();
        saveAutosave({
          id: "current",
          documentId: currentState.documentId,
          documentName: currentState.documentName,
          data,
          timestamp: Date.now(),
        }).catch(console.error);
      }, 1000); // Wait 1 second before autosaving
    };

    const unsubscribe = store.subscribe(handleStoreChange);
    return () => {
      unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  const handleNew = async () => {
    if (!isDirty || confirm("Create new document? Unsaved changes will be lost.")) {
      await clearAutosave();
      store.newDocument();
    }
    setOpenMenu(null);
  };

  // Discard unsaved changes - reload last saved version or create new if never saved
  const handleDiscardChanges = async () => {
    if (!isDirty) {
      setOpenMenu(null);
      return;
    }
    if (!confirm("Discard all unsaved changes?")) {
      setOpenMenu(null);
      return;
    }

    await clearAutosave();

    // If document was previously saved, reload it
    if (documentId) {
      const doc = await loadDocument(documentId);
      if (doc) {
        store.loadDocument(doc.data as Parameters<typeof store.loadDocument>[0], doc.id);
        setOpenMenu(null);
        return;
      }
    }

    // Document was never saved - create a new blank document
    store.newDocument();
    setOpenMenu(null);
  };

  // Load from file
  const handleLoadFromFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".estme,.json,.svg";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();

        // Check if it's an SVG file
        if (file.name.toLowerCase().endsWith(".svg") || text.trimStart().startsWith("<")) {
          // Import SVG
          const state = store.getState();
          const { paths, groups, snapConnections, newPathCounter, newGroupCounter } = importSvg(text, state.pathCounter, state.groupCounter);
          if (paths.length === 0) {
            alert("No paths found in SVG file");
            return;
          }
          // Create a new document with the imported paths
          const docName = file.name.replace(/\.svg$/i, "");
          store.loadDocument({
            name: docName,
            paths,
            groups,
            snapConnections,
            animationClips: [],
            pathCounter: newPathCounter,
            groupCounter: newGroupCounter,
          }, null);
        } else {
          // Load as estme/JSON format
          const data = JSON.parse(text);
          store.loadDocument(data, null);
        }
      } catch (err) {
        alert("Failed to open file: " + (err instanceof Error ? err.message : "Unknown error"));
      }
    };
    input.click();
    setOpenMenu(null);
  };

  // Download to file
  const handleDownload = () => {
    const data = store.getDocumentData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${documentName}.estme`;
    a.click();

    URL.revokeObjectURL(url);
    setOpenMenu(null);
  };

  // Export to Three.js format
  const handleExport = () => {
    setOpenMenu(null);
    try {
      const state = store.getState();
      const exported = exportToThreeJS(
        documentName,
        state.paths,
        state.groups,
        state.animationClips,
      );
      const json = JSON.stringify(exported);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `${documentName}.estme3d`;
      a.click();

      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Export failed: " + (err instanceof Error ? err.message : "Unknown error"));
    }
  };

  // Save to IndexedDB
  const handleSaveToStorage = async () => {
    setOpenMenu(null);
    try {
      const id = documentId || generateId();
      const data = store.getDocumentData();
      const now = Date.now();

      // Check if another document with the same name exists
      const existingDoc = await findDocumentByName(documentName);
      if (existingDoc && existingDoc.id !== id) {
        if (!confirm(`A document named "${documentName}" already exists. Overwrite it?`)) {
          return;
        }
        // Delete the existing document with that name
        await deleteDocument(existingDoc.id);
      }

      // Try to get existing createdAt if this document was previously saved
      const existingCreatedAt = (await loadDocument(id))?.createdAt;

      await saveDocument({
        id,
        name: documentName,
        data,
        updatedAt: now,
        createdAt: existingCreatedAt || now,
      });

      if (!documentId) {
        store.setDocumentId(id);
      }
      store.markClean();
      // Clear autosave since document is now saved
      await clearAutosave();
    } catch (err) {
      alert("Failed to save: " + (err instanceof Error ? err.message : "Unknown error"));
    }
  };

  // Open from IndexedDB
  const handleOpenFromStorage = async () => {
    setOpenMenu(null);
    try {
      const docs = await listDocuments();
      setSavedDocuments(docs);
      setShowOpenDialog(true);
    } catch (err) {
      alert("Failed to list documents: " + (err instanceof Error ? err.message : "Unknown error"));
    }
  };

  const handleSelectDocument = async (doc: StoredDocument) => {
    try {
      await clearAutosave(); // Clear autosave when opening a different document
      store.loadDocument(doc.data as Parameters<typeof store.loadDocument>[0], doc.id);
      setShowOpenDialog(false);
    } catch (err) {
      alert("Failed to load document: " + (err instanceof Error ? err.message : "Unknown error"));
    }
  };

  const handleDeleteDocument = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this document permanently?")) {
      try {
        await deleteDocument(id);
        setSavedDocuments(savedDocuments.filter((d) => d.id !== id));
        // If we deleted the current document, clear the ID
        if (documentId === id) {
          store.setDocumentId(null);
        }
      } catch (err) {
        alert("Failed to delete: " + (err instanceof Error ? err.message : "Unknown error"));
      }
    }
  };

  const handleRename = () => {
    setEditName(documentName);
    setIsEditingName(true);
    setOpenMenu(null);
    // Focus the input after it renders
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const handleNameSubmit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== documentName) {
      store.setDocumentName(trimmed);
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNameSubmit();
    } else if (e.key === "Escape") {
      setIsEditingName(false);
    }
  };

  const toggleMenu = (menu: string) => {
    setOpenMenu(openMenu === menu ? null : menu);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <>
      <div ref={menuBarRef} className={styles.menuBar}>
        <span className={styles.appName}>estme</span>

        <div
          className={`${styles.menuItem} ${openMenu === "file" ? styles.open : ""}`}
          onClick={() => toggleMenu("file")}
        >
          File
          {openMenu === "file" && (
            <div className={styles.dropdown}>
              <div className={styles.dropdownItem} onClick={handleNew}>
                <span>New</span>
                <span className={styles.shortcut}>Ctrl+N</span>
              </div>
              <div className={styles.separator} />
              <div className={styles.dropdownItem} onClick={handleOpenFromStorage}>
                <span>Open...</span>
                <span className={styles.shortcut}>Ctrl+O</span>
              </div>
              <div className={styles.dropdownItem} onClick={handleSaveToStorage}>
                <span>Save</span>
                <span className={styles.shortcut}>Ctrl+S</span>
              </div>
              <div className={styles.separator} />
              <div className={styles.dropdownItem} onClick={handleLoadFromFile}>
                <span>Load from file...</span>
              </div>
              <div className={styles.dropdownItem} onClick={handleDownload}>
                <span>Download</span>
              </div>
              <div className={styles.dropdownItem} onClick={handleExport}>
                <span>Export for Three.js</span>
              </div>
              <div className={styles.separator} />
              <div className={styles.dropdownItem} onClick={handleRename}>
                <span>Rename...</span>
              </div>
              <div
                className={`${styles.dropdownItem} ${!isDirty ? styles.disabled : ""}`}
                onClick={isDirty ? handleDiscardChanges : undefined}
              >
                <span>Discard Changes</span>
              </div>
            </div>
          )}
        </div>

        <div className={styles.documentName}>
          {isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={handleNameKeyDown}
              className={styles.nameInput}
            />
          ) : !isLoadingDocument && (
            <span onClick={handleRename} title="Click to rename">
              {isDirty && <span className={styles.dirtyIndicator}>*</span>}{documentName}
            </span>
          )}
        </div>
      </div>

      {showOpenDialog && (
        <div className={styles.dialogOverlay} onClick={() => setShowOpenDialog(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.dialogHeader}>
              <span>Open Document</span>
              <button className={styles.closeButton} onClick={() => setShowOpenDialog(false)}>×</button>
            </div>
            <div className={styles.dialogContent}>
              {savedDocuments.length === 0 ? (
                <div className={styles.emptyMessage}>No saved documents</div>
              ) : (
                <div className={styles.documentList}>
                  {savedDocuments.map((doc) => (
                    <div
                      key={doc.id}
                      className={`${styles.documentItem} ${doc.id === documentId ? styles.current : ""}`}
                      onClick={() => handleSelectDocument(doc)}
                    >
                      <div className={styles.documentInfo}>
                        <div className={styles.documentTitle}>{doc.name}</div>
                        <div className={styles.documentDate}>{formatDate(doc.updatedAt)}</div>
                      </div>
                      <button
                        className={styles.deleteDocButton}
                        onClick={(e) => handleDeleteDocument(doc.id, e)}
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
