import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMetaStore } from "../hooks/MetaStoreContext";
import { exportGraphBackup, importGraphBackup, readStorageUsage } from "../utils/localNgEngine";
import { subscribeRuntimeIssues } from "../utils/runtimeHealth";
import {
  readStoragePersistence,
  requestStoragePersistence,
  type StoragePersistence,
} from "../utils/storagePersistence";

/**
 * Quiet while there is room, plain as it fills, insistent at the limit. The
 * failure it exists to pre-empt is the app silently refusing to persist, which
 * today arrives as a runtime banner with no warning that it was coming.
 */
function StorageUsageNote({ usage }: { usage: ReturnType<typeof readStorageUsage> }) {
  const percent = Math.min(999, Math.round(usage.fraction * 100));
  const megabytes = (value: number) => `${(value / 1_000_000).toFixed(1)} MB`;
  const measure = `${megabytes(usage.used)} of ${megabytes(usage.cap)} used (${percent}%)`;

  if (usage.paused) {
    return (
      <p className="helper-text danger-text" role="alert">
        Storage is full — {measure}. Saving is paused. Export a backup, then delete
        records or unused schemas to make room.
      </p>
    );
  }
  if (usage.fraction >= 0.9) {
    return (
      <p className="helper-text danger-text">
        Storage is nearly full — {measure}. Saving stops when it fills, so export a
        backup and make room now.
      </p>
    );
  }
  if (usage.fraction >= 0.6) {
    return <p className="helper-text">Storage: {measure}.</p>;
  }
  return <p className="helper-text">{measure}.</p>;
}

export function DataBackup() {
  const { privateNuri } = useMetaStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [persistence, setPersistence] = useState<StoragePersistence>("unsupported");
  const [asking, setAsking] = useState(false);
  const [usage, setUsage] = useState(() => readStorageUsage());

  // Re-read on the same signal the issue banner uses, so a store that has just
  // stopped saving reports it here rather than only in the banner, and on an
  // interval so ordinary editing moves the figure.
  useEffect(() => {
    const refresh = () => setUsage(readStorageUsage());
    const timer = setInterval(refresh, 5_000);
    const unsubscribe = subscribeRuntimeIssues(refresh);
    return () => { clearInterval(timer); unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readStoragePersistence().then((state) => {
      if (!cancelled) setPersistence(state);
    });
    return () => { cancelled = true; };
  }, []);

  const askToKeep = async () => {
    setAsking(true);
    try {
      setPersistence(await requestStoragePersistence());
    } finally {
      setAsking(false);
    }
  };

  const exportData = () => {
    if (!privateNuri) return;
    const backup = exportGraphBackup(privateNuri);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `localgraph-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !privateNuri) return;
    if (!window.confirm("Replace all data and builder configuration in this graph with this backup?")) {
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
    <section className="panel">
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
        A backup contains every record, schema, tab, block, widget, and setting in the active graph.
        Import replaces that graph and reloads the app.
      </p>
      <StorageUsageNote usage={usage} />
      {persistence === "persisted" && (
        <p className="helper-text">
          This browser has agreed to keep your data: it will not be removed to reclaim
          space, and ordinary cleanup leaves it alone. Keep exporting backups anyway —
          nothing here survives losing the device.
        </p>
      )}
      {persistence === "not-persisted" && (
        <div className="layout-row">
          <p className="helper-text">
            This browser has not agreed to keep your data, so clearing site data deletes
            it. There is no copy anywhere else unless you have paired or exported one.
          </p>
          <button type="button" className="secondary-btn" onClick={askToKeep} disabled={asking}>
            {asking ? "Asking…" : "Ask to keep data"}
          </button>
        </div>
      )}
      {error && <p className="danger-text" role="alert">{error}</p>}
    </section>
  );
}
