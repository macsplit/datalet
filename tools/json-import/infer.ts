/**
 * DSL1 -> DSL2: turns normalized entities/records into typed fields, per the
 * heuristic spec (see datalet-spec.md and the design discussion it came
 * from). The guiding rule throughout: know when not to guess. A field that
 * fails every confidence check falls back to plain text rather than being
 * forced into a type it might not deserve - a wrong silent guess is worse
 * than an honest "left as text."
 */

import { normalizeDocument, SYNTHETIC_PARENT_FIELD, type RawNormalizedEntity } from "./normalize";
import type {
  FieldCardinality,
  ImportDocument,
  InferredEntity,
  InferredField,
  InferredModel,
  JsonValue,
} from "./types";

const ENUM_MIN_SAMPLES = 10;
const ENUM_MAX_DISTINCT = 6;
const LONGTEXT_LENGTH = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isMeaningfulSample(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** One field's samples, gathered across every record that has a non-blank
 * value for it - blank and absent both simply contribute no sample, per the
 * blank-vs-absent rule; they never argue against a type another record
 * establishes. */
function collectSamples(entity: RawNormalizedEntity, field: string): { scalars: JsonValue[]; sawArray: boolean; sawScalar: boolean } {
  const scalars: JsonValue[] = [];
  let sawArray = false;
  let sawScalar = false;
  for (const record of entity.records) {
    const value = record.values[field];
    if (Array.isArray(value)) {
      sawArray = true;
      for (const element of value) if (isMeaningfulSample(element)) scalars.push(element);
    } else if (isMeaningfulSample(value)) {
      sawScalar = true;
      scalars.push(value);
    }
  }
  return { scalars, sawArray, sawScalar };
}

function allOfType(values: JsonValue[], kind: "boolean" | "number" | "string"): boolean {
  return values.length > 0 && values.every((v) => typeof v === kind);
}

function looksLikeDateTime(value: string): boolean {
  return value.includes("T");
}

function inferField(
  entity: RawNormalizedEntity,
  fieldName: string,
  warn: (message: string) => void,
): InferredField {
  const hint = entity.hints[fieldName];
  const { scalars, sawArray, sawScalar } = collectSamples(entity, fieldName);
  const cardinality: FieldCardinality = sawArray ? "many" : "optional";

  if (sawArray && sawScalar) {
    warn(`"${entity.name}.${fieldName}": some records give it as a list and others a single value - treated as a list.`);
  }

  if (hint?.type === "reference") {
    return { name: fieldName, dataType: "reference", widgetType: "reference", cardinality, referenceEntity: hint.entity };
  }
  // "id" is an identifier, not typed data - never reformat it, even when its
  // value happens to look like a date, a number, or a low-cardinality enum.
  if (!hint && fieldName.toLowerCase() === "id") {
    return { name: fieldName, dataType: "text", widgetType: "text", cardinality };
  }
  if (hint?.type === "currency") {
    return { name: fieldName, dataType: "number", widgetType: "currency", cardinality };
  }

  if (scalars.length === 0) {
    // No non-blank sample anywhere: nothing to infer from - stays text.
    return { name: fieldName, dataType: "text", widgetType: "text", cardinality: "optional" };
  }

  if (allOfType(scalars, "boolean")) {
    return { name: fieldName, dataType: "boolean", widgetType: "checkbox", cardinality };
  }
  if (allOfType(scalars, "number")) {
    return { name: fieldName, dataType: "number", widgetType: "number", cardinality };
  }

  const strings = scalars.filter((v): v is string => typeof v === "string");
  const nonStringCount = scalars.length - strings.length;
  if (nonStringCount > 0) {
    warn(`"${entity.name}.${fieldName}": mixed value types across records - left as text.`);
    return { name: fieldName, dataType: "text", widgetType: "text", cardinality };
  }

  if (strings.every((v) => DATE_RE.test(v))) {
    const dateTime = strings.some(looksLikeDateTime);
    return { name: fieldName, dataType: "date", widgetType: dateTime ? "dateTime" : "date", cardinality };
  }
  if (strings.every((v) => URL_RE.test(v))) {
    return { name: fieldName, dataType: "text", widgetType: "url", cardinality };
  }
  if (strings.every((v) => EMAIL_RE.test(v))) {
    return { name: fieldName, dataType: "text", widgetType: "email", cardinality };
  }

  const distinct = new Set(strings);
  if (scalars.length >= ENUM_MIN_SAMPLES && distinct.size <= ENUM_MAX_DISTINCT) {
    return {
      name: fieldName,
      dataType: "enum",
      widgetType: cardinality === "many" ? "multiSelect" : "dropdown",
      cardinality,
      enumOptions: [...distinct].sort(),
    };
  }

  const isLong = strings.some((v) => v.length > LONGTEXT_LENGTH || v.includes("\n"));
  return { name: fieldName, dataType: "text", widgetType: isLong ? "longText" : "text", cardinality };
}

/** Flags field-name pairs like "mood" and "mood.score" that both exist on the
 * same entity - a strong sign the same logical field changed shape between
 * records (see normalize.ts) rather than two genuinely distinct fields. */
function warnAboutShapeCollisions(entity: RawNormalizedEntity, fieldNames: string[], warn: (message: string) => void): void {
  const names = new Set(fieldNames);
  for (const name of names) {
    for (const other of names) {
      if (other !== name && other.startsWith(`${name}.`)) {
        warn(`"${entity.name}": both "${name}" and "${other}" appear - it looks like this field changed shape between records.`);
      }
    }
  }
}

export function inferModel(doc: ImportDocument): InferredModel {
  const normalized = normalizeDocument(doc);
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  const entities: InferredEntity[] = [];
  for (const rawEntity of normalized.values()) {
    const fieldNames = [...new Set(rawEntity.records.flatMap((r) => Object.keys(r.values)))];
    warnAboutShapeCollisions(rawEntity, fieldNames, warn);

    const fields = fieldNames.map((name) => inferField(rawEntity, name, warn));
    if (rawEntity.parentEntity) {
      fields.push({
        name: SYNTHETIC_PARENT_FIELD,
        dataType: "reference",
        widgetType: "reference",
        cardinality: "one",
        referenceEntity: rawEntity.parentEntity,
        isSynthetic: true,
      });
    }

    entities.push({
      name: rawEntity.name,
      fields,
      records: rawEntity.records,
      parentEntity: rawEntity.parentEntity,
      isAutoPromoted: Boolean(rawEntity.parentEntity),
    });
  }

  return { entities, warnings };
}
