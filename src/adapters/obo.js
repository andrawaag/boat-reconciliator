// OBO Foundry ontologies via EBI's Ontology Lookup Service (OLS4) -> graph urn:koetai-reconciliator:source:obo.
// One term: label, definition, synonyms (oboInOwl scopes), obsoletion, is-a parents and children, and its
// cross-references to other terminologies (SNOMED CT, MeSH, ICD, UMLS, other OBO ontologies, …) via src/vocab.js.
import { NS, iri, quadSink } from "../model.js";
import { politeJson } from "../http.js";
import { addMapping, parseTargetIri, OBOINOWL, OWL } from "../vocab.js";

const OLS = "https://www.ebi.ac.uk/ols4/api";
const S = NS.schema;
const RDFS = NS.rdfs;
const SYNONYM_SCOPE = { hasExactSynonym: "hasExactSynonym", hasRelatedSynonym: "hasRelatedSynonym", hasBroadSynonym: "hasBroadSynonym", hasNarrowSynonym: "hasNarrowSynonym" };
const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
const notFound = (err) => { if (/HTTP 404/.test(err.message)) return null; throw err; };

/** Fetch the term from its defining ontology (prefix in lower case), falling back to a lookup by IRI. */
async function fetchTerm(ctx, termIri, prefix) {
  const direct = await politeJson(ctx, `${OLS}/ontologies/${prefix.toLowerCase()}/terms/${enc2(termIri)}`, "OLS").catch(notFound);
  if (direct) return direct;
  const any = await politeJson(ctx, `${OLS}/terms?iri=${encodeURIComponent(termIri)}&size=50`, "OLS");
  const terms = any?._embedded?.terms ?? [];
  return terms.find((t) => t.is_defining_ontology) ?? terms[0] ?? null;
}

export async function harvestObo(ctx, oboId) {
  const out = quadSink(ctx.DF, "obo");
  const me = iri.obo(oboId);
  const prefix = oboId.split("_")[0];
  const term = await fetchTerm(ctx, me, prefix);
  if (!term) throw new Error(`OLS has no term ${oboId}`);
  const ont = term.ontology_name;
  const base = `${OLS}/ontologies/${ont}/terms/${enc2(me)}`;

  const [ontology, parents, children] = await Promise.all([
    politeJson(ctx, `${OLS}/ontologies/${ont}`, "OLS").catch(() => null),
    politeJson(ctx, `${base}/parents?size=100`, "OLS").catch(notFound),
    politeJson(ctx, `${base}/children?size=500`, "OLS").catch(notFound),
  ]);

  out.add(me, NS.rdf + "type", S + "DefinedTerm");
  out.lit(me, S + "name", term.label);
  // OLS's description list can start with a comment; the OBO definition is the reliable one.
  out.lit(me, S + "description", term.obo_definition_citation?.[0]?.definition ?? term.description?.[0]);
  out.lit(me, S + "termCode", term.obo_id);
  const set = ontology?.config?.id ? `${NS.kr}ontology:${ontology.config.id}` : null;
  if (set) {
    out.add(me, S + "inDefinedTermSet", set);
    out.lit(set, S + "name", ontology.config.title ?? ont);
    out.lit(set, S + "url", ontology.config.homepage);
    out.lit(set, S + "version", ontology.config.versionIri ?? ontology.config.version);
  }
  if (term.is_obsolete) out.add(me, OWL + "deprecated", ctx.DF.literal("true", ctx.DF.namedNode(NS.xsd + "boolean")));
  const replaced = term.term_replaced_by;
  if (replaced) out.add(me, "http://purl.obolibrary.org/obo/IAO_0100001", /^https?:/.test(replaced) ? replaced : iri.obo(String(replaced).replace(":", "_")));

  // Synonyms with their OBO scope; exact ones also become schema:alternateName.
  for (const syn of term.obo_synonym ?? []) {
    const scope = SYNONYM_SCOPE[syn.scope] ?? "hasRelatedSynonym";
    out.lit(me, OBOINOWL + scope, syn.name);
    if (scope === "hasExactSynonym") out.lit(me, S + "alternateName", syn.name);
  }
  if (!term.obo_synonym) for (const name of term.synonyms ?? []) out.lit(me, OBOINOWL + "hasRelatedSynonym", name);

  // is-a hierarchy (one level up and down).
  const related = (list, up) => {
    for (const t of list?._embedded?.terms ?? []) {
      if (!t.iri) continue;
      out.add(up ? me : t.iri, RDFS + "subClassOf", up ? t.iri : me);
      out.add(t.iri, NS.rdf + "type", S + "DefinedTerm");
      out.lit(t.iri, S + "name", t.label);
      out.lit(t.iri, S + "termCode", t.obo_id);
    }
  };
  related(parents, true);
  related(children, false);
  if (children?.page?.totalElements > (children?._embedded?.terms?.length ?? 0)) out.lit(me, NS.kr + "childCount", children.page.totalElements);

  // Cross-references. "Exact" when the ontology says so (MONDO's "has exact match" / equivalentTo), otherwise a plain xref.
  const exact = new Set();
  for (const x of term.annotation?.["has exact match"] ?? []) {
    const t = typeof x === "string" ? parseTargetIri(x) : null;
    if (t) { addMapping(out, me, t.prefix, t.id, "exact"); exact.add(`${t.prefix}:${t.id}`.toUpperCase()); }
  }
  const xrefs = term.obo_xref?.length
    ? term.obo_xref.map((x) => ({ prefix: x.database, id: x.id, equivalent: /equivalentTo/i.test(x.description ?? "") }))
    : (term.annotation?.database_cross_reference ?? []).map((s) => { const [prefix, ...rest] = String(s).split(":"); return { prefix, id: rest.join(":") }; });
  for (const x of xrefs) {
    if (!x.prefix || !x.id) continue;
    const isExact = x.equivalent || exact.has(`${x.prefix}:${x.id}`.toUpperCase());
    addMapping(out, me, x.prefix, x.id, isExact ? "exact" : "xref");
  }
  return out.quads;
}

/** Label and obsolete status of a term, for checking IDs that Wikidata holds. */
export async function oboTermStatus(fetchFn, oboId) {
  const termIri = iri.obo(oboId);
  const res = await fetchFn(`${OLS}/terms?iri=${encodeURIComponent(termIri)}&size=50`).then((r) => r.json());
  const terms = res?._embedded?.terms ?? [];
  const t = terms.find((x) => x.is_defining_ontology) ?? terms[0];
  return t ? { label: t.label, obsolete: !!t.is_obsolete, replacedBy: t.term_replaced_by ?? null } : null;
}

/** OLS search, for the site's search box: terms whose label or synonym matches. */
export async function searchObo(fetchFn, text, rows = 6) {
  const url = `${OLS}/search?q=${encodeURIComponent(text)}&rows=${rows + 4}&local=true&fieldList=iri,label,obo_id,ontology_prefix,short_form`;
  const res = await fetchFn(url).then((r) => r.json());
  return (res?.response?.docs ?? []).filter((d) => d.iri?.startsWith("http://purl.obolibrary.org/obo/") && /^[A-Za-z]+_\w+$/.test(d.short_form ?? "")).slice(0, rows).map((d) => ({ id: d.short_form, label: d.label, oboId: d.obo_id, ontology: d.ontology_prefix }));
}
