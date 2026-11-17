// Crossref adapter: REST API (JSON, CORS-enabled) -> schema.org.
// Authors with an ORCID become https://orcid.org/… nodes (and merge with ORCID/Wikidata); others get per-work URNs.
import { NS, iri, quadSink, dateLiteral } from "../model.js";
import { politeJson } from "../http.js";
const S = NS.schema, FS = NS.kr;
const API = "https://api.crossref.org";
const FIELDS = "DOI,title,author,issued,container-title,ISSN,type,is-referenced-by-count";

const getJson = async (ctx, url) => (await politeJson(ctx, url, "Crossref")).message;

// DOI prefixes registered with DataCite, not Crossref (Zenodo, figshare, arXiv, Dryad, PANGAEA, OSF).
// Asking Crossref for them only burns rate limit; they belong to a future DataCite adapter.
const DATACITE_PREFIXES = ["10.5281/", "10.6084/", "10.48550/", "10.5061/", "10.1594/", "10.17605/"];
const isCrossrefCandidate = (doi) => !DATACITE_PREFIXES.some((p) => doi.startsWith(p)) && !doi.includes(",");

// Crossref titles may contain JATS/HTML markup (<i>, <sub>, <mml:math>…); keep the text only.
const plain = (t) => t?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function mapWork(DF, out, item) {
  const doi = item.DOI.toLowerCase();
  const w = iri.doi(doi);
  out.add(w, NS.rdf + "type", S + "ScholarlyArticle");
  out.lit(w, S + "name", plain(item.title?.[0]));
  const [y, m, d] = item.issued?.["date-parts"]?.[0] ?? [];
  out.add(w, S + "datePublished", dateLiteral(DF, y, m, d));
  if (item["is-referenced-by-count"] != null)
    out.add(w, FS + "citedByCount", DF.literal(String(item["is-referenced-by-count"]), DF.namedNode(NS.xsd + "integer")));
  (item.author ?? []).forEach((a, i) => {
    const orcid = a.ORCID?.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i)?.[0];
    const person = orcid ? iri.orcid(orcid) : `urn:koetai-reconciliator:crossref-author:${encodeURIComponent(doi)}:${i + 1}`;
    out.add(person, NS.rdf + "type", S + "Person");
    out.lit(person, S + "name", a.name || [a.given, a.family].filter(Boolean).join(" "));
    out.add(w, S + "author", person);
    const as = `urn:koetai-reconciliator:authorship:${encodeURIComponent(doi)}:${i + 1}`;
    out.add(w, FS + "authorship", as);
    out.add(as, FS + "agent", person);
    out.add(as, FS + "position", DF.literal(String(i + 1), DF.namedNode(NS.xsd + "integer")));
  });
  const issns = item.ISSN ?? [];
  if (issns.length) {
    const v = iri.issn(issns[0]);
    out.add(w, S + "isPartOf", v);
    out.add(v, NS.rdf + "type", S + "Periodical");
    out.lit(v, S + "name", plain(item["container-title"]?.[0]));
    for (const x of issns) { out.lit(v, S + "issn", x); if (x !== issns[0]) out.add(v, S + "sameAs", iri.issn(x)); }
  }
  for (const r of item.reference ?? []) {
    if (!r.DOI) continue;
    const c = iri.doi(r.DOI);
    out.add(w, S + "citation", c);
    out.lit(c, S + "name", plain(r["article-title"]));
    if (r.year) out.add(c, S + "datePublished", dateLiteral(DF, r.year));
  }
}

export async function harvestCrossref(ctx, { orcid, dois = [], issn, references = false }) {
  const out = quadSink(ctx.DF, "crossref");
  const seen = new Set();
  const take = (items) => { for (const it of items ?? []) { seen.add(it.DOI.toLowerCase()); mapWork(ctx.DF, out, it); } };
  const fields = references ? FIELDS + ",reference" : FIELDS;
  if (orcid) take((await getJson(ctx, `${API}/works?filter=orcid:${orcid}&rows=1000&select=${fields}`)).items);
  if (issn) {
    const journal = await getJson(ctx, `${API}/journals/${issn}`).catch(() => null);
    if (journal) {
      const v = iri.issn(issn);
      out.add(v, NS.rdf + "type", S + "Periodical");
      out.lit(v, S + "name", journal.title);
      for (const x of journal.ISSN ?? []) { out.lit(v, S + "issn", x); if (x.toUpperCase() !== issn) out.add(v, S + "sameAs", iri.issn(x)); }
    }
    take((await getJson(ctx, `${API}/journals/${issn}/works?sort=published&order=desc&rows=500&select=${fields}`)).items);
  }
  const missing = [...new Set(dois.map((d) => d.toLowerCase()))].filter((d) => !seen.has(d) && isCrossrefCandidate(d));
  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    const filter = batch.map((d) => `doi:${encodeURIComponent(d)}`).join(",");
    take((await getJson(ctx, `${API}/works?filter=${filter}&rows=${batch.length}&select=${fields}`)).items);
  }
  return out.quads;
}
