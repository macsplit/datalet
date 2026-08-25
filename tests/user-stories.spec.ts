import { expect, test, type Download, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInvariants } from "./support/dataletInvariants";
import { installFakeSyncServer } from "./support/fakeSyncServer";

/**
 * Deterministic, plausible journeys through the product rather than isolated
 * feature checks. The specification and remaining stories live in
 * docs/user-story-tests.md.
 */

const SOURCE_GRAPH = "did:ng:user-story-reading-log";
const SCHEMA_ID = "did:ng:z:meta:schema:reading-log";
const BLOCK_ID = "did:ng:z:meta:block:reading-log";

type BackupRecord = Record<string, unknown> & { "@id": string; "@graph": string };

function readingLogBackup() {
  const authors = [
    "Ursula Le Guin",
    "Octavia Butler",
    "Kazuo Ishiguro",
    "Susanna Clarke",
    "N. K. Jemisin",
    "Ted Chiang",
  ];
  const namedTitles = [
    "The Dispossessed",
    "A Wizard of Earthsea",
    "The Left Hand of Darkness",
    "Always Coming Home",
  ];
  const records: BackupRecord[] = [
    { "@graph": SOURCE_GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Reading log", order: 0 },
    { "@graph": SOURCE_GRAPH, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "My reading life" },
    { "@graph": SOURCE_GRAPH, "@id": SCHEMA_ID, "@type": "did:ng:z:SchemaDef", name: "Books", labelPropertyId: "property-reading-title" },
    { "@graph": SOURCE_GRAPH, "@id": "property-reading-title", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": SOURCE_GRAPH, "@id": "property-reading-author", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Author", order: 1, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": SOURCE_GRAPH, "@id": "property-reading-finished", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Finished", order: 2, dataType: "did:ng:z:date", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": SOURCE_GRAPH, "@id": "property-reading-rating", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Rating", order: 3, dataType: "did:ng:z:number", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": SOURCE_GRAPH, "@id": "property-reading-notes", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Notes", order: 4, dataType: "did:ng:z:text", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": SOURCE_GRAPH, "@id": BLOCK_ID, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId: SCHEMA_ID, parentTabId: "did:ng:z:HomeTab", searchEnabled: true, pageSize: 10 },
    { "@graph": SOURCE_GRAPH, "@id": "widget-reading-title-heading", "@type": "did:ng:z:Widget", parentBlockId: BLOCK_ID, order: 0, widgetType: "did:ng:z:title", label: "Books I've read" },
    { "@graph": SOURCE_GRAPH, "@id": "widget-reading-add", "@type": "did:ng:z:Widget", parentBlockId: BLOCK_ID, order: 1, widgetType: "did:ng:z:addButton", label: "Add book" },
    ...[
      ["Title", "did:ng:z:text"],
      ["Author", "did:ng:z:text"],
      ["Finished", "did:ng:z:date"],
      ["Rating", "did:ng:z:number"],
      ["Notes", "did:ng:z:markdown"],
    ].map(([name, fieldType], index) => ({
      "@graph": SOURCE_GRAPH,
      "@id": `widget-reading-${name.toLocaleLowerCase()}`,
      "@type": "did:ng:z:Widget",
      parentBlockId: BLOCK_ID,
      order: index + 2,
      widgetType: "did:ng:z:field",
      propertyName: name,
      label: name,
      fieldType,
    })),
    { "@graph": SOURCE_GRAPH, "@id": "widget-reading-actions", "@type": "did:ng:z:Widget", parentBlockId: BLOCK_ID, order: 7, widgetType: "did:ng:z:editDeleteActions" },
    ...Array.from({ length: 48 }, (_, index) => ({
      "@graph": SOURCE_GRAPH,
      "@id": `reading-${String(index + 1).padStart(2, "0")}`,
      "@type": `did:ng:z:user:${SCHEMA_ID}`,
      Title: namedTitles[index] ?? `Reading list book ${String(index + 1).padStart(2, "0")}`,
      Author: index < namedTitles.length
        ? authors[0]
        : authors[(index % (authors.length - 1)) + 1],
      Finished: `2026-${String((index % 8) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
      Rating: (index % 5) + 1,
      Notes: index % 3 === 0 ? "Worth discussing again." : "",
    })),
  ];

  return {
    format: "localgraph-backup",
    version: 1,
    exportedAt: "2026-08-24T12:00:00.000Z",
    graph: SOURCE_GRAPH,
    records: records.map((record) => ({ key: `${SOURCE_GRAPH}|${record["@id"]}`, record })),
  };
}

async function importBackup(page: Page, path: string) {
  page.once("dialog", (dialog) => void dialog.accept());
  const reloaded = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
  });
  await page.getByLabel("Choose backup file").setInputFiles(path);
  await reloaded;
  await page.waitForLoadState("domcontentloaded");
}

async function readDownload(download: Download) {
  const path = await download.path();
  if (!path) throw new Error("Playwright did not retain the downloaded file");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

type DataletIdentity = {
  title: string;
  schema: string;
  record: string;
  colour: string;
  rgb: string;
};

const J5_DATALETS: DataletIdentity[] = [
  { title: "Garden planner", schema: "Plantings", record: "Courtyard lavender", colour: "#f3ead7", rgb: "rgb(243, 234, 215)" },
  { title: "Reading room", schema: "Essays", record: "Ways of Seeing notes", colour: "#e2edf7", rgb: "rgb(226, 237, 247)" },
  { title: "Travel desk", schema: "Journeys", record: "Night train to Vienna", colour: "#e5f1e4", rgb: "rgb(229, 241, 228)" },
];

async function waitForActiveOutbox(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}") as {
      activeId?: string;
      entries?: Array<{ id: string; vault?: { vaultId: string } }>;
    };
    const vaultId = registry.entries?.find((entry) => entry.id === registry.activeId)?.vault?.vaultId;
    if (!vaultId) return -1;
    return JSON.parse(localStorage.getItem(`meta-ui-builder:sync-outbox:${vaultId}`) ?? "[]").length;
  })).toBe(0);
}

async function buildDistinctDatalet(page: Page, identity: DataletIdentity) {
  await page.goto("/settings");
  await page.getByLabel("Shown in the nav bar and browser tab").fill(identity.title);

  await page.goto("/settings/theme");
  const background = page.getByLabel("Light", { exact: true }).first();
  await expect(async () => {
    await background.fill(identity.colour);
    await expect(background).toHaveValue(identity.colour);
  }).toPass();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe(identity.rgb);

  await page.goto("/settings/schemas");
  await page.getByRole("button", { name: "+ New schema" }).click();
  await page.getByLabel("Schema name").fill(identity.schema);
  await page.getByLabel("Schema name").press("Enter");
  await page.getByRole("button", { name: "+ Add property" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Title");
  await page.getByLabel("Name", { exact: true }).press("Enter");

  await page.goto("/settings/tabs/did:ng:z:HomeTab/blocks");
  await page.getByLabel("Data block schema").selectOption({ label: identity.schema });
  await page.getByRole("button", { name: "+ Add data block" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: `+ Add ${identity.schema}` }).click();
  const card = page.locator(".record-card").first();
  await card.getByRole("button", { name: "Edit record" }).click();
  await card.getByLabel("Title").fill(identity.record);
  await card.getByRole("button", { name: "Done editing" }).click();
  await expect(card).toContainText(identity.record);
  await waitForActiveOutbox(page);
}

async function assertDistinctDatalet(page: Page, identity: DataletIdentity) {
  await expect(page.locator(".app-nav-brand")).toHaveText(identity.title);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe(identity.rgb);
  await page.goto("/");
  await expect(page.getByText(identity.record, { exact: true })).toBeVisible();
  for (const other of J5_DATALETS.filter((candidate) => candidate !== identity)) {
    await expect(page.getByText(other.record, { exact: true })).toHaveCount(0);
  }
}

async function openDatalet(page: Page, title: string) {
  await page.goto("/settings/datalets");
  const row = page.locator("#switch-datalet .layout-row").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Open" }).click();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".app-nav-brand")).toHaveText(title, { timeout: 15_000 });
}

test("a reader adopts and maintains an established reading log", async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const directory = await mkdtemp(join(tmpdir(), "datalet-user-story-"));
  const importPath = join(directory, "reading-log.json");
  await writeFile(importPath, JSON.stringify(readingLogBackup()));

  console.log("[user-story J1] Importing a 48-book reading log into a fresh browser");
  await page.goto("/settings/datalets");
  await importBackup(page, importPath);
  await expect(page.locator(".app-nav-brand")).toHaveText("My reading life");

  console.log("[user-story J1] Browsing pages and finding an author's books");
  await page.goto("/");
  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(10);
  await expect(page.getByText("Showing 1–10 of 48")).toBeVisible();
  await expect(page.getByText("Page 1 of 5")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 11–20 of 48")).toBeVisible();

  const search = page.getByLabel("Search Books");
  await search.fill("Ursula Le Guin");
  await expect(cards).toHaveCount(4);
  await expect(page.getByText("Page 1 of 1")).toBeVisible();

  console.log("[user-story J1] Updating an existing book and formatted notes");
  // Search leaves these four in their stable record-id order; keep the first
  // card by position because an input's current value is not descendant text,
  // so a hasText locator would stop matching the moment editing begins.
  const dispossessed = cards.first();
  await expect(dispossessed).toContainText("The Dispossessed");
  await dispossessed.getByRole("button", { name: "Edit record" }).click();
  await dispossessed.getByLabel("Rating").fill("5");
  await dispossessed.getByLabel("Notes").fill("## Re-read\n\nStill **essential**.");
  await dispossessed.getByRole("button", { name: "Done editing" }).click();
  await expect(dispossessed.locator(".markdown-body h2")).toHaveText("Re-read");
  await expect(dispossessed.locator(".markdown-body strong")).toHaveText("essential");

  console.log("[user-story J1] Adding a book, then proving it survives reload");
  await search.fill("");
  await page.getByRole("button", { name: "+ Add book" }).click();
  const newCard = cards.first();
  await newCard.getByRole("button", { name: "Edit record" }).click();
  await newCard.getByLabel("Title").fill("A Psalm for the Wild-Built");
  await newCard.getByLabel("Author").fill("Becky Chambers");
  await newCard.getByLabel("Finished").fill("2026-08-24");
  await newCard.getByLabel("Rating").fill("5");
  await newCard.getByLabel("Notes").fill("A hopeful **comfort read**.");
  await newCard.getByRole("button", { name: "Done editing" }).click();
  await search.fill("A Psalm for the Wild-Built");
  await expect(cards).toHaveCount(1);

  await page.reload();
  await page.getByLabel("Search Books").fill("A Psalm for the Wild-Built");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Becky Chambers");
  await expect(cards.first().locator("strong")).toHaveText("comfort read");

  console.log("[user-story J1] Exporting the searched result and a full recovery backup");
  const resultDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export Books as JSON" }).click(),
  ]).then(([download]) => download);
  const exported = await readDownload(resultDownload) as Array<Record<string, unknown>>;
  expect(exported).toHaveLength(1);
  expect(exported[0]).toMatchObject({
    Title: "A Psalm for the Wild-Built",
    Author: "Becky Chambers",
    Rating: 5,
  });

  await page.goto("/settings/datalets");
  const backupDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup" }).click(),
  ]).then(([download]) => download);
  const backupPath = await backupDownload.path();
  expect(backupPath).not.toBeNull();

  console.log("[user-story J1] Recovering the newly added book after deletion");
  await page.goto("/");
  await page.getByLabel("Search Books").fill("A Psalm for the Wild-Built");
  page.once("dialog", (dialog) => void dialog.accept());
  await cards.first().getByRole("button", { name: "Delete record" }).click();
  await expect(cards).toHaveCount(0);

  await page.goto("/settings/datalets");
  await importBackup(page, backupPath!);
  await page.goto("/");
  await page.getByLabel("Search Books").fill("A Psalm for the Wild-Built");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Becky Chambers");

  expect(await checkInvariants(page)).toEqual([]);
  expect(pageErrors).toEqual([]);
  console.log("[user-story J1] Complete: import, use, persist, export, delete and restore all agree");
});

test("a project tracker is built, used at moderate size, and evolved", async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  console.log("[user-story J2] Building a Projects schema from a fresh browser");
  await page.goto("/settings/schemas");
  await page.getByRole("button", { name: "+ New schema" }).click();
  await page.getByLabel("Schema name").fill("Projects");
  await page.getByLabel("Schema name").press("Enter");

  for (const [index, name] of ["Title", "Owner", "Budget", "Notes"].entries()) {
    await page.getByRole("button", { name: "+ Add property" }).click();
    const propertyName = page.getByLabel("Name", { exact: true }).nth(index);
    await propertyName.fill(name);
    await propertyName.press("Enter");
  }
  await page.getByLabel("Data type").nth(2).selectOption({ label: "Number" });
  await page.getByLabel("Cardinality").nth(3).selectOption({ label: "Optional" });
  await page.getByLabel("Show records as").selectOption({ label: "Title" });

  console.log("[user-story J2] Building a searchable, paged reader on Home");
  await page.goto("/settings/tabs/did:ng:z:HomeTab/blocks");
  await page.getByLabel("Data block schema").selectOption({ label: "Projects" });
  await page.getByRole("button", { name: "+ Add data block" }).click();
  const dataBlock = page.locator("article.builder-card").filter({ hasText: "Data block" }).first();
  await dataBlock.getByLabel("Sort property").selectOption({ label: "Title" });
  await dataBlock.getByLabel("Show a search box").check();
  await dataBlock.getByLabel("Records per page").fill("6");
  const notesWidget = dataBlock.locator(".builder-widget-card").last();
  await expect(notesWidget.getByLabel("Schema property")).toHaveValue("Notes");
  await notesWidget.getByLabel("Field display").selectOption({ label: "Markdown" });

  console.log("[user-story J2] Entering 24 projects through the reader UI");
  await page.goto("/");
  const cards = page.locator(".record-card");
  for (let number = 1; number <= 24; number += 1) {
    await page.getByRole("button", { name: "+ Add Projects" }).click();
    // Title ascending keeps the one blank record first. Fill Title last: as
    // soon as it gains text it moves to its sorted position, so the final
    // Done action is intentionally located globally rather than through the
    // now-moving first-card locator.
    const blank = cards.first();
    await blank.getByRole("button", { name: "Edit record" }).click();
    await blank.getByLabel("Owner").fill(number % 2 === 0 ? "Team A" : "Team B");
    await blank.getByLabel("Budget").fill(String(number * 1_000));
    await blank.getByLabel("Notes").fill(`## Project ${number}\n\nNext review in **two weeks**.`);
    await blank.getByLabel("Title").fill(`Project ${String(number).padStart(2, "0")}`);
    await page.getByRole("button", { name: "Done editing" }).click();
    if (number % 6 === 0) console.log(`[user-story J2] Entered ${number}/24 projects`);
  }
  await expect(page.getByText("Showing 1–6 of 24")).toBeVisible();
  await expect(page.getByText("Page 1 of 4")).toBeVisible();

  console.log("[user-story J2] Adding a Due field after records already exist");
  await page.goto("/settings/schemas");
  await page.getByRole("link", { name: "Edit Projects" }).click();
  await page.getByRole("button", { name: "+ Add property" }).click();
  await page.getByLabel("Name", { exact: true }).last().fill("Due");
  await page.getByLabel("Name", { exact: true }).last().press("Enter");
  await page.getByLabel("Data type").last().selectOption({ label: "Date / time" });
  await page.getByLabel("Cardinality").last().selectOption({ label: "Optional" });

  console.log("[user-story J2] Refining the existing reader around the evolved schema");
  await page.goto("/settings/tabs/did:ng:z:HomeTab/blocks");
  await expect(dataBlock.getByLabel("Schema property").last()).toHaveValue("Due");
  await expect(dataBlock.getByLabel("Field display").last()).toHaveValue("did:ng:z:date");
  await dataBlock.getByLabel("Filter property").selectOption({ label: "Owner" });
  await dataBlock.getByLabel("Filter contains").fill("Team A");
  await dataBlock.getByLabel("Sort property").selectOption({ label: "Budget" });
  await dataBlock.getByLabel("Sort direction").selectOption({ label: "Descending" });
  await page.waitForTimeout(200);

  await page.goto("/");
  await expect(page.getByText("Showing 1–6 of 12")).toBeVisible();
  await expect(cards.first()).toContainText("Project 24");
  await page.getByLabel("Search Projects").fill("Project 12");
  await expect(cards).toHaveCount(1);
  await cards.first().getByRole("button", { name: "Edit record" }).click();
  await cards.first().getByLabel("Due").fill("2026-08-30");
  await page.getByRole("button", { name: "Done editing" }).click();
  await page.reload();
  await page.getByLabel("Search Projects").fill("Project 12");
  await expect(cards).toHaveCount(1);
  await cards.first().getByRole("button", { name: "Edit record" }).click();
  await expect(cards.first().getByLabel("Due")).toHaveValue("2026-08-30");
  await page.getByRole("button", { name: "Done editing" }).click();

  console.log("[user-story J2] Backing up and restoring the evolved tracker");
  await page.goto("/settings/datalets");
  const backupDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup" }).click(),
  ]).then(([download]) => download);
  const backupPath = await backupDownload.path();
  expect(backupPath).not.toBeNull();

  await page.goto("/");
  await page.getByLabel("Search Projects").fill("Project 12");
  await cards.first().getByRole("button", { name: "Edit record" }).click();
  await cards.first().getByLabel("Due").fill("2027-01-01");
  await page.getByRole("button", { name: "Done editing" }).click();
  await page.goto("/settings/datalets");
  await importBackup(page, backupPath!);
  await page.goto("/");
  await page.getByLabel("Search Projects").fill("Project 12");
  await cards.first().getByRole("button", { name: "Edit record" }).click();
  await expect(cards.first().getByLabel("Due")).toHaveValue("2026-08-30");

  expect(await checkInvariants(page)).toEqual([]);
  expect(pageErrors).toEqual([]);
  console.log("[user-story J2] Complete: build, moderate use, schema evolution and recovery all agree");
});

test("three distinct datalets survive switching, archiving and recovery", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const server = await installFakeSyncServer(page);

  console.log("[user-story J5] Creating the first synced datalet and making it recognisable");
  await page.goto("/settings/datalets");
  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await buildDistinctDatalet(page, J5_DATALETS[0]);

  for (let index = 1; index < J5_DATALETS.length; index += 1) {
    const identity = J5_DATALETS[index];
    console.log(`[user-story J5] Creating and distinguishing datalet ${index + 1}/3: ${identity.title}`);
    await page.goto("/settings/datalets");
    const previousActive = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}").activeId as string);
    const reloaded = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
    });
    await page.getByRole("button", { name: "Start an empty one" }).click();
    await reloaded;
    await page.waitForLoadState("domcontentloaded");
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}").activeId as string))
      .not.toBe(previousActive);
    await buildDistinctDatalet(page, identity);
  }
  expect(server.vaultCount()).toBe(3);

  console.log("[user-story J5] Switching repeatedly and checking titles, themes and records never bleed");
  for (const identity of [J5_DATALETS[0], J5_DATALETS[1], J5_DATALETS[2], J5_DATALETS[0]]) {
    const currentTitle = await page.locator(".app-nav-brand").textContent();
    if (currentTitle !== identity.title) await openDatalet(page, identity.title);
    await assertDistinctDatalet(page, identity);
    expect(await checkInvariants(page)).toEqual([]);
  }

  console.log("[user-story J5] Archiving the reading datalet, restoring it, and opening it again");
  await page.goto("/settings/datalets");
  const readingRow = page.locator("#switch-datalet .layout-row").filter({ hasText: J5_DATALETS[1].title });
  await readingRow.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Archived (1)")).toBeVisible();
  await page.getByText("Archived (1)").click();
  const archivedReadingRow = page.locator(".datalet-archive .layout-row").filter({ hasText: J5_DATALETS[1].title });
  await archivedReadingRow.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Archived (")).toHaveCount(0);
  await openDatalet(page, J5_DATALETS[1].title);
  await assertDistinctDatalet(page, J5_DATALETS[1]);

  console.log("[user-story J5] Taking a backup before deletion, then recovering the reading datalet");
  await page.goto("/settings/datalets");
  const backupDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup" }).click(),
  ]).then(([download]) => download);
  const backupPath = await backupDownload.path();
  expect(backupPath).not.toBeNull();

  await page.goto("/");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator(".record-card").getByRole("button", { name: "Delete record" }).click();
  await expect(page.getByText(J5_DATALETS[1].record, { exact: true })).toHaveCount(0);
  await waitForActiveOutbox(page);

  await page.goto("/settings/datalets");
  await importBackup(page, backupPath!);
  await assertDistinctDatalet(page, J5_DATALETS[1]);
  await waitForActiveOutbox(page);

  console.log("[user-story J5] Reopening after recovery to prove the restored data is durable");
  await openDatalet(page, J5_DATALETS[2].title);
  await openDatalet(page, J5_DATALETS[1].title);
  await assertDistinctDatalet(page, J5_DATALETS[1]);

  expect(server.violations).toEqual([]);
  expect(await checkInvariants(page)).toEqual([]);
  expect(pageErrors).toEqual([]);
  console.log("[user-story J5] Complete: three identities, archive/rejoin and backup recovery all agree");
});
