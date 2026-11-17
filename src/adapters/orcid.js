// ORCID adapter: public API v3 (JSON, CORS-enabled) -> schema.org. Returns the DOIs it found for Crossref enrichment.
import { NS, iri, quadSink, dateLiteral } from "../model.js";
import { politeJson } from "../http.js";
const S = NS.schema;
const API = "https://pub.orcid.org/v3.0";

const getJson = (ctx, url) => politeJson(ctx, url, "ORCID");

export async function harvestOrcid(ctx, orcid) {
  const out = quadSink(ctx.DF, "orcid");
  const me = iri.orcid(orcid);
  const [person, works] = await Promise.all([getJson(ctx, `${API}/${orcid}/person`), getJson(ctx, `${API}/${orcid}/works`)]);
  out.add(me, NS.rdf + "type", S + "Person");
  const n = person.name;
  const name = n?.["credit-name"]?.value || [n?.["given-names"]?.value, n?.["family-name"]?.value].filter(Boolean).join(" ");
  out.lit(me, S + "name", name);
  out.lit(me, S + "description", person.biography?.content);
  const dois = [];
  for (const group of works.group ?? []) {
    const summary = group["work-summary"]?.[0];
    if (!summary) continue;
    const doi = (group["external-ids"]?.["external-id"] ?? []).find((x) => x["external-id-type"] === "doi")?.["external-id-value"];
    const w = doi ? iri.doi(doi) : `urn:frugalscholia:orcid-work:${orcid}:${summary["put-code"]}`;
    if (doi) dois.push(doi.toLowerCase());
    out.add(w, NS.rdf + "type", S + "ScholarlyArticle");
    out.add(w, S + "author", me);
    out.lit(w, S + "name", summary.title?.title?.value?.replace(/<[^>]+>/g, "").trim());
    const d = summary["publication-date"];
    out.add(w, S + "datePublished", dateLiteral(ctx.DF, d?.year?.value, d?.month?.value, d?.day?.value));
  }
  return { quads: out.quads, dois };
}
