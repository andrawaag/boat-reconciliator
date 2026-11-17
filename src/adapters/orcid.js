// ORCID adapter: public API v3 (JSON, CORS-enabled) -> schema.org. Returns the DOIs it found for Crossref enrichment.
import { NS, iri, quadSink, dateLiteral, addIdentifier } from "../model.js";
import { politeJson } from "../http.js";
const S = NS.schema;
const API = "https://pub.orcid.org/v3.0";

const getJson = (ctx, url) => politeJson(ctx, url, "ORCID");
const ORCID_ID_TYPES = { "Scopus Author ID": "P1153", ResearcherID: "P1053", "Loop profile": "P2798", ISNI: "P213", GitHub: "P2037" };

export async function harvestOrcid(ctx, orcid) {
  const out = quadSink(ctx.DF, "orcid");
  const me = iri.orcid(orcid);
  const [person, works] = await Promise.all([getJson(ctx, `${API}/${orcid}/person`), getJson(ctx, `${API}/${orcid}/works`)]);
  out.add(me, NS.rdf + "type", S + "Person");
  const n = person.name;
  const name = n?.["credit-name"]?.value || [n?.["given-names"]?.value, n?.["family-name"]?.value].filter(Boolean).join(" ");
  out.lit(me, S + "name", name);
  out.lit(me, S + "description", person.biography?.content);
  for (const o of person["other-names"]?.["other-name"] ?? []) out.lit(me, S + "alternateName", o.content);
  // External identifiers the person linked in ORCID, mapped to Wikidata properties.
  for (const x of person["external-identifiers"]?.["external-identifier"] ?? []) {
    const property = ORCID_ID_TYPES[x["external-id-type"]];
    if (!property) continue;
    let value = x["external-id-value"];
    if (property === "P213") value = value.replace(/\s/g, "").replace(/^(\d{4})(\d{4})(\d{4})(\d{3}[\dX])$/i, "$1 $2 $3 $4"); // ISNI as Wikidata formats it
    addIdentifier(out, me, property, value);
  }
  const dois = [];
  for (const group of works.group ?? []) {
    const summary = group["work-summary"]?.[0];
    if (!summary) continue;
    const doi = (group["external-ids"]?.["external-id"] ?? []).find((x) => x["external-id-type"] === "doi")?.["external-id-value"];
    const w = doi ? iri.doi(doi) : `urn:koetai-reconciliator:orcid-work:${orcid}:${summary["put-code"]}`;
    if (doi) dois.push(doi.toLowerCase());
    out.add(w, NS.rdf + "type", S + "ScholarlyArticle");
    out.add(w, S + "author", me);
    out.lit(w, S + "name", summary.title?.title?.value?.replace(/<[^>]+>/g, "").trim());
    const d = summary["publication-date"];
    out.add(w, S + "datePublished", dateLiteral(ctx.DF, d?.year?.value, d?.month?.value, d?.day?.value));
  }
  return { quads: out.quads, dois };
}
