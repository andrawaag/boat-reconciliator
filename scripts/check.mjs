#!/usr/bin/env node
// Harvest one entity live and run all of its panels in Node. Handy for developing adapters and queries.
//   npm run check -- orcid:0000-0001-9488-1870
//   npm run check -- doi:10.1145/2629489 work
import { readFile } from "node:fs/promises";
import { QueryEngine } from "@comunica/query-sparql";
import { DataFactory, Store } from "n3";
import { harvest } from "../src/harvest.js";
import { parseKey } from "../src/model.js";
import { fillPanel } from "../src/aspects.js";
import { normalizeConfig, panelsFor } from "../src/config.js";

const root = new URL("../", import.meta.url);
const loadText = (p) => readFile(new URL(p, root), "utf8");
const engine = new QueryEngine();
const config = normalizeConfig(JSON.parse(await loadText("site.config.json")));
const key = parseKey(process.argv[2] ?? "");
if (!key) { console.error("usage: npm run check -- <orcid:…|doi:…|issn:…|wikidata:Q…> [aspect]"); process.exit(2); }
const ctx = { engine, DF: DataFactory, fetch, loadText, endpoint: process.env.WIKIDATA_ENDPOINT || config.wikidataEndpoint, sources: config.sources, headers: { "User-Agent": "koetai-bibliography-check/0.2" }, openalexKey: process.env.OPENALEX_API_KEY };

const t0 = Date.now();
const g = await harvest(ctx, key, process.argv[3]);
console.log(`${g.key} → ${g.aspect}, canonical ${g.iri}, ${g.quads.length} quads in ${Date.now() - t0} ms`);
for (const l of g.log) console.log(`  ${l.source.padEnd(9)} ${l.what.padEnd(28)} ${l.error ? "ERROR " + l.error.slice(0, 140) : `${l.quads} quads`} (${l.ms} ms)`);
const store = new Store(g.quads);
const prefixes = await loadText("queries/prefixes.rq");
for (const p of panelsFor(config, g.aspect)) {
  const file = p.file;
  const t1 = Date.now();
  try {
    const rows = await (await engine.queryBindings(fillPanel(prefixes, await loadText(file), g.iri), { sources: [store], unionDefaultGraph: true })).toArray();
    const first = rows[0] ? [...rows[0]].map(([k, v]) => `${k.value}=${v.value.slice(0, 40)}`).join(", ") : "";
    console.log(`  panel ${p.id.padEnd(12)} ${String(rows.length).padStart(5)} rows ${String(Date.now() - t1).padStart(5)} ms  ${first}`);
  } catch (e) { console.log(`  panel ${p.id.padEnd(12)} ERROR ${e.message}`); process.exitCode = 1; }
}
