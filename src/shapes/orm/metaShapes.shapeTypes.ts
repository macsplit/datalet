import type { ShapeType } from "@ng-org/shex-orm";
import { metaShapesSchema } from "./metaShapes.schema";
import type {
  Tab,
  Block,
  Widget,
  SchemaDef,
  PropertyDef,
} from "./metaShapes.typings";

// ShapeTypes for metaShapes
export const TabShapeType: ShapeType<Tab> = {
  schema: metaShapesSchema,
  shape: "did:ng:z:TabShape",
};
export const BlockShapeType: ShapeType<Block> = {
  schema: metaShapesSchema,
  shape: "did:ng:z:BlockShape",
};
export const WidgetShapeType: ShapeType<Widget> = {
  schema: metaShapesSchema,
  shape: "did:ng:z:WidgetShape",
};
export const SchemaDefShapeType: ShapeType<SchemaDef> = {
  schema: metaShapesSchema,
  shape: "did:ng:z:SchemaDefShape",
};
export const PropertyDefShapeType: ShapeType<PropertyDef> = {
  schema: metaShapesSchema,
  shape: "did:ng:z:PropertyDefShape",
};
