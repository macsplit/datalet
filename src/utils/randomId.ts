/**
 * A fresh subject id for a new record in `graph`, in the `graph:q:random`
 * shape `@ng-org/orm`'s own auto-id convention uses (only for consistency -
 * nothing downstream parses this shape).
 *
 * Not delegated to the ORM's own id generation (an empty `"@id": ""` on
 * `.add()`): its generator prefers an internal deep-signal watcher path
 * over the `@graph` a caller explicitly passes, and under a condition this
 * app hasn't been able to pin down, that path can hold a stale composite
 * value instead of being empty - producing an `@id` with the graph
 * embedded in it twice (`did:ng:V|did:ng:V:q:R` instead of
 * `did:ng:V:q:R`). Once written, that shape permanently fails
 * `validGraphSnapshot`'s `key === graph|@id` check on every future
 * copy/join of the vault holding it, with no way to recover except
 * deleting the affected record - reported live, traced to one PropertyDef
 * created this way. Generating the id ourselves and passing it explicitly
 * takes the ORM's `object["@id"] !== ""` branch instead, which uses it
 * verbatim and never consults the buggy path-based branch at all.
 */
export function generateSubjectId(graph: string): string {
  return `${graph}:q:${randomUuid()}`;
}

/**
 * Generate an RFC 4122-shaped v4 UUID even when randomUUID is unavailable.
 * Browsers can omit/deny randomUUID on plain-HTTP LAN origins while still
 * exposing getRandomValues, so browser identity must never call it directly.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Insecure context or an implementation-specific failure: use bytes.
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
