/**
 * DSL2 -> actual import data: builds the SchemaDef/PropertyDef/Tab/Block/
 * Widget records and the data instances themselves, and wraps them in the
 * app's existing, documented backup file format (`LocalGraphBackup`, see
 * src/utils/localNgEngine.ts's own doc comments on `exportGraphBackup` /
 * `importGraphBackup` / `snapshotPatches`).
 *
 * Deliberately independent of the app's source: this file re-derives the
 * small, explicitly-documented pieces it needs (the id-minting convention,
 * the record shapes, the hash algorithm) from those doc comments rather than
 * importing the app's own modules, so this tool never depends on internals
 * that were never meant to be reused outside the browser bundle. If the
 * documented file format ever changes, this needs an update to match it -
 * same as any other independent producer of that format would.
 */

import { createHash, randomUUID } from "node:crypto";
import { SYNTHETIC_PARENT_FIELD } from "./normalize";
import type { FieldCardinality, FieldDataType, FieldWidgetType, InferredEntity, InferredModel, JsonValue } from "./types";

const GRAPH_PLACEHOLDER = "did:ng:z:import-placeholder";
const USER_TYPE_PREFIX = "did:ng:z:user:";
const SETTINGS_ID = "did:ng:z:SettingsSingleton";

/** Display-only: SchemaDef.name and Tab.title get this treatment so the UI
 * reads "Checkins" rather than the raw JSON key "checkins". Every internal
 * binding (schema ids, PropertyDef.name, Widget.propertyName, entity-name
 * lookups) keeps using the raw entity/field name - only these two
 * user-facing labels are prettified. */
export function titleCase(name: string): string {
  const words = name
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

type OrmRecord = { "@graph": string; "@id": string; "@type": string } & Record<string, unknown>;

export interface BuildResult {
  backup: Record<string, unknown>;
  byteLength: number;
  entityCount: number;
  recordCount: number;
}

function mintId(graph: string): string {
  return `${graph}:q:${randomUUID()}`;
}

const DATA_TYPE_IRI: Record<FieldDataType, string> = {
  text: "did:ng:z:text",
  number: "did:ng:z:number",
  boolean: "did:ng:z:boolean",
  date: "did:ng:z:date",
  enum: "did:ng:z:enum",
  reference: "did:ng:z:reference",
};

const FIELD_TYPE_IRI: Record<FieldWidgetType, string> = {
  text: "did:ng:z:text",
  longText: "did:ng:z:longText",
  markdown: "did:ng:z:markdown",
  url: "did:ng:z:url",
  email: "did:ng:z:email",
  number: "did:ng:z:number",
  currency: "did:ng:z:currency",
  date: "did:ng:z:date",
  dateTime: "did:ng:z:dateTime",
  dropdown: "did:ng:z:dropdown",
  multiSelect: "did:ng:z:multiSelect",
  checkbox: "did:ng:z:checkbox",
  reference: "did:ng:z:reference",
};

const CARDINALITY_IRI: Record<FieldCardinality, string> = {
  one: "did:ng:z:one",
  optional: "did:ng:z:optional",
  many: "did:ng:z:many",
};

/** Coerces a value that didn't match its field's inferred type (see infer.ts's
 * mixed-type warning) into something the field's declared dataType can still
 * hold, rather than losing it or crashing the whole import. */
function coerceToFieldShape(value: JsonValue, dataType: FieldDataType): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean") return typeof value === "boolean" ? value : Boolean(value);
  if (dataType === "number") return typeof value === "number" ? value : Number(value) || 0;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildFieldValue(raw: JsonValue | undefined, field: { dataType: FieldDataType; cardinality: FieldCardinality }): unknown {
  if (raw === undefined) return field.cardinality === "many" ? [] : null;
  if (field.cardinality === "many") {
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((v) => coerceToFieldShape(v, field.dataType));
  }
  const single = Array.isArray(raw) ? raw[0] : raw;
  return coerceToFieldShape(single ?? null, field.dataType);
}

/**
 * Picks a schema's `labelPropertyId` explicitly rather than leaving it to the
 * app's own automatic fallback (first text/enum property in declared order) -
 * that fallback treats "id" as just another eligible text field, and "id" is
 * usually declared first, so without this every reference in the app would
 * display as an opaque id instead of something a person can recognize.
 */
function chooseLabelField(entity: InferredEntity): string | undefined {
  const eligible = entity.fields.filter(
    (f) => !f.isSynthetic && f.name.toLowerCase() !== "id" && (f.dataType === "text" || f.dataType === "enum"),
  );
  if (eligible.length === 0) return undefined;

  const prose = eligible.find((f) => f.widgetType === "longText" || f.widgetType === "markdown");
  if (prose) return prose.name;

  const averageLength = (fieldName: string): number => {
    const lengths = entity.records
      .map((r) => r.values[fieldName])
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.length);
    return lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length;
  };
  return eligible.reduce((best, f) => (averageLength(f.name) > averageLength(best.name) ? f : best), eligible[0]).name;
}

export function buildBackup(model: InferredModel, warn: (message: string) => void, appTitle?: string): BuildResult {
  const graph = GRAPH_PLACEHOLDER;
  const records: OrmRecord[] = [];

  if (appTitle) {
    records.push({ "@graph": graph, "@id": SETTINGS_ID, "@type": "did:ng:z:Settings", appTitle });
  }

  // Pass 1: mint every entity's SchemaDef/PropertyDef/Tab/Block/Widget ids,
  // and every data record's subject id, before building any record body -
  // references (declared ids and auto-promoted parent links) need the
  // targets' minted ids to already exist, in either direction.
  const schemaIdByEntity = new Map<string, string>();
  const dataIdsByEntity = new Map<string, string[]>(); // parallel to entity.records order
  const declaredIdToMintedId = new Map<string, Map<string, string>>(); // entity -> declared "id" value -> minted id

  for (const entity of model.entities) {
    schemaIdByEntity.set(entity.name, mintId(graph));
    const ids = entity.records.map(() => mintId(graph));
    dataIdsByEntity.set(entity.name, ids);
    const declared = new Map<string, string>();
    entity.records.forEach((record, i) => {
      const rawId = record.values["id"];
      if (typeof rawId === "string") declared.set(rawId, ids[i]);
    });
    declaredIdToMintedId.set(entity.name, declared);
  }

  let order = 0;
  for (const entity of model.entities) {
    const schemaId = schemaIdByEntity.get(entity.name)!;
    const schemaRecord: OrmRecord = {
      "@graph": graph,
      "@id": schemaId,
      "@type": "did:ng:z:SchemaDef",
      name: titleCase(entity.name),
    };
    records.push(schemaRecord);

    const propertyIdByField = new Map<string, string>();
    entity.fields.forEach((field, i) => {
      const propertyId = mintId(graph);
      propertyIdByField.set(field.name, propertyId);
      const referenceSchemaId = field.referenceEntity ? schemaIdByEntity.get(field.referenceEntity) : undefined;
      if (field.referenceEntity && !referenceSchemaId) {
        warn(`"${entity.name}.${field.name}" references unknown entity "${field.referenceEntity}" - left unresolved.`);
      }
      const propertyRecord: OrmRecord = {
        "@graph": graph,
        "@id": propertyId,
        "@type": "did:ng:z:PropertyDef",
        schemaId,
        name: field.name,
        order: i,
        dataType: DATA_TYPE_IRI[field.dataType],
        cardinality: CARDINALITY_IRI[field.cardinality],
      };
      if (field.enumOptions) propertyRecord.enumOptions = field.enumOptions;
      if (referenceSchemaId) propertyRecord.referenceSchemaId = referenceSchemaId;
      records.push(propertyRecord);
    });

    const labelField = chooseLabelField(entity);
    if (labelField) schemaRecord.labelPropertyId = propertyIdByField.get(labelField);

    const tabId = mintId(graph);
    records.push({ "@graph": graph, "@id": tabId, "@type": "did:ng:z:Tab", title: titleCase(entity.name), order: order++ });

    const blockId = mintId(graph);
    records.push({
      "@graph": graph,
      "@id": blockId,
      "@type": "did:ng:z:Block",
      blockType: "did:ng:z:data",
      order: 0,
      schemaId,
      parentTabId: tabId,
      searchEnabled: true,
    });

    let widgetOrder = 0;
    records.push({ "@graph": graph, "@id": mintId(graph), "@type": "did:ng:z:Widget", parentBlockId: blockId, order: widgetOrder++, widgetType: "did:ng:z:title" });
    records.push({ "@graph": graph, "@id": mintId(graph), "@type": "did:ng:z:Widget", parentBlockId: blockId, order: widgetOrder++, widgetType: "did:ng:z:addButton" });
    records.push({ "@graph": graph, "@id": mintId(graph), "@type": "did:ng:z:Widget", parentBlockId: blockId, order: widgetOrder++, widgetType: "did:ng:z:editDeleteActions" });
    for (const field of entity.fields) {
      if (field.isSynthetic) continue; // the auto back-reference stays out of the UI
      records.push({
        "@graph": graph,
        "@id": mintId(graph),
        "@type": "did:ng:z:Widget",
        parentBlockId: blockId,
        order: widgetOrder++,
        widgetType: "did:ng:z:field",
        propertyName: field.name,
        fieldType: FIELD_TYPE_IRI[field.widgetType],
      });
    }

    // Pass 2 (per entity): the actual data instances.
    const ids = dataIdsByEntity.get(entity.name)!;
    entity.records.forEach((record, i) => {
      const instance: OrmRecord = {
        "@graph": graph,
        "@id": ids[i],
        "@type": `${USER_TYPE_PREFIX}${schemaId}`,
      };
      for (const field of entity.fields) {
        if (field.isSynthetic) {
          const parentIds = dataIdsByEntity.get(entity.parentEntity ?? "");
          instance[SYNTHETIC_PARENT_FIELD] = record.parentIndex !== undefined ? parentIds?.[record.parentIndex] ?? null : null;
          continue;
        }
        if (field.dataType === "reference" && field.referenceEntity) {
          const raw = record.values[field.name];
          const targetMap = declaredIdToMintedId.get(field.referenceEntity);
          const resolveOne = (v: JsonValue): string | null => {
            if (typeof v !== "string") return null;
            const resolved = targetMap?.get(v);
            if (!resolved) warn(`"${entity.name}.${field.name}": reference "${v}" does not match any "id" in "${field.referenceEntity}" - left unresolved.`);
            return resolved ?? null;
          };
          instance[field.name] = field.cardinality === "many"
            ? (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []).map(resolveOne).filter((v): v is string => v !== null)
            : resolveOne(Array.isArray(raw) ? raw[0] : (raw as JsonValue));
          continue;
        }
        instance[field.name] = buildFieldValue(record.values[field.name], field);
      }
      records.push(instance);
    });
  }

  const payload = {
    format: "localgraph-backup" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    sourceHost: "",
    graph,
    records: records.map((record) => ({ key: `${graph}|${record["@id"]}`, record })),
  };
  const hash = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  const backup = { ...payload, hash };
  const byteLength = Buffer.byteLength(JSON.stringify(backup), "utf8");

  return { backup, byteLength, entityCount: model.entities.length, recordCount: records.length };
}
