export type IRI = string;

/**
 * =============================================================================
 * Typescript Typings for settingsShapes
 * =============================================================================
 */

/**
 * Settings Type
 */
export interface Settings {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:Settings";
  /**
   * The currency used to display monetary values
   *
   * Original IRI: did:ng:z:currency
   */
  currency: "did:ng:z:USD" | "did:ng:z:GBP" | "did:ng:z:EUR";
  /**
   * The application title shown in the nav bar and browser tab
   *
   * Original IRI: did:ng:z:appTitle
   */
  appTitle: string;
}
