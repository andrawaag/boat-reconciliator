// OpenAlex adapter: REST API (JSON, CORS-enabled, CC0) -> schema.org.
// Brings disambiguated author ids, venue ids, OpenAlex topics, and a real "cited by" list.
// Anonymous use is metered (about 1,000 requests a day per IP). Node runs may set OPENALEX_API_KEY;
// the browser never sees a key.
import { NS, iri, quadSink, dateLiteral, addIdentifier } from "../model.js";
import { politeJson } from "../http.js";
const S = NS.schema, FS = NS.kr;
const API = "https://api.openalex.org";
const WORK_FIELDS = "id,doi,display_name,publication_date,publication_year,type,primary_location,authorships,topics,cited_by_count";
const MAX_PAGES = 5; // 5 x 200 works

const short = (id) => id?.replace("https://openalex.org/", "");
const doiOf = (u) => u?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
const plain = (t) => t?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function url(ctx, path, params = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (ctx.openalexKey) u.searchParams.set("api_key", ctx.openalexKey);
  return u.toString();
}
const get = (ctx, path, params) => politeJson(ctx, url(ctx, path, params), "OpenAlex");

function workIri(out, w) {
  const doi = doiOf(w.doi);
  const node = doi ? iri.doi(doi) : w.id;
  if (doi) out.add(node, S + "sameAs", w.id);
  return node;
}

function venue(out, src) {
  if (!src?.id) return null;
  const v = src.issn_l ? iri.issn(src.issn_l) : src.id;
  out.add(v, NS.rdf + "type", S + "Periodical");
  out.lit(v, S + "name", src.display_name);
  if (v !== src.id) out.add(v, S + "sameAs", src.id);
  for (const x of src.issn ?? []) { out.lit(v, S + "issn", x); if (iri.issn(x) !== v) out.add(v, S + "sameAs", iri.issn(x)); }
  return v;
}

function mapWork(DF, out, w, { references = false } = {}) {
  const node = workIri(out, w);
  out.add(node, NS.rdf + "type", S + (w.type === "dataset" ? "Dataset" : "ScholarlyArticle"));
  out.lit(node, S + "name", plain(w.display_name));
  const d = w.publication_date?.match(/^(\d{4})-(\d\d)-(\d\d)/);
  out.add(node, S + "datePublished", d ? dateLiteral(DF, d[1], d[2], d[3]) : dateLiteral(DF, w.publication_year));
  if (w.cited_by_count != null) out.add(node, FS + "citedByCount", DF.literal(String(w.cited_by_count), DF.namedNode(NS.xsd + "integer")));
  const v = venue(out, w.primary_location?.source);
  if (v) out.add(node, S + "isPartOf", v);
  (w.authorships ?? []).forEach((a, i) => {
    if (!a.author?.id) return;
    const orcid = a.author.orcid?.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i)?.[0];
    const person = orcid ? iri.orcid(orcid) : a.author.id;
    if (orcid) out.add(person, S + "sameAs", a.author.id);
    out.add(person, NS.rdf + "type", S + "Person");
    out.lit(person, S + "name", a.author.display_name);
    out.add(node, S + "author", person);
    const as = `urn:koetai-reconciliator:authorship:openalex:${short(w.id)}:${i + 1}`;
    out.add(node, FS + "authorship", as);
    out.add(as, FS + "agent", person);
    out.add(as, FS + "position", DF.literal(String(i + 1), DF.namedNode(NS.xsd + "integer")));
  });
  for (const t of (w.topics ?? []).slice(0, 3)) {
    out.add(node, S + "about", t.id);
    out.add(t.id, NS.rdf + "type", S + "DefinedTerm");
    out.lit(t.id, S + "name", t.display_name);
  }
  if (references) for (const r of w.referenced_works ?? []) out.add(node, S + "citation", r);
  return node;
}

// Plain page numbers: cursor paging answers HTTP 401 without an API key.
async function listWorks(ctx, out, filter, { sort = "publication_date:desc", pages = MAX_PAGES } = {}) {
  let n = 0;
  for (let p = 1; p <= pages; p++) {
    const page = await get(ctx, "/works", { filter, sort, "per-page": 200, page: p, select: WORK_FIELDS });
    for (const w of page.results ?? []) { mapWork(ctx.DF, out, w); n++; }
    if (n >= (page.meta?.count ?? 0) || !page.results?.length) break;
  }
  return n;
}
const notFound = (err) => { if (/HTTP 404/.test(err.message)) return null; throw err; };

/** Look up an OpenAlex entity and return the cross-identifiers it knows (orcid, doi, issn, wikidata, openalex). */
export async function resolveOpenalex(ctx, id) {
  const path = { A: "/authors/", W: "/works/", S: "/sources/", T: "/topics/", C: "/concepts/" }[id[0]] + id;
  const e = await get(ctx, path, { select: "id,ids" });
  const ids = e.ids ?? {};
  return {
    orcid: ids.orcid?.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i)?.[0],
    doi: doiOf(ids.doi),
    issn: ids.issn_l,
    wikidata: ids.wikidata?.match(/Q\d+/)?.[0],
  };
}

export async function harvestOpenalex(ctx, aspect, ids) {
  const out = quadSink(ctx.DF, "openalex");
  if (aspect === "author") {
    const filter = ids.orcid ? `author.orcid:${ids.orcid}` : ids.openalex ? `author.id:${ids.openalex}` : null;
    if (!filter) return [];
    // The author record gives the OpenAlex id even when Wikidata doesn't know it, plus Scopus ids.
    const ref = ids.openalex?.startsWith("A") ? ids.openalex : `orcid:${ids.orcid}`;
    const author = await get(ctx, `/authors/${ref}`, { select: "id,display_name,orcid,ids" }).catch(notFound);
    if (author) {
      const me = ids.orcid ? iri.orcid(ids.orcid) : author.id;
      out.lit(me, S + "name", author.display_name);
      if (me !== author.id) out.add(me, S + "sameAs", author.id);
      const scopus = author.ids?.scopus?.match(/authorId=(\d+)/)?.[1];
      if (scopus) addIdentifier(out, me, "P1153", scopus);
      addIdentifier(out, me, "P10283", author.id.replace("https://openalex.org/", ""));
    }
    await listWorks(ctx, out, filter);
  } else if (aspect === "work") {
    const ref = ids.doi ? `doi:${ids.doi}` : ids.openalex;
    if (!ref) return [];
    const w = await get(ctx, `/works/${ref}`, { select: WORK_FIELDS + ",referenced_works" }).catch(notFound);
    if (!w) return [];
    const node = mapWork(ctx.DF, out, w, { references: true });
    // Give referenced works their DOIs and titles, so they merge with Crossref/Wikidata citations.
    const refs = (w.referenced_works ?? []).map(short);
    for (let i = 0; i < refs.length; i += 50) {
      const page = await get(ctx, "/works", { filter: `openalex:${refs.slice(i, i + 50).join("|")}`, "per-page": 50, select: "id,doi,display_name,publication_date,publication_year" });
      for (const r of page.results ?? []) {
        const rn = workIri(out, r);
        out.lit(rn, S + "name", plain(r.display_name));
        const d = r.publication_date?.match(/^(\d{4})-(\d\d)-(\d\d)/);
        out.add(rn, S + "datePublished", d ? dateLiteral(ctx.DF, d[1], d[2], d[3]) : dateLiteral(ctx.DF, r.publication_year));
      }
    }
    // Newest citing works (OpenAlex's citation index goes well beyond what Wikidata holds).
    const citing = await get(ctx, "/works", { filter: `cites:${short(w.id)}`, sort: "publication_date:desc", "per-page": 200, select: "id,doi,display_name,publication_date,publication_year" });
    for (const c of citing.results ?? []) {
      const cn = workIri(out, c);
      out.add(cn, S + "citation", node);
      out.lit(cn, S + "name", plain(c.display_name));
      const d = c.publication_date?.match(/^(\d{4})-(\d\d)-(\d\d)/);
      out.add(cn, S + "datePublished", d ? dateLiteral(ctx.DF, d[1], d[2], d[3]) : dateLiteral(ctx.DF, c.publication_year));
    }
  } else if (aspect === "venue") {
    const src = ids.openalex?.startsWith("S") ? await get(ctx, `/sources/${ids.openalex}`, {}) : ids.issn ? await get(ctx, `/sources/issn:${ids.issn}`, {}).catch(notFound) : null;
    if (!src) return [];
    venue(out, src);
    await listWorks(ctx, out, `primary_location.source.id:${short(src.id)}`, { pages: 3 });
  } else if (aspect === "topic") {
    const id = ids.openalex;
    if (!id || !/^[TC]/.test(id)) return [];
    const t = await get(ctx, `/${id[0] === "T" ? "topics" : "concepts"}/${id}`, { select: "id,display_name,description" });
    out.add(t.id, NS.rdf + "type", S + "DefinedTerm");
    out.lit(t.id, S + "name", t.display_name);
    out.lit(t.id, S + "description", t.description);
    await listWorks(ctx, out, `${id[0] === "T" ? "topics" : "concepts"}.id:${id}`, { pages: 3 });
  }
  return out.quads;
}
