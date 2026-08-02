import type {
  PropertyDef,
  Widget,
} from "../shapes/orm/metaShapes.typings";
import type { DynamicRecord } from "../utils/dynamicSchema";
import { useSettings } from "../hooks/useSettings";

function valuesOf(value: unknown): string[] {
  if (value instanceof Set) return [...value].map(String);
  if (Array.isArray(value)) return value.map(String);
  return [];
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
