import { useCallback } from "react";
import type { SchemaDef } from "../shapes/orm/metaShapes.typings";
import { newMetaSubjectIri } from "./metaHookUtils";
import { useMetaStore } from "./MetaStoreContext";

/** Read user-defined schemas and expose mutations. */
export function useSchemas() {
  const { privateNuri, schemaSet } = useMetaStore();
  const schemas = [...schemaSet].sort(
    (a, b) => a.name.localeCompare(b.name) || a["@id"].localeCompare(b["@id"]),
  );

  const createSchema = useCallback(
    (name = "New schema") => {
      if (!privateNuri) return;
      const schemaId = newMetaSubjectIri("schema");
      schemaSet.add({
        "@graph": privateNuri,
        "@id": schemaId,
        "@type": "did:ng:z:SchemaDef",
        name,
      });
      return schemaId;
    },
    [privateNuri, schemaSet],
  );

  const deleteSchema = useCallback(
    (schema: SchemaDef) => schemaSet.delete(schema),
    [schemaSet],
  );

  return { schemas, createSchema, deleteSchema };
}
