import type { ShapeType } from "@ng-org/shex-orm";
import { settingsShapesSchema } from "./settingsShapes.schema";
import type { Settings } from "./settingsShapes.typings";

// ShapeTypes for settingsShapes
export const SettingsShapeType: ShapeType<Settings> = {
  schema: settingsShapesSchema,
  shape: "did:ng:z:SettingsShape",
};
