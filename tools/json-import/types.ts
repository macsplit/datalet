/**
 * Types for the JSON-import tool's two front-facing stages:
 *  - DSL1: the generic multi-entity document a producer (LLM or human) writes,
 *    per docs handed out separately (see the datalet-spec.md this tool implements).
 *  - DSL2: the inferred model this tool derives from DSL1 - field types,
 *    cardinalities, entity/reference structure - before any record is built.
 *
 * This module has no dependency on the app's own source (see infer.ts's
 * header comment for why): it is an independent client of the *documented*
 * backup file format, not a consumer of the app's internal ORM/sync code.
 */

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type Hint = { type: "reference"; entity: string } | { type: "currency" };

/** One record as written in DSL1, `_hints` aside. */
export type RawRecord = { _hints?: Record<string, Hint> } & { [key: string]: JsonValue };

/** The whole DSL1 document: entity name -> its array of records. */
export type ImportDocument = Record<string, RawRecord[]>;

export type FieldDataType = "text" | "number" | "boolean" | "date" | "enum" | "reference";

export type FieldWidgetType =
  | "text"
  | "longText"
  | "markdown"
  | "url"
  | "email"
  | "number"
  | "currency"
  | "date"
  | "dateTime"
  | "dropdown"
  | "multiSelect"
  | "checkbox"
  | "reference";

export type FieldCardinality = "one" | "optional" | "many";

/** DSL2: one inferred field on one entity. */
export interface InferredField {
  name: string;
  dataType: FieldDataType;
  widgetType: FieldWidgetType;
  cardinality: FieldCardinality;
  enumOptions?: string[];
  referenceEntity?: string;
  /** True for the tool-generated back-reference on an auto-promoted child entity. */
  isSynthetic?: boolean;
}

/** One flattened, typed record ready to become an ORM data instance. */
export interface NormalizedRecord {
  index: number;
  parentIndex?: number;
  values: Record<string, JsonValue>;
}

/** DSL2: one entity - either declared at the top level of DSL1, or promoted
 * from a repeating array-of-objects nested inside another entity's records. */
export interface InferredEntity {
  name: string;
  fields: InferredField[];
  records: NormalizedRecord[];
  parentEntity?: string;
  isAutoPromoted: boolean;
}

export interface InferredModel {
  entities: InferredEntity[];
  warnings: string[];
}
