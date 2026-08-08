export type IRI = string;

/**
 * =============================================================================
 * Typescript Typings for metaShapes
 * =============================================================================
 */

/**
 * Tab Type
 */
export interface Tab {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:Tab";
  /**
   * The tab's display name
   *
   * Original IRI: did:ng:z:title
   */
  title: string;
  /**
   * Sort order among tabs
   *
   * Original IRI: did:ng:z:order
   */
  order: number;
}

/**
 * Block Type
 */
export interface Block {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:Block";
  /**
   * Whether this block lays out child blocks or displays a data collection
   *
   * Original IRI: did:ng:z:blockType
   */
  blockType: "did:ng:z:layout" | "did:ng:z:data";
  /**
   * Sort order among sibling blocks
   *
   * Original IRI: did:ng:z:order
   */
  order: number;
  /**
   * Optional heading shown for this block
   *
   * Original IRI: did:ng:z:title
   */
  title?: string;
  /**
   * How child blocks are arranged (layout blocks only)
   *
   * Original IRI: did:ng:z:layoutMode
   */
  layoutMode?: "did:ng:z:stack" | "did:ng:z:row" | "did:ng:z:grid";
  /**
   * The SchemaDef this block displays records of (data blocks only)
   *
   * Original IRI: did:ng:z:schemaId
   */
  schemaId?: IRI;
  /**
   * Property whose display value must contain filterValue (data blocks only)
   *
   * Original IRI: did:ng:z:filterPropertyName
   */
  filterPropertyName?: string;
  /**
   * Case-insensitive value filter for a data block
   *
   * Original IRI: did:ng:z:filterValue
   */
  filterValue?: string;
  /**
   * Property used to order records, or @id when omitted
   *
   * Original IRI: did:ng:z:sortPropertyName
   */
  sortPropertyName?: string;
  /**
   * Direction used to order records in a data block
   *
   * Original IRI: did:ng:z:sortDirection
   */
  sortDirection?: "did:ng:z:ascending" | "did:ng:z:descending";
  /**
   * Whether readers get a search box over this data block
   *
   * Original IRI: did:ng:z:searchEnabled
   */
  searchEnabled?: boolean;
  /**
   * Records shown per page, or all records when omitted
   *
   * Original IRI: did:ng:z:pageSize
   */
  pageSize?: number;
  /**
   * The Tab this block lives in directly (top-level blocks only)
   *
   * Original IRI: did:ng:z:parentTabId
   */
  parentTabId?: IRI;
  /**
   * The layout Block this block is nested inside (nested blocks only)
   *
   * Original IRI: did:ng:z:parentBlockId
   */
  parentBlockId?: IRI;
}

/**
 * Widget Type
 */
export interface Widget {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:Widget";
  /**
   * The data Block this widget belongs to
   *
   * Original IRI: did:ng:z:parentBlockId
   */
  parentBlockId: IRI;
  /**
   * Sort order among sibling widgets
   *
   * Original IRI: did:ng:z:order
   */
  order: number;
  /**
   * What kind of widget this is
   *
   * Original IRI: did:ng:z:widgetType
   */
  widgetType:
    | "did:ng:z:title"
    | "did:ng:z:addButton"
    | "did:ng:z:editDeleteActions"
    | "did:ng:z:field";
  /**
   * Optional display label override
   *
   * Original IRI: did:ng:z:label
   */
  label?: string;
  /**
   * The bound PropertyDef's name (field widgets only)
   *
   * Original IRI: did:ng:z:propertyName
   */
  propertyName?: string;
  /**
   * How to render the bound field (field widgets only)
   *
   * Original IRI: did:ng:z:fieldType
   */
  fieldType?:
    | "did:ng:z:text"
    | "did:ng:z:number"
    | "did:ng:z:currency"
    | "did:ng:z:date"
    | "did:ng:z:dateTime"
    | "did:ng:z:dropdown"
    | "did:ng:z:multiSelect"
    | "did:ng:z:checkbox"
    | "did:ng:z:reference";
}

/**
 * SchemaDef Type
 */
export interface SchemaDef {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:SchemaDef";
  /**
   * The user-defined data type's name
   *
   * Original IRI: did:ng:z:name
   */
  name: string;
}

/**
 * PropertyDef Type
 */
export interface PropertyDef {
  /**
   * The graph NURI.
   */
  readonly "@graph": IRI;
  /**
   * The subject IRI.
   */
  readonly "@id": IRI;
  /**
   * Original IRI: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
   */
  "@type": "did:ng:z:PropertyDef";
  /**
   * The SchemaDef this property belongs to
   *
   * Original IRI: did:ng:z:schemaId
   */
  schemaId: IRI;
  /**
   * The property's name
   *
   * Original IRI: did:ng:z:name
   */
  name: string;
  /**
   * Sort order among sibling properties
   *
   * Original IRI: did:ng:z:order
   */
  order: number;
  /**
   * The property's underlying data type
   *
   * Original IRI: did:ng:z:dataType
   */
  dataType:
    | "did:ng:z:text"
    | "did:ng:z:number"
    | "did:ng:z:boolean"
    | "did:ng:z:date"
    | "did:ng:z:enum"
    | "did:ng:z:reference";
  /**
   * Whether the property is required, optional, or a multi-value set
   *
   * Original IRI: did:ng:z:cardinality
   */
  cardinality: "did:ng:z:one" | "did:ng:z:optional" | "did:ng:z:many";
  /**
   * Allowed values when dataType is enum
   *
   * Original IRI: did:ng:z:enumOptions
   */
  enumOptions?: Set<string>;
  /**
   * Target SchemaDef when dataType is reference
   *
   * Original IRI: did:ng:z:referenceSchemaId
   */
  referenceSchemaId?: IRI;
}
