import assert from "node:assert/strict";
import { test } from "node:test";
import { inferModel } from "./infer";
import type { ImportDocument } from "./types";

function entity(model: ReturnType<typeof inferModel>, name: string) {
  const found = model.entities.find((e) => e.name === name);
  assert.ok(found, `expected an entity named "${name}"`);
  return found;
}

function field(entity: ReturnType<typeof inferModel>["entities"][number], name: string) {
  const found = entity.fields.find((f) => f.name === name);
  assert.ok(found, `expected a field named "${name}"`);
  return found;
}

test("infers scalar types from plain values", () => {
  const doc: ImportDocument = {
    things: [
      { id: "1", when: "2026-09-01", count: 3, active: true, note: "short" },
      { id: "2", when: "2026-09-06", count: 5, active: false, note: "also short" },
    ],
  };
  const model = inferModel(doc);
  const things = entity(model, "things");
  assert.equal(field(things, "when").dataType, "date");
  assert.equal(field(things, "count").dataType, "number");
  assert.equal(field(things, "active").dataType, "boolean");
  assert.equal(field(things, "active").widgetType, "checkbox");
  assert.equal(field(things, "note").dataType, "text");
  assert.equal(field(things, "note").widgetType, "text");
});

test("detects a dateTime field only when a time component is present", () => {
  const doc: ImportDocument = {
    events: [
      { id: "1", at: "2026-09-01T10:00:00Z" },
      { id: "2", at: "2026-09-02T11:30:00Z" },
    ],
  };
  const model = inferModel(doc);
  assert.equal(field(entity(model, "events"), "at").widgetType, "dateTime");
});

test("detects urls and emails", () => {
  const doc: ImportDocument = {
    contacts: [
      { id: "1", site: "https://example.com/a", email: "a@example.com" },
      { id: "2", site: "https://example.com/b", email: "b@example.com" },
    ],
  };
  const model = inferModel(doc);
  const contacts = entity(model, "contacts");
  assert.equal(field(contacts, "site").widgetType, "url");
  assert.equal(field(contacts, "email").widgetType, "email");
});

test("enum requires both enough samples and low cardinality", () => {
  const manyLowCardinality: ImportDocument = {
    tasks: Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      status: i % 3 === 0 ? "done" : i % 3 === 1 ? "doing" : "todo",
    })),
  };
  const model = inferModel(manyLowCardinality);
  const status = field(entity(model, "tasks"), "status");
  assert.equal(status.dataType, "enum");
  assert.equal(status.widgetType, "dropdown");
  assert.deepEqual(status.enumOptions, ["doing", "done", "todo"]);

  const tooFewSamples: ImportDocument = {
    tasks: [
      { id: "1", status: "done" },
      { id: "2", status: "todo" },
    ],
  };
  const fewModel = inferModel(tooFewSamples);
  assert.equal(field(entity(fewModel, "tasks"), "status").dataType, "text");
});

test("blank and absent values never count as samples, and don't break inference", () => {
  const doc: ImportDocument = {
    checkins: [
      { id: "1", date: "2026-09-01", mood: "" },
      { id: "2", date: "2026-09-02" },
      { id: "3", date: "2026-09-03", mood: null },
    ],
  };
  const model = inferModel(doc);
  const checkins = entity(model, "checkins");
  assert.equal(field(checkins, "date").dataType, "date");
  // No non-blank sample anywhere for "mood": stays a safe, unopinionated text field.
  assert.equal(field(checkins, "mood").dataType, "text");
});

test("an explicit reference hint is never inferred, and always wins", () => {
  const doc: ImportDocument = {
    recipes: [{ id: "r1", name: "Sourdough" }],
    batches: [
      { _hints: { recipeId: { type: "reference", entity: "recipes" } }, id: "b1", recipeId: "r1" },
      { id: "b2", recipeId: "r1" },
    ],
  };
  const model = inferModel(doc);
  const recipeId = field(entity(model, "batches"), "recipeId");
  assert.equal(recipeId.dataType, "reference");
  assert.equal(recipeId.referenceEntity, "recipes");
});

test("a currency hint sets fieldType without ever being guessed", () => {
  const doc: ImportDocument = {
    batches: [
      { _hints: { cost: { type: "currency" } }, id: "b1", cost: 42.5 },
      { id: "b2", cost: 10 },
    ],
  };
  const model = inferModel(doc);
  const cost = field(entity(model, "batches"), "cost");
  assert.equal(cost.dataType, "number");
  assert.equal(cost.widgetType, "currency");
});

test("array-of-objects is promoted to its own entity with a synthetic parent reference", () => {
  const doc: ImportDocument = {
    batches: [
      {
        id: "b1",
        ingredients: [
          { name: "flour", amount: 100 },
          { name: "water", amount: 100 },
        ],
      },
      { id: "b2", ingredients: [{ name: "flour", amount: 50 }] },
    ],
  };
  const model = inferModel(doc);
  const ingredients = entity(model, "batches.ingredients");
  assert.equal(ingredients.isAutoPromoted, true);
  assert.equal(ingredients.parentEntity, "batches");
  assert.equal(ingredients.records.length, 3);
  const backRef = field(ingredients, "__parentId");
  assert.equal(backRef.dataType, "reference");
  assert.equal(backRef.referenceEntity, "batches");
  assert.equal(backRef.isSynthetic, true);
  // First two ingredient rows belong to batches[0], the third to batches[1].
  assert.equal(ingredients.records[0].parentIndex, 0);
  assert.equal(ingredients.records[1].parentIndex, 0);
  assert.equal(ingredients.records[2].parentIndex, 1);
});

test("a nested plain object is flattened into dotted field names", () => {
  const doc: ImportDocument = {
    trips: [
      { id: "1", location: { city: "Leeds", country: "UK" } },
      { id: "2", location: { city: "York", country: "UK" } },
    ],
  };
  const model = inferModel(doc);
  const trips = entity(model, "trips");
  assert.ok(trips.fields.some((f) => f.name === "location.city"));
  assert.ok(trips.fields.some((f) => f.name === "location.country"));
});

test("a field that changes shape between records is flagged, not silently guessed", () => {
  const doc: ImportDocument = {
    checkins: [
      { id: "1", mood: "productive" },
      { id: "2", mood: { score: 3 } },
    ],
  };
  const model = inferModel(doc);
  assert.ok(model.warnings.some((w) => w.includes("mood") && w.includes("changed shape")));
});

test("an \"id\" field stays text even when every value looks like a date", () => {
  const doc: ImportDocument = {
    checkins: [
      { id: "2026-09-13", date: "2026-09-13" },
      { id: "2026-09-06", date: "2026-09-06" },
    ],
  };
  const model = inferModel(doc);
  const checkins = entity(model, "checkins");
  assert.equal(field(checkins, "id").dataType, "text");
  assert.equal(field(checkins, "date").dataType, "date");
});

test("mixed scalar types on one field fall back to text rather than crash", () => {
  const doc: ImportDocument = {
    things: [
      { id: "1", value: "42" },
      { id: "2", value: 42 },
    ],
  };
  const model = inferModel(doc);
  const value = field(entity(model, "things"), "value");
  assert.equal(value.dataType, "text");
  assert.ok(model.warnings.some((w) => w.includes("mixed value types")));
});
