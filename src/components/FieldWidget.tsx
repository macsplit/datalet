import { useMemo } from "react";
import { useShape } from "@ng-org/orm/react";
import type {
  PropertyDef,
  Widget,
} from "../shapes/orm/metaShapes.typings";
import type { DynamicRecord } from "../utils/dynamicSchema";
import { useSettings } from "../hooks/useSettings";
import { useSchemas } from "../hooks/useSchemas";
import { usePropertyDefs } from "../hooks/usePropertyDefs";
import { useMetaStore } from "../hooks/MetaStoreContext";
import { buildShapeType } from "../utils/dynamicSchema";

const EMPTY_REFERENCE_SHAPE = {
  shape: "did:ng:z:MissingReferenceShape",
  schema: {
    "did:ng:z:MissingReferenceShape": {
      iri: "did:ng:z:MissingReferenceShape",
      predicates: [],
    },
  },
} as ReturnType<typeof buildShapeType>;

function valuesOf(value: unknown): string[] {
  if (value instanceof Set) return [...value].map(String);
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function ReferenceField({
  record,
  property,
  label,
  inputId,
  isEditing,
}: {
  record: DynamicRecord;
  property: PropertyDef;
  label: string;
  inputId: string;
  isEditing: boolean;
}) {
  const { schemas } = useSchemas();
  const { properties } = usePropertyDefs(property.referenceSchemaId);
  const { privateNuri } = useMetaStore();
  const target = schemas.find((schema) => schema["@id"] === property.referenceSchemaId);
  const signature = properties
    .map((item) => `${item["@id"]}|${item.name}|${item.dataType}|${item.cardinality}|${item.referenceSchemaId ?? ""}`)
    .join(";");
  const shapeType = useMemo(
    () => target ? buildShapeType(target, properties) : EMPTY_REFERENCE_SHAPE,
    // Mutable graph records are represented by the content signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.["@id"], signature],
  );
  const targets = useShape(shapeType, target ? privateNuri : undefined);
  const labelProperty = properties.find(
    (item) => item.dataType === "did:ng:z:text" || item.dataType === "did:ng:z:enum",
  );
  const options = [...targets].sort((a, b) => a["@id"].localeCompare(b["@id"]));
  const selected = property.cardinality === "did:ng:z:many"
    ? valuesOf(record[property.name])
    : [typeof record[property.name] === "string" ? record[property.name] as string : ""];
  const display = (id: string) => {
    const match = options.find((candidate) => candidate["@id"] === id);
    if (!match) return id || "Not set";
    const primary = labelProperty ? String(match[labelProperty.name] ?? "").trim() : "";
    return primary || match["@id"];
  };

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={inputId}>{label}</label>
      {isEditing ? (
        property.cardinality === "did:ng:z:many" ? (
          <select
            id={inputId}
            className="select"
            multiple
            value={selected}
            onChange={(event) => {
              record[property.name] = new Set(
                [...event.currentTarget.selectedOptions].map((option) => option.value),
              );
            }}
          >
            {options.map((option) => (
              <option value={option["@id"]} key={option["@id"]}>{display(option["@id"])}</option>
            ))}
          </select>
        ) : (
          <select
            id={inputId}
            className="select"
            value={selected[0]}
            onChange={(event) => (record[property.name] = event.target.value)}
          >
            <option value="">Not set</option>
            {options.map((option) => (
              <option value={option["@id"]} key={option["@id"]}>{display(option["@id"])}</option>
            ))}
          </select>
        )
      ) : selected.filter(Boolean).length > 0 ? (
        <div className="chip-list">
          {selected.filter(Boolean).map((id) => <span className="chip" key={id}>{display(id)}</span>)}
        </div>
      ) : (
        <span className="value-text">Not set</span>
      )}
    </div>
  );
}

export function FieldWidget({
  record,
  widget,
  property,
  isEditing,
}: {
  record: DynamicRecord;
  widget: Widget;
  property: PropertyDef;
  isEditing: boolean;
}) {
  const { format, symbol } = useSettings();
  const propertyName = property.name;
  const value = record[propertyName];
  const label = widget.label || propertyName;
  const fieldType = widget.fieldType ?? "did:ng:z:text";
  const enumOptions = [...(property.enumOptions ?? [])];
  const inputId = `${record["@id"]}-${encodeURIComponent(propertyName)}`;

  if (fieldType === "did:ng:z:reference") {
    return (
      <ReferenceField
        record={record}
        property={property}
        label={label}
        inputId={inputId}
        isEditing={isEditing}
      />
    );
  }

  const setScalar = (next: string | number | boolean) => {
    record[propertyName] = next;
  };

  const toggleOption = (option: string, checked: boolean) => {
    const current = record[propertyName];
    if (!(current instanceof Set)) {
      if (checked) record[propertyName] = new Set([option]);
      return;
    }
    if (checked) current.add(option);
    else current.delete(option);
  };

  if (fieldType === "did:ng:z:checkbox") {
    return (
      <div className="field-group">
        <span className="field-label">{label}</span>
        {isEditing ? (
          <label className="option-card" htmlFor={inputId}>
            <input
              id={inputId}
              type="checkbox"
              className="checkbox"
              checked={Boolean(value)}
              onChange={(event) => setScalar(event.target.checked)}
            />
            <span className="option-text">
              {Boolean(value) ? "Enabled" : "Disabled"}
            </span>
          </label>
        ) : (
          <span className="value-text">{Boolean(value) ? "Yes" : "No"}</span>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:multiSelect") {
    const selected = valuesOf(value);
    return (
      <div className="field-group">
        <span className="field-label">{label}</span>
        {isEditing ? (
          enumOptions.length > 0 ? (
            <div className="option-picker">
              {enumOptions.map((option) => (
                <label className="option-card" key={option}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={selected.includes(option)}
                    onChange={(event) =>
                      toggleOption(option, event.target.checked)
                    }
                  />
                  <span className="option-text">{option}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">No options configured.</p>
          )
        ) : selected.length > 0 ? (
          <div className="chip-list">
            {selected.map((option) => (
              <span className="chip" key={option}>
                {option}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">None selected.</p>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:dropdown") {
    return (
      <div className="field-group">
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
        {isEditing ? (
          <select
            id={inputId}
            className="select"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => setScalar(event.target.value)}
          >
            {property.cardinality === "did:ng:z:optional" && (
              <option value="">Not set</option>
            )}
            {enumOptions.map((option) => (
              <option value={option} key={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <span className="value-text">{String(value || "Not set")}</span>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:number" || fieldType === "did:ng:z:currency") {
    const numericValue = typeof value === "number" ? value : 0;
    return (
      <div className="field-group">
        <label className="field-label" htmlFor={inputId}>
          {label}
          {fieldType === "did:ng:z:currency" ? ` (${symbol})` : ""}
        </label>
        {isEditing ? (
          <input
            id={inputId}
            type="number"
            className="input"
            value={numericValue}
            onChange={(event) => setScalar(Number(event.target.value))}
          />
        ) : (
          <span className="value-text">
            {fieldType === "did:ng:z:currency"
              ? format(numericValue)
              : numericValue}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {isEditing ? (
        <input
          id={inputId}
          className="input"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => setScalar(event.target.value)}
        />
      ) : (
        <p className="value-text">{String(value || "Not set")}</p>
      )}
    </div>
  );
}
