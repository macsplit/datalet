import type { Schema } from "@ng-org/shex-orm";

/**
 * =============================================================================
 * settingsShapesSchema: Schema for settingsShapes
 * =============================================================================
 */
export const settingsShapesSchema: Schema = {
  "did:ng:z:SettingsShape": {
    iri: "did:ng:z:SettingsShape",
    predicates: [
      {
        dataTypes: [
          {
            valType: "iri",
            literals: ["did:ng:z:Settings"],
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
            literals: ["did:ng:z:USD"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:GBP"],
          },
          {
            valType: "iri",
            literals: ["did:ng:z:EUR"],
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:currency",
        readablePredicate: "currency",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:appTitle",
        readablePredicate: "appTitle",
      },
    ],
  },
};
