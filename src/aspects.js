// Aspect definitions: which panels a page shows. Each panel is queries/<aspect>/<id>.rq (or queries/common/<id>.rq),
// a SPARQL query over the merged schema.org graph with {{iri}} as the entity placeholder.
export const ASPECTS = {
  vessel: {
    title: "Vessel",
    panels: [
      { id: "details", title: "Details", render: "kv" },
      { id: "images", title: "Images (Wikimedia Commons)", render: "gallery", wide: true, hideEmpty: true },
      { id: "checks", title: "Checks across Wikidata, Commons and OpenStreetMap", render: "table", wide: true },
      { id: "timeline", title: "Timeline", render: "table", wide: true, hideEmpty: true },
      { id: "names", title: "Names", render: "table", hideEmpty: true },
      { id: "sister-ships", title: "Sister ships (same class)", render: "table", hideEmpty: true },
      { id: "osm", title: "On OpenStreetMap", render: "table", wide: true, hideEmpty: true },
      { id: "works", title: "Works about this vessel", render: "table", hideEmpty: true, query: "queries/topic/works.rq" },
      { id: "external-ids", title: "Other identifiers (Wikidata)", render: "table", wide: true, hideEmpty: true, query: "queries/author/external-ids.rq" },
    ],
  },
  class: {
    title: "Ship class",
    panels: [
      { id: "details", title: "Summary", render: "kv", query: "queries/fleet/details.rq" },
      { id: "per-year", title: "Ships per year (launched or in service)", render: "bars", query: "queries/fleet/per-year.rq" },
      { id: "ships", title: "Ships of this class", render: "table", wide: true, query: "queries/fleet/ships.rq" },
      { id: "builders", title: "Builders", render: "table", query: "queries/fleet/builders.rq" },
      { id: "flags", title: "Flags", render: "table", query: "queries/fleet/flags.rq" },
      { id: "images", title: "Images (Wikimedia Commons)", render: "gallery", wide: true, hideEmpty: true, query: "queries/vessel/images.rq" },
      { id: "works", title: "Works about this class", render: "table", hideEmpty: true, query: "queries/topic/works.rq" },
      { id: "external-ids", title: "Other identifiers (Wikidata)", render: "table", wide: true, hideEmpty: true, query: "queries/author/external-ids.rq" },
    ],
  },
  shipyard: {
    title: "Shipbuilder",
    panels: [
      { id: "details", title: "Summary", render: "kv", query: "queries/fleet/details.rq" },
      { id: "per-year", title: "Ships built per year", render: "bars", query: "queries/fleet/per-year.rq" },
      { id: "ships", title: "Ships built", render: "table", wide: true, query: "queries/fleet/ships.rq" },
      { id: "types", title: "Types of vessel", render: "table", query: "queries/fleet/types.rq" },
      { id: "classes", title: "Classes", render: "table", query: "queries/fleet/classes.rq" },
      { id: "images", title: "Images (Wikimedia Commons)", render: "gallery", wide: true, hideEmpty: true, query: "queries/vessel/images.rq" },
      { id: "works", title: "Works about this builder", render: "table", hideEmpty: true, query: "queries/topic/works.rq" },
      { id: "external-ids", title: "Other identifiers (Wikidata)", render: "table", wide: true, hideEmpty: true, query: "queries/author/external-ids.rq" },
    ],
  },
  operator: {
    title: "Ship operator or owner",
    panels: [
      { id: "details", title: "Summary", render: "kv", query: "queries/fleet/details.rq" },
      { id: "per-year", title: "Fleet by year built", render: "bars", query: "queries/fleet/per-year.rq" },
      { id: "ships", title: "Fleet (operated or owned, past and present)", render: "table", wide: true, query: "queries/fleet/ships.rq" },
      { id: "types", title: "Types of vessel", render: "table", query: "queries/fleet/types.rq" },
      { id: "builders", title: "Builders", render: "table", query: "queries/fleet/builders.rq" },
      { id: "images", title: "Images (Wikimedia Commons)", render: "gallery", wide: true, hideEmpty: true, query: "queries/vessel/images.rq" },
      { id: "works", title: "Works about this operator", render: "table", hideEmpty: true, query: "queries/topic/works.rq" },
      { id: "external-ids", title: "Other identifiers (Wikidata)", render: "table", wide: true, hideEmpty: true, query: "queries/author/external-ids.rq" },
    ],
  },
  author: {
    title: "Author",
    panels: [
      { id: "per-year", title: "Works per year", render: "bars" },
      { id: "works", title: "Works", render: "table" },
      { id: "coauthors", title: "Co-authors", render: "table" },
      { id: "topics", title: "Topics", render: "table" },
      { id: "venues", title: "Venues", render: "table" },
      { id: "external-ids", title: "Other identifiers (Wikidata)", render: "table", wide: true, hideEmpty: true },
    ],
  },
  work: {
    title: "Work",
    panels: [
      { id: "details", title: "Details", render: "kv" },
      { id: "authors", title: "Authors", render: "table" },
      { id: "topics", title: "Main subjects", render: "table" },
      { id: "cites", title: "Cites", render: "table" },
      { id: "cited-by", title: "Cited by", render: "table" },
    ],
  },
  topic: {
    title: "Topic",
    panels: [
      { id: "per-year", title: "Works per year", render: "bars" },
      { id: "works", title: "Works", render: "table" },
      { id: "authors", title: "Most prolific authors", render: "table" },
      { id: "mappings", title: "Codes in terminologies (checked in OLS)", render: "table", wide: true, hideEmpty: true },
    ],
  },
  term: {
    title: "Ontology term",
    panels: [
      { id: "details", title: "Definition", render: "kv" },
      { id: "agreement", title: "Agreement between sources", render: "table" },
      { id: "mappings", title: "Mappings to other terminologies (checked in OLS)", render: "table", wide: true },
      { id: "parents", title: "Parents (is a)", render: "table" },
      { id: "children", title: "Children", render: "table" },
      { id: "genes", title: "Associated genes (Wikidata)", render: "table", wide: true, hideEmpty: true },
      { id: "synonyms", title: "Synonyms", render: "table" },
      { id: "per-year", title: "Works about this term per year (Wikidata)", render: "bars" },
      { id: "works", title: "Works about this term (Wikidata)", render: "table" },
    ],
  },
  venue: {
    title: "Venue",
    panels: [
      { id: "per-year", title: "Works per year", render: "bars" },
      { id: "works", title: "Works", render: "table" },
      { id: "authors", title: "Most prolific authors", render: "table" },
      { id: "topics", title: "Topics", render: "table" },
    ],
  },
};
export const COMMON_PANELS = [
  { id: "identifiers", title: "Identifiers", render: "ids" },
  { id: "sources", title: "Sources", render: "table" },
];

// Map wdt:P31 values to an aspect when only a Wikidata QID is given.
const ID = (s) => s.split(" ").map((q) => `http://www.wikidata.org/entity/${q}`);
export const TYPE_TO_ASPECT = [
  ["author", ID("Q5")],
  ["work", ID("Q13442814 Q18918145 Q191067 Q591041 Q1980247 Q23927052 Q187685 Q7318358 Q571 Q47461344 Q1266946 Q580922")],
  ["venue", ID("Q5633421 Q737498 Q1143604 Q41298 Q2217301 Q1002697 Q2020153")],
];
export function aspectForTypes(typeIris) {
  for (const [aspect, iris] of TYPE_TO_ASPECT) if (typeIris.some((t) => iris.includes(t))) return aspect;
  return "topic";
}

export const ENDPOINTS = {
  qlever: { label: "QLever Wikidata (full graph)", url: "https://qlever.dev/api/wikidata" },
  wdqs: { label: "WDQS main graph", url: "https://query.wikidata.org/sparql" },
};

export function fillPanel(prefixes, template, entityIri) {
  if (!/^(https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(entityIri)) throw new Error(`Unsafe IRI: ${entityIri}`);
  return `${prefixes}\n${template.replaceAll("{{iri}}", entityIri)}`;
}
