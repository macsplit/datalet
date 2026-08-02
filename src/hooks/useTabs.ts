import { useCallback } from "react";
import type { Tab } from "../shapes/orm/metaShapes.typings";
import { byOrderThenId, newMetaSubjectIri, nextOrder } from "./metaHookUtils";
import { HOME_TAB_ID, useMetaStore } from "./MetaStoreContext";

export { HOME_TAB_ID } from "./MetaStoreContext";

/** Read all tabs, ensure Home exists, and expose tab-level mutations. */
export function useTabs() {
  const { privateNuri, tabSet } = useMetaStore();

  const tabs = [...tabSet].sort(byOrderThenId);
  const homeTab = tabs.find((tab) => tab["@id"] === HOME_TAB_ID);
  const userTabs = tabs.filter((tab) => tab["@id"] !== HOME_TAB_ID);

  const createTab = useCallback(
    (values: Partial<Pick<Tab, "title" | "order">> = {}) => {
      if (!privateNuri) return;
      const tabId = newMetaSubjectIri("tab");
      tabSet.add({
        "@graph": privateNuri,
        "@id": tabId,
        "@type": "did:ng:z:Tab",
        title: values.title ?? "New tab",
        order: values.order ?? nextOrder(tabSet),
      });
      return tabId;
    },
    [privateNuri, tabSet],
  );

  const deleteTab = useCallback(
    (tab: Tab) => {
      if (tab["@id"] !== HOME_TAB_ID) tabSet.delete(tab);
    },
    [tabSet],
  );

  return { tabs, userTabs, homeTab, createTab, deleteTab };
}

/** Resolve the protected Home singleton through the same live tab source. */
export function useHomeTab() {
  return useTabs().homeTab;
}
