// "Add to Wikidata": for an author with no Wikidata item, collect every identifier the merged graph holds,
// check Wikidata for an existing item that already carries one of them, and generate QuickStatements (V1)
// commands with references. The visitor reviews and edits them, then runs them in QuickStatements under their
// own Wikimedia account; this site never sees credentials and never writes to Wikidata itself.

const PROPS = {
  P496: { label: "ORCID iD", url: (v) => `https://orcid.org/${v}` },
  P10283: { label: "OpenAlex ID", url: (v) => `https://openalex.org/${v}` },
  P1153: { label: "Scopus author ID", url: (v) => `https://www.scopus.com/authid/detail.uri?authorId=${v}` },
  P1053: { label: "Web of Science ResearcherID", url: (v) => `https://www.webofscience.com/wos/author/rid/${v}` },
  P2798: { label: "Loop ID", url: (v) => `https://loop.frontiersin.org/people/${v}` },
  P213: { label: "ISNI", url: (v) => `https://isni.org/isni/${v.replace(/\s/g, "")}` },
  P2037: { label: "GitHub account", url: (v) => `https://github.com/${v}` },
};
// Reference ("stated in") per source, plus a reference URL to the source record.
const STATED_IN = { orcid: "Q51044", openalex: "Q107507571", wikidata: null };
const PATTERN = { P496: /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, P10283: /^A\d+$/, P1153: /^\d+$/, P1053: /^[A-Z]{1,3}-\d{4}-(19|20)\d\d$/, P2798: /^\d+$/, P213: /^\d{4} \d{4} \d{4} \d{3}[\dX]$/, P2037: /^[A-Za-z0-9-]+$/ };

const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").replace(/\s+/g, " ").trim();
const isNaturalName = (n) => n && !n.includes(",") && /\p{L}{2,}/u.test(n);

/** Gather names and identifiers for `iri` from the graph. */
export async function gatherCandidate(runQuery, iri) {
  const rows = await runQuery("queries/author/wikidata-candidate.rq");
  const orcid = iri.match(/^https:\/\/orcid\.org\/(.+)$/)?.[1];
  const ids = new Map(); // "P1153|123" -> { property, value, sources:Set }
  const names = new Map(); // name -> Set(source)
  const wikidata = new Set();
  const addId = (property, value, source) => {
    const k = `${property}|${value}`;
    if (!ids.has(k)) ids.set(k, { property, value, sources: new Set() });
    ids.get(k).sources.add(source);
  };
  if (orcid) addId("P496", orcid, "orcid");
  for (const b of rows) {
    const kind = b.get("kind").value, value = b.get("value").value, source = b.get("source")?.value ?? "";
    if (kind === "wikidata") wikidata.add(value);
    else if (kind === "id") addId(b.get("property").value, value, source);
    // Names: ORCID's and OpenAlex's own, plus ORCID's other names. Crossref/DataCite names on a merged node
    // may come from name-based matching, so they don't go to Wikidata.
    else if (isNaturalName(value) && (kind === "alias" || ["orcid", "openalex", "wikidata"].includes(source))) (names.get(value) ?? names.set(value, new Set()).get(value)).add(kind === "name" ? source : `${source}:alias`);
  }
  // Label: the ORCID name if there is one, else the name most sources agree on.
  const ranked = [...names.entries()].sort((a, b) => (b[1].has("orcid") - a[1].has("orcid")) || (b[1].size - a[1].size));
  const label = ranked[0]?.[0];
  // Aliases only from ORCID's "other names" (what the person says about themself).
  const aliases = ranked.slice(1).filter(([, src]) => [...src].some((x) => x.endsWith(":alias"))).map(([n]) => n).filter((n) => n.toLowerCase() !== label?.toLowerCase()).slice(0, 6);
  const valid = [...ids.values()].filter((x) => PROPS[x.property] && (!PATTERN[x.property] || PATTERN[x.property].test(x.value)));
  return { orcid, label, aliases, ids: valid, wikidata: [...wikidata] };
}

/** Look for Wikidata items that already carry any of these identifiers (to avoid creating a duplicate). */
export async function findExisting(engine, endpoint, ids) {
  if (!ids.length) return [];
  // One UNION branch per property with a fixed predicate; a variable predicate makes QLever scan everything.
  const byProp = new Map();
  for (const x of ids) byProp.set(x.property, [...(byProp.get(x.property) ?? []), `"${clean(x.value)}"`]);
  const branches = [...byProp].map(([p, vs]) => `{ VALUES ?value { ${vs.join(" ")} } ?item wdt:${p} ?value BIND("${p}" AS ?p) }`).join(" UNION ");
  const q = `PREFIX wdt: <http://www.wikidata.org/prop/direct/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?p ?value (SAMPLE(?l) AS ?label) WHERE { ${branches}
OPTIONAL { ?item rdfs:label ?l FILTER(LANG(?l) = "en") } } GROUP BY ?item ?p ?value`;
  const rows = await (await engine.queryBindings(q, { sources: [{ type: "sparql", value: endpoint }], httpTimeout: 30000 })).toArray();
  return rows.map((b) => ({ qid: b.get("item").value.split("/").pop(), property: b.get("p").value, value: b.get("value").value, label: b.get("label")?.value }));
}

/** Name search on Wikidata, to show possible matches that lack any of our identifiers. */
export async function searchByName(name) {
  if (!name) return [];
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(name)}`;
  const res = await fetch(url).then((r) => r.json()).catch(() => null);
  return (res?.search ?? []).map((s) => ({ qid: s.id, label: s.label, description: s.description }));
}

/**
 * QuickStatements V1 commands (tab-separated). With `target` (a QID) it only adds the missing identifiers to that
 * item; without, it creates a new item for a human researcher.
 */
export function buildCommands(cand, { target = null, today = new Date() } = {}) {
  const date = `+${today.toISOString().slice(0, 10)}T00:00:00Z/11`;
  const refFor = (sources, x) => {
    const src = sources.has("orcid") ? "orcid" : sources.has("openalex") ? "openalex" : [...sources][0];
    const parts = [];
    if (STATED_IN[src]) parts.push("S248", STATED_IN[src]);
    const recordUrl = src === "orcid" && cand.orcid ? `https://orcid.org/${cand.orcid}` : src === "openalex" && x?.property === "P10283" ? `https://openalex.org/${x.value}` : null;
    if (recordUrl) parts.push("S854", `"${recordUrl}"`);
    parts.push("S813", date);
    return parts;
  };
  const orcidRef = refFor(new Set(["orcid"]));
  const subject = target ?? "LAST";
  const lines = [];
  if (!target) {
    lines.push(["CREATE"]);
    if (cand.label) lines.push([subject, "Len", `"${clean(cand.label)}"`]);
    lines.push([subject, "Den", `"researcher"`]);
    for (const a of cand.aliases) lines.push([subject, "Aen", `"${clean(a)}"`]);
    lines.push([subject, "P31", "Q5", ...(cand.orcid ? orcidRef : [])]);
    lines.push([subject, "P106", "Q1650915", ...(cand.orcid ? orcidRef : [])]);
  }
  for (const x of cand.ids) lines.push([subject, x.property, `"${clean(x.value)}"`, ...refFor(x.sources, x)]);
  return lines.map((l) => l.join("\t")).join("\n");
}

export const quickStatementsUrl = (commands) =>
  `https://quickstatements.toolforge.org/#/v1=${encodeURIComponent(commands.replace(/\t/g, "|").replace(/\n/g, "||"))}`;

export const propertyLabel = (p) => PROPS[p]?.label ?? p;
export const propertyUrl = (p, v) => PROPS[p]?.url(v);
