// "Works missing on Wikidata" for an author: works with a DOI that ORCID, Crossref, DataCite or OpenAlex attribute to
// the author but that Wikidata does not link to them (no P50). Checked against Wikidata by DOI, then:
//   - not on Wikidata at all  -> CREATE a scholarly-work item (title, type, DOI, date, venue, authors in order);
//   - on Wikidata, but the author is missing -> add P50 with the series ordinal, and optionally remove the matching
//     author name string (P2093), as the Author Disambiguator tool would.
// Commands are QuickStatements V1, run by the visitor under their own Wikimedia account.

const SOURCE_ITEM = { crossref: "Q5188229", datacite: "Q821542", openalex: "Q107507571", orcid: "Q51044" };
const SOURCE_PREF = ["crossref", "datacite", "openalex"];
// Work type -> Wikidata class (P31). Crossref type, then OpenAlex type, then the schema.org class DataCite gives.
const TYPE_TO_P31 = {
  "crossref:journal-article": "Q13442814", "crossref:proceedings-article": "Q23927052", "crossref:posted-content": "Q580922",
  "crossref:book-chapter": "Q21481766", "crossref:book": "Q571", "crossref:monograph": "Q571", "crossref:edited-book": "Q571",
  "crossref:dataset": "Q1172284", "crossref:dissertation": "Q1266946",
  "openalex:article": "Q13442814", "openalex:review": "Q7318358", "openalex:letter": "Q13442814", "openalex:preprint": "Q580922",
  "openalex:dataset": "Q1172284", "openalex:book-chapter": "Q21481766", "openalex:book": "Q571", "openalex:dissertation": "Q1266946",
  "http://schema.org/Dataset": "Q1172284", "http://schema.org/SoftwareSourceCode": "Q7397", "http://schema.org/Thesis": "Q1266946",
  "http://schema.org/Chapter": "Q21481766", "http://schema.org/Book": "Q571",
};
export const P31_LABEL = { Q13442814: "scholarly article", Q23927052: "conference paper", Q580922: "preprint", Q21481766: "scholarly chapter", Q571: "book", Q1172284: "data set", Q1266946: "thesis", Q7397: "software", Q7318358: "review article" };

const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").replace(/\s+/g, " ").trim();
const qidOf = (i) => i?.match(/\/entity\/(Q\d+)$/)?.[1] ?? null;
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

function p31For(workTypes, classes) {
  const types = workTypes.split(" ").filter(Boolean);
  for (const prefix of ["crossref:", "openalex:"]) for (const t of types) if (t.startsWith(prefix) && TYPE_TO_P31[t]) return TYPE_TO_P31[t];
  for (const c of classes.split(" ")) if (TYPE_TO_P31[c] && c !== "http://schema.org/ScholarlyArticle") return TYPE_TO_P31[c];
  // DataCite gives classes only; "ScholarlyArticle" without any other type info means a text work.
  return classes.includes("http://schema.org/ScholarlyArticle") && !types.length ? "Q13442814" : null;
}

/** Candidate works from the merged graph. run(file) runs a panel query over it. */
export async function gatherMissingWorks(run, authorIri) {
  const [workRows, authorRows, candRows] = await Promise.all([
    run("queries/author/missing-works.rq"), run("queries/author/missing-works-authors.rq"), run("queries/author/wikidata-candidate.rq"),
  ]);
  const authorQid = qidOf(authorIri) ?? candRows.filter((b) => b.get("kind").value === "wikidata").map((b) => b.get("value").value)[0] ?? null;

  // Author lists per work, from the most preferred source that has one.
  const lists = new Map(); // doi IRI -> Map(source -> Map(pos -> author))
  for (const b of authorRows) {
    const work = b.get("work").value, src = b.get("src").value, pos = Number(b.get("pos").value);
    const bySrc = lists.get(work) ?? lists.set(work, new Map()).get(work);
    const list = bySrc.get(src) ?? bySrc.set(src, new Map()).get(src);
    if (!list.has(pos)) list.set(pos, { pos, agent: b.get("agent").value, name: b.get("name")?.value ?? "", qid: qidOf(b.get("qid")?.value) });
  }

  const works = [];
  for (const b of workRows) {
    const iri = b.get("work").value;
    const doi = iri.replace("https://doi.org/", "");
    const sources = (b.get("sources")?.value ?? "").split(" ").filter(Boolean);
    const bySrc = lists.get(iri) ?? new Map();
    const hasMe = (s) => [...(bySrc.get(s)?.values() ?? [])].some((a) => a.agent === authorIri);
    const src = SOURCE_PREF.find(hasMe) ?? SOURCE_PREF.find((s) => bySrc.has(s)) ?? SOURCE_PREF.find((s) => sources.includes(s)) ?? sources[0];
    const authors = [...(bySrc.get(src)?.values() ?? [])].sort((a, z) => a.pos - z.pos);
    for (const a of authors) {
      a.isMe = a.agent === authorIri;
      if (a.isMe) a.qid = authorQid;
      a.orcid = a.agent.match(/^https:\/\/orcid\.org\/(.+)$/)?.[1] ?? null;
    }
    const venue = b.get("venue")?.value;
    works.push({
      doi, title: b.get("title")?.value ?? "", date: b.get("date")?.value ?? "", source: src, sources,
      p31: p31For(b.get("workTypes")?.value ?? "", b.get("classes")?.value ?? ""),
      venueQid: qidOf(venue), venueIssn: b.get("venueIssn")?.value ?? null, authors,
      myPosition: authors.find((a) => a.isMe)?.pos ?? null,
    });
  }
  works.sort((a, z) => z.date.localeCompare(a.date));
  // Same title, different DOIs (e.g. Zenodo's concept DOI and version DOIs): propose at most one new item per title.
  for (const w of works) w.titleKey = w.title.toLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return { authorQid, works };
}

/** Look the candidates up on Wikidata: existing items by DOI (with their author name strings), co-authors by ORCID, venues by ISSN. */
export async function checkOnWikidata(engine, endpoint, found) {
  // QLever answers 429 when all its threads are busy: retry with backoff.
  const select = async (q) => {
    for (let attempt = 0; ; attempt++) {
      try { return await selectOnce(q); }
      catch (err) {
        if (attempt >= 4 || !/HTTP status (429|503)/.test(err.message ?? "")) throw err;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  };
  const selectOnce = async (q) => (await engine.queryBindings(`PREFIX wdt: <http://www.wikidata.org/prop/direct/> PREFIX wd: <http://www.wikidata.org/entity/> PREFIX p: <http://www.wikidata.org/prop/> PREFIX ps: <http://www.wikidata.org/prop/statement/> PREFIX pq: <http://www.wikidata.org/prop/qualifier/>\n${q}`,
    { sources: [{ type: "sparql", value: endpoint }], httpTimeout: 60000 })).toArray();
  const lit = (s) => JSON.stringify(String(s));

  const byDoi = new Map(found.works.map((w) => [w.doi.toUpperCase(), w]));
  for (const batch of chunks([...byDoi.keys()], 100)) {
    const values = batch.flatMap((d) => [lit(d), lit(d.toLowerCase())]).join(" ");
    for (const r of await select(`SELECT ?item ?doi WHERE { VALUES ?doi { ${values} } ?item wdt:P356 ?doi }`)) {
      const w = byDoi.get(r.get("doi").value.toUpperCase());
      if (w && !w.existing) w.existing = { qid: qidOf(r.get("item").value), nameStrings: [] };
    }
  }
  const existing = found.works.filter((w) => w.existing);
  for (const batch of chunks(existing, 100)) {
    const byQid = new Map(batch.map((w) => [w.existing.qid, w]));
    const rows = await select(`SELECT ?item ?name ?ord WHERE { VALUES ?item { ${batch.map((w) => `wd:${w.existing.qid}`).join(" ")} } ?item p:P2093 ?st . ?st ps:P2093 ?name . OPTIONAL { ?st pq:P1545 ?ord } }`);
    for (const r of rows) byQid.get(qidOf(r.get("item").value))?.existing.nameStrings.push({ name: r.get("name").value, ordinal: r.get("ord")?.value ?? null });
  }

  const orcids = [...new Set(found.works.flatMap((w) => w.authors.filter((a) => !a.qid && a.orcid).map((a) => a.orcid)))];
  const orcidQid = new Map();
  for (const batch of chunks(orcids, 150))
    for (const r of await select(`SELECT ?item ?o WHERE { VALUES ?o { ${batch.map(lit).join(" ")} } ?item wdt:P496 ?o }`)) orcidQid.set(r.get("o").value, qidOf(r.get("item").value));
  for (const w of found.works) for (const a of w.authors) if (!a.qid && a.orcid) a.qid = orcidQid.get(a.orcid) ?? null;

  const issns = [...new Set(found.works.filter((w) => !w.venueQid && w.venueIssn).map((w) => w.venueIssn))];
  const issnQid = new Map();
  for (const batch of chunks(issns, 150))
    for (const r of await select(`SELECT ?item ?i WHERE { VALUES ?i { ${batch.map(lit).join(" ")} } ?item wdt:P236 ?i }`)) issnQid.set(r.get("i").value, qidOf(r.get("item").value));
  for (const w of found.works) if (!w.venueQid && w.venueIssn) w.venueQid = issnQid.get(w.venueIssn) ?? null;

  for (const w of found.works) w.removable = w.existing ? matchNameString(w) : null;
  return found;
}

// The author name string on an existing item that stands for this author: same ordinal, or same family name + initial.
function matchNameString(w) {
  const me = w.authors.find((a) => a.isMe);
  if (!me) return null;
  const key = (n) => { const p = n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s-]/g, " ").trim().split(/\s+/); return `${p.at(-1)} ${p[0]?.[0] ?? ""}`; };
  const byName = w.existing.nameStrings.filter((s) => key(s.name) === key(me.name));
  const both = byName.filter((s) => s.ordinal === String(me.pos));
  const pick = both[0] ?? (byName.length === 1 ? byName[0] : null);
  return pick ? pick.name : null;
}

/** Wikidata time value for an xsd date/gYearMonth/gYear string. */
function timeValue(date) {
  const m = date.match(/^(\d{4})(?:-(\d\d))?(?:-(\d\d))?/);
  if (!m) return null;
  return `+${m[1]}-${m[2] ?? "00"}-${m[3] ?? "00"}T00:00:00Z/${m[3] ? 11 : m[2] ? 10 : 9}`;
}

/**
 * QuickStatements V1. chosen: Set of DOIs to include. opts.removeNameStrings: also remove the matching P2093
 * on existing items. opts.language: title language (default "en").
 */
export function buildWorkCommands(found, chosen, { removeNameStrings = true, language = "en", today = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [];
  for (const w of found.works) {
    if (!chosen.has(w.doi)) continue;
    const ref = [SOURCE_ITEM[w.source] ? `S248\t${SOURCE_ITEM[w.source]}` : null, `S854\t"https://doi.org/${clean(w.doi)}"`, `S813\t+${today}T00:00:00Z/11`].filter(Boolean).join("\t");
    if (w.existing) {
      if (!found.authorQid) continue; // link and claimed both need the author's item
      const me = w.authors.find((a) => a.isMe);
      const ordinal = w.myPosition ? `\tP1545\t"${w.myPosition}"` : "";
      const statedAs = me?.name ? `\tP1932\t"${clean(me.name)}"` : "";
      lines.push(`${w.existing.qid}\tP50\t${found.authorQid}${ordinal}${statedAs}\t${ref}`);
      if (removeNameStrings && w.removable) lines.push(`-${w.existing.qid}\tP2093\t"${clean(w.removable)}"`);
      continue;
    }
    if (workStatus(found, w) !== "create") continue;
    const title = clean(w.title);
    lines.push("CREATE");
    lines.push(`LAST\tLen\t"${title.slice(0, 250)}"`);
    lines.push(`LAST\tP31\t${w.p31}\t${ref}`);
    lines.push(`LAST\tP1476\t${language}:"${title}"\t${ref}`);
    lines.push(`LAST\tP356\t"${clean(w.doi.toUpperCase())}"\t${ref}`);
    const t = timeValue(w.date);
    if (t) lines.push(`LAST\tP577\t${t}\t${ref}`);
    if (w.venueQid) lines.push(`LAST\tP1433\t${w.venueQid}\t${ref}`);
    for (const a of w.authors) {
      if (a.qid) lines.push(`LAST\tP50\t${a.qid}\tP1545\t"${a.pos}"\tP1932\t"${clean(a.name)}"\t${ref}`);
      else if (a.name) lines.push(`LAST\tP2093\t"${clean(a.name)}"\tP1545\t"${a.pos}"\t${ref}`);
    }
  }
  return lines.join("\n");
}

/** Which bucket a checked work is in. */
export function workStatus(found, w) {
  // On Wikidata already: "link" when the work's author list names this author; "claimed" when only their ORCID record lists it.
  if (w.existing) return !found.authorQid ? "link-blocked" : w.myPosition ? "link" : "claimed";
  if (!w.title || !w.p31) return "unsupported";
  if (!w.authors.some((a) => a.isMe)) return "no-authors"; // never create an item without its author list
  const twins = found.works.filter((x) => x !== w && x.titleKey && x.titleKey === w.titleKey);
  if (twins.some((x) => x.existing)) return "duplicate";
  // Among same-title candidates, keep the one with the best metadata source, then the shortest DOI (usually the concept DOI).
  const rank = (x) => [SOURCE_PREF.indexOf(x.source) < 0 ? 9 : SOURCE_PREF.indexOf(x.source), x.doi.length, x.doi];
  const better = (a, b) => { const [x, y] = [rank(a), rank(b)]; return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
  const eligible = [w, ...twins].filter((x) => !x.existing && x.p31 && x.authors.some((a) => a.isMe));
  return eligible.sort(better)[0] === w ? "create" : "duplicate";
}
