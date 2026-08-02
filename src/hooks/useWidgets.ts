import { useCallback } from "react";
import type { Widget } from "../shapes/orm/metaShapes.typings";
import { byOrderThenId, newMetaSubjectIri, nextOrder } from "./metaHookUtils";
import { useMetaStore } from "./MetaStoreContext";

export type CreateWidget = Pick<Widget, "parentBlockId" | "widgetType"> &
  Partial<Pick<Widget, "order" | "label" | "propertyName" | "fieldType">>;

/** Read a data block's ordered widgets and expose mutations. */
export function useWidgets(parentBlockId?: string) {
  const { privateNuri, widgetSet } = useMetaStore();
  const widgets = [...widgetSet]
    .filter(
      (widget) =>
        parentBlockId === undefined || widget.parentBlockId === parentBlockId,
    )
    .sort(byOrderThenId);

  const createWidget = useCallback(
    (values: CreateWidget) => {
      if (!privateNuri) return;
      const widgetId = newMetaSubjectIri("widget");
      const siblings = [...widgetSet].filter(
        (widget) => widget.parentBlockId === values.parentBlockId,
      );
      widgetSet.add({
        "@graph": privateNuri,
        "@id": widgetId,
        "@type": "did:ng:z:Widget",
        parentBlockId: values.parentBlockId,
        widgetType: values.widgetType,
        order: values.order ?? nextOrder(siblings),
        ...(values.label !== undefined && { label: values.label }),
        ...(values.propertyName !== undefined && {
          propertyName: values.propertyName,
        }),
        ...(values.fieldType !== undefined && { fieldType: values.fieldType }),
      });
      return widgetId;
    },
    [privateNuri, widgetSet],
  );

  const deleteWidget = useCallback(
    (widget: Widget) => widgetSet.delete(widget),
    [widgetSet],
  );

  return { widgets, createWidget, deleteWidget };
}
