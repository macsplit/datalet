import { useEffect, useRef, useState } from "react";
import type {
  PropertyDef,
  Widget,
} from "../shapes/orm/metaShapes.typings";
import type { DynamicRecord } from "../utils/dynamicSchema";
import { CheckIcon, PencilIcon, TrashIcon } from "./icons";
import { FieldWidget } from "./FieldWidget";

export function RecordCard({
  record,
  widgets,
  properties,
  onDelete,
  onEditingChange,
  startEditing = false,
  displayRecord,
  displayRevision,
}: {
  record: DynamicRecord;
  widgets: Widget[];
  properties: PropertyDef[];
  onDelete: () => void;
  onEditingChange?: (editing: boolean) => void;
  startEditing?: boolean;
  displayRecord?: Record<string, unknown>;
  displayRevision?: number;
}) {
  const [isEditing, setIsEditing] = useState(startEditing);
  const hasActions = widgets.some(
    (widget) => widget.widgetType === "did:ng:z:editDeleteActions",
  );
  const cardRef = useRef<HTMLElement>(null);

  // A card that mounts already editing is a record the reader just added (or
  // an editor paged back into view): bring it on screen with its first field
  // focused. Mount-only, like the initial state it mirrors.
  useEffect(() => {
    if (!startEditing || !hasActions) return;
    const card = cardRef.current;
    card?.scrollIntoView({ block: "nearest" });
    card
      ?.querySelector<HTMLElement>(".info-grid input, .info-grid textarea, .info-grid select")
      ?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fieldWidgets = widgets.filter(
    (widget) => widget.widgetType === "did:ng:z:field",
  );
  const propertiesByName = new Map(
    properties.map((property) => [property.name, property]),
  );

  const handleDelete = () => {
    if (window.confirm("Delete this record?")) onDelete();
  };

  const toggleEditing = () => {
    const next = !isEditing;
    setIsEditing(next);
    onEditingChange?.(next);
  };

  return (
    <article className="record-card" ref={cardRef}>
      {hasActions && (
        <div className="record-header">
          <div className="record-header-text">
            <p className="label-accent">Record</p>
          </div>
          <div className="record-actions">
            <button
              type="button"
              className={isEditing ? "icon-btn icon-btn-success" : "icon-btn"}
              aria-label={isEditing ? "Done editing" : "Edit record"}
              onClick={toggleEditing}
            >
              {isEditing ? <CheckIcon /> : <PencilIcon />}
            </button>
            {!isEditing && (
              <button
                type="button"
                className="icon-btn icon-btn-danger"
                aria-label="Delete record"
                onClick={handleDelete}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
      )}
      {fieldWidgets.length > 0 ? (
        <div className="info-grid">
          {fieldWidgets.map((widget) => {
            const property = widget.propertyName
              ? propertiesByName.get(widget.propertyName)
              : undefined;
            return property ? (
              <FieldWidget
                key={`${widget["@id"]}|${displayRevision ?? 0}`}
                record={record}
                widget={widget}
                property={property}
                isEditing={hasActions && isEditing}
                displayValue={displayRecord?.[property.name]}
              />
            ) : (
              <p className="muted" key={widget["@id"]}>
                Field configuration is incomplete.
              </p>
            );
          })}
        </div>
      ) : (
        <p className="muted">No fields configured for this record.</p>
      )}
    </article>
  );
}
