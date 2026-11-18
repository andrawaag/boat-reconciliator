// "Improve Wikidata" for ontology terms: compare the term's codes with the linked Wikidata item and propose
// QuickStatements (V1) edits. The visitor reviews them and runs them under their own Wikimedia account.
//   - add the term's own ID when the item was only matched through shared codes;
//   - add codes the ontology states as exact matches but the item lacks (with qualifier P4390 = exact match);
//   - optionally remove an ID of the same ontology that the item holds but the ontology has made obsolete.
// Codes that only Wikidata has are listed for review; nothing is proposed for them.
import { VOCABS, canonicalPrefix, parseTargetIri } from "./vocab.js";
import { oboTermStatus } from "./adapters/obo.js";

const EXACT_MATCH = "Q39893449"; // value for P4390 "mapping relation type"
const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").trim();

export async function gatherFixes(run, pageIri, fetchFn) {
  // Term pages (an OBO PURL) get all three kinds of edit; topic pages (a Wikidata item) only the removal of obsolete codes.
  const isTerm = pageIri.startsWith("http://purl.obolibrary.org/obo/");
  const oboId = isTerm ? pageIri.replace("http://purl.obolibrary.org/obo/", "") : null;
  const [prefix, local] = oboId ? oboId.split("_") : [null, null];
  const ownCanon = prefix ? canonicalPrefix(prefix) : null;
  const own = ownCanon ? VOCABS[ownCanon] : null;
  const [fixRows, mapRows] = await Promise.all([run("queries/term/wikidata-fix.rq"), run("queries/term/mappings.rq")]);

  let qid = isTerm ? null : pageIri.match(/\/(Q\d+)$/)?.[1] ?? null, ownOnWikidata = false;
  const matchedBy = [], wdValues = new Map();
  for (const b of fixRows) {
    const kind = b.get("kind").value;
    if (kind === "item" && isTerm) qid = b.get("item").value.split("/").pop();
    else if (kind === "own") ownOnWikidata = true;
    else if (kind === "matchedBy") matchedBy.push(b.get("value").value);
    else if (kind === "value") {
      const code = b.get("code").value, v = b.get("value").value;
      if (!/^https?:/.test(v)) (wdValues.get(code) ?? wdValues.set(code, []).get(code)).push(v);
    }
  }
  const result = { qid, oboId, isTerm, label: own?.label ?? prefix, matchedBy, own: null, additions: [], removals: [], review: [] };
  if (!qid) return result;

  const reference = { item: own?.wdItem ?? null, url: pageIri };
  if (own?.wd && !ownOnWikidata) {
    result.own = { property: own.wd, value: own.wdForms ? own.wdForms(local)[0] : local, vocabulary: own.label, code: `${prefix}:${local}`, url: pageIri, reference };
  }

  for (const b of mapRows) {
    const code = b.get("code")?.value;
    if (!code) continue;
    const sources = new Set((b.get("sources")?.value ?? "").split(" "));
    const relation = b.get("relation")?.value ?? "";
    const label = b.get("codeLabel")?.value ?? code;
    const t = parseTargetIri(code);
    const canon = t && canonicalPrefix(t.prefix);
    const vocab = canon && VOCABS[canon];
    const row = { vocabulary: vocab?.label ?? b.get("vocabulary")?.value ?? "", code: label, url: code };
    // What OLS (src/adapters/ols.js) or RDF Portal (NANDO) says about the code; null when neither covers it or was asked.
    const checked = b.get("status")?.value ?? null;
    const from = b.get("checkedIn")?.value ?? "OLS";
    let status = checked ? { label: b.get("checkedName")?.value ?? null, obsolete: checked === "obsolete", missing: checked === "not found", replacedBy: b.get("replacedBy")?.value ?? null, from } : null;
    const named = status?.label ? ` (“${status.label}” in ${from})` : "";
    if (sources.has("obo") && !sources.has("wikidata")) {
      if (vocab?.wd && relation.includes("exact") && canon !== ownCanon) {
        if (status?.obsolete || status?.missing) result.review.push({ ...row, note: `${status.obsolete ? "obsolete" : "not found"} in ${status.from}${named}, so not proposed although ${result.label} states it as an exact match` });
        else result.additions.push({ ...row, property: vocab.wd, value: vocab.wdForms ? vocab.wdForms(label)[0] : label, reference, status });
      }
    } else if (sources.has("wikidata") && !sources.has("obo")) {
      if (vocab?.wd && wdValues.has(code)) {
        // Without an OLS result (source switched off, old snapshot), still check same-ontology IDs directly.
        if (!status && canon === ownCanon) status = await oboTermStatus(fetchFn, `${prefix}_${label}`).catch(() => null);
        if (status?.obsolete) {
          for (const value of wdValues.get(code)) result.removals.push({ ...row, property: vocab.wd, value, status });
          continue;
        }
        if (status?.missing) { result.review.push({ ...row, note: `not found in ${status.from}: check the code on Wikidata` }); continue; }
        if (canon === ownCanon) { result.review.push({ ...row, note: status?.label ? `“${status.label}”, a different ${own.label} term` : `a different ${own.label} term` }); continue; }
      }
      if (isTerm) result.review.push({ ...row, note: `only on Wikidata${named}` });
    }
  }
  return result;
}

/** QuickStatements V1 for the chosen fixes. `chosen` holds the keys returned by fixKey(). */
export function buildFixCommands(fix, chosen, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const q = fix.qid;
  const ref = (r) => [r.item ? `S248\t${r.item}` : null, `S854\t"${clean(r.url)}"`, `S813\t+${today}T00:00:00Z/11`].filter(Boolean).join("\t");
  const lines = [];
  if (fix.own && chosen.has(fixKey(fix.own))) lines.push(`${q}\t${fix.own.property}\t"${clean(fix.own.value)}"\t${ref(fix.own.reference)}`);
  for (const a of fix.additions) if (chosen.has(fixKey(a))) lines.push(`${q}\t${a.property}\t"${clean(a.value)}"\tP4390\t${EXACT_MATCH}\t${ref(a.reference)}`);
  for (const r of fix.removals) if (chosen.has(fixKey(r))) lines.push(`-${q}\t${r.property}\t"${clean(r.value)}"`);
  return lines.join("\n");
}

export const fixKey = (x) => `${x.property}|${x.value}`;
