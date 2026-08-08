import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { PropertyDef, Widget } from "../shapes/orm/metaShapes.typings";
import { usePropertyDefs } from "../hooks/usePropertyDefs";
import { useSchemas } from "../hooks/useSchemas";
import { useBlocks } from "../hooks/useBlocks";
import { useWidgets } from "../hooks/useWidgets";
import { TrashIcon } from "../components/icons";

const DATA_TYPES: Array<{ value: PropertyDef["dataType"]; label: string }> = [
  { value: "did:ng:z:text", label: "Text" },
  { value: "did:ng:z:number", label: "Number" },
  { value: "did:ng:z:boolean", label: "Boolean" },
  { value: "did:ng:z:date", label: "Date / time" },
  { value: "did:ng:z:enum", label: "Enum" },
  { value: "did:ng:z:reference", label: "Reference" },
];

const CARDINALITIES: Array<{
  value: PropertyDef["cardinality"];
  label: string;
}> = [
  { value: "did:ng:z:one", label: "Required (one)" },
  { value: "did:ng:z:optional", label: "Optional" },
  { value: "did:ng:z:many", label: "Multiple values" },
];

function fieldTypeForProperty(property: PropertyDef): NonNullable<Widget["fieldType"]> {
  switch (property.dataType) {
    case "did:ng:z:number":
      return "did:ng:z:number";
    case "did:ng:z:boolean":
      return "did:ng:z:checkbox";
    case "did:ng:z:date":
      return "did:ng:z:date";
    case "did:ng:z:enum":
      return property.cardinality === "did:ng:z:many"
        ? "did:ng:z:multiSelect"
        : "did:ng:z:dropdown";
    case "did:ng:z:reference":
      return "did:ng:z:reference";
    default:
      return "did:ng:z:text";
  }
}

function EnumOption({
  option,
  options,
}: {
  option: string;
  options: Set<string>;
}) {
  const [draft, setDraft] = useState(option);

  useEffect(() => setDraft(option), [option]);

  const commit = () => {
    const next = draft.trim();
    if (!next || (next !== option && options.has(next))) {
      setDraft(option);
      return;
    }
    if (next !== option) {
      options.delete(option);
      options.add(next);
    }
  };

  return (
    <div className="builder-option">
      <input
        className="input"
        aria-label="Enum option"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(option);
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="icon-btn icon-btn-danger"
        onClick={() => options.delete(option)}
        aria-label={`Remove enum option ${option}`}
        title={`Remove enum option ${option}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function PropertyEditor({
  property,
  properties,
  index,
  onMove,
  onRename,
  onDisplayTypeChange,
  onDelete,
}: {
  property: PropertyDef;
  properties: PropertyDef[];
  index: number;
  onMove: (from: number, offset: -1 | 1) => void;
  onRename: (next: string) => void;
  onDisplayTypeChange: () => void;
  onDelete: () => void;
}) {
  const { schemas } = useSchemas();
  const [nameDraft, setNameDraft] = useState(property.name);
  const [nameError, setNameError] = useState("");

  useEffect(() => setNameDraft(property.name), [property.name]);

  const commitName = () => {
    const next = nameDraft.trim();
    if (!next) {
      setNameError("Property names cannot be empty.");
      setNameDraft(property.name);
      return;
    }
    if (
      next !== property.name &&
      properties.some((candidate) => candidate.name === next)
    ) {
      setNameError("Property names must be unique within a schema.");
      setNameDraft(property.name);
      return;
    }
    setNameError("");
    onRename(next);
  };

  const addOption = () => {
    const options = property.enumOptions ?? new Set<string>();
    let suffix = options.size + 1;
    let option = `Option ${suffix}`;
    while (options.has(option)) option = `Option ${++suffix}`;
    if (property.enumOptions) options.add(option);
    else property.enumOptions = new Set([option]);
  };

  return (
    <article className="builder-card builder-card-column">
      <div className="builder-property-header">
        <p className="label-accent">Property {index + 1}</p>
        <div className="builder-actions">
          <button
            type="button"
            className="secondary-btn"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label={`Move ${property.name} up`}
          >
            ↑
          </button>
          <button
            type="button"
            className="secondary-btn"
            disabled={index === properties.length - 1}
            onClick={() => onMove(index, 1)}
            aria-label={`Move ${property.name} down`}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onDelete}
            aria-label={`Remove property ${property.name}`}
            title={`Remove property ${property.name}`}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      <div className="builder-grid">
        <div className="field-group">
          <label className="field-label" htmlFor={`${property["@id"]}-name`}>
            Name
          </label>
          <input
            id={`${property["@id"]}-name`}
            className="input"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          {nameError && <small className="danger-text">{nameError}</small>}
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${property["@id"]}-type`}>
            Data type
          </label>
          <select
            id={`${property["@id"]}-type`}
            className="select"
            value={property.dataType}
            onChange={(event) => {
              const next = event.target.value as PropertyDef["dataType"];
              property.dataType = next;
              if (next === "did:ng:z:reference") {
                property.referenceSchemaId ??= schemas[0]?.["@id"];
              } else {
                delete property.referenceSchemaId;
              }
              onDisplayTypeChange();
            }}
          >
            {DATA_TYPES.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label
            className="field-label"
            htmlFor={`${property["@id"]}-cardinality`}
          >
            Cardinality
          </label>
          <select
            id={`${property["@id"]}-cardinality`}
            className="select"
            value={property.cardinality}
            onChange={(event) => {
              property.cardinality = event.target
                .value as PropertyDef["cardinality"];
              onDisplayTypeChange();
            }}
          >
            {CARDINALITIES.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {property.dataType === "did:ng:z:enum" && (
        <div className="field-group">
          <div className="builder-property-header">
            <span className="field-label">Enum options</span>
            <button type="button" className="secondary-btn" onClick={addOption}>
              + Add option
            </button>
          </div>
          {property.enumOptions?.size ? (
            <div className="builder-options">
              {[...property.enumOptions].map((option) => (
                <EnumOption
                  key={option}
                  option={option}
                  options={property.enumOptions!}
                />
              ))}
            </div>
          ) : (
            <p className="muted">No options configured.</p>
          )}
        </div>
      )}
      {property.dataType === "did:ng:z:reference" && (
        <div className="field-group">
          <label className="field-label" htmlFor={`${property["@id"]}-reference-schema`}>
            Referenced schema
          </label>
          <select
            id={`${property["@id"]}-reference-schema`}
            className="select"
            value={property.referenceSchemaId ?? ""}
            onChange={(event) => (property.referenceSchemaId = event.target.value)}
          >
            {schemas.length === 0 && <option value="">No schemas available</option>}
            {schemas.map((candidate) => (
              <option value={candidate["@id"]} key={candidate["@id"]}>
                {candidate.name}
              </option>
            ))}
          </select>
          <small className="helper-text">
            Stored values use the referenced record id; labels come from that schema's first text field.
          </small>
        </div>
      )}
    </article>
  );
}

export function SchemaEditorPage() {
  const { schemaId } = useParams({ from: "/settings/schemas/$schemaId" });
  const { schemas } = useSchemas();
  const { properties, createPropertyDef, deletePropertyDef } =
    usePropertyDefs(schemaId);
  const { blocks } = useBlocks();
  const { widgets, createWidget, deleteWidget } = useWidgets();
  const schema = schemas.find((candidate) => candidate["@id"] === schemaId);
  const [schemaNameDraft, setSchemaNameDraft] = useState("");

  useEffect(() => {
    setSchemaNameDraft(schema?.name ?? "");
  }, [schema?.name]);

  if (!schema) {
    return (
      <div className="page-content">
        <section className="panel">
          <h1 className="title">Schema not found</h1>
          <Link
            className="secondary-btn button-link"
            to="/settings/schemas"
          >
            Back to schemas
          </Link>
        </section>
      </div>
    );
  }

  const addProperty = () => {
    const usedNames = new Set(properties.map((property) => property.name));
    let suffix = properties.length + 1;
    let name = `field${suffix}`;
    while (usedNames.has(name)) name = `field${++suffix}`;
    createPropertyDef({ schemaId, name });
    for (const block of blocks) {
      if (block.schemaId === schemaId) {
        createWidget({
          parentBlockId: block["@id"],
          widgetType: "did:ng:z:field",
          label: name,
          propertyName: name,
          fieldType: "did:ng:z:text",
        });
      }
    }
  };

  const commitSchemaName = () => {
    const next = schemaNameDraft.trim();
    if (next) schema.name = next;
    else setSchemaNameDraft(schema.name);
  };

  const moveProperty = (from: number, offset: -1 | 1) => {
    const reordered = [...properties];
    const [property] = reordered.splice(from, 1);
    reordered.splice(from + offset, 0, property);
    reordered.forEach((item, index) => {
      item.order = index;
    });
  };

  const widgetsBoundTo = (propertyName: string) =>
    widgets.filter((widget) => {
      const block = blocks.find(
        (candidate) => candidate["@id"] === widget.parentBlockId,
      );
      return (
        block?.schemaId === schemaId &&
        widget.widgetType === "did:ng:z:field" &&
        widget.propertyName === propertyName
      );
    });

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>{schema.name || "Unnamed schema"}</h1>
        <p>Schema editor · Changes are stored immediately in the local graph.</p>
      </header>
      <section className="panel">
        <div className="field-group">
          <label className="field-label" htmlFor="schema-name">
            Schema name
          </label>
          <input
            id="schema-name"
            className="input"
            value={schemaNameDraft}
            onChange={(event) => setSchemaNameDraft(event.target.value)}
            onBlur={commitSchemaName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setSchemaNameDraft(schema.name);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      </section>
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="label-accent">Shape</p>
            <h2 className="title">Properties</h2>
          </div>
          <button type="button" className="primary-btn" onClick={addProperty}>
            + Add property
          </button>
        </header>
        <div className="cards-stack">
          {properties.length > 0 ? (
            properties.map((property, index) => (
              <PropertyEditor
                key={property["@id"]}
                property={property}
                properties={properties}
                index={index}
                onMove={moveProperty}
                onRename={(next) => {
                  for (const widget of widgetsBoundTo(property.name)) {
                    widget.propertyName = next;
                    if (!widget.label || widget.label === property.name) {
                      widget.label = next;
                    }
                  }
                  for (const block of blocks) {
                    if (block.schemaId !== schemaId) continue;
                    if (block.filterPropertyName === property.name) block.filterPropertyName = next;
                    if (block.sortPropertyName === property.name) block.sortPropertyName = next;
                  }
                  property.name = next;
                }}
                onDisplayTypeChange={() => {
                  for (const widget of widgetsBoundTo(property.name)) {
                    widget.fieldType = fieldTypeForProperty(property);
                  }
                }}
                onDelete={() => {
                  for (const widget of widgetsBoundTo(property.name)) {
                    deleteWidget(widget);
                  }
                  for (const block of blocks) {
                    if (block.schemaId !== schemaId) continue;
                    if (block.filterPropertyName === property.name) {
                      delete block.filterPropertyName;
                      delete block.filterValue;
                    }
                    if (block.sortPropertyName === property.name) delete block.sortPropertyName;
                  }
                  deletePropertyDef(property);
                }}
              />
            ))
          ) : (
            <p className="muted">This schema has no properties yet.</p>
          )}
        </div>
      </section>
      <Link
        className="secondary-btn button-link"
        to="/settings/schemas"
      >
        ← Back to schemas
      </Link>
    </div>
  );
}
