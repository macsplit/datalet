import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
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
import { displayDate } from "./FieldWidget";
import { DownloadIcon, PrinterIcon } from "./icons";
import { useSettings } from "../hooks/useSettings";
import { RuntimeCircuitNotice } from "./RuntimeSafety";
import { RUNTIME_LIMITS } from "../utils/runtimeHealth";
import {
  getLastUndoRecords,
  getUndoAppliedRevision,
  subscribeUndoApplied,
} from "../utils/localNgEngine";

function propertySignature(properties: PropertyDef[]): string {
  return properties
    .map((property) =>
      [
        property["@id"],
        property.name,
        property.order,
        property.dataType,
        property.cardinality,
        property.referenceSchemaId ?? "",
        [...(property.enumOptions ?? [])].sort().join(","),
      ].join("|"),
    )
    .join(";");
}

/**
 * Every value a property can hold, as display strings. A single stringifier
 * backs both the builder-configured filter and the reader's search box, so
 * "contains" means the same thing in both places.
 */
function valueStrings(raw: unknown): string[] {
  const values = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : [raw];
  return values.map((value) => String(value ?? ""));
}

/** `needle` must already be trimmed and lower-cased by the caller. */
function containsNeedle(raw: unknown, needle: string): boolean {
  return valueStrings(raw).some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

/** A safe, readable file-name stem for a downloaded export. */
function fileSlug(name: string): string {
  return name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "records";
}

/**
 * One record property as printed text. Reference fields print the stored
 * target id for the same reason search matches on it: resolving the label
 * needs the target schema's own subscription, which only the on-screen
 * reference control opens.
 */
function printableValue(
  raw: unknown,
  fieldType: string,
  formatCurrency: (value: number) => string,
): string {
  if (raw instanceof Set || Array.isArray(raw)) {
    return valueStrings(raw).filter(Boolean).join(", ");
  }
  if (fieldType === "did:ng:z:date" || fieldType === "did:ng:z:dateTime") {
    return raw ? displayDate(raw, fieldType === "did:ng:z:dateTime") : "";
  }
  if (fieldType === "did:ng:z:currency") {
    return formatCurrency(typeof raw === "number" ? raw : 0);
  }
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return raw === undefined || raw === null ? "" : String(raw);
}

function defaultValue(property: PropertyDef): string | number | boolean | Set<string> {
  if (property.cardinality === "did:ng:z:many") return new Set<string>();
  switch (property.dataType) {
    case "did:ng:z:number":
      return 0;
    case "did:ng:z:boolean":
      return false;
    case "did:ng:z:date":
      return "";
    case "did:ng:z:enum":
      return property.enumOptions?.values().next().value ?? "";
    case "did:ng:z:reference":
      return "";
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
  const { format } = useSettings();
  const signature = propertySignature(properties);
  const shapeType = useMemo(
    () => buildShapeType(schema, properties),
    // The signature deliberately captures mutable graph-backed properties.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema["@id"], signature],
  );
  const records = useShape(shapeType, privateNuri);
  const undoRevision = useSyncExternalStore(
    subscribeUndoApplied,
    getUndoAppliedRevision,
    getUndoAppliedRevision,
  );
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

  // Only properties actually rendered as fields are searchable, so a reader
  // never gets hits from data that is not on screen. A reference field matches
  // on its stored target id rather than the resolved label: resolving a label
  // needs the target schema's own subscription, which only ReferenceField
  // mounts, and opening a second subscription per data block to search it
  // would cost more than the feature is worth.
  const searchableNames = widgets
    .filter(
      (widget) =>
        widget.widgetType === "did:ng:z:field" &&
        widget.propertyName &&
        properties.some((property) => property.name === widget.propertyName),
    )
    .map((widget) => widget.propertyName as string);
  // JSON-encoded so the memo below has a stable primitive dependency;
  // `widgets` is a graph-backed array that is a fresh value on every render.
  const searchableKey = JSON.stringify(searchableNames);
  const searchable = useMemo(() => JSON.parse(searchableKey) as string[], [searchableKey]);

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const searchEnabled = block.searchEnabled === true && searchableNames.length > 0;
  const needle = searchEnabled ? query.trim().toLocaleLowerCase() : "";
  const filterNeedle = (block.filterValue ?? "").trim().toLocaleLowerCase();
  const filterProperty = block.filterPropertyName ?? "";
  const sortProperty = block.sortPropertyName || "@id";
  const direction = block.sortDirection === "did:ng:z:descending" ? -1 : 1;
  const pageSize = Math.max(0, Math.trunc(block.pageSize ?? 0));

  // useShape hands back a new proxy identity whenever anything in the set
  // changes (its deepSignal is created with replaceProxiesInBranchOnChange),
  // so depending on `records` recomputes exactly when the data moves and not
  // on unrelated re-renders of this block's ancestors.
  const visibleRecords = useMemo(() => {
    const matching = [...records].filter((record) => {
      if (filterProperty && filterNeedle && !containsNeedle(record[filterProperty], filterNeedle)) {
        return false;
      }
      if (!needle) return true;
      return searchable.some((name) => containsNeedle(record[name], needle));
    });
    return matching.sort((left, right) => {
      const a = left[sortProperty];
      const b = right[sortProperty];
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      if (typeof a === "boolean" && typeof b === "boolean") return (Number(a) - Number(b)) * direction;
      return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true }) * direction;
    });
  }, [records, filterProperty, filterNeedle, needle, searchable, sortProperty, direction]);

  const total = visibleRecords.length;
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  // Any change to what is being listed sends the reader back to the first
  // page; landing on page 4 of a 2-page result is the classic paging bug.
  // Adjusting state during render is React's own pattern for this and avoids
  // the extra commit an effect would cost.
  const resetKey = JSON.stringify([
    filterProperty,
    filterNeedle,
    needle,
    sortProperty,
    direction,
    pageSize,
  ]);
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setPage(0);
  }

  // Deleting the last record on the final page shrinks pageCount without any
  // of the above changing, so the page index is clamped rather than trusted.
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = pageSize > 0 ? currentPage * pageSize : 0;
  const pageRecords =
    pageSize > 0 ? visibleRecords.slice(pageStart, pageStart + pageSize) : visibleRecords;

  const heading = titleWidget?.label || block.title || schema.name;
  // Both utilities act on everything the reader is currently looking at --
  // every page of the filtered and searched result, not just the page on
  // screen. Paging is a screen constraint, not a selection.
  const exportRecords = () => {
    const rows = visibleRecords.map((record) => {
      const row: Record<string, unknown> = { "@id": record["@id"] };
      for (const property of properties) {
        const raw = record[property.name];
        row[property.name] = raw instanceof Set ? [...raw] : raw;
      }
      return row;
    });
    // Every schema property, not only the displayed ones: a file called an
    // export that silently dropped stored fields would be a data-loss trap.
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileSlug(schema.name)}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same tick can cancel the download that was just started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const printColumns = widgets
    .filter(
      (widget) =>
        widget.widgetType === "did:ng:z:field" &&
        widget.propertyName &&
        properties.some((property) => property.name === widget.propertyName),
    )
    .map((widget) => ({
      name: widget.propertyName as string,
      label: widget.label || (widget.propertyName as string),
      fieldType: widget.fieldType ?? "did:ng:z:text",
    }));

  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    // The sheet has to be in the DOM before the dialog opens, so the print
    // call waits for this commit rather than running in the click handler.
    const finish = () => setPrinting(false);
    window.addEventListener("afterprint", finish);
    window.print();
    return () => window.removeEventListener("afterprint", finish);
  }, [printing]);

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="label-accent">{schema.name}</p>
          {(titleWidget || block.title) && <h2 className="title">{heading}</h2>}
        </div>
        <div className="panel-header-actions">
          {addWidget && (
            <button type="button" className="primary-btn" onClick={createRecord}>
              + {addWidget.label || `Add ${schema.name}`}
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-quiet"
            aria-label={`Export ${schema.name} as JSON`}
            title={`Export ${schema.name} as JSON`}
            onClick={exportRecords}
          >
            <DownloadIcon />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-quiet"
            aria-label={`Print ${schema.name}`}
            title={`Print ${schema.name}`}
            onClick={() => setPrinting(true)}
          >
            <PrinterIcon />
          </button>
        </div>
      </header>
      {searchEnabled && (
        <div className="field-group">
          <label className="field-label" htmlFor={`${block["@id"]}-search`}>
            Search {schema.name}
          </label>
          <input
            id={`${block["@id"]}-search`}
            className="input"
            type="search"
            value={query}
            placeholder={`Search ${searchableNames.join(", ")}`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div className="cards-stack">
        {pageRecords.length > 0 ? (
          pageRecords.map((record) => {
            const recordKey = `${record["@graph"]}|${record["@id"]}`;
            const restored = getLastUndoRecords()[recordKey];
            return (
              <RecordCard
                key={recordKey}
                record={record}
                widgets={widgets}
                properties={properties}
                onDelete={() => records.delete(record)}
                displayRecord={restored}
                displayRevision={restored ? undoRevision : undefined}
              />
            );
          })
        ) : (
          <p className="muted">
            {needle || (filterProperty && filterNeedle)
              ? "No records match."
              : "No records yet."}
          </p>
        )}
      </div>
      {pageSize > 0 && total > 0 && (
        <div className="block-pagination">
          <span className="muted">
            Showing {pageStart + 1}–{pageStart + pageRecords.length} of {total}
          </span>
          <div className="builder-actions">
            <button
              type="button"
              className="secondary-btn"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <span className="muted">
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              type="button"
              className="secondary-btn"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {printing && createPortal(
        // Mounted only while printing: outside .app-shell so the print
        // stylesheet can hide the whole application and leave just this
        // block's sheet, and never a second copy of every record sitting in
        // the document the rest of the time.
        <div className="print-sheet" aria-hidden="true">
          <h1>{heading}</h1>
          <p className="print-meta">
            {total} {total === 1 ? "record" : "records"}
            {needle ? ` matching “${query.trim()}”` : ""}
          </p>
          <table>
            <thead>
              <tr>
                {printColumns.map((column) => (
                  <th key={column.name}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((record) => (
                <tr key={`${record["@graph"]}|${record["@id"]}`}>
                  {printColumns.map((column) => (
                    <td key={column.name}>
                      {printableValue(record[column.name], column.fieldType, format)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
        document.body,
      )}
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
