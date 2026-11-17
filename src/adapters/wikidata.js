// Wikidata adapter: runs CONSTRUCT queries through Comunica against a Wikidata SPARQL endpoint,
// then maps the raw wdt: triples onto the schema.org model. The mapping happens here, not in SPARQL:
// minting IRIs inside the query (BIND(IRI(CONCAT(...)))) makes QLever evaluate it over all of Wikidata.
import { NS, iri, quadSink, dateLiteral } from "../model.js";
import { aspectForTypes, TYPE_TO_ASPECT } from "../aspects.js";

const S = NS.schema;
const LINK = { author: "P50", topic: "P921", venue: "P1433" };
const PREDICATES = {
  [NS.rdfs + "label"]: S + "name",
  [S + "description"]: S + "description",
  [NS.wdt + "P1476"]: S + "name",
  [NS.wdt + "P50"]: S + "author",
  [NS.wdt + "P921"]: S + "about",
  [NS.wdt + "P1433"]: S + "isPartOf",
  [NS.wdt + "P2860"]: S + "citation",
  [NS.wdt + "P856"]: S + "url",
};
const CLASS = { author: "Person", work: "ScholarlyArticle", venue: "Periodical" };

async function template(ctx, name, vars) {
  let text = (await ctx.loadText("queries/wikidata/prefixes.rq")) + "\n" + (await ctx.loadText(`queries/wikidata/${name}.rq`));
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[\w.\/:-]+$/.test(v)) throw new Error(`Unsafe template value for ${k}: ${v}`);
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}

const source = (ctx) => [{ type: "sparql", value: ctx.endpoint }];

// Public endpoints rate-limit bursts (QLever answers HTTP 429), so queries go one at a time with backoff.
let queue = Promise.resolve();
function polite(fn) {
  const run = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (!/HTTP status 429/.test(err.message) || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  });
  queue = run.catch(() => {});
  return run;
}

export async function lookupQid(ctx, scheme, value) {
  const prop = { orcid: "P496", doi: "P356", issn: "P236" }[scheme];
  if (!prop) return null;
  const v = scheme === "doi" ? value.toUpperCase() : value; // Wikidata stores DOIs upper-case
  const q = await template(ctx, "lookup", { prop, value: v });
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  return rows[0]?.get("item")?.value.replace(NS.wd, "") ?? null;
}

export async function detectAspect(ctx, qid) {
  const q = await template(ctx, "types", { q: qid });
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  return aspectForTypes(rows.map((r) => r.get("type").value));
}

export async function harvestWikidata(ctx, qid, aspect) {
  const runs = aspect === "work"
    ? [["entity", {}], ["work", {}], ["citations", {}]]
    : [["entity", {}], ["works", { link: LINK[aspect] }], ["works-people", { link: LINK[aspect] }], ["works-context", { link: LINK[aspect] }]];
  const raw = (await Promise.all(runs.map(async ([name, vars]) => {
    const q = await template(ctx, name, { q: qid, ...vars });
    return polite(async () => (await ctx.engine.queryQuads(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  }))).flat();
  return mapToSchema(ctx.DF, raw, qid, aspect);
}

function mapToSchema(DF, raw, qid, aspect) {
  const out = quadSink(DF, "wikidata");
  const typeOf = new Map(TYPE_TO_ASPECT.flatMap(([a, iris]) => iris.map((i) => [i, a])));
  const roles = { [NS.wdt + "P50"]: ["work", "author"], [NS.wdt + "P921"]: ["work", null], [NS.wdt + "P1433"]: ["work", "venue"], [NS.wdt + "P2860"]: ["work", "work"] };
  const typed = new Set();
  const type = (s, a) => { if (CLASS[a] && !typed.has(s + a)) { typed.add(s + a); out.add(s, NS.rdf + "type", S + CLASS[a]); } };
  const main = iri.wikidata(qid);
  type(main, aspect);
  for (const { subject: s, predicate: { value: p }, object: o } of raw) {
    if (PREDICATES[p]) out.add(s, PREDICATES[p], o);
    if (roles[p]) { type(s.value, roles[p][0]); if (roles[p][1]) type(o.value, roles[p][1]); }
    switch (p) {
      case NS.wdt + "P577": {
        const m = o.value.match(/^(-?\d{1,4})-(\d\d)-(\d\d)/);
        if (m) out.add(s, S + "datePublished", dateLiteral(DF, m[1], m[2], m[3]));
        break;
      }
      case NS.wdt + "P496": out.add(s, S + "sameAs", iri.orcid(o.value)); type(s.value, "author"); break;
      // A DOI identifies a work. Journals and people sometimes carry one on Wikidata; it must not become their identity.
      case NS.wdt + "P10283": if (/^[WASTC]\d+$/.test(o.value)) out.add(s, S + "sameAs", iri.openalex(o.value)); break;
      case NS.wdt + "P356": if (s.value !== main || aspect === "work") out.add(s, S + "sameAs", iri.doi(o.value)); break;
      case NS.wdt + "P236": out.add(s, S + "sameAs", iri.issn(o.value)); out.lit(s, S + "issn", o.value); type(s.value, "venue"); break;
      case NS.wdt + "P31": out.add(s, S + "additionalType", o); if (typeOf.has(o.value)) type(s.value, typeOf.get(o.value)); break;
    }
  }
  return out.quads;
}
