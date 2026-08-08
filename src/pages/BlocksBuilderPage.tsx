import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type {
  Block,
  PropertyDef,
  SchemaDef,
  Widget,
} from "../shapes/orm/metaShapes.typings";
import {
  useBlocks,
  type BlockParent,
} from "../hooks/useBlocks";
import { usePropertyDefs } from "../hooks/usePropertyDefs";
import { useSchemas } from "../hooks/useSchemas";
import { HOME_TAB_ID, useTabs } from "../hooks/useTabs";
import { useWidgets } from "../hooks/useWidgets";
import { TrashIcon } from "../components/icons";
import { RuntimeCircuitNotice } from "../components/RuntimeSafety";
import { collectDescendantBlockIds } from "../utils/blockGraph";
import { reportRuntimeIssue, RUNTIME_LIMITS } from "../utils/runtimeHealth";

const WIDGET_TYPES: Array<{
  value: Widget["widgetType"];
  label: string;
}> = [
  { value: "did:ng:z:title", label: "Panel title" },
  { value: "did:ng:z:addButton", label: "Add button" },
  { value: "did:ng:z:editDeleteActions", label: "Edit/delete actions" },
  { value: "did:ng:z:field", label: "Field" },
];

const FIELD_TYPES: Array<{
  value: NonNullable<Widget["fieldType"]>;
  label: string;
}> = [
  { value: "did:ng:z:text", label: "Text" },
  { value: "did:ng:z:number", label: "Number" },
  { value: "did:ng:z:currency", label: "Currency" },
  { value: "did:ng:z:date", label: "Date" },
  { value: "did:ng:z:dateTime", label: "Date and time" },
  { value: "did:ng:z:dropdown", label: "Dropdown" },
  { value: "did:ng:z:multiSelect", label: "Multi-select" },
  { value: "did:ng:z:checkbox", label: "Checkbox" },
  { value: "did:ng:z:reference", label: "Record reference" },
];

function defaultFieldType(
  property?: PropertyDef,
): NonNullable<Widget["fieldType"]> {
  if (!property) return "did:ng:z:text";
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

function WidgetEditor({
  widget,
  widgets,
  properties,
  index,
  onMove,
  onDelete,
}: {
  widget: Widget;
  widgets: Widget[];
  properties: PropertyDef[];
  index: number;
  onMove: (from: number, offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const changeWidgetType = (next: Widget["widgetType"]) => {
    widget.widgetType = next;
    if (next === "did:ng:z:field") {
      const property = properties[0];
      if (property) {
        widget.label = property.name;
        widget.propertyName = property.name;
        widget.fieldType = defaultFieldType(property);
      }
    } else {
      delete widget.propertyName;
      delete widget.fieldType;
      if (next === "did:ng:z:title") widget.label = "Records";
      else if (next === "did:ng:z:addButton") widget.label = "Add record";
      else delete widget.label;
    }
  };

  return (
    <article className="builder-card builder-card-column builder-widget-card">
      <div className="builder-property-header">
        <p className="label-accent">Widget {index + 1}</p>
        <div className="builder-actions">
          <button
            type="button"
            className="secondary-btn"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label="Move widget up"
          >
            ↑
          </button>
          <button
            type="button"
            className="secondary-btn"
            disabled={index === widgets.length - 1}
            onClick={() => onMove(index, 1)}
            aria-label="Move widget down"
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onDelete}
            aria-label={`Remove widget ${widget.label || index + 1}`}
            title={`Remove widget ${widget.label || index + 1}`}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      <div className="builder-grid">
        <div className="field-group">
          <label className="field-label" htmlFor={`${widget["@id"]}-type`}>
            Widget type
          </label>
          <select
            id={`${widget["@id"]}-type`}
            className="select"
            value={widget.widgetType}
            onChange={(event) =>
              changeWidgetType(event.target.value as Widget["widgetType"])
            }
          >
            {WIDGET_TYPES.map((option) => {
              const alreadyUsed = widgets.some(
                (candidate) =>
                  candidate !== widget &&
                  candidate.widgetType === option.value &&
                  option.value !== "did:ng:z:field",
              );
              return (
                <option
                  value={option.value}
                  key={option.value}
                  disabled={alreadyUsed}
                >
                  {option.label}
                </option>
              );
            })}
          </select>
        </div>
        {widget.widgetType !== "did:ng:z:editDeleteActions" && (
          <div className="field-group">
            <label className="field-label" htmlFor={`${widget["@id"]}-label`}>
              Label
            </label>
            <input
              id={`${widget["@id"]}-label`}
              className="input"
              value={widget.label ?? ""}
              placeholder="Use the default label"
              onChange={(event) => (widget.label = event.target.value)}
            />
          </div>
        )}
        {widget.widgetType === "did:ng:z:field" && (
          <>
            <div className="field-group">
              <label
                className="field-label"
                htmlFor={`${widget["@id"]}-property`}
              >
                Schema property
              </label>
              <select
                id={`${widget["@id"]}-property`}
                className="select"
                value={widget.propertyName ?? ""}
                onChange={(event) => {
                  const previousName = widget.propertyName;
                  const property = properties.find(
                    (candidate) => candidate.name === event.target.value,
                  );
                  if (!widget.label || widget.label === previousName) {
                    widget.label = event.target.value;
                  }
                  widget.propertyName = event.target.value;
                  widget.fieldType = defaultFieldType(property);
                }}
              >
                {properties.length === 0 && <option value="">No properties</option>}
                {properties.map((property) => (
                  <option value={property.name} key={property["@id"]}>
                    {property.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label
                className="field-label"
                htmlFor={`${widget["@id"]}-field-type`}
              >
                Field display
              </label>
              <select
                id={`${widget["@id"]}-field-type`}
                className="select"
                value={widget.fieldType ?? "did:ng:z:text"}
                onChange={(event) => {
                  widget.fieldType = event.target
                    .value as NonNullable<Widget["fieldType"]>;
                }}
              >
                {FIELD_TYPES.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function WidgetsEditor({ block }: { block: Block }) {
  const { properties: allProperties } = usePropertyDefs();
  const properties = block.schemaId
    ? allProperties.filter((property) => property.schemaId === block.schemaId)
    : [];
  const { widgets, createWidget, deleteWidget } = useWidgets(block["@id"]);
  const [widgetType, setWidgetType] = useState<Widget["widgetType"]>(
    "did:ng:z:title",
  );

  const isSingletonAlreadyUsed =
    widgetType !== "did:ng:z:field" &&
    widgets.some((widget) => widget.widgetType === widgetType);
  const canAdd =
    !isSingletonAlreadyUsed &&
    (widgetType !== "did:ng:z:field" || properties.length > 0);
  const representedProperties = new Set(
    widgets
      .filter((widget) => widget.widgetType === "did:ng:z:field")
      .map((widget) => widget.propertyName),
  );
  const missingProperties = properties.filter(
    (property) => !representedProperties.has(property.name),
  );

  const addWidget = () => {
    if (!canAdd) return;
    const property = widgetType === "did:ng:z:field" ? properties[0] : undefined;
    createWidget({
      parentBlockId: block["@id"],
      widgetType,
      ...(widgetType === "did:ng:z:title" && { label: block.title || "Records" }),
      ...(widgetType === "did:ng:z:addButton" && { label: "Add record" }),
      ...(property && {
        label: property.name,
        propertyName: property.name,
        fieldType: defaultFieldType(property),
      }),
    });
  };

  const moveWidget = (from: number, offset: -1 | 1) => {
    const reordered = [...widgets];
    const [widget] = reordered.splice(from, 1);
    reordered.splice(from + offset, 0, widget);
    reordered.forEach((item, index) => {
      item.order = index;
    });
  };

  const addMissingFields = () => {
    for (const property of missingProperties) {
      createWidget({
        parentBlockId: block["@id"],
        widgetType: "did:ng:z:field",
        label: property.name,
        propertyName: property.name,
        fieldType: defaultFieldType(property),
      });
    }
  };

  return (
    <div className="builder-subsection">
      <div className="builder-property-header">
        <div>
          <p className="label-accent">Renderer</p>
          <h4 className="title">Widgets</h4>
        </div>
        <div className="builder-actions">
          {missingProperties.length > 0 && (
            <button
              type="button"
              className="primary-btn"
              onClick={addMissingFields}
            >
              + Add missing fields
            </button>
          )}
          <select
            className="select builder-compact-select"
            aria-label="New widget type"
            value={widgetType}
            onChange={(event) =>
              setWidgetType(event.target.value as Widget["widgetType"])
            }
          >
            {WIDGET_TYPES.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-btn"
            disabled={!canAdd}
            onClick={addWidget}
          >
            + Add widget
          </button>
        </div>
      </div>
      {isSingletonAlreadyUsed && (
        <small className="helper-text">That widget type is already present.</small>
      )}
      {widgetType === "did:ng:z:field" && properties.length === 0 && (
        <small className="helper-text">
          Add a property to this schema before adding a field widget.
        </small>
      )}
      <div className="cards-stack">
        {widgets.length > 0 ? (
          widgets.map((widget, index) => (
            <WidgetEditor
              key={widget["@id"]}
              widget={widget}
              widgets={widgets}
              properties={properties}
              index={index}
              onMove={moveWidget}
              onDelete={() => deleteWidget(widget)}
            />
          ))
        ) : (
          <p className="muted">No widgets configured.</p>
        )}
      </div>
    </div>
  );
}

function DataBlockEditor({
  block,
  schemas,
  index,
  siblingCount,
  onMove,
  onDelete,
}: BlockEditorProps) {
  const { properties: allProperties } = usePropertyDefs();
  const { widgets, deleteWidget } = useWidgets(block["@id"]);
  const properties = block.schemaId
    ? allProperties.filter((property) => property.schemaId === block.schemaId)
    : [];
  // Mirrors the renderer's searchable-property rule: search reaches exactly
  // the fields on screen, so with no bound field widget there is nothing for a
  // search box to match and the renderer omits it.
  const hasFieldWidget = widgets.some(
    (widget) =>
      widget.widgetType === "did:ng:z:field" &&
      widget.propertyName &&
      properties.some((property) => property.name === widget.propertyName),
  );

  const changeSchema = (schemaId: string) => {
    block.schemaId = schemaId;
    const nextProperties = allProperties.filter(
      (property) => property.schemaId === schemaId,
    );
    const nextNames = new Set(nextProperties.map((property) => property.name));
    if (block.filterPropertyName && !nextNames.has(block.filterPropertyName)) {
      delete block.filterPropertyName;
      delete block.filterValue;
    }
    if (block.sortPropertyName && !nextNames.has(block.sortPropertyName)) {
      delete block.sortPropertyName;
    }
    for (const widget of widgets) {
      if (
        widget.widgetType === "did:ng:z:field" &&
        (!widget.propertyName || !nextNames.has(widget.propertyName))
      ) {
        const replacement = nextProperties[0];
        if (replacement) {
          if (!widget.label || widget.label === widget.propertyName) {
            widget.label = replacement.name;
          }
          widget.propertyName = replacement.name;
          widget.fieldType = defaultFieldType(replacement);
        } else {
          deleteWidget(widget);
        }
      }
    }
  };

  return (
    <article className="builder-card builder-card-column">
      <BlockHeader
        label="Data block"
        block={block}
        index={index}
        siblingCount={siblingCount}
        onMove={onMove}
        onDelete={onDelete}
      />
      <div className="builder-grid">
        <BlockTitleInput block={block} />
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-schema`}>
            Schema
          </label>
          <select
            id={`${block["@id"]}-schema`}
            className="select"
            value={block.schemaId ?? ""}
            onChange={(event) => changeSchema(event.target.value)}
          >
            {schemas.length === 0 && <option value="">No schemas available</option>}
            {schemas.map((schema) => (
              <option value={schema["@id"]} key={schema["@id"]}>
                {schema.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-filter-property`}>
            Filter property
          </label>
          <select
            id={`${block["@id"]}-filter-property`}
            className="select"
            value={block.filterPropertyName ?? ""}
            onChange={(event) => {
              if (event.target.value) block.filterPropertyName = event.target.value;
              else {
                delete block.filterPropertyName;
                delete block.filterValue;
              }
            }}
          >
            <option value="">No filter</option>
            {properties.map((property) => (
              <option value={property.name} key={property["@id"]}>{property.name}</option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-filter-value`}>
            Filter contains
          </label>
          <input
            id={`${block["@id"]}-filter-value`}
            className="input"
            value={block.filterValue ?? ""}
            disabled={!block.filterPropertyName}
            placeholder="Case-insensitive text"
            onChange={(event) => (block.filterValue = event.target.value)}
          />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-sort-property`}>
            Sort property
          </label>
          <select
            id={`${block["@id"]}-sort-property`}
            className="select"
            value={block.sortPropertyName ?? ""}
            onChange={(event) => {
              if (event.target.value) block.sortPropertyName = event.target.value;
              else delete block.sortPropertyName;
            }}
          >
            <option value="">Record id</option>
            {properties.map((property) => (
              <option value={property.name} key={property["@id"]}>{property.name}</option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-sort-direction`}>
            Sort direction
          </label>
          <select
            id={`${block["@id"]}-sort-direction`}
            className="select"
            value={block.sortDirection ?? "did:ng:z:ascending"}
            onChange={(event) => {
              block.sortDirection = event.target.value as NonNullable<Block["sortDirection"]>;
            }}
          >
            <option value="did:ng:z:ascending">Ascending</option>
            <option value="did:ng:z:descending">Descending</option>
          </select>
        </div>
        <div className="field-group">
          <span className="field-label">Reader search</span>
          <label className="option-card" htmlFor={`${block["@id"]}-search-enabled`}>
            <input
              id={`${block["@id"]}-search-enabled`}
              type="checkbox"
              className="checkbox"
              checked={block.searchEnabled === true}
              onChange={(event) => {
                if (event.target.checked) block.searchEnabled = true;
                else delete block.searchEnabled;
              }}
            />
            <span className="option-text">Show a search box</span>
          </label>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-page-size`}>
            Records per page
          </label>
          <input
            id={`${block["@id"]}-page-size`}
            className="input"
            type="number"
            min={1}
            value={block.pageSize ?? ""}
            placeholder="All records"
            onChange={(event) => {
              const next = Math.trunc(Number(event.target.value));
              if (Number.isFinite(next) && next > 0) block.pageSize = next;
              else delete block.pageSize;
            }}
          />
        </div>
      </div>
      {block.searchEnabled === true && !hasFieldWidget && (
        <small className="helper-text">
          Search covers field widgets only. Add a field widget for the search box
          to appear.
        </small>
      )}
      <WidgetsEditor block={block} />
    </article>
  );
}

function LayoutBlockEditor({
  block,
  schemas,
  index,
  siblingCount,
  onMove,
  onDelete,
  onDeleteCascade,
  ancestry,
  depth,
}: BlockEditorProps) {
  return (
    <article className="builder-card builder-card-column">
      <BlockHeader
        label="Layout block"
        block={block}
        index={index}
        siblingCount={siblingCount}
        onMove={onMove}
        onDelete={onDelete}
      />
      <div className="builder-grid">
        <BlockTitleInput block={block} />
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-layout`}>
            Layout mode
          </label>
          <select
            id={`${block["@id"]}-layout`}
            className="select"
            value={block.layoutMode ?? "did:ng:z:stack"}
            onChange={(event) => {
              block.layoutMode = event.target.value as NonNullable<
                Block["layoutMode"]
              >;
            }}
          >
            <option value="did:ng:z:stack">Stack</option>
            <option value="did:ng:z:row">Row</option>
            <option value="did:ng:z:grid">Grid</option>
          </select>
        </div>
      </div>
      <div className="builder-nested">
        <BlockListEditor
          parent={{ parentBlockId: block["@id"] }}
          schemas={schemas}
          onDeleteCascade={onDeleteCascade}
          ancestry={new Set([...ancestry, block["@id"]])}
          depth={depth + 1}
        />
      </div>
    </article>
  );
}

function BlockTitleInput({ block }: { block: Block }) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor={`${block["@id"]}-title`}>
        Optional title
      </label>
      <input
        id={`${block["@id"]}-title`}
        className="input"
        value={block.title ?? ""}
        placeholder="No heading"
        onChange={(event) => (block.title = event.target.value)}
      />
    </div>
  );
}

function BlockHeader({
  label,
  block,
  index,
  siblingCount,
  onMove,
  onDelete,
}: {
  label: string;
  block: Block;
  index: number;
  siblingCount: number;
  onMove: (from: number, offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <div className="builder-property-header">
      <p className="label-accent">{label}</p>
      <div className="builder-actions">
        <button
          type="button"
          className="secondary-btn"
          disabled={index === 0}
          onClick={() => onMove(index, -1)}
          aria-label={`Move ${block.title || label} up`}
        >
          ↑
        </button>
        <button
          type="button"
          className="secondary-btn"
          disabled={index === siblingCount - 1}
          onClick={() => onMove(index, 1)}
          aria-label={`Move ${block.title || label} down`}
        >
          ↓
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          onClick={onDelete}
          aria-label={`Delete ${block.title || label}`}
          title={`Delete ${block.title || label}`}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

type BlockEditorProps = {
  block: Block;
  schemas: SchemaDef[];
  index: number;
  siblingCount: number;
  onMove: (from: number, offset: -1 | 1) => void;
  onDelete: () => void;
  onDeleteCascade: (block: Block) => void;
  ancestry: ReadonlySet<string>;
  depth: number;
};

function BlockEditor(props: BlockEditorProps) {
  if (props.ancestry.has(props.block["@id"])) {
    return <RuntimeCircuitNotice message={`A circular block reference at “${props.block.title || props.block["@id"]}” was not opened in the editor.`} />;
  }
  if (props.depth >= RUNTIME_LIMITS.blockDepth) {
    return <RuntimeCircuitNotice message={`Block nesting exceeded ${RUNTIME_LIMITS.blockDepth} levels and was not opened further.`} />;
  }
  return props.block.blockType === "did:ng:z:layout" ? (
    <LayoutBlockEditor {...props} />
  ) : (
    <DataBlockEditor {...props} />
  );
}

function BlockListEditor({
  parent,
  schemas,
  onDeleteCascade,
  ancestry = new Set<string>(),
  depth = 0,
}: {
  parent: BlockParent;
  schemas: SchemaDef[];
  onDeleteCascade: (block: Block) => void;
  ancestry?: ReadonlySet<string>;
  depth?: number;
}) {
  const { blocks, createBlock } = useBlocks(parent);
  const { properties: allProperties } = usePropertyDefs();
  const { createWidget } = useWidgets();
  const [newType, setNewType] = useState<"layout" | "data">("layout");
  const [schemaId, setSchemaId] = useState(schemas[0]?.["@id"] ?? "");
  const schemaIds = schemas.map((schema) => schema["@id"]).join("|");

  useEffect(() => {
    if (!schemas.some((schema) => schema["@id"] === schemaId)) {
      setSchemaId(schemas[0]?.["@id"] ?? "");
    }
  }, [schemaId, schemaIds]);

  const addBlock = () => {
    if (newType === "data") {
      if (!schemaId) return;
      const schema = schemas.find((candidate) => candidate["@id"] === schemaId);
      const blockId = createBlock({
        ...parent,
        blockType: "did:ng:z:data",
        schemaId,
        title: schema?.name,
      });
      if (!blockId) return;
      createWidget({
        parentBlockId: blockId,
        widgetType: "did:ng:z:title",
        label: schema?.name || "Records",
      });
      createWidget({
        parentBlockId: blockId,
        widgetType: "did:ng:z:addButton",
        label: `Add ${schema?.name || "record"}`,
      });
      createWidget({
        parentBlockId: blockId,
        widgetType: "did:ng:z:editDeleteActions",
      });
      for (const property of allProperties.filter(
        (candidate) => candidate.schemaId === schemaId,
      )) {
        createWidget({
          parentBlockId: blockId,
          widgetType: "did:ng:z:field",
          label: property.name,
          propertyName: property.name,
          fieldType: defaultFieldType(property),
        });
      }
    } else {
      createBlock({
        ...parent,
        blockType: "did:ng:z:layout",
        layoutMode: "did:ng:z:stack",
        title: "New layout",
      });
    }
  };

  const moveBlock = (from: number, offset: -1 | 1) => {
    const reordered = [...blocks];
    const [block] = reordered.splice(from, 1);
    reordered.splice(from + offset, 0, block);
    reordered.forEach((item, index) => {
      item.order = index;
    });
  };

  return (
    <div className="builder-block-list">
      <div className="builder-property-header">
        <div>
          <p className="label-accent">Structure</p>
          <h3 className="title">Blocks</h3>
        </div>
        <div className="builder-actions">
          <select
            className="select builder-compact-select"
            aria-label="New block type"
            value={newType}
            onChange={(event) =>
              setNewType(event.target.value as "layout" | "data")
            }
          >
            <option value="layout">Layout block</option>
            <option value="data">Data block</option>
          </select>
          {newType === "data" && (
            <select
              className="select builder-compact-select"
              aria-label="Data block schema"
              value={schemaId}
              onChange={(event) => setSchemaId(event.target.value)}
            >
              {schemas.length === 0 && <option value="">No schemas</option>}
              {schemas.map((schema) => (
                <option value={schema["@id"]} key={schema["@id"]}>
                  {schema.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="primary-btn"
            disabled={newType === "data" && !schemaId}
            onClick={addBlock}
          >
            + Add block
          </button>
        </div>
      </div>
      <div className="cards-stack">
        {blocks.length > 0 ? (
          blocks.map((block, index) => (
            <BlockEditor
              key={block["@id"]}
              block={block}
              schemas={schemas}
              index={index}
              siblingCount={blocks.length}
              onMove={moveBlock}
              onDelete={() => onDeleteCascade(block)}
              onDeleteCascade={onDeleteCascade}
              ancestry={ancestry}
              depth={depth}
            />
          ))
        ) : (
          <p className="muted">No blocks at this level.</p>
        )}
      </div>
    </div>
  );
}

export function BlocksBuilderPage() {
  const { tabId } = useParams({ from: "/settings/tabs/$tabId/blocks" });
  const { tabs } = useTabs();
  const { schemas } = useSchemas();
  const { blocks: allBlocks, deleteBlock } = useBlocks();
  const { widgets: allWidgets, deleteWidget } = useWidgets();
  const tab = tabs.find((candidate) => candidate["@id"] === tabId);

  const deleteCascade = (rootBlock: Block) => {
    if (
      !window.confirm(
        `Delete “${rootBlock.title || "this block"}” and its contents?`,
      )
    ) {
      return;
    }
    let ids: Set<string>;
    try {
      ids = collectDescendantBlockIds(allBlocks, [rootBlock["@id"]]);
    } catch (error) {
      reportRuntimeIssue(error, "Block deletion was stopped");
      return;
    }
    for (const widget of allWidgets) {
      if (ids.has(widget.parentBlockId)) deleteWidget(widget);
    }
    for (const block of allBlocks) {
      if (ids.has(block["@id"])) deleteBlock(block);
    }
  };

  if (!tab) {
    return (
      <div className="page-content">
        <section className="panel">
          <h1 className="title">Tab not found</h1>
          <Link className="secondary-btn button-link" to="/settings/tabs">
            Back to tabs
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>{tab.title}</h1>
        <p>Arrange layout and data blocks, then choose how records are rendered.</p>
      </header>
      <section className="panel">
        <BlockListEditor
          parent={{ parentTabId: tabId }}
          schemas={schemas}
          onDeleteCascade={deleteCascade}
        />
      </section>
      <div className="builder-footer-links">
        <Link className="secondary-btn button-link" to="/settings/tabs">
          ← Back to tabs
        </Link>
        {tabId === HOME_TAB_ID ? (
          <Link className="primary-btn button-link" to="/">
            View tab →
          </Link>
        ) : (
          <Link
            className="primary-btn button-link"
            to="/tab/$tabId"
            params={{ tabId }}
          >
            View tab →
          </Link>
        )}
      </div>
    </div>
  );
}
