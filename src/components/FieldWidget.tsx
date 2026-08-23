import { useEffect, useMemo, useState } from "react";
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
import { clearUndoDisplayForRecord } from "../utils/localNgEngine";
import { safeWebUrl } from "../utils/urlSafety";
import { MARKDOWN_FIELD_MAX_LENGTH, renderMarkdownToSafeHtml } from "../utils/markdown";

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

function dateTimeInputValue(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function displayDate(value: unknown, includeTime: boolean): string {
  if (typeof value !== "string" || !value) return "Not set";
  const date = includeTime
    ? new Date(value)
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(
          Number(value.slice(0, 4)),
          Number(value.slice(5, 7)) - 1,
          Number(value.slice(8, 10)),
        )
      : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(
    undefined,
    includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" },
  ).format(date);
}

function ReferenceField({
  record,
  property,
  label,
  inputId,
  isEditing,
  displayValue,
}: {
  record: DynamicRecord;
  property: PropertyDef;
  label: string;
  inputId: string;
  isEditing: boolean;
  displayValue?: unknown;
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
  const eligibleLabelProperty = (item: PropertyDef) =>
    item.dataType === "did:ng:z:text" || item.dataType === "did:ng:z:enum";
  const configuredLabelProperty = target?.labelPropertyId
    ? properties.find((item) => item["@id"] === target.labelPropertyId && eligibleLabelProperty(item))
    : undefined;
  const labelProperty = configuredLabelProperty ?? properties.find(eligibleLabelProperty);
  const options = [...targets].sort((a, b) => a["@id"].localeCompare(b["@id"]));
  const recordValue = displayValue ?? record[property.name];
  const [localValue, setLocalValue] = useState(recordValue);
  useEffect(() => setLocalValue(recordValue), [recordValue]);
  const selected = property.cardinality === "did:ng:z:many"
    ? valuesOf(localValue)
    : [typeof localValue === "string" ? localValue : ""];
  const setValue = (next: string | Set<string>) => {
    clearUndoDisplayForRecord(`${record["@graph"]}|${record["@id"]}`);
    setLocalValue(next);
    record[property.name] = next;
  };
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
              setValue(new Set(
                [...event.currentTarget.selectedOptions].map((option) => option.value),
              ));
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
            onChange={(event) => setValue(event.target.value)}
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
  displayValue,
}: {
  record: DynamicRecord;
  widget: Widget;
  property: PropertyDef;
  isEditing: boolean;
  displayValue?: unknown;
}) {
  const { format, symbol } = useSettings();
  const propertyName = property.name;
  const recordValue = displayValue ?? record[propertyName];
  const [value, setLocalValue] = useState(recordValue);
  useEffect(() => setLocalValue(recordValue), [recordValue]);
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
        displayValue={displayValue}
      />
    );
  }

  const setScalar = (next: string | number | boolean) => {
    clearUndoDisplayForRecord(`${record["@graph"]}|${record["@id"]}`);
    setLocalValue(next);
    record[propertyName] = next;
  };

  const toggleOption = (option: string, checked: boolean) => {
    const current = value instanceof Set ? new Set(value) : new Set<string>();
    if (checked) current.add(option);
    else current.delete(option);
    clearUndoDisplayForRecord(`${record["@graph"]}|${record["@id"]}`);
    setLocalValue(current);
    record[propertyName] = current;
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

  if (fieldType === "did:ng:z:date" || fieldType === "did:ng:z:dateTime") {
    const includeTime = fieldType === "did:ng:z:dateTime";
    const inputValue = includeTime
      ? dateTimeInputValue(value)
      : typeof value === "string" ? value : "";
    return (
      <div className="field-group">
        <label className="field-label" htmlFor={inputId}>{label}</label>
        {isEditing ? (
          <input
            id={inputId}
            type={includeTime ? "datetime-local" : "date"}
            className="input"
            value={inputValue}
            onChange={(event) => {
              const next = event.target.value;
              setScalar(includeTime && next ? new Date(next).toISOString() : next);
            }}
          />
        ) : (
          <span className="value-text">{displayDate(value, includeTime)}</span>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:longText") {
    const text = typeof value === "string" ? value : "";
    return (
      <div className="field-group field-group-full-width">
        <label className="field-label" htmlFor={inputId}>{label}</label>
        {isEditing ? (
          <textarea
            id={inputId}
            className="textarea"
            value={text}
            onChange={(event) => setScalar(event.target.value)}
          />
        ) : (
          <p className="value-text preserve-whitespace">{text || "Not set"}</p>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:markdown") {
    const text = typeof value === "string" ? value : "";
    return (
      <div className="field-group field-group-full-width">
        <label className="field-label" htmlFor={inputId}>{label}</label>
        {isEditing ? (
          <textarea
            id={inputId}
            className="textarea textarea-mono"
            value={text}
            maxLength={MARKDOWN_FIELD_MAX_LENGTH}
            onChange={(event) => setScalar(event.target.value)}
          />
        ) : text ? (
          // A div, not a <p>: the rendered markdown can itself contain block
          // elements (headings, lists, a blockquote), which is invalid
          // nested inside a <p>.
          <div
            className="value-text markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(text) }}
          />
        ) : (
          <p className="value-text">Not set</p>
        )}
      </div>
    );
  }

  if (fieldType === "did:ng:z:url" || fieldType === "did:ng:z:email") {
    const text = typeof value === "string" ? value : "";
    const href = fieldType === "did:ng:z:email"
      ? text ? `mailto:${text}` : undefined
      : safeWebUrl(text);
    return (
      <div className="field-group">
        <label className="field-label" htmlFor={inputId}>{label}</label>
        {isEditing ? (
          <input
            id={inputId}
            type={fieldType === "did:ng:z:email" ? "email" : "url"}
            className="input"
            value={text}
            onChange={(event) => setScalar(event.target.value)}
          />
        ) : href ? (
          <a
            className="value-text"
            href={href}
            target={fieldType === "did:ng:z:url" ? "_blank" : undefined}
            rel="noreferrer noopener"
          >
            {text}
          </a>
        ) : (
          <span className="value-text">{text || "Not set"}</span>
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
