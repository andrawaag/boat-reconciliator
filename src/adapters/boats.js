// Boats: ships and other watercraft on Wikidata, their classes, builders and operators, reconciled with
// Wikimedia Commons (category and images) and OpenStreetMap (wrecks, museum ships and memorials tagged with the item).
//   - A vessel's own statements are read live from Wikidata's API, so qualifiers (dates of launches, renamings, flag
//     and owner changes) and ranks are exact and recent edits show at once.
//   - Lists of ships (of a class, by a builder, of an operator) come from the SPARQL endpoint.
//   - Checks compare the sources: IMO check digits, MMSI country digits against the flag, items sharing an IMO or
//     MMSI, Commons category and image, OSM features and their IDs on Wikidata, coordinates.
// Every check that suggests an edit becomes a proposal; the page turns them into QuickStatements the visitor runs.
import { NS, iri, quadSink } from "../model.js";

const S = NS.schema, K = NS.kr, WD = NS.wd;
const WD_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const OVERPASS = "https://overpass-api.de/api/interpreter";
export const BOAT_ASPECTS = new Set(["vessel", "class", "shipyard", "operator"]);
const WATERCRAFT = "Q1229765", SHIP_CLASS = "Q559026", LAUNCH = "Q596643";

// Statements shown as the vessel's details. The "best" statement (preferred rank, else one without an end date,
// else the latest) becomes the value; all dated ones also go on the timeline.
export const FIELDS = {
  P31: "type", P289: "vesselClass", P176: "builder", P1071: "builtAt", P617: "yardNumber", P287: "designer",
  P8047: "flag", P532: "portOfRegistry", P504: "homePort", P137: "operator", P127: "owner",
  P458: "imo", P587: "mmsi", P2317: "callSign", P5910: "eni", P879: "pennant", P5006: "dnv",
  P2043: "length", P2261: "beam", P2049: "width", P2262: "draft", P1093: "grossTonnage", P2067: "displacement", P2052: "speed", P1083: "capacity",
  P571: "inception", P729: "serviceEntry", P730: "serviceRetirement", P5817: "stateOfUse", P1435: "heritage", P138: "namedAfter",
  P373: "commonsCategory", P18: "image", P625: "coordinates", P402: "osmRelation", P10689: "osmWay", P11693: "osmNode",
};
// Dated statements that change over a ship's life, as timeline entries.
const CHANGES = { P2561: "named", P1448: "official name", P137: "operator", P127: "owner", P8047: "flag", P532: "port of registry", P504: "home port", P5817: "state", P1435: "heritage designation" };

const enc = encodeURIComponent;
const node = (kind, qid, i) => `urn:koetai-reconciliator:${kind}:${qid}:${i}`;

// Wikimedia APIs answer bursts with HTTP 429 (with Retry-After): wait and try again a few times.
async function json(ctx, url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetch(url, { ...init, headers: { ...(ctx.headers ?? {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60000) });
    if (res.status === 429 && attempt < 4) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt * 2, 30);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
    return res.json();
  }
}
const wdApi = (ctx, params) => json(ctx, `${WD_API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`);

/** SELECT against the site's Wikidata endpoint: rows of { var: value }. Retries when rate-limited. */
export async function sparql(ctx, query) {
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetch(ctx.endpoint, {
      method: "POST",
      headers: { ...(ctx.headers ?? {}), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
      body: new URLSearchParams({ query }), signal: AbortSignal.timeout(90000),
    });
    if (res.status === 429 && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    const j = await res.json();
    return j.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  }
}
const PREFIXES = `PREFIX wd: <${WD}> PREFIX wdt: <${NS.wdt}> PREFIX p: <http://www.wikidata.org/prop/> PREFIX ps: <http://www.wikidata.org/prop/statement/> PREFIX pq: <http://www.wikidata.org/prop/qualifier/> PREFIX rdfs: <${NS.rdfs}>`;
const qidOf = (v) => (v?.startsWith(WD) ? v.slice(WD.length) : null);

/** Which boat page a Wikidata item gets, or null: vessel, class, shipyard (builder) or operator (fleet). */
export async function detectBoatAspect(ctx, qid) {
  const rows = await sparql(ctx, `${PREFIXES} SELECT ?kind (COUNT(*) AS ?n) WHERE {
    { wd:${qid} wdt:P31/wdt:P279* wd:${SHIP_CLASS} BIND("classType" AS ?kind) }
    UNION { wd:${qid} wdt:P31/wdt:P279* wd:${WATERCRAFT} BIND("vessel" AS ?kind) }
    UNION { ?s wdt:P289 wd:${qid} BIND("class" AS ?kind) }
    UNION { ?s wdt:P176 wd:${qid} . ?s wdt:P31/wdt:P279* wd:${WATERCRAFT} BIND("shipyard" AS ?kind) }
    UNION { ?s wdt:P137|wdt:P127 wd:${qid} . ?s wdt:P31/wdt:P279* wd:${WATERCRAFT} BIND("operator" AS ?kind) }
  } GROUP BY ?kind`);
  const n = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  if (n.classType) return "class";
  if (n.vessel) return "vessel";
  if (n.class) return "class";
  if (n.shipyard || n.operator) return (n.shipyard ?? 0) >= (n.operator ?? 0) ? "shipyard" : "operator";
  return null;
}

// ---------- Wikidata values ----------
const UNITS = { Q11573: "m", Q3710: "ft", Q11570: "kg", Q191118: "t", Q128822: "kn", Q180154: "km/h", Q47083: "hp", Q25235: "kW", Q1550: "TEU" };
function timeString(v) {
  const m = v?.time?.match(/^([+-])0*(\d{1,4})-(\d\d)-(\d\d)/);
  if (!m) return null;
  const y = (m[1] === "-" ? "-" : "") + m[2].padStart(4, "0");
  return v.precision >= 11 ? `${y}-${m[3]}-${m[4]}` : v.precision === 10 ? `${y}-${m[3]}` : y;
}
// A snak's value as { iri } (items, files), or { text } (strings, quantities, dates).
function snakValue(snak, labels) {
  const dv = snak?.datavalue;
  if (!dv) return null;
  switch (dv.type) {
    case "wikibase-entityid": return { iri: WD + dv.value.id, qid: dv.value.id };
    case "string": return { text: dv.value };
    case "monolingualtext": return { text: dv.value.text, lang: dv.value.language };
    case "time": return { text: timeString(dv.value), date: true };
    case "globecoordinate": return { text: `${dv.value.latitude.toFixed(5)}, ${dv.value.longitude.toFixed(5)}`, lat: dv.value.latitude, lon: dv.value.longitude };
    case "quantity": {
      const unit = dv.value.unit.split("/").pop();
      const amount = String(Number(dv.value.amount));
      const u = UNITS[unit] ?? (unit === "1" ? "" : labels.get(unit) ?? unit);
      return { text: u ? `${amount} ${u}` : amount, amount: Number(dv.value.amount), unit };
    }
    default: return null;
  }
}
const qual = (st, p) => (st.qualifiers?.[p] ?? []).map((s) => s.datavalue?.value);
const qualTime = (st, p) => qual(st, p).map(timeString).find(Boolean) ?? null;
function best(statements) {
  const live = statements.filter((s) => s.rank !== "deprecated");
  const pref = live.filter((s) => s.rank === "preferred");
  if (pref.length) return pref;
  const open = live.filter((s) => !s.qualifiers?.P582);
  if (open.length) return open;
  return live.slice().sort((a, b) => String(qualTime(b, "P580") ?? "").localeCompare(String(qualTime(a, "P580") ?? ""))).slice(0, 1);
}

async function labelsFor(ctx, qids) {
  const out = new Map();
  const ids = [...new Set(qids)].filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const res = await wdApi(ctx, { action: "wbgetentities", ids: ids.slice(i, i + 50).join("|"), props: "labels", languages: "en|mul", languagefallback: "1" });
    for (const [id, e] of Object.entries(res.entities ?? {})) {
      const l = e.labels?.en?.value ?? e.labels?.mul?.value ?? Object.values(e.labels ?? {})[0]?.value;
      if (l) out.set(id, l);
    }
  }
  return out;
}

// ---------- harvest ----------
/** Everything the boat pages need from Wikidata for one item. Returns { quads, facts }. */
export async function harvestBoat(ctx, qid, aspect) {
  const out = quadSink(ctx.DF, "wikidata");
  const main = iri.wikidata(qid);
  const res = await wdApi(ctx, { action: "wbgetentities", ids: qid, props: "labels|descriptions|aliases|claims|sitelinks", languages: "en|mul", languagefallback: "1" });
  const e = res.entities?.[qid] ?? {};
  const claims = e.claims ?? {};
  const facts = {
    qid, aspect, label: e.labels?.en?.value ?? e.labels?.mul?.value ?? qid, claims,
    commonsSitelink: e.sitelinks?.commonswiki?.title ?? null,
    values: (p) => best(claims[p] ?? []).map((s) => s.mainsnak?.datavalue?.value).filter((v) => v != null),
  };
  out.lit(main, S + "name", facts.label);
  if (e.descriptions?.en?.value) out.lit(main, S + "description", e.descriptions.en.value);
  out.add(main, NS.rdf + "type", K + { vessel: "Vessel", class: "VesselClass", shipyard: "Shipbuilder", operator: "ShipOperator" }[aspect]);

  // Labels for every item a statement or qualifier points to.
  const refs = [];
  for (const sts of Object.values(claims)) for (const st of sts) {
    if (st.mainsnak?.datavalue?.type === "wikibase-entityid") refs.push(st.mainsnak.datavalue.value.id);
    if (st.mainsnak?.datavalue?.type === "quantity") refs.push(st.mainsnak.datavalue.value.unit.split("/").pop());
    for (const qs of Object.values(st.qualifiers ?? {})) for (const q of qs) if (q.datavalue?.type === "wikibase-entityid") refs.push(q.datavalue.value.id);
  }
  const labels = await labelsFor(ctx, refs.filter((r) => /^Q\d+$/.test(r)));
  const put = (s, p, v) => {
    if (!v) return;
    if (v.iri) { out.add(s, p, v.iri); if (labels.has(v.qid)) out.lit(v.iri, S + "name", labels.get(v.qid)); }
    else if (v.text != null) out.lit(s, p, v.text);
  };

  for (const [p, field] of Object.entries(FIELDS)) {
    for (const st of best(claims[p] ?? [])) {
      const v = snakValue(st.mainsnak, labels);
      if (p === "P18" && v) { out.add(main, K + field, `https://commons.wikimedia.org/wiki/File:${enc(v.text.replace(/ /g, "_"))}`); continue; }
      put(main, K + field, v);
      if (p === "P458" && v?.text) out.add(main, S + "sameAs", iri.imo(v.text));
      if (p === "P587" && v?.text) out.add(main, S + "sameAs", iri.mmsi(v.text));
    }
  }

  // Timeline: significant events (launch, sinking, …) and the dated changes of name, owner, flag and operator.
  let n = 0;
  const event = (date, what, obj, property, end) => {
    const ev = node("event", qid, n++);
    out.add(main, K + "event", ev);
    out.lit(ev, K + "date", date ?? "");
    out.lit(ev, S + "name", what);
    if (obj) put(ev, K + "with", obj);
    if (end) out.lit(ev, K + "until", end);
    out.lit(ev, K + "property", property);
  };
  for (const st of claims.P793 ?? []) {
    if (st.rank === "deprecated") continue;
    const v = snakValue(st.mainsnak, labels);
    const date = qualTime(st, "P585") ?? qualTime(st, "P580");
    const place = qual(st, "P276")[0]?.id;
    event(date, labels.get(v?.qid) ?? v?.qid ?? "event", place ? { iri: WD + place, qid: place } : null, "P793");
    if (v?.qid === LAUNCH && date) out.lit(main, K + "launched", date);
  }
  for (const [p, what] of [["P571", "construction began or completed (inception)"], ["P729", "entered service"], ["P730", "left service"]])
    for (const st of claims[p] ?? []) if (st.rank !== "deprecated") event(snakValue(st.mainsnak, labels)?.text, what, null, p);
  let names = 0;
  for (const [p, what] of Object.entries(CHANGES)) for (const st of claims[p] ?? []) {
    if (st.rank === "deprecated") continue;
    const v = snakValue(st.mainsnak, labels), start = qualTime(st, "P580"), end = qualTime(st, "P582");
    if (p === "P2561" || p === "P1448") {
      const nm = node("name", qid, names++);
      out.add(main, K + "nameRecord", nm);
      out.lit(nm, S + "name", v?.text);
      if (v?.lang) out.lit(nm, K + "language", v.lang);
      if (start) out.lit(nm, K + "start", start);
      if (end) out.lit(nm, K + "end", end);
    }
    if (start || end) event(start ?? "", v?.iri ? what : `${what} “${v?.text}”`, v?.iri ? v : null, p, end);
  }

  // Ships listed under this page: sister ships of a vessel's class, or the class's / builder's / operator's fleet.
  const listed = { vessel: null, class: ["P289", qid], shipyard: ["P176", qid], operator: ["P137|wdt:P127", qid] }[aspect];
  const classes = aspect === "vessel" ? facts.values("P289").map((v) => v.id) : [];
  const lists = [];
  if (listed) lists.push(shipsBy(ctx, listed[0], listed[1], main, aspect === "operator"));
  for (const c of classes.slice(0, 3)) lists.push(shipsBy(ctx, "P289", c, WD + c, false));
  for (const qs of await Promise.all(lists.map((p) => p.catch(() => [])))) for (const q of qs) out.quads.push(q);
  if (aspect === "vessel") facts.shared = await sharedIdentifiers(ctx, qid, facts).catch(() => []);
  if (aspect === "vessel") facts.mids = await midsFor(ctx, facts.values("P8047").map((v) => v.id)).catch(() => new Map());
  return { quads: out.quads, facts };
}

// Ships whose `prop` is `qid` (vessel class P289, manufacturer P176, operator P137 or owner P127), with the
// fields the fleet tables show. Each gets `kr:listedUnder <page>`; years come from launch, service entry or inception.
async function shipsBy(ctx, prop, qid, under, onlyWatercraft) {
  const rows = await sparql(ctx, `${PREFIXES} SELECT ?ship ?shipLabel ?type ?typeLabel ?imo ?builder ?builderLabel ?class ?classLabel ?flag ?flagLabel ?launch ?entry ?retired ?inception WHERE {
    ?ship wdt:${prop} wd:${qid} . ${onlyWatercraft ? `?ship wdt:P31/wdt:P279* wd:${WATERCRAFT} .` : ""} FILTER NOT EXISTS { ?ship wdt:P31 wd:${SHIP_CLASS} }
    OPTIONAL { ?ship rdfs:label ?shipLabel FILTER(LANG(?shipLabel) = "en") }
    OPTIONAL { ?ship wdt:P31 ?type OPTIONAL { ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel) = "en") } }
    OPTIONAL { ?ship wdt:P458 ?imo }
    OPTIONAL { ?ship wdt:P176 ?builder OPTIONAL { ?builder rdfs:label ?builderLabel FILTER(LANG(?builderLabel) = "en") } }
    OPTIONAL { ?ship wdt:P289 ?class OPTIONAL { ?class rdfs:label ?classLabel FILTER(LANG(?classLabel) = "en") } }
    OPTIONAL { ?ship wdt:P8047 ?flag OPTIONAL { ?flag rdfs:label ?flagLabel FILTER(LANG(?flagLabel) = "en") } }
    OPTIONAL { ?ship p:P793 ?ev . ?ev ps:P793 wd:${LAUNCH} ; pq:P585 ?launch }
    OPTIONAL { ?ship wdt:P729 ?entry } OPTIONAL { ?ship wdt:P730 ?retired } OPTIONAL { ?ship wdt:P571 ?inception }
  } LIMIT 20000`);
  const out = quadSink(ctx.DF, "wikidata");
  const named = (s, p, o, label) => { if (!o) return; out.add(s, p, o); if (label) out.lit(o, S + "name", label); };
  const year = (d) => d?.match(/^-?\d{1,4}/)?.[0];
  for (const r of rows) {
    const s = r.ship;
    out.add(s, K + "listedUnder", under);
    out.add(s, NS.rdf + "type", K + "Vessel");
    if (r.shipLabel) out.lit(s, S + "name", r.shipLabel);
    named(s, K + "type", r.type, r.typeLabel);
    named(s, K + "builder", r.builder, r.builderLabel);
    named(s, K + "vesselClass", r.class, r.classLabel);
    named(s, K + "flag", r.flag, r.flagLabel);
    if (r.imo) out.lit(s, K + "imo", r.imo);
    const y = year(r.launch) ?? year(r.entry) ?? year(r.inception);
    if (y) out.lit(s, K + "year", y);
    if (r.retired) out.lit(s, K + "retiredYear", year(r.retired));
  }
  return out.quads;
}

// Other items with the same IMO number or MMSI: duplicates, or another stage of the same hull.
async function sharedIdentifiers(ctx, qid, facts) {
  const pairs = [...facts.values("P458").map((v) => ["P458", v]), ...facts.values("P587").map((v) => ["P587", v])];
  if (!pairs.length) return [];
  const values = pairs.map(([p, v]) => `(wdt:${p} ${JSON.stringify(v)})`).join(" ");
  const rows = await sparql(ctx, `${PREFIXES} SELECT ?prop ?value ?other ?otherLabel WHERE { VALUES (?prop ?value) { ${values} } ?other ?prop ?value FILTER(?other != wd:${qid}) OPTIONAL { ?other rdfs:label ?otherLabel FILTER(LANG(?otherLabel) = "en") } } LIMIT 50`);
  return rows.map((r) => ({ property: r.prop.split("/").pop(), value: r.value, qid: qidOf(r.other), label: r.otherLabel ?? null }));
}

// Maritime identification digits (P2979) of the flag states: the first three digits of a ship's MMSI.
async function midsFor(ctx, qids) {
  const out = new Map();
  if (!qids.length) return out;
  const rows = await sparql(ctx, `${PREFIXES} SELECT ?c ?mid WHERE { VALUES ?c { ${qids.map((q) => `wd:${q}`).join(" ")} } ?c wdt:P2979 ?mid }`);
  for (const r of rows) (out.get(qidOf(r.c)) ?? out.set(qidOf(r.c), new Set()).get(qidOf(r.c))).add(String(r.mid).padStart(3, "0"));
  return out;
}

/** Commons: the item's category (P373, else its Commons sitelink) with a gallery of files, and the P18 image. */
export async function harvestCommons(ctx, qid, facts) {
  const out = quadSink(ctx.DF, "commons");
  const main = iri.wikidata(qid);
  const p373 = facts?.values("P373")?.[0];
  const cat = p373 ? `Category:${p373}` : facts?.commonsSitelink?.startsWith("Category:") ? facts.commonsSitelink : null;
  const result = { category: cat, exists: false, files: 0, p18: facts?.values("P18") ?? [], p18Exists: [] };
  const api = (params) => json(ctx, `${COMMONS_API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`);
  const fileIri = (title) => `https://commons.wikimedia.org/wiki/${enc(title.replace(/ /g, "_")).replace(/%3A/g, ":")}`;
  const addFile = (pg, isMain) => {
    const info = pg.imageinfo?.[0];
    if (!info) return;
    const f = fileIri(pg.title);
    out.add(main, K + "commonsFile", f);
    out.lit(f, S + "name", pg.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""));
    out.add(f, K + "thumbnail", info.thumburl ?? info.url);
    if (isMain) out.lit(f, K + "mainImage", "true");
  };
  if (result.p18.length) {
    const r = await api({ action: "query", titles: result.p18.map((t) => `File:${t}`).join("|"), prop: "imageinfo", iiprop: "url", iiurlwidth: "320" });
    for (const pg of Object.values(r.query?.pages ?? {})) if (!pg.missing && pg.imageinfo) { result.p18Exists.push(pg.title.replace(/^File:/, "")); addFile(pg, true); }
  }
  if (cat) {
    const info = await api({ action: "query", titles: cat, prop: "categoryinfo" });
    const pg = Object.values(info.query?.pages ?? {})[0];
    result.exists = pg && !("missing" in pg);
    result.files = pg?.categoryinfo?.files ?? 0;
    result.subcats = pg?.categoryinfo?.subcats ?? 0;
    if (result.exists) {
      out.add(main, K + "commonsCategoryPage", `https://commons.wikimedia.org/wiki/${enc(cat.replace(/ /g, "_")).replace(/%3A/g, ":")}`);
      out.lit(main, K + "commonsFiles", result.files);
      const filesIn = async (title, limit) => {
        const r = await api({ action: "query", generator: "categorymembers", gcmtitle: title, gcmtype: "file", gcmlimit: String(limit), prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "320" });
        return Object.values(r.query?.pages ?? {}).filter((fp) => /^image\//.test(fp.imageinfo?.[0]?.mime ?? ""));
      };
      let found = await filesIn(cat, 24);
      // Ship categories often hold their photos in subcategories (Commons' "IMO 1234567" categories group a ship's
      // names and years): look one level down when the category itself has few files.
      if (found.length < 6 && result.subcats) {
        const subs = await api({ action: "query", list: "categorymembers", cmtitle: cat, cmtype: "subcat", cmlimit: "5" });
        for (const sub of subs.query?.categorymembers ?? []) found = found.concat(await filesIn(sub.title, 12).catch(() => []));
      }
      for (const fp of found.slice(0, 30)) addFile(fp, false);
    }
  }
  return { quads: out.quads, commons: result };
}

/**
 * OpenStreetMap: features tagged wikidata=<item> (the wreck, the museum ship) or subject:wikidata=<item> (memorials).
 * Read from QLever's copy of OpenStreetMap (osm2rdf, updated about weekly), which answers in a fraction of a second;
 * Overpass, which searches the whole planet by tag in tens of seconds, is the fallback.
 */
export async function harvestOsm(ctx, qid) {
  const features = await osmQlever(ctx, qid).catch(() => osmOverpass(ctx, qid));
  const out = quadSink(ctx.DF, "osm");
  const main = iri.wikidata(qid);
  for (const f of features) {
    const u = `https://www.openstreetmap.org/${f.type}/${f.id}`;
    out.add(main, K + "osmFeature", u);
    out.lit(u, S + "name", f.name ?? `${f.type} ${f.id}`);
    out.lit(u, K + "osmKind", f.kind);
    out.lit(u, K + "osmLink", f.link);
    if (f.lat != null) { out.lit(u, K + "lat", f.lat.toFixed(5)); out.lit(u, K + "lon", f.lon.toFixed(5)); }
  }
  return { quads: out.quads, osm: features };
}
const OSM_QLEVER = "https://qlever.dev/api/osm-planet";
const KEY = "https://www.openstreetmap.org/wiki/Key:";
const KINDS = ["historic", "seamark:type", "tourism", "memorial", "building", "amenity", "attraction"];
function feature(qid, type, id, t, lat, lon) {
  return { type, id: String(id), name: t.name ?? t["name:en"] ?? null, lat, lon, link: t.wikidata === qid ? "wikidata" : "subject:wikidata",
    kind: KINDS.filter((k) => t[k]).map((k) => `${k}=${t[k]}`).slice(0, 2).join(", ") || "feature" };
}
async function osmSparql(ctx, query) {
  const res = await ctx.fetch(OSM_QLEVER, { method: "POST", headers: { ...(ctx.headers ?? {}), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" }, body: new URLSearchParams({ query }), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`QLever OSM HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}
async function osmQlever(ctx, qid) {
  const rows = await osmSparql(ctx, `SELECT ?osm ?k ?v WHERE { { ?osm <${KEY}wikidata> "${qid}" } UNION { ?osm <${KEY}subject:wikidata> "${qid}" } ?osm ?k ?v FILTER(STRSTARTS(STR(?k), "${KEY}")) } LIMIT 3000`);
  const tags = new Map();
  for (const r of rows) {
    const t = tags.get(r.osm.value) ?? tags.set(r.osm.value, {}).get(r.osm.value);
    t[r.k.value.slice(KEY.length)] = r.v.value;
  }
  const list = [...tags].slice(0, 30).map(([u, t]) => { const [, type, id] = u.match(/\/(node|way|relation)\/(\d+)$/) ?? []; return { u, type, id, t }; }).filter((x) => x.type);
  // Geometry separately, by the geometry's own IRI: joining it in the query above is slow.
  const centre = new Map();
  if (list.length) {
    const values = list.map((x) => `<https://osm2rdf.cs.uni-freiburg.de/rdf/geom#osm${x.type}_${x.id}>`).join(" ");
    const geo = await osmSparql(ctx, `SELECT ?g ?w WHERE { VALUES ?g { ${values} } ?g <http://www.opengis.net/ont/geosparql#asWKT> ?w }`).catch(() => []);
    for (const r of geo) {
      const pts = [...r.w.value.slice(0, 200000).matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      if (pts.length) centre.set(r.g.value.split("#osm")[1], { lon: pts.reduce((a, p) => a + p[0], 0) / pts.length, lat: pts.reduce((a, p) => a + p[1], 0) / pts.length });
    }
  }
  return list.map((x) => { const c = centre.get(`${x.type}_${x.id}`); return feature(qid, x.type, x.id, x.t, c?.lat, c?.lon); });
}
async function osmOverpass(ctx, qid) {
  const q = `[out:json][timeout:25];(nwr["wikidata"="${qid}"];nwr["subject:wikidata"="${qid}"];);out tags center 30;`;
  const j = await json(ctx, OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: q }) });
  return (j.elements ?? []).map((el) => feature(qid, el.type, el.id, el.tags ?? {}, el.lat ?? el.center?.lat, el.lon ?? el.center?.lon));
}

// ---------- checks across sources ----------
/** IMO number check digit: the 7th digit is the last digit of 7·d1 + 6·d2 + … + 2·d6. */
export function imoValid(imo) {
  const m = String(imo).match(/^(?:IMO\s*)?(\d{7})$/i);
  if (!m) return false;
  const d = m[1].split("").map(Number);
  return d.slice(0, 6).reduce((s, x, i) => s + x * (7 - i), 0) % 10 === d[6];
}
const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const OSM_PROP = { node: "P11693", way: "P10689", relation: "P402" };

/**
 * Compares Wikidata, Commons and OpenStreetMap for a vessel. Each check is a kr:check node (name, status, detail);
 * statuses: ok, mismatch, missing, warning. Edits that follow from a check become kr:proposal nodes
 * (property, value, reason), turned into QuickStatements by the page.
 */
export function vesselChecks(ctx, qid, facts, commons, osm) {
  const out = quadSink(ctx.DF, "reconcile");
  const main = iri.wikidata(qid);
  let n = 0, np = 0;
  const check = (name, status, detail, link) => {
    const c = node("check", qid, n++);
    out.add(main, K + "check", c);
    out.lit(c, S + "name", name); out.lit(c, K + "status", status); out.lit(c, S + "description", detail);
    out.lit(c, K + "order", String(n).padStart(3, "0"));
    if (link) out.add(c, K + "see", link);
  };
  const propose = (property, value, reason, extra = {}) => {
    const p = node("proposal", qid, np++);
    out.add(main, K + "proposal", p);
    out.lit(p, K + "property", property); out.lit(p, K + "value", value); out.lit(p, S + "description", reason);
    for (const [k, v] of Object.entries(extra)) out.lit(p, K + k, v);
  };
  if (!facts) return out.quads;
  const imos = facts.values("P458"), mmsis = facts.values("P587"), flags = facts.values("P8047").map((v) => v.id);

  // IMO numbers.
  if (!imos.length) check("IMO number", "none", "No IMO ship number (P458). Ships of 100 gross tonnes and more built since the 1960s usually have one; older, small and naval vessels often don't.");
  for (const v of imos) check("IMO number", imoValid(v) ? "ok" : "mismatch", imoValid(v) ? `${v}: the check digit is right.` : `${v}: the check digit is wrong, so this is not a valid IMO number. Check it against the ship's registry or a photo of the hull.`);

  // MMSI against the flag state.
  for (const v of mmsis) {
    const mid = String(v).slice(0, 3);
    if (!/^\d{9}$/.test(String(v))) { check("MMSI", "mismatch", `${v} is not nine digits.`); continue; }
    if (!/^[2-7]/.test(String(v))) { check("MMSI", "warning", `${v} is not a ship station MMSI (those start with 2–7); it may be a coast station, group or device.`); continue; }
    const known = flags.filter((f) => facts.mids?.has(f));
    if (!flags.length) check("MMSI and flag", "missing", `MMSI ${v} points to country digits ${mid}, but the item has no country of registry (P8047).`);
    else if (!known.length) check("MMSI and flag", "warning", `MMSI ${v} starts with ${mid}; the flag state on Wikidata has no maritime identification digits (P2979) to compare.`);
    else {
      const ok = known.some((f) => facts.mids.get(f).has(mid));
      check("MMSI and flag", ok ? "ok" : "mismatch", ok ? `MMSI ${v} starts with ${mid}, which belongs to the flag state.` : `MMSI ${v} starts with ${mid}, but the flag state's digits are ${known.map((f) => [...facts.mids.get(f)].join("/")).join(", ")}. The flag or the MMSI is out of date (ships change both when sold).`);
    }
  }

  // Other items with the same IMO or MMSI.
  for (const s of facts.shared ?? []) check(s.property === "P458" ? "Shared IMO number" : "Shared MMSI", "warning",
    `${s.label ?? s.qid} (${s.qid}) also has ${s.property === "P458" ? "IMO" : "MMSI"} ${s.value}. An IMO number stays with a hull for life, so two items are either a duplicate (merge them) or the ship before and after a rebuild (link them with P1365/P1366 or P155/P156). An MMSI can pass to another ship.`, WD + s.qid);

  // Commons category and image.
  if (commons) {
    const p373 = facts.values("P373")[0];
    if (p373 && commons.exists) check("Commons category", "ok", `Category:${p373} exists on Commons (${commons.files} file${commons.files === 1 ? "" : "s"}${commons.subcats ? ` and ${commons.subcats} subcategor${commons.subcats === 1 ? "y" : "ies"}` : ""}).`);
    else if (p373 && !commons.exists) check("Commons category", "mismatch", `Commons category (P373) is “${p373}”, but Commons has no such category. It may have been renamed.`);
    else if (commons.category && commons.exists) {
      check("Commons category", "missing", `The item links to ${commons.category} on Commons (sitelink) but has no Commons category statement (P373).`);
      propose("P373", commons.category.replace(/^Category:/, ""), "Commons category, from the item's Commons sitelink");
    } else check("Commons category", "missing", "No Commons category: neither P373 nor a Commons sitelink.");
    const p18 = facts.values("P18");
    const broken = p18.filter((f) => !commons.p18Exists.includes(f.replace(/_/g, " ")) && !commons.p18Exists.includes(f));
    if (p18.length && !broken.length) check("Image", "ok", `${p18.join(", ")} exists on Commons.`);
    else if (broken.length) check("Image", "mismatch", `${broken.join(", ")} is not on Commons (deleted or renamed).`);
    else if (commons.files || commons.subcats) check("Image", "missing", "No image (P18), but the Commons category has photos. Pick one under Improve Wikidata to add it.");
    else check("Image", "missing", "No image (P18) and no Commons files to choose from.");
  }

  // OpenStreetMap.
  if (osm) {
    const tagged = osm.filter((f) => f.link === "wikidata");
    const about = osm.filter((f) => f.link !== "wikidata");
    if (!osm.length) check("OpenStreetMap", "none", "No OpenStreetMap feature is tagged with this item. Most ships at sea aren't mapped; wrecks, museum ships and memorials can be.");
    for (const f of tagged) {
      const prop = OSM_PROP[f.type];
      const held = facts.values(prop).map(String);
      const url = `https://www.openstreetmap.org/${f.type}/${f.id}`;
      if (held.includes(f.id)) check("OpenStreetMap", "ok", `${f.name ?? url} (${f.kind}) is tagged with this item, and the item has its ${f.type} ID (${prop}).`, url);
      else {
        check("OpenStreetMap", "missing", `${f.name ?? url} (${f.kind}) is tagged with this item, but the item lacks its OSM ${f.type} ID (${prop}).`, url);
        propose(prop, f.id, `OSM ${f.type} ${f.id}${f.name ? ` (${f.name})` : ""}, tagged wikidata=${qid} on OpenStreetMap`);
      }
      const wdCoord = facts.values("P625")[0];
      if (wdCoord && f.lat != null) {
        const d = km({ lat: wdCoord.latitude, lon: wdCoord.longitude }, f);
        check("Location", d < 2 ? "ok" : "mismatch", d < 2 ? `Wikidata's and OpenStreetMap's positions are ${d < 0.1 ? "within 100 m" : `${d.toFixed(1)} km apart`}.` : `Wikidata's coordinates are ${d.toFixed(0)} km from the OpenStreetMap feature. One of them is wrong, or the item is not the feature (a ship moves; its wreck doesn't).`, url);
      }
    }
    if (about.length) check("OpenStreetMap", "ok", `${about.length} feature${about.length === 1 ? "" : "s"} (memorials, plaques, …) name this item as subject:wikidata.`);
  }
  return out.quads;
}
