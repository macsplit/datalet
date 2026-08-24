import { useState } from "react";
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
  displayRecord,
  displayRevision,
}: {
  record: DynamicRecord;
  widgets: Widget[];
  properties: PropertyDef[];
  onDelete: () => void;
  onEditingChange?: (editing: boolean) => void;
  displayRecord?: Record<string, unknown>;
  displayRevision?: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const hasActions = widgets.some(
    (widget) => widget.widgetType === "did:ng:z:editDeleteActions",
  );
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
    <article className="record-card">
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
