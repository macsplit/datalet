import { useCallback } from "react";
import type { PropertyDef } from "../shapes/orm/metaShapes.typings";
import { byOrderThenId, nextOrder } from "./metaHookUtils";
import { useMetaStore } from "./MetaStoreContext";

export type CreatePropertyDef = Pick<PropertyDef, "schemaId" | "name"> &
  Partial<
    Pick<PropertyDef, "order" | "dataType" | "cardinality" | "enumOptions" | "referenceSchemaId">
  >;

/** Read a schema's ordered properties and expose mutations. */
export function usePropertyDefs(schemaId?: string) {
  const { privateNuri, propertySet } = useMetaStore();
  const properties = [...propertySet]
    .filter(
      (property) => schemaId === undefined || property.schemaId === schemaId,
    )
    .sort(byOrderThenId);

  const createPropertyDef = useCallback(
    (values: CreatePropertyDef) => {
      if (!privateNuri) return;
      const siblings = [...propertySet].filter(
        (property) => property.schemaId === values.schemaId,
      );
      propertySet.add({
        "@graph": privateNuri,
        "@id": "",
        "@type": "did:ng:z:PropertyDef",
        schemaId: values.schemaId,
        name: values.name,
        order: values.order ?? nextOrder(siblings),
        dataType: values.dataType ?? "did:ng:z:text",
        cardinality: values.cardinality ?? "did:ng:z:one",
        enumOptions: values.enumOptions ?? new Set<string>(),
        ...(values.referenceSchemaId && { referenceSchemaId: values.referenceSchemaId }),
      });
    },
    [privateNuri, propertySet],
  );

  const deletePropertyDef = useCallback(
    (property: PropertyDef) => propertySet.delete(property),
    [propertySet],
  );

  return { properties, createPropertyDef, deletePropertyDef };
}
