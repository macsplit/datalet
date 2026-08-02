import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useShape } from "@ng-org/orm/react";
import {
  BlockShapeType,
  PropertyDefShapeType,
  SchemaDefShapeType,
  TabShapeType,
  WidgetShapeType,
} from "../shapes/orm/metaShapes.shapeTypes";
import usePrivateNuri from "../components/usePrivateNuri";
import type {
  Block,
  PropertyDef,
  SchemaDef,
  Tab,
  Widget,
} from "../shapes/orm/metaShapes.typings";

export const HOME_TAB_ID = "did:ng:z:HomeTab";

type MetaStore = {
  privateNuri: string | undefined;
  tabSet: Set<Tab>;
  blockSet: Set<Block>;
  widgetSet: Set<Widget>;
  schemaSet: Set<SchemaDef>;
  propertySet: Set<PropertyDef>;
};

const MetaStoreContext = createContext<MetaStore | undefined>(undefined);
export function MetaStoreProvider({ children }: { children: ReactNode }) {
  const privateNuri = usePrivateNuri();
  const tabSet = useShape(TabShapeType, privateNuri);
  const blockSet = useShape(BlockShapeType, privateNuri);
  const widgetSet = useShape(WidgetShapeType, privateNuri);
  const schemaSet = useShape(SchemaDefShapeType, privateNuri);
  const propertySet = useShape(PropertyDefShapeType, privateNuri);

  useEffect(() => {
    if (!privateNuri) return;
    let cancelled = false;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!cancelled && ![...tabSet].some((tab) => tab["@id"] === HOME_TAB_ID)) {
          tabSet.add({
            "@graph": privateNuri,
            "@id": HOME_TAB_ID,
            "@type": "did:ng:z:Tab",
            title: "Home",
            order: 0,
          });
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [privateNuri, tabSet]);

  const value = useMemo(
    () => ({ privateNuri, tabSet, blockSet, widgetSet, schemaSet, propertySet }),
    [privateNuri, tabSet, blockSet, widgetSet, schemaSet, propertySet],
  );

  return (
    <MetaStoreContext.Provider value={value}>
      {children}
    </MetaStoreContext.Provider>
  );
}

export function useMetaStore() {
  const value = useContext(MetaStoreContext);
  if (!value) throw new Error("Metadata hooks must be used inside MetaStoreProvider.");
  return value;
}
