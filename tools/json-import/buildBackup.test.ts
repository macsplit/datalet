import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildBackup, titleCase } from "./buildBackup";
import { inferModel } from "./infer";
import type { ImportDocument } from "./types";

type OrmRecord = Record<string, unknown> & { "@id": string; "@graph": string; "@type": string };

function recordsOfType(backup: Record<string, unknown>, type: string): OrmRecord[] {
  const entries = backup.records as Array<{ key: string; record: OrmRecord }>;
  return entries.map((e) => e.record).filter((r) => r["@type"] === type);
}

function build(doc: ImportDocument) {
  const model = inferModel(doc);
  const warnings = [...model.warnings];
  const result = buildBackup(model, (m) => warnings.push(m));
  return { ...result, warnings };
}

test("produces one SchemaDef, Tab, and data Block per entity", () => {
  const { backup } = build({
    recipes: [{ id: "r1", name: "Sourdough" }],
    batches: [{ id: "b1", date: "2026-09-01" }],
  });
  assert.equal(recordsOfType(backup, "did:ng:z:SchemaDef").length, 2);
  assert.equal(recordsOfType(backup, "did:ng:z:Tab").length, 2);
  const blocks = recordsOfType(backup, "did:ng:z:Block");
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.blockType === "did:ng:z:data"));
});

test("every record's key is exactly its own @graph and @id joined with |", () => {
  const { backup } = build({ recipes: [{ id: "r1", name: "Sourdough" }] });
  const entries = backup.records as Array<{ key: string; record: OrmRecord }>;
  for (const { key, record } of entries) {
    assert.equal(key, `${record["@graph"]}|${record["@id"]}`);
  }
});

test("the hash matches an independently recomputed sha256 over the payload minus hash", () => {
  const { backup } = build({ recipes: [{ id: "r1", name: "Sourdough" }] });
  const { hash, ...payload } = backup as { hash: string } & Record<string, unknown>;
  const recomputed = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  assert.equal(hash, recomputed);
});

test("enumOptions is a plain array in the written record, never a Set", () => {
  const { backup } = build({
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: String(i), status: i % 2 === 0 ? "done" : "todo" })),
  });
  const property = recordsOfType(backup, "did:ng:z:PropertyDef").find((p) => p.name === "status");
  assert.ok(Array.isArray(property?.enumOptions));
});

test("a hinted reference resolves to the target's minted subject id, not its declared id", () => {
  const { backup } = build({
    recipes: [{ id: "r1", name: "Sourdough" }],
    batches: [{ _hints: { recipeId: { type: "reference", entity: "recipes" } }, id: "b1", recipeId: "r1" }],
  });
  const recipe = recordsOfType(backup, "did:ng:z:user:" + recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Recipes")!["@id"])[0];
  const batch = recordsOfType(backup, "did:ng:z:user:" + recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Batches")!["@id"])[0];
  assert.equal(batch.recipeId, recipe["@id"]);
  assert.notEqual(batch.recipeId, "r1");
});

test("an auto-promoted child entity's __parentId resolves to its parent's minted id, by row position", () => {
  const { backup } = build({
    batches: [
      { id: "b1", ingredients: [{ name: "flour" }] },
      { id: "b2", ingredients: [{ name: "water" }] },
    ],
  });
  const batchSchemaId = recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Batches")!["@id"];
  const ingredientSchemaId = recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Batches Ingredients")!["@id"];
  const batches = recordsOfType(backup, `did:ng:z:user:${batchSchemaId}`);
  const ingredients = recordsOfType(backup, `did:ng:z:user:${ingredientSchemaId}`);
  const b2 = batches.find((b) => b.id === "b2")!;
  const water = ingredients.find((i) => i.name === "water")!;
  assert.equal(water.__parentId, b2["@id"]);
});

test("an unresolvable reference is dropped with a warning, not thrown", () => {
  const { backup, warnings } = build({
    recipes: [{ id: "r1", name: "Sourdough" }],
    batches: [{ _hints: { recipeId: { type: "reference", entity: "recipes" } }, id: "b1", recipeId: "does-not-exist" }],
  });
  const batchSchemaId = recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Batches")!["@id"];
  const batch = recordsOfType(backup, `did:ng:z:user:${batchSchemaId}`)[0];
  assert.equal(batch.recipeId, null);
  assert.ok(warnings.some((w) => w.includes("does not match any")));
});

test("titleCase turns entity/field-style names into display labels", () => {
  assert.equal(titleCase("checkins"), "Checkins");
  assert.equal(titleCase("batches.ingredients"), "Batches Ingredients");
  assert.equal(titleCase("product_line_drift"), "Product Line Drift");
  assert.equal(titleCase("myCamelCaseName"), "My Camel Case Name");
});

test("SchemaDef.name and Tab.title are title-cased, but binding identifiers are not", () => {
  const { backup } = build({ checkins: [{ id: "1" }] });
  const schema = recordsOfType(backup, "did:ng:z:SchemaDef")[0];
  const tab = recordsOfType(backup, "did:ng:z:Tab")[0];
  assert.equal(schema.name, "Checkins");
  assert.equal(tab.title, "Checkins");
  // Widget.propertyName must still match PropertyDef.name exactly (raw, not title-cased).
  const idProperty = recordsOfType(backup, "did:ng:z:PropertyDef").find((p) => p.name === "id");
  assert.ok(idProperty);
});

test("an app title, when given, becomes a Settings record the app will pick up", () => {
  const model = inferModel({ checkins: [{ id: "1" }] });
  const { backup } = (() => {
    const warnings: string[] = [];
    return { backup: buildBackup(model, (m) => warnings.push(m), "Career Log").backup };
  })();
  const settings = recordsOfType(backup, "did:ng:z:Settings")[0];
  assert.equal(settings?.appTitle, "Career Log");
  assert.equal(settings?.["@id"], "did:ng:z:SettingsSingleton");
});

test("omitting an app title omits the Settings record entirely", () => {
  const { backup } = build({ checkins: [{ id: "1" }] });
  assert.equal(recordsOfType(backup, "did:ng:z:Settings").length, 0);
});

test("labelPropertyId points at a descriptive field, never at \"id\"", () => {
  const { backup } = build({
    questions: [
      { id: "s1q1", section: 1, sectionName: "Incident response", order: 1, text: "What happened, in one or two neutral sentences?" },
      { id: "s1q2", section: 1, sectionName: "Incident response", order: 2, text: "What part was within my control?" },
    ],
  });
  const schema = recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Questions")!;
  const properties = recordsOfType(backup, "did:ng:z:PropertyDef").filter((p) => p.schemaId === schema["@id"]);
  const labelProperty = properties.find((p) => p["@id"] === schema.labelPropertyId);
  assert.equal(labelProperty?.name, "text");
});

test("a schema with nothing but an id gets no labelPropertyId, same as the app's own default", () => {
  const { backup } = build({ things: [{ id: "1" }, { id: "2" }] });
  const schema = recordsOfType(backup, "did:ng:z:SchemaDef").find((s) => s.name === "Things")!;
  assert.equal(schema.labelPropertyId, undefined);
});

test("byteLength reflects the actual written JSON size", () => {
  const { backup, byteLength } = build({ recipes: [{ id: "r1", name: "Sourdough" }] });
  assert.equal(byteLength, Buffer.byteLength(JSON.stringify(backup), "utf8"));
});
