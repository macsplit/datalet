import { useRef, useState, type ChangeEvent } from "react";
import { useMetaStore } from "../hooks/MetaStoreContext";
import { exportGraphBackup, importGraphBackup } from "../utils/localNgEngine";

export function DataBackup() {
  const { privateNuri } = useMetaStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const exportData = () => {
    if (!privateNuri) return;
    const backup = exportGraphBackup(privateNuri);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `datalet-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !privateNuri) return;
    if (!window.confirm("Replace everything in the datalet you have open with this backup?")) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setError("");
      importGraphBackup(privateNuri, parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The backup could not be imported.");
    }
  };

  return (
    <section className="panel" id="backup">
      <div className="panel-header">
        <div>
          <p className="label-accent">Recovery</p>
          <h2 className="title">Export or import data</h2>
        </div>
        <div className="builder-actions">
          <button type="button" className="secondary-btn" onClick={exportData} disabled={!privateNuri}>
            Export backup
          </button>
          <button type="button" className="primary-btn" onClick={() => inputRef.current?.click()} disabled={!privateNuri}>
            Import backup
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            aria-label="Choose backup file"
            onChange={importData}
            hidden
          />
        </div>
      </div>
      <p className="helper-text">
        A backup contains every record, schema, tab, block, widget and setting in the
        datalet you have open. Importing replaces all of it and reloads the app.
      </p>
      {error && <p className="danger-text" role="alert">{error}</p>}
    </section>
  );
}
