import type { Schema } from "@ng-org/shex-orm";

/**
 * =============================================================================
 * metaShapesSchema: Schema for metaShapes
 * =============================================================================
 */
export const metaShapesSchema: Schema = {
  "did:ng:z:TabShape": {
    iri: "did:ng:z:TabShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:Tab"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        readablePredicate: "@type",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:title",
        readablePredicate: "title",
      },
      {
        dataTypes: [
          {
            valType: "number",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:order",
        readablePredicate: "order",
      },
    ],
  },
  "did:ng:z:BlockShape": {
    iri: "did:ng:z:BlockShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:Block"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        readablePredicate: "@type",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:layout"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:data"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:blockType",
        readablePredicate: "blockType",
      },
      {
        dataTypes: [
          {
            valType: "number",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:order",
        readablePredicate: "order",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:title",
        readablePredicate: "title",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:stack"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:row"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:grid"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:layoutMode",
        readablePredicate: "layoutMode",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:schemaId",
        readablePredicate: "schemaId",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:filterPropertyName",
        readablePredicate: "filterPropertyName",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:filterValue",
        readablePredicate: "filterValue",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:sortPropertyName",
        readablePredicate: "sortPropertyName",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:ascending"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:descending"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:sortDirection",
        readablePredicate: "sortDirection",
      },
      {
        dataTypes: [
          {
            valType: "boolean",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:searchEnabled",
        readablePredicate: "searchEnabled",
      },
      {
        dataTypes: [
          {
            valType: "number",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:pageSize",
        readablePredicate: "pageSize",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:parentTabId",
        readablePredicate: "parentTabId",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:parentBlockId",
        readablePredicate: "parentBlockId",
      },
    ],
  },
  "did:ng:z:WidgetShape": {
    iri: "did:ng:z:WidgetShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:Widget"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        readablePredicate: "@type",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:parentBlockId",
        readablePredicate: "parentBlockId",
      },
      {
        dataTypes: [
          {
            valType: "number",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:order",
        readablePredicate: "order",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:title"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:addButton"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:editDeleteActions"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:field"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:widgetType",
        readablePredicate: "widgetType",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:label",
        readablePredicate: "label",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:propertyName",
        readablePredicate: "propertyName",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:text"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:longText"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:markdown"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:url"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:email"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:number"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:currency"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:date"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:dateTime"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:dropdown"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:multiSelect"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:checkbox"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:reference"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:fieldType",
        readablePredicate: "fieldType",
      },
    ],
  },
  "did:ng:z:SchemaDefShape": {
    iri: "did:ng:z:SchemaDefShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:SchemaDef"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        readablePredicate: "@type",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:name",
        readablePredicate: "name",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:labelPropertyId",
        readablePredicate: "labelPropertyId",
      },
    ],
  },
  "did:ng:z:PropertyDefShape": {
    iri: "did:ng:z:PropertyDefShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:PropertyDef"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        readablePredicate: "@type",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:schemaId",
        readablePredicate: "schemaId",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:name",
        readablePredicate: "name",
      },
      {
        dataTypes: [
          {
            valType: "number",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:order",
        readablePredicate: "order",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:text"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:number"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:boolean"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:date"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:enum"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:reference"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:dataType",
        readablePredicate: "dataType",
      },
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:one"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:optional"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:many"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:cardinality",
        readablePredicate: "cardinality",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: -1,
        minCardinality: 0,
        iri: "did:ng:z:enumOptions",
        readablePredicate: "enumOptions",
      },
      {
        dataTypes: [
          {
            valType: "iri",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:referenceSchemaId",
        readablePredicate: "referenceSchemaId",
      },
    ],
  },
};
