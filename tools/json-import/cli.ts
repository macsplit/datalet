/**
 * Usage: tsx tools/json-import/cli.ts <input.json> <output.json> [app title]
 *
 * Reads a DSL1 document (see datalet-spec.md), infers a schema from it, and
 * writes a backup file the app's existing, unmodified "Start an empty one" +
 * "Import backup" buttons can load. This tool never talks to a running
 * datalet, the sync server, or the app's own source - it only produces a
 * file in the app's documented backup format.
 *
 * [app title], if given, becomes the new datalet's display name (the
 * Settings.appTitle the header shows) instead of the generic "Datalet" a
 * fresh, untitled one falls back to. Defaults to the input file's own name.
 */

import { basename, extname } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { buildBackup, titleCase } from "./buildBackup";
import { inferModel } from "./infer";
import type { ImportDocument } from "./types";

// Well under the ~5MB browser localStorage budget, which this import shares
// with everything else already in that browser origin (see datalet-spec.md's
// "Size limits" section) - there is no way to know from here how much
// headroom actually exists on the destination, so this stays conservative.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function main(): void {
  const [inputPath, outputPath, explicitTitle] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error("Usage: tsx tools/json-import/cli.ts <input.json> <output.json> [app title]");
    process.exitCode = 1;
    return;
  }
  const appTitle = explicitTitle ?? titleCase(basename(inputPath, extname(inputPath)));

  const raw = readFileSync(inputPath, "utf8");
  let doc: ImportDocument;
  try {
    doc = JSON.parse(raw) as ImportDocument;
  } catch (error) {
    console.error(`"${inputPath}" is not valid JSON: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(`"${inputPath}" must be a JSON object of entity name -> array of records.`);
    process.exitCode = 1;
    return;
  }

  const model = inferModel(doc);
  const warnings = [...model.warnings];
  const result = buildBackup(model, (message) => warnings.push(message), appTitle);

  if (result.byteLength > MAX_OUTPUT_BYTES) {
    console.error(
      `Generated backup is ${(result.byteLength / 1024 / 1024).toFixed(2)}MB, over the ` +
        `${(MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0)}MB safety ceiling. Not written - ` +
        `split the source data or raise MAX_OUTPUT_BYTES deliberately.`,
    );
    process.exitCode = 1;
    return;
  }

  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(result.backup, null, 2));
  renameSync(tempPath, outputPath); // atomic on the same filesystem: no half-written file on interrupt

  console.log(`Wrote ${outputPath}`);
  console.log(`  App title: "${appTitle}"`);
  console.log(`  ${result.entityCount} entities, ${result.recordCount} records, ${(result.byteLength / 1024).toFixed(1)}KB`);
  if (warnings.length > 0) {
    console.log(`  ${warnings.length} thing(s) worth a look:`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  console.log(`Next: in the app, Manage datalets -> "Start an empty one", then "Import backup" and pick ${outputPath}.`);
}

main();
