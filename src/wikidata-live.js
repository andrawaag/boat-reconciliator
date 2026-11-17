// Live checks against Wikidata itself (its search and entity APIs), next to the SPARQL endpoint.
// The SPARQL copy (QLever) can lag behind edits by hours or days. Without these checks, an item someone has just
// created with QuickStatements would still look missing, the page would not link to it, and the panels could
// propose creating the same item again. Wikidata's search index (haswbstatement) is updated within about a minute.
const API = "https://www.wikidata.org/w/api.php";

async function api(fetchFn, params) {
  const url = `${API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url);
    if (res.ok) return res.json();
    if (![429, 503].includes(res.status) || attempt >= 3) throw new Error(`Wikidata API HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const norm = (property, value) => (property === "P356" ? String(value).toUpperCase() : String(value));

/**
 * Items that carry any of these statements: pairs = [{ property, value }]. Returns [{ qid, property, value, label }],
 * verified against the items' actual claims (search hits alone are not trusted).
 */
export async function findByStatementsLive(fetchFn, pairs, { batch = 20 } = {}) {
  const usable = pairs.filter((p) => p.value && !/["|]/.test(p.value));
  const hits = new Set();
  for (let i = 0; i < usable.length; i += batch) {
    const part = usable.slice(i, i + batch);
    const q = `haswbstatement:"${part.map((p) => `${p.property}=${p.value}`).join("|")}"`;
    const res = await api(fetchFn, { action: "query", list: "search", srsearch: q, srlimit: "50", srprop: "" });
    for (const s of res?.query?.search ?? []) hits.add(s.title);
  }
  if (!hits.size) return [];
  const wanted = new Map(usable.map((p) => [`${p.property}|${norm(p.property, p.value)}`, p]));
  const props = [...new Set(usable.map((p) => p.property))];
  const out = [];
  const ids = [...hits];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await api(fetchFn, { action: "wbgetentities", ids: ids.slice(i, i + 50).join("|"), props: "labels", languages: "en" });
    for (const qid of ids.slice(i, i + 50)) {
      const label = res?.entities?.[qid]?.labels?.en?.value;
      for (const property of props) {
        // Only the claims for the properties asked about: works can have thousands of other statements.
        const claims = await api(fetchFn, { action: "wbgetclaims", entity: qid, property });
        for (const c of claims?.claims?.[property] ?? []) {
          const v = c.mainsnak?.datavalue?.value;
          if (typeof v !== "string") continue;
          const p = wanted.get(`${property}|${norm(property, v)}`);
          if (p) out.push({ qid, property, value: p.value, label });
        }
      }
    }
  }
  return out;
}

/** Raw wdt: quads (label, description, string and item claims) for one item, read live: for items too new for the SPARQL copy. */
export async function entityQuadsLive(fetchFn, DF, qid) {
  const res = await api(fetchFn, { action: "wbgetentities", ids: qid, props: "labels|descriptions|claims", languages: "en" });
  const e = res?.entities?.[qid];
  if (!e || e.missing !== undefined) return [];
  const s = DF.namedNode(`http://www.wikidata.org/entity/${qid}`);
  const quads = [];
  if (e.labels?.en) quads.push(DF.quad(s, DF.namedNode("http://www.w3.org/2000/01/rdf-schema#label"), DF.literal(e.labels.en.value, "en")));
  if (e.descriptions?.en) quads.push(DF.quad(s, DF.namedNode("http://schema.org/description"), DF.literal(e.descriptions.en.value, "en")));
  for (const [p, claims] of Object.entries(e.claims ?? {})) {
    for (const c of claims) {
      if (c.rank === "deprecated") continue;
      const v = c.mainsnak?.datavalue?.value;
      const pred = DF.namedNode(`http://www.wikidata.org/prop/direct/${p}`);
      if (typeof v === "string") quads.push(DF.quad(s, pred, DF.literal(v)));
      else if (v?.["entity-type"] === "item") quads.push(DF.quad(s, pred, DF.namedNode(`http://www.wikidata.org/entity/${v.id}`)));
      else if (v?.time) quads.push(DF.quad(s, pred, DF.literal(v.time.replace(/^\+/, ""))));
      else if (v?.text) quads.push(DF.quad(s, pred, DF.literal(v.text, v.language)));
    }
  }
  return quads;
}
