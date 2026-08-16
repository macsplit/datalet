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
