// Concept check via EBI's Ontology Lookup Service (OLS4) -> graph urn:koetai-reconciliator:source:ols.
// Every code that a page maps to (an ontology's cross-reference, an external ID on Wikidata) is looked up in OLS:
// does it exist, what is it called there, and is it obsolete (and replaced by what)? The results are plain RDF on
// the code's node, so the mappings panel and the "Improve Wikidata" panel can use them:
//   <code> kr:olsStatus "current" | "obsolete" | "not found" ; kr:olsName "…" ; kr:olsOntology "mondo" ;
//          obo:IAO_0100001 <replacement> .
import { NS, quadSink } from "../model.js";
import { politeJson } from "../http.js";
import { olsLookup } from "../vocab.js";

const OLS = "https://www.ebi.ac.uk/ols4/api";
const REPLACED_BY = "http://purl.obolibrary.org/obo/IAO_0100001";

/** OLS's view of one IRI, or null when OLS has no term with it. Prefers the ontology that defines the term. */
export async function olsTerm(ctx, termIri) {
  const res = await politeJson(ctx, `${OLS}/terms?iri=${encodeURIComponent(termIri)}&size=50`, "OLS");
  const terms = res?._embedded?.terms ?? [];
  const t = terms.find((x) => x.is_defining_ontology) ?? terms.find((x) => !x.is_obsolete) ?? terms[0];
  if (!t) return null;
  const replaced = t.term_replaced_by;
  return {
    label: t.label, obsolete: !!t.is_obsolete, ontology: t.ontology_name,
    replacedBy: replaced ? (/^https?:/.test(replaced) ? replaced : `http://purl.obolibrary.org/obo/${String(replaced).replace(":", "_")}`) : null,
  };
}

/** Check these code IRIs in OLS (a few requests at a time). Codes OLS does not cover are skipped. */
export async function checkConceptsOls(ctx, codeIris, { concurrency = 6 } = {}) {
  const out = quadSink(ctx.DF, "ols");
  const todo = [...new Set(codeIris)].map((code) => ({ code, lookup: olsLookup(code) })).filter((x) => x.lookup);
  // An OBO PURL of an ontology that OLS does not load (NANDO, …) is not evidence that the code is missing.
  const hosted = new Map();
  const ontologyInOls = (prefix) => {
    if (!hosted.has(prefix)) hosted.set(prefix, politeJson(ctx, `${OLS}/ontologies/${prefix.toLowerCase()}`, "OLS").then(() => true, () => false));
    return hosted.get(prefix);
  };
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { code, lookup } = todo[next++];
      const t = await olsTerm(ctx, lookup.iri).catch(() => undefined);
      if (t === undefined) continue; // OLS error: no claim either way
      if (!t) {
        const prefix = lookup.iri.match(/^http:\/\/purl\.obolibrary\.org\/obo\/([A-Za-z]+)_/)?.[1];
        if (lookup.authoritative && (!prefix || await ontologyInOls(prefix))) out.lit(code, NS.kr + "olsStatus", "not found");
        continue;
      }
      out.lit(code, NS.kr + "olsStatus", t.obsolete ? "obsolete" : "current");
      out.lit(code, NS.kr + "olsName", lookup.via ? `${t.label} (via ${lookup.via})` : t.label);
      out.lit(code, NS.kr + "olsOntology", t.ontology);
      if (t.replacedBy && t.replacedBy !== code) out.add(code, REPLACED_BY, t.replacedBy);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { quads: out.quads, checked: todo.length };
}
