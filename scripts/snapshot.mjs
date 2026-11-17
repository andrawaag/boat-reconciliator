#!/usr/bin/env node
// Builds static, pre-merged RDF snapshots for the seeds in site.config.json, using exactly the code the
// browser uses for live pages (src/harvest.js). Output: data/<aspect>/<key>.nq.gz plus data/manifest.json.
//   npm run snapshot                    # rebuild every seed
//   npm run snapshot -- --missing       # only seeds without a snapshot; drop snapshots of removed seeds
//   npm run snapshot -- orcid:0000-…    # only these keys
// Env: WIKIDATA_ENDPOINT, OPENALEX_API_KEY (optional), MAX_QUADS (default 200000).
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { QueryEngine } from "@comunica/query-sparql";
import { DataFactory, Writer } from "n3";
import { harvest } from "../src/harvest.js";
import { parseKey, keyString, iriToKey } from "../src/model.js";
import { normalizeConfig } from "../src/config.js";

const root = new URL("../", import.meta.url);
const loadText = (p) => readFile(new URL(p, root), "utf8");
const config = normalizeConfig(JSON.parse(await loadText("site.config.json")));
const MAX_QUADS = Number(process.env.MAX_QUADS || 200000);
const ctx = {
  engine: new QueryEngine(),
  DF: DataFactory,
  fetch,
  loadText,
  endpoint: process.env.WIKIDATA_ENDPOINT || config.wikidataEndpoint,
  sources: config.sources,
  headers: { "User-Agent": "frugalScholia-snapshot/0.3 (static site generator)" },
  openalexKey: process.env.OPENALEX_API_KEY || undefined,
};

const args = process.argv.slice(2);
const missingOnly = args.includes("--missing");
const only = new Set(args.filter((a) => !a.startsWith("--")).map((k) => keyString(parseKey(k))));
let manifest = { entities: {}, aliases: {} };
try { manifest = JSON.parse(await loadText("data/manifest.json")); } catch {}

const seeds = config.seeds.map((s) => ({ ...s, parsed: parseKey(s.key) }));
for (const s of seeds) if (!s.parsed) { console.error(`bad seed in site.config.json: ${s.key}`); process.exitCode = 1; }
const seedKeys = new Set(seeds.filter((s) => s.parsed).map((s) => keyString(s.parsed)));

// Drop snapshots whose seed was removed from the config.
for (const [k, e] of Object.entries(manifest.entities)) {
  if (seedKeys.has(k)) continue;
  await rm(new URL(e.file, root), { force: true });
  delete manifest.entities[k];
  console.log(`drop ${k}: no longer a seed`);
}
for (const [a, k] of Object.entries(manifest.aliases ?? {})) if (!manifest.entities[k]) delete manifest.aliases[a];

const toNQuads = (quads) => new Promise((ok, fail) => {
  const w = new Writer({ format: "N-Quads" });
  w.addQuads(quads);
  w.end((err, out) => (err ? fail(err) : ok(out)));
});

for (const { parsed: key, aspect: aspectHint } of seeds) {
  if (!key) continue;
  const k = keyString(key);
  if (only.size && !only.has(k)) continue;
  if (missingOnly && manifest.entities[k]) continue;
  const t0 = Date.now();
  const g = await harvest(ctx, key, aspectHint);
  for (const l of g.log) console.log(`  ${l.source.padEnd(9)} ${l.what.padEnd(32)} ${l.error ? "ERROR " + l.error.slice(0, 120) : l.quads + " quads"} (${l.ms} ms)`);
  if (g.quads.length > MAX_QUADS) { console.log(`skip ${k}: ${g.quads.length} quads > ${MAX_QUADS}; the site will harvest it live`); continue; }
  if (!g.log.length || g.log.every((l) => l.error)) { console.log(`skip ${k}: no source answered`); process.exitCode = 1; continue; }
  const file = `data/${g.aspect}/${key.scheme}_${key.value.replace(/[^A-Za-z0-9.-]/g, "_")}.nq.gz`;
  await mkdir(new URL(`data/${g.aspect}/`, root), { recursive: true });
  const gz = gzipSync(await toNQuads(g.quads), { level: 9 });
  await writeFile(new URL(file, root), gz);
  const name = g.quads.find((q) => q.subject.value === g.iri && q.predicate.value === "http://schema.org/name")?.object.value;
  manifest.entities[k] = { name, aspect: g.aspect, iri: g.iri, file, quads: g.quads.length, bytes: gz.length, generated: new Date().toISOString(), endpoint: ctx.endpoint, log: g.log };
  // Every identifier of the entity (its ORCID, DOI, QID, ISSNs, OpenAlex id) resolves to this snapshot.
  const sameAs = g.quads.filter((q) => q.subject.value === g.iri && q.predicate.value === "http://schema.org/sameAs").map((q) => q.object.value);
  for (const i of [g.iri, ...sameAs]) { const a = iriToKey(i); if (a && keyString(a) !== k) manifest.aliases[keyString(a)] = k; }
  console.log(`ok   ${k} (${g.aspect}): ${g.quads.length} quads, ${(gz.length / 1024).toFixed(0)} KiB gz, ${Date.now() - t0} ms`);
}
manifest.generated = new Date().toISOString();
await writeFile(new URL("data/manifest.json", root), JSON.stringify(manifest, null, 2) + "\n");
