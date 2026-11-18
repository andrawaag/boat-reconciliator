// PubMed via RDF Portal's NCBI SPARQL endpoint (https://rdfportal.org/ncbi/sparql) -> graph urn:koetai-reconciliator:source:pubmed.
//   - Work pages: the work's PMID, title, date, journal (ISSN), MeSH subjects and ordered author list.
//   - Author pages: the PMIDs and major MeSH subjects of the author's works, found by DOI in batches.
// Each PubMed record is http://rdf.ncbi.nlm.nih.gov/pubmed/<pmid>, linked to the DOI with schema:sameAs and given
// a P698 identifier node for the Wikidata panels. MeSH subjects are http://id.nlm.nih.gov/mesh/<descriptor> nodes.
// PubMed authors carry no ORCIDs: they are per-work nodes that reconcile.js joins with other sources' authors by name.
//
// Virtuoso notes: DOIs are stored in their original case, so lookups use the full-text index (bif:contains, which
// ignores case) and are checked exactly afterwards. VALUES must sit inside the GRAPH block, or the endpoint scans
// the whole dataset. The DOI property really is spelled "namespeces".
import { NS, iri, quadSink, dateLiteral, addIdentifier } from "../model.js";
import { rdfPortalSelect } from "./rdfportal.js";

const ENDPOINT = "https://rdfportal.org/ncbi/sparql";
const GRAPH = "http://rdfportal.org/dataset/pubmed";
const MESH_GRAPH = "http://id.nlm.nih.gov/mesh";
const PRISM = "http://prismstandard.org/namespeces/1.2/basic/";
const FABIO = "http://purl.org/spar/fabio/";
const DCT = "http://purl.org/dc/terms/";
const OLO = "http://purl.org/ontology/olo/core#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const S = NS.schema;
const pmidOf = (pmIri) => pmIri.split("/").pop();
const select = (ctx, q) => rdfPortalSelect(ctx, q, ENDPOINT);
// Only DOIs the full-text index can take as a phrase; others (with brackets, semicolons, …) are looked up exactly.
const phraseSafe = (doi) => /^10\.[\w./-]+$/.test(doi);

/** PMIDs for DOIs: Map lower-case DOI -> PubMed IRI. */
export async function pmidsForDois(ctx, dois, { batch = 40 } = {}) {
  const wanted = [...new Set(dois.map((d) => d.toLowerCase()))];
  const found = new Map();
  const safe = wanted.filter(phraseSafe), other = wanted.filter((d) => !phraseSafe(d));
  const chunks = [];
  for (let i = 0; i < safe.length; i += batch) chunks.push(safe.slice(i, i + batch));
  let next = 0;
  const worker = async () => { // a few batches at a time: long author lists have hundreds of DOIs
    while (next < chunks.length) {
      const text = chunks[next++].map((d) => `"${d}"`).join(" OR ");
      const rows = await select(ctx, `SELECT ?pm ?d WHERE { GRAPH <${GRAPH}> { ?pm <${PRISM}doi> ?d . ?d bif:contains ${JSON.stringify(text)} } }`);
      for (const b of rows) found.set(b.d.value.toLowerCase(), b.pm.value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  for (let i = 0; i < other.length; i += batch) {
    const values = other.slice(i, i + batch).flatMap((d) => [d, d.toUpperCase()]).map((d) => JSON.stringify(d)).join(" ");
    const rows = await select(ctx, `SELECT ?pm ?d WHERE { GRAPH <${GRAPH}> { VALUES ?d { ${values} } ?pm <${PRISM}doi> ?d } }`);
    for (const b of rows) found.set(b.d.value.toLowerCase(), b.pm.value);
  }
  for (const d of [...found.keys()]) if (!wanted.includes(d)) found.delete(d); // phrase matches that are not exact
  return found;
}

/** DOI of a PubMed record, or null. */
export async function doiForPmid(ctx, pmid) {
  const rows = await select(ctx, `SELECT ?d WHERE { GRAPH <${GRAPH}> { <${iri.pmid(pmid)}> <${PRISM}doi> ?d } } LIMIT 1`);
  return rows[0]?.d.value.toLowerCase() ?? null;
}

async function meshSubjects(ctx, out, pmIris, { majorOnly }) {
  const subjects = new Set();
  for (let i = 0; i < pmIris.length; i += 50) {
    const values = pmIris.slice(i, i + 50).map((p) => `<${p}>`).join(" ");
    const rows = await select(ctx, `SELECT ?pm ?mesh ?major WHERE { GRAPH <${GRAPH}> { VALUES ?pm { ${values} }
  { ?pm <${FABIO}hasPrimarySubjectTerm> ?mesh BIND(1 AS ?major) }${majorOnly ? "" : ` UNION { ?pm <${FABIO}hasSubjectTerm> ?mesh BIND(0 AS ?major) }`} } }`);
    for (const b of rows) {
      if (!/^http:\/\/id\.nlm\.nih\.gov\/mesh\/D\d+$/.test(b.mesh.value)) continue; // descriptors only, not qualifiers
      out.add(b.pm.value, S + "about", b.mesh.value);
      subjects.add(b.mesh.value);
    }
  }
  const list = [...subjects];
  for (let i = 0; i < list.length; i += 100) {
    const rows = await select(ctx, `SELECT ?mesh ?label WHERE { GRAPH <${MESH_GRAPH}> { VALUES ?mesh { ${list.slice(i, i + 100).map((m) => `<${m}>`).join(" ")} } ?mesh <http://www.w3.org/2000/01/rdf-schema#label> ?label } }`);
    for (const b of rows) {
      out.add(b.mesh.value, NS.rdf + "type", S + "DefinedTerm");
      out.lit(b.mesh.value, S + "name", b.label.value);
      out.lit(b.mesh.value, NS.kr + "vocabulary", "MeSH");
      out.lit(b.mesh.value, NS.kr + "code", pmidOf(b.mesh.value));
    }
  }
}

function link(out, doi, pm) {
  out.add(iri.doi(doi), S + "sameAs", pm);
  out.add(pm, NS.rdf + "type", S + "ScholarlyArticle");
  addIdentifier(out, pm, "P698", pmidOf(pm));
}

/** Work page: everything PubMed has on one work, by DOI or PMID. */
export async function harvestPubmedWork(ctx, { doi, pmid }) {
  const out = quadSink(ctx.DF, "pubmed");
  const pm = pmid ? iri.pmid(pmid) : (await pmidsForDois(ctx, [doi])).get(doi.toLowerCase());
  if (!pm) return out.quads;
  const d = doi ?? (await doiForPmid(ctx, pmidOf(pm)));
  if (d) link(out, d, pm); else { out.add(pm, NS.rdf + "type", S + "ScholarlyArticle"); addIdentifier(out, pm, "P698", pmidOf(pm)); }

  const [meta, authors] = await Promise.all([
    select(ctx, `SELECT ?title ?issued ?issnL ?eissn ?journal WHERE { GRAPH <${GRAPH}> { VALUES ?pm { <${pm}> }
  OPTIONAL { ?pm <${DCT}title> ?title } OPTIONAL { ?pm <${DCT}issued> ?issued } OPTIONAL { ?pm <${FABIO}hasIssnL> ?issnL }
  OPTIONAL { ?pm <${PRISM}eISSN> ?eissn } OPTIONAL { ?pm <${PRISM}publicationName> ?journal } } } LIMIT 1`),
    select(ctx, `SELECT ?i ?name ?first ?last WHERE { GRAPH <${GRAPH}> { VALUES ?pm { <${pm}> }
  ?pm <${DCT}creator>/<${OLO}slot> ?slot . ?slot <${OLO}index> ?i ; <${OLO}item> ?a .
  OPTIONAL { ?a <${FOAF}name> ?name } OPTIONAL { ?a <${FOAF}firstName> ?first } OPTIONAL { ?a <${FOAF}LastName> ?last } } }`),
  ]);
  const m = meta[0];
  if (m) {
    out.lit(pm, S + "name", m.title?.value);
    const [y, mo, da] = (m.issued?.value ?? "").split("-").map(Number);
    out.add(pm, S + "datePublished", dateLiteral(ctx.DF, y, mo, da));
    const issn = m.issnL?.value ?? m.eissn?.value;
    if (issn) {
      const v = iri.issn(issn);
      out.add(pm, S + "isPartOf", v);
      out.add(v, NS.rdf + "type", S + "Periodical");
      out.lit(v, S + "name", m.journal?.value);
      out.lit(v, S + "issn", issn.toUpperCase());
      if (m.eissn && m.eissn.value.toUpperCase() !== issn.toUpperCase()) { out.lit(v, S + "issn", m.eissn.value.toUpperCase()); out.add(v, S + "sameAs", iri.issn(m.eissn.value)); }
    }
  }
  const pmidv = pmidOf(pm);
  const seen = new Set();
  for (const b of authors.sort((a, z) => Number(a.i.value) - Number(z.i.value))) {
    const i = Number(b.i.value);
    if (seen.has(i)) continue;
    seen.add(i);
    const name = [b.first?.value, b.last?.value].filter(Boolean).join(" ") || b.name?.value;
    if (!name) continue;
    const person = `urn:koetai-reconciliator:pubmed-author:${pmidv}:${i}`;
    out.add(person, NS.rdf + "type", S + "Person");
    out.lit(person, S + "name", name);
    out.add(pm, S + "author", person);
    const as = `urn:koetai-reconciliator:authorship:pmid-${pmidv}:${i}`;
    out.add(pm, NS.kr + "authorship", as);
    out.add(as, NS.kr + "agent", person);
    out.add(as, NS.kr + "position", ctx.DF.literal(String(i), ctx.DF.namedNode(NS.xsd + "integer")));
  }
  await meshSubjects(ctx, out, [pm], { majorOnly: false });
  return out.quads;
}

/** Author page: PMIDs and major MeSH subjects for the author's works (by DOI). */
export async function harvestPubmedForDois(ctx, dois) {
  const out = quadSink(ctx.DF, "pubmed");
  const found = await pmidsForDois(ctx, dois);
  for (const [doi, pm] of found) link(out, doi, pm);
  if (found.size) await meshSubjects(ctx, out, [...found.values()], { majorOnly: true });
  return out.quads;
}
