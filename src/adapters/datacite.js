// DataCite adapter: REST API (JSON:API, CORS-enabled) -> schema.org.
// Covers the DOIs Crossref does not: Zenodo, figshare, arXiv, Dryad, OSF, institutional repositories.
import { NS, iri, quadSink, dateLiteral } from "../model.js";
import { politeJson } from "../http.js";
const S = NS.schema, FS = NS.kr;
const API = "https://api.datacite.org/dois";
const FIELDS = "doi,titles,creators,publicationYear,dates,types,container,relatedIdentifiers,citationCount";

const TYPE = { Dataset: "Dataset", Software: "SoftwareSourceCode", JournalArticle: "ScholarlyArticle", Preprint: "ScholarlyArticle", Text: "ScholarlyArticle", ConferencePaper: "ScholarlyArticle", Report: "Report", Book: "Book", BookChapter: "Chapter", Dissertation: "Thesis", Image: "ImageObject", Audiovisual: "VideoObject", Collection: "Collection", Event: "Event", Presentation: "PresentationDigitalDocument", Poster: "CreativeWork" };
const ORCID_RE = /\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i;

function mapRecord(DF, out, a) {
  const doi = a.doi.toLowerCase();
  const w = iri.doi(doi);
  out.add(w, NS.rdf + "type", S + (TYPE[a.types?.resourceTypeGeneral] ?? "CreativeWork"));
  out.lit(w, S + "name", a.titles?.find((t) => !t.titleType)?.title ?? a.titles?.[0]?.title);
  const issued = a.dates?.find((d) => d.dateType === "Issued")?.date?.match(/^(\d{4})(?:-(\d\d))?(?:-(\d\d))?/);
  out.add(w, S + "datePublished", issued ? dateLiteral(DF, issued[1], issued[2], issued[3]) : dateLiteral(DF, a.publicationYear));
  if (a.citationCount) out.add(w, FS + "citedByCount", DF.literal(String(a.citationCount), DF.namedNode(NS.xsd + "integer")));
  (a.creators ?? []).forEach((c, i) => {
    const orcid = (c.nameIdentifiers ?? []).find((n) => /orcid/i.test(n.nameIdentifierScheme ?? ""))?.nameIdentifier?.match(ORCID_RE)?.[0];
    const person = orcid ? iri.orcid(orcid) : `urn:koetai-reconciliator:datacite-author:${encodeURIComponent(doi)}:${i + 1}`;
    if (c.nameType === "Organizational") out.add(person, NS.rdf + "type", S + "Organization");
    else out.add(person, NS.rdf + "type", S + "Person");
    out.lit(person, S + "name", c.givenName && c.familyName ? `${c.givenName} ${c.familyName}` : c.name);
    out.add(w, S + "author", person);
    const as = `urn:koetai-reconciliator:authorship:datacite:${encodeURIComponent(doi)}:${i + 1}`;
    out.add(w, FS + "authorship", as);
    out.add(as, FS + "agent", person);
    out.add(as, FS + "position", DF.literal(String(i + 1), DF.namedNode(NS.xsd + "integer")));
  });
  if (a.container?.identifierType === "ISSN" && a.container.identifier) {
    const v = iri.issn(a.container.identifier);
    out.add(w, S + "isPartOf", v);
    out.add(v, NS.rdf + "type", S + "Periodical");
    out.lit(v, S + "name", a.container.title);
  }
  for (const r of a.relatedIdentifiers ?? []) {
    if (r.relatedIdentifierType !== "DOI" || !r.relatedIdentifier) continue;
    const other = iri.doi(r.relatedIdentifier.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
    if (r.relationType === "References" || r.relationType === "Cites") out.add(w, S + "citation", other);
    if (r.relationType === "IsReferencedBy" || r.relationType === "IsCitedBy") out.add(other, S + "citation", w);
  }
}

export async function harvestDatacite(ctx, { orcid, dois = [] }) {
  const out = quadSink(ctx.DF, "datacite");
  const seen = new Set();
  const take = (data) => { for (const d of data ?? []) { seen.add(d.attributes.doi.toLowerCase()); mapRecord(ctx.DF, out, d.attributes); } };
  if (orcid) {
    const q = encodeURIComponent(`creators.nameIdentifiers.nameIdentifier:"https://orcid.org/${orcid}"`);
    take((await politeJson(ctx, `${API}?query=${q}&page[size]=1000&fields[dois]=${FIELDS}`, "DataCite")).data);
  }
  const missing = [...new Set(dois.map((d) => d.toLowerCase()))].filter((d) => !seen.has(d) && !d.includes('"'));
  if (missing.length === 1) {
    // Single lookups 404 for non-DataCite DOIs; that is "not ours", not an error.
    const res = await ctx.fetch(`${API}/${encodeURIComponent(missing[0])}`, { headers: { Accept: "application/json", ...ctx.headers } });
    if (res.ok) take([(await res.json()).data]);
    else if (res.status !== 404) throw new Error(`DataCite HTTP ${res.status}`);
  } else {
    for (let i = 0; i < missing.length; i += 25) {
      const batch = missing.slice(i, i + 25);
      const q = encodeURIComponent(batch.map((d) => `doi:"${d}"`).join(" OR "));
      take((await politeJson(ctx, `${API}?query=${q}&page[size]=${batch.length}&fields[dois]=${FIELDS}`, "DataCite")).data);
    }
  }
  return out.quads;
}
