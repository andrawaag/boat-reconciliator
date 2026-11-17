// The koetai-bibliography data model: schema.org, with one named graph per source.
// Identity: people are keyed by ORCID, works by DOI, venues by ISSN, everything else by Wikidata QID.
// Adapters mint IRIs from whatever identifiers they have and assert schema:sameAs; src/reconcile.js merges them.

export const NS = {
  schema: "http://schema.org/",
  wd: "http://www.wikidata.org/entity/",
  wdt: "http://www.wikidata.org/prop/direct/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  kb: "urn:koetai-bibliography:vocab:",
};

export const SOURCES = ["wikidata", "orcid", "crossref", "datacite", "openalex"];
export const graphFor = (source) => `urn:koetai-bibliography:source:${source}`;

export const iri = {
  wikidata: (q) => NS.wd + q,
  orcid: (o) => `https://orcid.org/${o.toUpperCase()}`,
  doi: (d) => `https://doi.org/${d.trim().toLowerCase()}`,
  issn: (i) => `urn:issn:${i.trim().toUpperCase()}`,
  openalex: (id) => `https://openalex.org/${id.toUpperCase()}`,
};

const PATTERNS = [
  ["wikidata", /^(?:wikidata:|wd:)?(Q\d+)$/i, (m) => m[1].toUpperCase()],
  ["orcid", /^(?:orcid:|https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i, (m) => m[1].toUpperCase()],
  ["doi", /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i, (m) => m[1].toLowerCase()],
  ["issn", /^(?:issn:|urn:issn:)?(\d{4}-\d{3}[\dX])$/i, (m) => m[1].toUpperCase()],
  ["openalex", /^(?:openalex:|https?:\/\/(?:api\.)?openalex\.org\/(?:\w+\/)?)?([WASTC]\d{3,})$/i, (m) => m[1].toUpperCase()],
];

/** Parse user input or a route key ("orcid:0000-…", "10.1145/…", "Q42") into { scheme, value }. */
export function parseKey(input) {
  const s = decodeURIComponent(String(input)).trim();
  for (const [scheme, re, norm] of PATTERNS) {
    const m = s.match(re);
    if (m) return { scheme, value: norm(m) };
  }
  const wd = s.match(/^http:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/);
  if (wd) return { scheme: "wikidata", value: wd[1] };
  return null;
}

export const keyString = ({ scheme, value }) => `${scheme}:${value}`;
export const keyToIri = ({ scheme, value }) => iri[scheme](value);
export const iriToKey = (i) => (/^(https?:|urn:issn:)/.test(i) ? parseKey(i) : null);

/** Which aspect an identifier implies on its own (a Wikidata QID needs a type lookup). */
const OPENALEX_ASPECT = { A: "author", W: "work", S: "venue", T: "topic", C: "topic" };
export function aspectForKey({ scheme, value }) {
  if (scheme === "openalex") return OPENALEX_ASPECT[value[0]];
  return { orcid: "author", doi: "work", issn: "venue" }[scheme];
}

/** Normalise a partial date to an RDF literal: xsd:date, xsd:gYearMonth or xsd:gYear. */
export function dateLiteral(DF, y, m, d) {
  if (!y) return null;
  const p = (n) => String(n).padStart(2, "0");
  if (m && d) return DF.literal(`${y}-${p(m)}-${p(d)}`, DF.namedNode(NS.xsd + "date"));
  if (m) return DF.literal(`${y}-${p(m)}`, DF.namedNode(NS.xsd + "gYearMonth"));
  return DF.literal(String(y), DF.namedNode(NS.xsd + "gYear"));
}

/** Small helper that collects quads for one source graph. */
export function quadSink(DF, source) {
  const g = DF.namedNode(graphFor(source));
  const quads = [];
  const term = (x) => (typeof x === "string" ? DF.namedNode(x) : x);
  return {
    quads,
    add(s, p, o) { if (s && o) quads.push(DF.quad(term(s), DF.namedNode(p), term(o), g)); },
    lit(s, p, value, lang) { if (value != null && value !== "") quads.push(DF.quad(term(s), DF.namedNode(p), DF.literal(String(value), lang), g)); },
  };
}
