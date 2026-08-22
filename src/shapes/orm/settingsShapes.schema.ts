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
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 1,
        iri: "did:ng:z:appTitle",
        readablePredicate: "appTitle",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBgLight",
        readablePredicate: "themeColorBgLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBgDark",
        readablePredicate: "themeColorBgDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSurfaceLight",
        readablePredicate: "themeColorSurfaceLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSurfaceDark",
        readablePredicate: "themeColorSurfaceDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSurfaceAltLight",
        readablePredicate: "themeColorSurfaceAltLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSurfaceAltDark",
        readablePredicate: "themeColorSurfaceAltDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBorderLight",
        readablePredicate: "themeColorBorderLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBorderDark",
        readablePredicate: "themeColorBorderDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorTextLight",
        readablePredicate: "themeColorTextLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorTextDark",
        readablePredicate: "themeColorTextDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorTextMutedLight",
        readablePredicate: "themeColorTextMutedLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorTextMutedDark",
        readablePredicate: "themeColorTextMutedDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentLight",
        readablePredicate: "themeColorAccentLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentDark",
        readablePredicate: "themeColorAccentDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentHoverLight",
        readablePredicate: "themeColorAccentHoverLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentHoverDark",
        readablePredicate: "themeColorAccentHoverDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentTextLight",
        readablePredicate: "themeColorAccentTextLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorAccentTextDark",
        readablePredicate: "themeColorAccentTextDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorChipBgLight",
        readablePredicate: "themeColorChipBgLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorChipBgDark",
        readablePredicate: "themeColorChipBgDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorChipTextLight",
        readablePredicate: "themeColorChipTextLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorChipTextDark",
        readablePredicate: "themeColorChipTextDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBadgeBgLight",
        readablePredicate: "themeColorBadgeBgLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBadgeBgDark",
        readablePredicate: "themeColorBadgeBgDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBadgeTextLight",
        readablePredicate: "themeColorBadgeTextLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorBadgeTextDark",
        readablePredicate: "themeColorBadgeTextDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorDangerLight",
        readablePredicate: "themeColorDangerLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorDangerDark",
        readablePredicate: "themeColorDangerDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSuccessLight",
        readablePredicate: "themeColorSuccessLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorSuccessDark",
        readablePredicate: "themeColorSuccessDark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorHeading2Light",
        readablePredicate: "themeColorHeading2Light",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorHeading2Dark",
        readablePredicate: "themeColorHeading2Dark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorHeading3Light",
        readablePredicate: "themeColorHeading3Light",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorHeading3Dark",
        readablePredicate: "themeColorHeading3Dark",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorLabelLight",
        readablePredicate: "themeColorLabelLight",
      },
      {
        dataTypes: [
          {
            valType: "string",
          },
        ],
        maxCardinality: 1,
        minCardinality: 0,
        iri: "did:ng:z:themeColorLabelDark",
        readablePredicate: "themeColorLabelDark",
      },
    ],
  },
};
