// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

const METADATA_LABEL_BY_TYPE = new Map<string, string>([
  ["did:ng:z:Tab", "Tab"],
  ["did:ng:z:Block", "Block"],
  ["did:ng:z:Widget", "Widget"],
  ["did:ng:z:SchemaDef", "SchemaDef"],
  ["did:ng:z:PropertyDef", "PropertyDef"],
  ["did:ng:z:Settings", "Settings"],
]);

/** The complete set of type labels new Record nodes may receive. */
export const BOUNDED_RECORD_TYPE_LABELS = new Set([
  ...[...METADATA_LABEL_BY_TYPE.values()].map((name) => `Type_${name}`),
  "Type_User",
]);

/**
 * Cypher cannot parameterize a label. Only a closed, application-owned label
 * suffix reaches this whitelist; never splice caller-controlled text into a
 * query without an equivalent `[A-Za-z0-9_]` restriction.
 */
export function sanitizeLabel(typeIri: string | undefined): string {
  const suffix = (typeIri && METADATA_LABEL_BY_TYPE.get(typeIri)) ?? "User";
  const cleaned = suffix.replace(/[^A-Za-z0-9_]/g, "").slice(0, 100);
  return cleaned.length > 0 ? `Type_${cleaned}` : "Type_User";
}

/**
 * Select legacy dynamic Type_* labels that are safe to splice into a cleanup
 * query. Exact regex equality matters: sanitizing an unsafe database value
 * into a different string would target the wrong label.
 */
export function staleRecordTypeLabels(labels: Iterable<string>): string[] {
  return [...labels]
    .filter((label) => /^Type_[A-Za-z0-9_]{1,100}$/.test(label))
    .filter((label) => !BOUNDED_RECORD_TYPE_LABELS.has(label))
    .sort();
}
