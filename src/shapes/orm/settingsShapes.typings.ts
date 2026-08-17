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
   * The application title shown in the nav bar and browser tab
   *
   * Original IRI: did:ng:z:appTitle
   */
  appTitle: string;
  /**
   * --color-bg in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBgLight
   */
  themeColorBgLight?: string;
  /**
   * --color-bg in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBgDark
   */
  themeColorBgDark?: string;
  /**
   * --color-surface in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSurfaceLight
   */
  themeColorSurfaceLight?: string;
  /**
   * --color-surface in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSurfaceDark
   */
  themeColorSurfaceDark?: string;
  /**
   * --color-surface-alt in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSurfaceAltLight
   */
  themeColorSurfaceAltLight?: string;
  /**
   * --color-surface-alt in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSurfaceAltDark
   */
  themeColorSurfaceAltDark?: string;
  /**
   * --color-border in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBorderLight
   */
  themeColorBorderLight?: string;
  /**
   * --color-border in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBorderDark
   */
  themeColorBorderDark?: string;
  /**
   * --color-text in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextLight
   */
  themeColorTextLight?: string;
  /**
   * --color-text in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextDark
   */
  themeColorTextDark?: string;
  /**
   * --color-text-muted in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextMutedLight
   */
  themeColorTextMutedLight?: string;
  /**
   * --color-text-muted in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextMutedDark
   */
  themeColorTextMutedDark?: string;
  /**
   * --color-text-subtle in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextSubtleLight
   */
  themeColorTextSubtleLight?: string;
  /**
   * --color-text-subtle in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorTextSubtleDark
   */
  themeColorTextSubtleDark?: string;
  /**
   * --color-accent in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentLight
   */
  themeColorAccentLight?: string;
  /**
   * --color-accent in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentDark
   */
  themeColorAccentDark?: string;
  /**
   * --color-accent-hover in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentHoverLight
   */
  themeColorAccentHoverLight?: string;
  /**
   * --color-accent-hover in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentHoverDark
   */
  themeColorAccentHoverDark?: string;
  /**
   * --color-accent-text in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentTextLight
   */
  themeColorAccentTextLight?: string;
  /**
   * --color-accent-text in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorAccentTextDark
   */
  themeColorAccentTextDark?: string;
  /**
   * --color-chip-bg in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorChipBgLight
   */
  themeColorChipBgLight?: string;
  /**
   * --color-chip-bg in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorChipBgDark
   */
  themeColorChipBgDark?: string;
  /**
   * --color-chip-text in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorChipTextLight
   */
  themeColorChipTextLight?: string;
  /**
   * --color-chip-text in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorChipTextDark
   */
  themeColorChipTextDark?: string;
  /**
   * --color-badge-bg in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBadgeBgLight
   */
  themeColorBadgeBgLight?: string;
  /**
   * --color-badge-bg in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBadgeBgDark
   */
  themeColorBadgeBgDark?: string;
  /**
   * --color-badge-text in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBadgeTextLight
   */
  themeColorBadgeTextLight?: string;
  /**
   * --color-badge-text in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorBadgeTextDark
   */
  themeColorBadgeTextDark?: string;
  /**
   * --color-danger in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorDangerLight
   */
  themeColorDangerLight?: string;
  /**
   * --color-danger in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorDangerDark
   */
  themeColorDangerDark?: string;
  /**
   * --color-success in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSuccessLight
   */
  themeColorSuccessLight?: string;
  /**
   * --color-success in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorSuccessDark
   */
  themeColorSuccessDark?: string;
  /**
   * --color-heading-2 in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorHeading2Light
   */
  themeColorHeading2Light?: string;
  /**
   * --color-heading-2 in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorHeading2Dark
   */
  themeColorHeading2Dark?: string;
  /**
   * --color-heading-3 in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorHeading3Light
   */
  themeColorHeading3Light?: string;
  /**
   * --color-heading-3 in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorHeading3Dark
   */
  themeColorHeading3Dark?: string;
  /**
   * --color-label in the light palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorLabelLight
   */
  themeColorLabelLight?: string;
  /**
   * --color-label in the dark palette; omitted uses the stylesheet default
   *
   * Original IRI: did:ng:z:themeColorLabelDark
   */
  themeColorLabelDark?: string;
}
