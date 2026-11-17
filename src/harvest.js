// Gathers everything frugalScholia knows about one entity from all sources and returns one merged RDF graph.
// Runs unchanged in the browser (live mode) and in Node (the snapshot GitHub Action).
// ctx = { engine (Comunica), DF (RDF/JS DataFactory), fetch, loadText(path), endpoint, headers,
//         sources? (names to use; default all), openalexKey? (Node only) }
import { NS, iri, keyToIri, keyString, aspectForKey, SOURCES } from "./model.js";
import { lookupQid, detectAspect, harvestWikidata } from "./adapters/wikidata.js";
import { harvestOrcid } from "./adapters/orcid.js";
import { harvestCrossref } from "./adapters/crossref.js";
import { harvestDatacite } from "./adapters/datacite.js";
import { harvestOpenalex, resolveOpenalex } from "./adapters/openalex.js";
import { reconcile } from "./reconcile.js";

export async function harvest(ctx, key, aspectHint, onProgress = () => {}) {
  const enabled = new Set(ctx.sources ?? SOURCES);
  const on = (s) => enabled.has(s);
  const ids = { [key.scheme]: key.value };
  const log = [];
  const quads = [];
  const step = async (source, what, fn) => {
    const t0 = Date.now();
    onProgress({ source, what, state: "running" });
    try {
      const got = await fn();
      const list = Array.isArray(got) ? got : got?.quads ?? [];
      quads.push(...list);
      log.push({ source, what, quads: list.length, ms: Date.now() - t0 });
      onProgress({ source, what, state: "done", quads: list.length });
      return got;
    } catch (err) {
      log.push({ source, what, error: String(err.message ?? err), ms: Date.now() - t0 });
      onProgress({ source, what, state: "error", error: String(err.message ?? err) });
      return null;
    }
  };
  const fill = (more) => { for (const [k, v] of Object.entries(more ?? {})) if (v && !ids[k]) ids[k] = v; };

  // 1. Cross-identifiers. OpenAlex ids are resolved via OpenAlex; everything else is looked up on Wikidata.
  if (key.scheme === "openalex" && on("openalex")) fill(await resolveOpenalex(ctx, key.value).catch(() => null));
  if (!ids.wikidata && on("wikidata")) {
    for (const scheme of ["orcid", "doi", "issn"]) {
      if (!ids[scheme]) continue;
      ids.wikidata = await lookupQid(ctx, scheme, ids[scheme]).catch(() => null);
      if (ids.wikidata) break;
    }
  }
  const aspect = aspectHint || aspectForKey(key)
    || (ids.wikidata && on("wikidata") ? await detectAspect(ctx, ids.wikidata).catch(() => "topic") : "topic");

  // 2. Wikidata, the hub for topics and for further identifiers.
  if (ids.wikidata && on("wikidata")) await step("wikidata", `${aspect} neighbourhood`, () => harvestWikidata(ctx, ids.wikidata, aspect));
  const me = iri.wikidata(ids.wikidata ?? "");
  for (const q of quads) {
    if (q.subject.value !== me || q.predicate.value !== NS.schema + "sameAs") continue;
    const v = q.object.value;
    if (v.startsWith("https://orcid.org/")) fill({ orcid: v.slice(18) });
    if (v.startsWith("https://doi.org/")) fill({ doi: v.slice(16) });
    if (v.startsWith("urn:issn:")) fill({ issn: v.slice(9) });
    if (v.startsWith("https://openalex.org/")) fill({ openalex: v.slice(21) });
  }
  if (ids.openalex && ids.openalex[0] !== { author: "A", work: "W", venue: "S", topic: "T" }[aspect] && !(aspect === "topic" && ids.openalex[0] === "C")) delete ids.openalex;

  // 3. Source-specific enrichment; independent hosts, so in parallel.
  const jobs = [];
  if (aspect === "author" && ids.orcid) {
    if (on("orcid")) jobs.push(step("orcid", "record and works", () => harvestOrcid(ctx, ids.orcid)));
    if (on("crossref")) jobs.push(step("crossref", "works with this ORCID", () => harvestCrossref(ctx, { orcid: ids.orcid })));
    if (on("datacite")) jobs.push(step("datacite", "works with this ORCID", () => harvestDatacite(ctx, { orcid: ids.orcid })));
  }
  if (aspect === "author" && (ids.orcid || ids.openalex) && on("openalex")) jobs.push(step("openalex", "works by this author", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "work" && ids.doi) {
    if (on("crossref")) jobs.push(step("crossref", "work and references", () => harvestCrossref(ctx, { dois: [ids.doi], references: true })));
    if (on("datacite")) jobs.push(step("datacite", "work and relations", () => harvestDatacite(ctx, { dois: [ids.doi] })));
  }
  if (aspect === "work" && (ids.doi || ids.openalex) && on("openalex")) jobs.push(step("openalex", "work, references, citing works", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "venue" && ids.issn && on("crossref")) jobs.push(step("crossref", "journal and recent works", () => harvestCrossref(ctx, { issn: ids.issn })));
  if (aspect === "venue" && (ids.issn || ids.openalex) && on("openalex")) jobs.push(step("openalex", "source and recent works", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "topic" && ids.openalex && on("openalex")) jobs.push(step("openalex", "topic and recent works", () => harvestOpenalex(ctx, aspect, ids)));
  const results = await Promise.all(jobs);

  // 4. DOIs listed in ORCID that no source has described yet: try Crossref, then DataCite.
  if (aspect === "author") {
    const orcidDois = results.find((r) => r?.dois)?.dois ?? [];
    const described = () => new Set(quads.filter((q) => q.predicate.value === NS.schema + "name").map((q) => q.subject.value));
    let missing = orcidDois.filter((d) => !described().has(iri.doi(d)));
    if (missing.length && on("crossref")) await step("crossref", `${missing.length} more DOIs from ORCID`, () => harvestCrossref(ctx, { dois: missing }));
    missing = orcidDois.filter((d) => !described().has(iri.doi(d)));
    if (missing.length && on("datacite")) await step("datacite", `${missing.length} more DOIs from ORCID`, () => harvestDatacite(ctx, { dois: missing }));
  }

  // 5. Merge.
  const merged = reconcile(ctx.DF, quads);
  return { key: keyString(key), aspect, iri: merged.canonical(keyToIri(key)), ids, quads: merged.quads, log };
}
