import type { Tab } from "../shapes/orm/metaShapes.typings";

type RoutableTab = Pick<Tab, "@id" | "title">;

/** Derive a readable URL segment without adding persisted identity state. */
export function tabTitleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The first tab in the already sorted list owns a shared slug. Later
 * collisions, empty slugs, and segments that collide with a raw id retain
 * their permanent id instead.
 */
export function tabRouteSegment(tab: RoutableTab, orderedTabs: RoutableTab[]): string {
  const slug = tabTitleSlug(tab.title);
  if (!slug) return tab["@id"];
  const owner = orderedTabs.find((candidate) => tabTitleSlug(candidate.title) === slug);
  const shadowsRawId = orderedTabs.some(
    (candidate) => candidate["@id"] === slug && candidate["@id"] !== tab["@id"],
  );
  return owner?.["@id"] === tab["@id"] && !shadowsRawId ? slug : tab["@id"];
}

/** Raw ids win forever; only then are derived canonical segments considered. */
export function resolveTabRouteSegment(
  segment: string,
  allTabs: RoutableTab[],
  orderedSlugTabs: RoutableTab[] = allTabs,
): RoutableTab | undefined {
  return allTabs.find((tab) => tab["@id"] === segment) ??
    orderedSlugTabs.find((tab) => tabRouteSegment(tab, orderedSlugTabs) === segment);
}
