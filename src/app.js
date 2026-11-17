// koetai-reconciliator web app: routing, loading a graph (snapshot or live harvest), and rendering panels.
import { QueryEngine, Store, Parser, Writer, DataFactory } from "../vendor/comunica.js";
import { ASPECTS, ENDPOINTS, fillPanel } from "./aspects.js";
import { normalizeConfig, panelsFor } from "./config.js";
import { parseKey, keyString, iriToKey } from "./model.js";
import { harvest } from "./harvest.js";
import { searchObo } from "./adapters/obo.js";
import { gatherFixes, buildFixCommands, fixKey } from "./wikidata-fix.js";
import { gatherCandidate, findExisting, searchByName, buildCommands, quickStatementsUrl, propertyLabel, propertyUrl } from "./wikidata-create.js";

const engine = new QueryEngine();
const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");

// ---------- instance configuration (site.config.json) ----------
const config = normalizeConfig(await fetch("site.config.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
$(".brand").textContent = config.title;
document.documentElement.style.setProperty("--accent-config", config.accent);

// ---------- settings ----------
const store = {
  get: (k, d) => { try { return localStorage.getItem(`kr.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`kr.${k}`, v); } catch {} },
};
const endpoints = { site: { label: `Site default (${new URL(config.wikidataEndpoint).host})`, url: config.wikidataEndpoint }, ...ENDPOINTS };
const settings = { mode: config.liveHarvest ? store.get("mode", "auto") : "snapshot", endpoint: store.get("endpoint", "site") };
if (!endpoints[settings.endpoint]) settings.endpoint = "site";
const endpointSel = $("#endpoint");
for (const [id, e] of Object.entries(endpoints)) endpointSel.add(new Option(e.label, id));
endpointSel.value = settings.endpoint;
$("#mode").value = settings.mode;
if (!config.liveHarvest) $(".settings").hidden = true;
for (const id of ["mode", "endpoint"]) $(`#${id}`).addEventListener("change", (e) => { settings[id] = e.target.value; store.set(id, e.target.value); graphs.clear(); route(); });

// ---------- text resources ----------
const texts = new Map();
const loadText = (p) => texts.get(p) ?? texts.set(p, fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); })).get(p);
let manifest = null;
const getManifest = async () => (manifest ??= await fetch("data/manifest.json").then((r) => (r.ok ? r.json() : { entities: {}, aliases: {} })).catch(() => ({ entities: {}, aliases: {} })));

// ---------- loading graphs ----------
const graphs = new Map(); // key -> Promise<graph>

async function loadSnapshot(entry) {
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`snapshot ${entry.file}: HTTP ${res.status}`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return new Parser({ format: "N-Quads" }).parse(text);
}

function loadGraph(key, aspectHint, onProgress) {
  const id = `${keyString(key)}|${aspectHint ?? ""}`;
  if (!graphs.has(id)) graphs.set(id, (async () => {
    const m = await getManifest();
    const snapKey = m.entities[keyString(key)] ? keyString(key) : m.aliases?.[keyString(key)];
    const entry = snapKey && m.entities[snapKey];
    if (entry && settings.mode !== "live" && (!aspectHint || aspectHint === entry.aspect)) {
      onProgress({ source: "snapshot", what: entry.file, state: "running" });
      const t0 = performance.now();
      const quads = await loadSnapshot(entry);
      onProgress({ source: "snapshot", what: entry.file, state: "done", quads: quads.length });
      return { ...entry, key: snapKey, quads, store: new Store(quads), snapshot: entry, log: [{ source: "snapshot", what: `built ${entry.generated.slice(0, 10)}`, quads: quads.length, ms: Math.round(performance.now() - t0) }, ...entry.log] };
    }
    if (settings.mode === "snapshot") throw new Error("No snapshot for this entity, and the mode is set to snapshots only.");
    const ctx = { engine, DF: DataFactory, fetch: window.fetch.bind(window), loadText, endpoint: endpoints[settings.endpoint].url, sources: config.sources, headers: {} };
    const g = await harvest(ctx, key, aspectHint, onProgress);
    return { ...g, store: new Store(g.quads) };
  })());
  const p = graphs.get(id);
  p.catch(() => graphs.delete(id));
  return p;
}

// ---------- rendering helpers ----------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
};

const COLUMN_ASPECT = { work: "work", cited: "work", citing: "work", author: "author", coauthor: "author", venue: "venue", topic: "topic", parent: "term", child: "term", replacedBy: "term", code: "term" };
const HIDDEN = new Set(["position"]);

function externalUrl(key) {
  return {
    orcid: `https://orcid.org/${key.value}`,
    doi: `https://doi.org/${key.value}`,
    wikidata: `https://www.wikidata.org/wiki/${key.value}`,
    issn: `https://portal.issn.org/resource/ISSN/${key.value}`,
    openalex: `https://openalex.org/${key.value}`,
    obo: `http://purl.obolibrary.org/obo/${key.value}`,
  }[key.scheme];
}

function entityLink(iri, label, column) {
  const key = iriToKey(iri);
  const aspect = COLUMN_ASPECT[column];
  const text = label || (key ? `${key.scheme}:${key.value}` : "(unnamed)");
  // Codes in other terminologies (SNOMED CT, MeSH, ICD, …) have no page here: link to the terminology itself.
  if (!key) return /^https?:\/\//.test(iri) ? h("a", { href: iri, target: "_blank", rel: "noopener", class: "external", title: iri }, label || iri) : h("span", { class: "unlinked", title: iri }, text);
  return h("a", { href: `#/${aspect ? aspect + "/" : ""}${keyString(key)}` }, text);
}

function sourceBadges(value) {
  return h("span", { class: "badges" }, value.split(" ").filter(Boolean).map((s) => h("span", { class: `badge src-${s}` }, s)));
}

function renderTable(rows, vars) {
  const cols = vars.filter((v) => !v.endsWith("Label") && !HIDDEN.has(v));
  if (!rows.length) return h("p", { class: "empty" }, "Nothing found in the merged graph.");
  const body = rows.map((b) => h("tr", {}, cols.map((c) => {
    const t = b.get(c);
    if (!t) return h("td");
    if (c === "sources") return h("td", {}, sourceBadges(t.value));
    if (t.termType === "NamedNode") return h("td", {}, entityLink(t.value, b.get(`${c}Label`)?.value, c));
    const numeric = /integer|int|decimal|double/.test(t.datatype?.value ?? "");
    return h("td", { class: numeric ? "num" : c === "date" ? "nowrap" : null }, t.value);
  })));
  const table = h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))), h("tbody", {}, body));
  return rows.length > 12 ? h("div", { class: "scroll" }, table) : table;
}

function renderKv(rows, vars) {
  const b = rows[0];
  if (!b) return h("p", { class: "empty" }, "No details.");
  return h("dl", { class: "kv" }, vars.filter((v) => !v.endsWith("Label") && b.get(v)).map((v) => {
    const t = b.get(v);
    return [h("dt", {}, v), h("dd", {}, t.termType === "NamedNode" ? entityLink(t.value, b.get(`${v}Label`)?.value, v) : t.value)];
  }));
}

// Bars: first variable is the label, second the value. Integer labels (years) get their gaps filled.
function renderBars(rows, vars) {
  const [lx, ly] = vars;
  const pairs = rows.map((b) => [b.get(lx)?.value, Number(b.get(ly)?.value)]).filter(([x, y]) => x != null && Number.isFinite(y));
  if (!pairs.length) return h("p", { class: "empty" }, "Nothing to chart.");
  let data;
  if (pairs.every(([x]) => /^-?\d{1,4}$/.test(x))) {
    const counts = new Map(pairs.map(([x, y]) => [Number(x), y]));
    const xs = [...counts.keys()];
    data = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) data.push({ x: String(x), y: counts.get(x) ?? 0 });
  } else data = pairs.map(([x, y]) => ({ x, y }));
  const W = 640, H = 180, pad = 24, max = Math.max(...data.map((d) => d.y));
  const bw = (W - pad) / data.length;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 20}`);
  svg.setAttribute("class", "bars");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${ly} by ${lx}, ${data[0].x} to ${data.at(-1).x}`);
  const step = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    const bh = (d.y / max) * (H - 10);
    const r = document.createElementNS(ns, "rect");
    Object.entries({ x: pad + i * bw + 1, y: H - bh, width: Math.max(bw - 2, 1), height: bh, rx: 2 }).forEach(([k, v]) => r.setAttribute(k, v));
    const title = document.createElementNS(ns, "title"); title.textContent = `${d.x}: ${d.y}`; r.append(title);
    svg.append(r);
    if (i % step === 0) {
      const t = document.createElementNS(ns, "text");
      Object.entries({ x: pad + i * bw + bw / 2, y: H + 15, "text-anchor": "middle" }).forEach(([k, v]) => t.setAttribute(k, v));
      t.textContent = d.x; svg.append(t);
    }
  });
  const yl = document.createElementNS(ns, "text");
  Object.entries({ x: 0, y: 12 }).forEach(([k, v]) => yl.setAttribute(k, v)); yl.textContent = max; svg.append(yl);
  return svg;
}

function renderIds(rows) {
  return h("ul", { class: "ids" }, rows.map((b) => {
    const key = iriToKey(b.get("id").value);
    if (!key) return null;
    return h("li", {}, h("span", { class: "scheme" }, key.scheme), " ", h("a", { href: externalUrl(key), rel: "noopener" }, key.value));
  }));
}

// Vega-Lite: the panel's "spec" from site.config.json, with the query results as data.
// Loaded from a CDN only when a page actually has such a panel.
let vegaReady;
const VEGA = ["https://cdn.jsdelivr.net/npm/vega@5.30.0", "https://cdn.jsdelivr.net/npm/vega-lite@5.21.0", "https://cdn.jsdelivr.net/npm/vega-embed@6.26.0"];
function loadVega() {
  return (vegaReady ??= (async () => {
    for (const src of VEGA) await new Promise((ok, fail) => { const s = h("script", { src }); s.onload = ok; s.onerror = () => fail(new Error(`Could not load ${src}`)); document.head.append(s); });
    return window.vegaEmbed;
  })());
}
async function renderVegaLite(rows, vars, panel, body) {
  if (!rows.length) return h("p", { class: "empty" }, "Nothing to chart.");
  const values = rows.map((b) => Object.fromEntries(vars.map((v) => {
    const t = b.get(v);
    if (!t) return [v, null];
    return [v, /integer|int|decimal|double|float/.test(t.datatype?.value ?? "") ? Number(t.value) : t.value];
  })));
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  const el = h("div", { class: "vega" });
  body.replaceChildren(el);
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", width: "container", height: 220, background: null,
    ...panel.spec, data: { values },
    config: { axis: { labelColor: c("--muted"), titleColor: c("--muted"), gridColor: c("--line"), domainColor: c("--line"), tickColor: c("--line") }, legend: { labelColor: c("--ink"), titleColor: c("--muted") }, view: { stroke: null }, ...(panel.spec?.config ?? {}) },
  };
  await (await loadVega())(el, spec, { actions: { export: true, source: false, compiled: false, editor: false }, renderer: "svg" });
}

const RENDER = { table: renderTable, kv: renderKv, bars: renderBars, ids: renderIds, "vega-lite": renderVegaLite };

async function runPanel(graph, panel, el) {
  const file = panel.file;
  const body = $(".panel-body", el);
  try {
    const query = fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri);
    $(".sparql pre", el).textContent = query;
    const t0 = performance.now();
    const result = await engine.query(query, { sources: [graph.store], unionDefaultGraph: true });
    const vars = (await result.metadata()).variables.map((v) => (v.variable ?? v).value);
    const rows = await (await result.execute()).toArray();
    const render = RENDER[panel.render];
    if (!render) throw new Error(`Unknown renderer "${panel.render}". Use one of: ${Object.keys(RENDER).join(", ")}.`);
    const node = await render(rows, vars, panel, body);
    if (node) body.replaceChildren(node);
    $(".timing", el).textContent = `${rows.length} rows · ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    body.replaceChildren(h("p", { class: "error" }, String(err.message ?? err)));
  }
}

function panelShell(panel) {
  return h("section", { class: `panel panel-${panel.render}${panel.wide ? " wide" : ""}`, id: `panel-${panel.id}` },
    h("header", {}, h("h2", {}, panel.title), h("span", { class: "timing" })),
    h("div", { class: "panel-body" }, h("p", { class: "loading" }, "Querying…")),
    h("details", { class: "sparql" }, h("summary", {}, "SPARQL"), h("pre")));
}

function downloadGraph(graph) {
  const w = new Writer({ format: "N-Quads" });
  w.addQuads(graph.quads);
  w.end((err, text) => {
    if (err) return;
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/n-quads" })), download: `${graph.key.replace(/[^\w.-]/g, "_")}.nq` });
    document.body.append(a); a.click(); a.remove();
  });
}

// ---------- Add to Wikidata (authors without a Wikidata item) ----------
async function wikidataPanel(graph) {
  const run = async (file) => (await engine.queryBindings(fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const cand = await gatherCandidate(run, graph.iri);
  if (cand.wikidata.length || graph.iri.startsWith("http://www.wikidata.org/") || !cand.ids.length) return null;

  const status = h("span", { class: "timing" }, "Checking Wikidata…");
  const box = h("div", { class: "panel-body" });
  const el = h("section", { class: "panel wide wd-create", id: "panel-add-to-wikidata" }, h("header", {}, h("h2", {}, "Not on Wikidata yet"), status), box);

  const [existing, byName] = await Promise.all([
    findExisting(engine, endpoints[settings.endpoint].url, cand.ids).catch(() => []),
    searchByName(cand.label).catch(() => []),
  ]);
  status.textContent = existing.length ? "Identifier already on Wikidata" : `${cand.ids.length} identifiers found`;

  let target = existing[0]?.qid ?? null;
  const textarea = h("textarea", { class: "qs", rows: 10, spellcheck: "false", "aria-label": "QuickStatements commands" });
  const regenerate = () => {
    const have = new Set(existing.filter((e) => e.qid === target).map((e) => `${e.property}|${e.value}`));
    const ids = target ? cand.ids.filter((x) => !have.has(`${x.property}|${x.value}`)) : cand.ids;
    textarea.value = buildCommands({ ...cand, ids }, { target });
    modeLine.replaceChildren(target
      ? h("span", {}, "Adds the missing identifiers to ", h("a", { href: `https://www.wikidata.org/wiki/${target}`, target: "_blank", rel: "noopener" }, target), ". ", h("button", { type: "button", class: "linkish", onclick: () => { target = null; regenerate(); } }, "Create a new item instead"))
      : h("span", {}, "Creates a new item for a human researcher with these names and identifiers."));
  };
  const modeLine = h("p", { class: "mode-line" });
  const useItem = (qid) => h("button", { type: "button", class: "linkish", onclick: () => { target = qid; regenerate(); textarea.scrollIntoView({ block: "nearest" }); } }, "add identifiers to this item");

  box.replaceChildren(...h("div", {},
    h("p", {}, "No Wikidata item carries this person's ORCID or OpenAlex ID. You can add them to Wikidata with ",
      h("a", { href: "https://www.wikidata.org/wiki/Help:QuickStatements", target: "_blank", rel: "noopener" }, "QuickStatements"),
      ", which runs the edits under your own Wikimedia account. Check the possible matches first so you don't create a duplicate."),
    existing.length > 0 && h("div", { class: "warn" }, h("b", {}, "Already on Wikidata: "), existing.map((e, i) => [i ? "; " : "",
      h("a", { href: `https://www.wikidata.org/wiki/${e.qid}`, target: "_blank", rel: "noopener" }, e.label ? `${e.label} (${e.qid})` : e.qid), ` has ${propertyLabel(e.property)} ${e.value}`])),
    h("h3", {}, "Identifiers"),
    h("ul", { class: "ids" }, cand.ids.map((x) => h("li", {}, h("span", { class: "scheme" }, propertyLabel(x.property)), " ",
      h("a", { href: propertyUrl(x.property, x.value), target: "_blank", rel: "noopener" }, x.value), " ",
      h("span", { class: "badges" }, [...x.sources].map((s) => h("span", { class: `badge src-${s}` }, s)))))),
    byName.length ? [h("h3", {}, `Possible matches for “${cand.label}”`), h("ul", { class: "matches" }, byName.map((m) => h("li", {},
      h("a", { href: `https://www.wikidata.org/wiki/${m.qid}`, target: "_blank", rel: "noopener" }, `${m.label ?? m.qid} (${m.qid})`),
      m.description ? ` · ${m.description} · ` : " · ", useItem(m.qid))))] : h("p", { class: "muted" }, `No Wikidata items match the name “${cand.label}”.`),
    h("h3", {}, "QuickStatements"),
    modeLine,
    textarea,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
      h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
    h("p", { class: "muted small" }, "Review and edit the commands above before running them. In QuickStatements, log in, press Run, and check the new item. Then use “Fetch live instead” on this page to see it linked.")).childNodes);
  regenerate();
  return el;
}

// ---------- Improve Wikidata (ontology terms) ----------
async function termFixPanel(graph) {
  const run = async (file) => (await engine.queryBindings(fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const fix = await gatherFixes(run, graph.iri, fetch);
  if (!fix.qid) return null;
  const proposals = [fix.own, ...fix.additions, ...fix.removals].filter(Boolean);
  if (!proposals.length && !fix.review.length) return null;

  const wdLink = (qid) => h("a", { href: `https://www.wikidata.org/wiki/${qid}`, target: "_blank", rel: "noopener" }, qid);
  const codeLink = (x) => h("a", { href: x.url, target: "_blank", rel: "noopener" }, x.code);
  const chosen = new Set([fix.own, ...fix.additions].filter(Boolean).map(fixKey)); // removals stay opt-in
  const textarea = h("textarea", { class: "qs", rows: 6, spellcheck: "false", "aria-label": "QuickStatements commands" });
  const regenerate = () => { textarea.value = buildFixCommands(fix, chosen); };
  const option = (x, text) => h("li", {}, h("label", {},
    h("input", { type: "checkbox", checked: chosen.has(fixKey(x)), onchange: (e) => { e.target.checked ? chosen.add(fixKey(x)) : chosen.delete(fixKey(x)); regenerate(); } }),
    " ", text));

  const body = h("div", { class: "panel-body" },
    h("p", {}, "Linked Wikidata item: ", wdLink(fix.qid),
      fix.matchedBy.length ? ` (matched through shared codes: ${fix.matchedBy.join(", ")}; it does not carry this term's own ID).` : "."),
    proposals.length ? [
      h("h3", {}, "Proposed edits"),
      h("ul", { class: "fixes" },
        fix.own && option(fix.own, [h("b", {}, "Add "), `${fix.own.vocabulary} ID `, codeLink(fix.own), ` (${fix.own.property}).`]),
        fix.additions.map((a) => option(a, [h("b", {}, "Add "), `${a.vocabulary} `, codeLink(a), ` (${a.property}): ${fix.label} states it as an exact match.`])),
        fix.removals.map((r) => option(r, [h("b", {}, "Remove "), `${r.vocabulary} `, codeLink(r), ` (${r.property}): obsolete in ${fix.label} (“${r.status.label}”)`, r.status.replacedBy ? `, replaced by ${r.status.replacedBy}` : "", ". Unticked by default; removing a statement can't be undone from here."]))),
      h("h3", {}, "QuickStatements"),
      textarea,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
        h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
      h("p", { class: "muted small" }, `Additions cite ${fix.label} (stated in, reference URL, retrieved) and mark codes with mapping relation type “exact match” (P4390). You run the edits in QuickStatements under your own Wikimedia account; review them first.`),
    ] : h("p", {}, `Wikidata already has this term's ID and every code ${fix.label} states as an exact match.`),
    fix.review.length ? [
      h("h3", {}, "Only on Wikidata (review; no edits proposed)"),
      h("ul", { class: "matches" }, fix.review.map((r) => h("li", {}, `${r.vocabulary} `, codeLink(r), ` · ${r.note}`))),
    ] : null);
  regenerate();
  return h("section", { class: "panel wide wd-create", id: "panel-improve-wikidata" },
    h("header", {}, h("h2", {}, "Improve Wikidata"), h("span", { class: "timing" }, proposals.length ? `${proposals.length} possible edits` : "In agreement")), body);
}

// ---------- pages ----------
let routeId = 0;
async function entityPage(aspectHint, rawKey) {
  const myRoute = routeId;
  const key = parseKey(rawKey);
  if (!key) return notFound(`"${rawKey}" is not an ORCID, DOI, ISSN or Wikidata QID.`);
  const progress = h("ol", { class: "progress" });
  const steps = new Map();
  const onProgress = (p) => {
    const id = `${p.source}|${p.what}`;
    const li = steps.get(id) ?? progress.appendChild(h("li"));
    steps.set(id, li);
    li.className = p.state;
    li.replaceChildren(h("span", { class: `badge src-${p.source}` }, p.source), ` ${p.what} `,
      p.state === "done" ? h("span", { class: "muted" }, `${p.quads} quads`) : p.state === "error" ? h("span", { class: "error" }, p.error.slice(0, 160)) : h("span", { class: "muted" }, "…"));
  };
  main.replaceChildren(h("div", { class: "loading-page" }, h("h1", {}, keyString(key)), h("p", { class: "muted" }, "Gathering the graph…"), progress));

  let graph;
  try { graph = await loadGraph(key, aspectHint, onProgress); }
  catch (err) { return notFound(String(err.message ?? err)); }
  if (myRoute !== routeId) return; // navigated away meanwhile

  const aspect = graph.aspect;
  const prefixes = await loadText("queries/prefixes.rq");
  const head = await (await engine.queryBindings(fillPanel(prefixes, await loadText("queries/common/header.rq"), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const name = head[0]?.get("name")?.value || keyString(key);
  const description = head[0]?.get("description")?.value;
  document.title = `${name} · ${config.title}`;

  const log = h("ul", { class: "log" }, graph.log.map((l) => h("li", {},
    h("span", { class: `badge src-${l.source}` }, l.source), ` ${l.what} `,
    l.error ? h("span", { class: "error" }, l.error.slice(0, 200)) : h("span", { class: "muted" }, `${l.quads} quads · ${l.ms} ms`))));

  const panels = panelsFor(config, aspect);
  const grid = h("div", { class: "grid" });
  main.replaceChildren(
    h("article", { class: "entity" },
      h("div", { class: "entity-head" },
        h("span", { class: "aspect" }, ASPECTS[aspect].title),
        h("h1", {}, name),
        description && h("p", { class: "description" }, description),
        h("div", { class: "meta" },
          h("span", { class: graph.snapshot ? "mode snap" : "mode live" }, graph.snapshot ? "Static snapshot" : "Live harvest"),
          h("span", { class: "muted" }, `${graph.quads.length.toLocaleString()} quads · canonical IRI `), h("code", {}, graph.iri),
          h("button", { type: "button", onclick: () => downloadGraph(graph) }, "Download graph (N-Quads)"),
          graph.snapshot && settings.mode !== "live" && h("button", { type: "button", onclick: () => { settings.mode = "live"; $("#mode").value = "live"; store.set("mode", "live"); graphs.clear(); route(); } }, "Fetch live instead")),
        h("details", { class: "provenance" }, h("summary", {}, "How this graph was gathered"), log)),
      grid));
  for (const p of panels) {
    const el = panelShell(p);
    grid.append(el);
    runPanel(graph, p, el);
  }
  if (aspect === "author" && config.wikidataCreate && config.sources.includes("wikidata"))
    wikidataPanel(graph).then((el) => { if (el && myRoute === routeId) grid.prepend(el); }).catch((err) => console.warn("Add-to-Wikidata panel:", err));
  if (aspect === "term" && config.wikidataFixes && config.sources.includes("wikidata"))
    termFixPanel(graph).then((el) => {
      if (!el || myRoute !== routeId) return;
      const after = grid.querySelector("#panel-agreement");
      after ? after.after(el) : grid.prepend(el);
    }).catch((err) => console.warn("Improve-Wikidata panel:", err));
}

async function home() {
  document.title = config.title;
  const m = await getManifest();
  const byAspect = {};
  for (const [k, e] of Object.entries(m.entities)) (byAspect[e.aspect] ??= []).push([k, e]);
  main.replaceChildren(h("section", { class: "home" },
    h("h1", {}, config.tagline),
    config.intro && h("p", { class: "lede" }, config.intro),
    h("p", {}, config.liveHarvest ? "Search above, or paste an ORCID, DOI, ISSN, Wikidata QID, OpenAlex id or ontology term ID (e.g. MONDO:0005148)." : "This site shows the pre-built pages below."),
    h("h2", {}, "Featured"),
    Object.keys(byAspect).length ? h("div", { class: "snapshots" }, Object.entries(byAspect).map(([a, list]) => h("div", {},
      h("h3", {}, ASPECTS[a]?.title ?? a),
      h("ul", {}, list.map(([k, e]) => h("li", {}, h("a", { href: `#/${a}/${k}` }, e.name ?? k), h("span", { class: "muted" }, ` ${k} · ${e.quads.toLocaleString()} quads`))))))) : h("p", { class: "muted" }, "None yet. Run npm run snapshot."),
    m.generated && h("p", { class: "muted" }, `Snapshots generated ${m.generated.slice(0, 16).replace("T", " ")} UTC.`)));
}

function notFound(msg) {
  main.replaceChildren(h("section", { class: "home" }, h("h1", {}, "Can't show that"), h("p", { class: "error" }, msg), h("p", {}, h("a", { href: "#/" }, "Back to the start"))));
}

function route() {
  routeId++;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (!parts.length) return home();
  if (ASPECTS[parts[0]]) return entityPage(parts[0], decodeURIComponent(parts.slice(1).join("/")));
  return entityPage(null, decodeURIComponent(parts.join("/")));
}
window.addEventListener("hashchange", route);
route();

// ---------- search ----------
const input = $("#q"), suggest = $("#suggest");
let timer;
$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = parseKey(input.value);
  if (key) { location.hash = `#/${keyString(key)}`; suggest.hidden = true; }
  else suggest.querySelector("a")?.click();
});
input.addEventListener("input", () => {
  clearTimeout(timer);
  const term = input.value.trim();
  if (term.length < 3 || parseKey(term)) { suggest.hidden = true; return; }
  timer = setTimeout(async () => {
    // Name search: Wikidata's search API, plus ontology terms from OLS when the OBO source is on.
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&uselang=en&limit=8&search=${encodeURIComponent(term)}`;
    const [res, terms] = await Promise.all([
      fetch(url).then((r) => r.json()).catch(() => null),
      config.sources.includes("obo") ? searchObo(fetch, term, 5).catch(() => []) : [],
    ]);
    if (input.value.trim() !== term) return;
    const pick = () => { suggest.hidden = true; input.value = ""; };
    const hits = [
      ...(res?.search ?? []).map((s) => h("li", {}, h("a", { href: `#/wikidata:${s.id}`, onclick: pick }, h("b", {}, s.label ?? s.id), s.description ? ` · ${s.description}` : ""))),
      ...terms.map((t) => h("li", { class: "obo-hit" }, h("a", { href: `#/term/obo:${t.id}`, onclick: pick }, h("b", {}, t.label), ` · ${t.oboId} `, h("span", { class: "badge src-obo" }, t.ontology)))),
    ];
    suggest.replaceChildren(...hits);
    suggest.hidden = !hits.length;
  }, 250);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#search")) suggest.hidden = true; });
