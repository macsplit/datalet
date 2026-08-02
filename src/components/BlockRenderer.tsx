import { useMemo } from "react";
import { useShape } from "@ng-org/orm/react";
import type {
  Block,
  PropertyDef,
  SchemaDef,
  Widget,
} from "../shapes/orm/metaShapes.typings";
import { useBlocks } from "../hooks/useBlocks";
import { usePropertyDefs } from "../hooks/usePropertyDefs";
import { useSchemas } from "../hooks/useSchemas";
import { useWidgets } from "../hooks/useWidgets";
import { useMetaStore } from "../hooks/MetaStoreContext";
import {
  buildShapeType,
  dynamicTypeIri,
  type DynamicRecord,
} from "../utils/dynamicSchema";
import { RecordCard } from "./RecordCard";
import { RuntimeCircuitNotice } from "./RuntimeSafety";
import { RUNTIME_LIMITS } from "../utils/runtimeHealth";

function propertySignature(properties: PropertyDef[]): string {
  return properties
    .map((property) =>
      [
        property["@id"],
        property.name,
        property.order,
        property.dataType,
        property.cardinality,
        [...(property.enumOptions ?? [])].sort().join(","),
      ].join("|"),
    )
    .join(";");
}

function defaultValue(property: PropertyDef): string | number | boolean | Set<string> {
  if (property.cardinality === "did:ng:z:many") return new Set<string>();
  switch (property.dataType) {
    case "did:ng:z:number":
      return 0;
    case "did:ng:z:boolean":
      return false;
    case "did:ng:z:enum":
      return property.enumOptions?.values().next().value ?? "";
    default:
      return "";
  }
}

function ResolvedDataBlock({
  block,
  schema,
  properties,
  widgets,
}: {
  block: Block;
  schema: SchemaDef;
  properties: PropertyDef[];
  widgets: Widget[];
}) {
  const { privateNuri } = useMetaStore();
  const signature = propertySignature(properties);
  const shapeType = useMemo(
    () => buildShapeType(schema, properties),
    // The signature deliberately captures mutable graph-backed properties.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema["@id"], signature],
  );
  const records = useShape(shapeType, privateNuri);
  const titleWidget = widgets.find(
    (widget) => widget.widgetType === "did:ng:z:title",
  );
  const addWidget = widgets.find(
    (widget) => widget.widgetType === "did:ng:z:addButton",
  );

  const createRecord = () => {
    if (!privateNuri) return;
    const record: DynamicRecord = {
      "@graph": privateNuri,
      "@id": "",
      "@type": dynamicTypeIri(schema),
    };
    for (const property of properties) {
      record[property.name] = defaultValue(property);
    }
    records.add(record);
  };

  const sortedRecords = [...records].sort((a, b) =>
    a["@id"].localeCompare(b["@id"]),
  );

  return (
    <section className="panel">
      {(titleWidget || addWidget || block.title) && (
        <header className="panel-header">
          <div>
            <p className="label-accent">{schema.name}</p>
            {(titleWidget || block.title) && (
              <h2 className="title">
                {titleWidget?.label || block.title || schema.name}
              </h2>
            )}
          </div>
          {addWidget && (
            <button type="button" className="primary-btn" onClick={createRecord}>
              + {addWidget.label || `Add ${schema.name}`}
            </button>
          )}
        </header>
      )}
      <div className="cards-stack">
        {sortedRecords.length > 0 ? (
          sortedRecords.map((record) => (
            <RecordCard
              key={`${record["@graph"]}|${record["@id"]}`}
              record={record}
              widgets={widgets}
              properties={properties}
              onDelete={() => records.delete(record)}
            />
          ))
        ) : (
          <p className="muted">No records yet.</p>
        )}
      </div>
    </section>
  );
}

function DataBlock({ block }: { block: Block }) {
  const { schemas } = useSchemas();
  const { properties: allProperties } = usePropertyDefs();
  const { widgets } = useWidgets(block["@id"]);
  const schema = schemas.find((candidate) => candidate["@id"] === block.schemaId);
  const properties = schema
    ? allProperties.filter((property) => property.schemaId === schema["@id"])
    : [];

  if (!block.schemaId) {
    return <p className="muted">This data block has no schema configured.</p>;
  }
  if (!schema) {
    return <p className="muted">The schema for this data block was not found.</p>;
  }
  return (
    <ResolvedDataBlock
      block={block}
      schema={schema}
      properties={properties}
      widgets={widgets}
    />
  );
}

function LayoutBlock({
  block,
  ancestry,
  depth,
}: {
  block: Block;
  ancestry: ReadonlySet<string>;
  depth: number;
}) {
  const { blocks } = useBlocks({ parentBlockId: block["@id"] });
  const mode = block.layoutMode ?? "did:ng:z:stack";
  const className =
    mode === "did:ng:z:row"
      ? "layout-row"
      : mode === "did:ng:z:grid"
        ? "cards-grid"
        : "section-stack";

  return (
    <section className="section-stack">
      {block.title && <h2 className="title">{block.title}</h2>}
      <div className={className}>
        {blocks.length > 0 ? (
          blocks.map((child) => (
            <BlockRenderer
              block={child}
              key={child["@id"]}
              ancestry={ancestry}
              depth={depth}
            />
          ))
        ) : (
          <p className="muted">This layout block is empty.</p>
        )}
      </div>
    </section>
  );
}

/** Render a graph-defined block, recursively for layout blocks. */
export function BlockRenderer({
  block,
  ancestry = new Set<string>(),
  depth = 0,
}: {
  block: Block;
  ancestry?: ReadonlySet<string>;
  depth?: number;
}) {
  if (ancestry.has(block["@id"])) {
    return <RuntimeCircuitNotice message={`A circular block reference at “${block.title || block["@id"]}” was not rendered.`} />;
  }
  if (depth >= RUNTIME_LIMITS.blockDepth) {
    return <RuntimeCircuitNotice message={`Block nesting exceeded ${RUNTIME_LIMITS.blockDepth} levels and was not rendered further.`} />;
  }

  const nextAncestry = new Set(ancestry);
  nextAncestry.add(block["@id"]);
  return block.blockType === "did:ng:z:layout" ? (
    <LayoutBlock block={block} ancestry={nextAncestry} depth={depth + 1} />
  ) : (
    <DataBlock block={block} />
  );
}
