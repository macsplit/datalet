import type { BaseType, DataType, Predicate, ShapeType } from "@ng-org/shex-orm";
import type {
  PropertyDef,
  SchemaDef,
} from "../shapes/orm/metaShapes.typings";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const USER_TYPE_PREFIX = "did:ng:z:user:";

function shapeRevision(properties: PropertyDef[]): string {
  const signature = [...properties]
    .sort((a, b) => a["@id"].localeCompare(b["@id"]))
    .map((property) =>
      [
        property["@id"],
        property.name,
        property.order,
        property.dataType,
        property.cardinality,
        property.referenceSchemaId ?? "",
        [...(property.enumOptions ?? [])].sort().join("\u001f"),
      ].join("\u001e"),
    )
    .join("\u001d");

  // Small deterministic FNV-1a revision: this is a cache identity, not a
  // security boundary. It forces the ORM pool to reopen when shape content
  // changes instead of reusing a stale subscription under the same IRI.
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A record produced from a user-defined schema. */
export interface DynamicRecord extends BaseType {
  readonly "@graph": string;
  "@type": string;
  [property: string]: unknown;
}

function cardinalityFor(property: PropertyDef) {
  switch (property.cardinality) {
    case "did:ng:z:optional":
      return { minCardinality: 0, maxCardinality: 1 };
    case "did:ng:z:many":
      return { minCardinality: 0, maxCardinality: -1 };
    default:
      return { minCardinality: 1, maxCardinality: 1 };
  }
}

function dataTypesFor(property: PropertyDef): DataType[] {
  switch (property.dataType) {
    case "did:ng:z:number":
      return [{ valType: "number" }];
    case "did:ng:z:boolean":
      return [{ valType: "boolean" }];
    case "did:ng:z:date":
      return [{ valType: "string" }];
    case "did:ng:z:reference":
      return [{ valType: "iri" }];
    case "did:ng:z:enum": {
      const options = [...(property.enumOptions ?? [])];
      return options.length > 0
        ? options.map((option) => ({ valType: "string", literals: [option] }))
        : [{ valType: "string" }];
    }
    default:
      return [{ valType: "string" }];
  }
}

/**
 * Build the runtime ORM shape for a user-defined schema.
 *
 * The RDF type is stable for stored records, while the shape IRI also carries
 * a deterministic content revision so the ORM cannot reuse a stale pooled
 * subscription after fields or enum values change. Property IRIs include the
 * schema subject, preventing two schemas with an equally named field from
 * accidentally sharing a predicate.
 */
export function buildShapeType(
  schemaDef: SchemaDef,
  properties: PropertyDef[],
): ShapeType<DynamicRecord> {
  const typeIri = `${USER_TYPE_PREFIX}${schemaDef["@id"]}`;
  const shapeIri = `${typeIri}:Shape:${shapeRevision(properties)}`;

  const propertyPredicates: Predicate[] = [...properties]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((property) => ({
      dataTypes: dataTypesFor(property),
      ...cardinalityFor(property),
      iri: `${typeIri}:property:${encodeURIComponent(property.name)}`,
      readablePredicate: property.name,
    }));

  return {
    shape: shapeIri,
    schema: {
      [shapeIri]: {
        iri: shapeIri,
        predicates: [
          {
            dataTypes: [{ valType: "iri", literals: [typeIri] }],
            minCardinality: 1,
            maxCardinality: 1,
            iri: RDF_TYPE,
            readablePredicate: "@type",
          },
          ...propertyPredicates,
        ],
      },
    },
  };
}

/** Return the RDF type used when inserting records for a dynamic shape. */
export function dynamicTypeIri(schemaDef: SchemaDef): string {
  return `${USER_TYPE_PREFIX}${schemaDef["@id"]}`;
}
