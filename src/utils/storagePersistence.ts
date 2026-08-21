/**
 * Asking the browser to keep this origin's storage.
 *
 * Everything the app holds lives in `localStorage`, so "clear browsing data"
 * has always been able to delete the only copy - a hazard
 * `docs/product-assessment.md` has to carry as a condition of the
 * privacy-by-construction use case rather than a footnote beside it. A granted
 * persistence request exempts the origin from routine eviction and from the
 * ordinary clearing paths, which is most of what a desktop shell would buy.
 *
 * The request is deliberately *not* made on load. Chrome decides silently from
 * engagement and installed state, but Firefox raises a permission prompt, and a
 * prompt nobody asked for on first paint is worse than the problem. It is
 * offered where losing data is already the subject: next to backup and import.
 */

export type StoragePersistence = "persisted" | "not-persisted" | "unsupported";

function storageManager(): StorageManager | undefined {
  // Not present on plain-HTTP LAN origins, which this app is expected to run
  // on - see the note in randomId.ts about the same class of gap.
  return typeof navigator !== "undefined" ? navigator.storage : undefined;
}

/** Whether this origin's storage is already exempt from routine clearing. */
export async function readStoragePersistence(): Promise<StoragePersistence> {
  const storage = storageManager();
  if (!storage?.persisted) return "unsupported";
  try {
    return (await storage.persisted()) ? "persisted" : "not-persisted";
  } catch {
    return "unsupported";
  }
}

/**
 * Ask for persistence. Returns the state afterwards, so a refusal is reported
 * as plainly as a grant - a caller that assumed success would tell the user
 * their data was safe when the browser had just declined.
 */
export async function requestStoragePersistence(): Promise<StoragePersistence> {
  const storage = storageManager();
  if (!storage?.persist) return "unsupported";
  try {
    return (await storage.persist()) ? "persisted" : "not-persisted";
  } catch {
    return "unsupported";
  }
}
