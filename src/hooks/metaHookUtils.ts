export function byOrderThenId<T extends { order: number; "@id": string }>(
  left: T,
  right: T,
): number {
  return left.order - right.order || left["@id"].localeCompare(right["@id"]);
}

export function nextOrder(items: Iterable<{ order: number }>): number {
  let greatest = -1;
  for (const item of items) greatest = Math.max(greatest, item.order);
  return greatest + 1;
}

/** Create an explicit globally unique subject IRI for builder-created metadata. */
export function newMetaSubjectIri(kind: string): string {
  let id: string;
  try {
    id = crypto.randomUUID();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `did:ng:z:meta:${encodeURIComponent(kind)}:${id}`;
}
