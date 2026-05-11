#!/usr/bin/env node
// Patch snapshot YAML so FK columns referencing uuid PKs are also typed as uuid.
// Without this, schema apply on Postgres fails with:
//   "Key columns ... are of incompatible types: character varying and uuid"

import fs from "node:fs";

const path = process.argv[2] ?? "data/snapshot-prod-bootstrap.yaml";
const src = fs.readFileSync(path, "utf8");

const fkFields = [
  { collection: "festival_awards", field: "movie" },
  { collection: "movies_tags", field: "movies_id" },
  { collection: "movies_tags", field: "tags_id" },
];

let out = src;
for (const { collection, field } of fkFields) {
  // Match the field block: "    field: <field>\n    type: string\n    meta:\n..." up to the next "  - " entry.
  const blockRe = new RegExp(
    `(    field: ${field}\\n)(    type: )string(\\n    meta:\\n[\\s\\S]*?\\n      )special: null(\\n)`,
    "g"
  );
  const before = out;
  out = out.replace(blockRe, (_m, lead, typePrefix, metaUpToSpecial, tail) => {
    return `${lead}${typePrefix}uuid${metaUpToSpecial}special:\n        - uuid${tail}`;
  });
  if (out === before) {
    console.error(`WARN: did not patch ${collection}.${field} — pattern not found`);
  } else {
    console.log(`patched ${collection}.${field}: type=string→uuid, special=null→[uuid]`);
  }
}

fs.writeFileSync(path, out);
console.log(`wrote ${path}`);
