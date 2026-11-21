// "Improve Wikidata" for vessels, in the manner of the template's ontology-term panel (src/wikidata-fix.js):
//   - add statements another source states, with a reference: the IMO number from the ship's Commons
//     "IMO 1234567" category (P458), and the Commons sitelink from the item's Commons category (P373);
//   - deprecate identifiers that cannot be right (an IMO number whose check digit fails, an MMSI that is not
//     nine digits), with reason for deprecated rank "incorrect value", through Wikidata's API sandbox;
//   - list what was found but not proposed, for review.
// Everything is read live, so edits made minutes ago drop out. The visitor runs the edits under their own account.
import { imoValid } from "./adapters/boats.js";
import { findByStatementsLive } from "./wikidata-live.js";

const WD_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS = "Q565"; // Wikimedia Commons, for "imported from Wikimedia project" (P143)
export const INCORRECT_VALUE = "Q41755623"; // reason for deprecated rank (P2241): incorrect value
const IMO_CATEGORY = /^(?:Category:)?IMO[ _](\d{7})$/;

async function json(fetchFn, base, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(`${base}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`, { signal: AbortSignal.timeout(20000) });
    if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(base).host}`);
    return res.json();
  }
}
const value = (c) => { const v = c.mainsnak?.datavalue?.value; return typeof v === "string" ? v : v?.id ?? null; };
const categoryUrl = (title) => `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%3A/g, ":")}`;

/**
 * { additions: [{ key, kind: "statement"|"sitelink", property|site, value, reason, reference, on }],
 *   deprecations: [{ key, property, value, reason, statements }], review: [{ text, url }] }
 */
export async function boatEnrichments(fetchFn, qid) {
  const e = (await json(fetchFn, WD_API, { action: "wbgetentities", ids: qid, props: "claims|sitelinks", sitefilter: "commonswiki" })).entities?.[qid];
  const claims = e?.claims ?? {};
  const live = (p) => (claims[p] ?? []).filter((c) => c.rank !== "deprecated" && value(c));
  const out = { additions: [], deprecations: [], review: [] };

  // Identifiers that cannot be right.
  for (const c of live("P458")) if (!imoValid(value(c)))
    out.deprecations.push({ key: `P458|${value(c)}`, property: "P458", value: value(c), reason: "the check digit is wrong, so this is not a valid IMO number", statements: [c] });
  for (const c of live("P587")) if (!/^\d{9}$/.test(value(c)))
    out.deprecations.push({ key: `P587|${value(c)}`, property: "P587", value: value(c), reason: "an MMSI has exactly nine digits", statements: [c] });

  const p373 = live("P373").map(value)[0];
  const sitelink = e?.sitelinks?.commonswiki?.title ?? null;
  if (!p373) return out;
  const title = `Category:${p373}`;
  const pg = Object.values((await json(fetchFn, COMMONS_API, { action: "query", titles: title, prop: "categories|pageprops", ppprop: "wikibase_item", cllimit: "50" })).query?.pages ?? {})[0];
  if (!pg || "missing" in pg) return out; // the checks panel reports a missing category

  // Commons sitelink from the Commons category, unless the category is already linked to another item.
  const linked = pg.pageprops?.wikibase_item;
  if (!sitelink && (!linked || linked === qid))
    out.additions.push({ key: "Scommonswiki", kind: "sitelink", site: "commonswiki", value: title, reason: "the item's Commons category (P373); links the item and the category both ways", on: true });
  else if (!sitelink && linked) {
    // Usually a Wikimedia category item (Q4167836), linked to the ship through P910/P301: that is how Wikidata
    // models it, so nothing to do. Linked to another kind of item, it may be a duplicate of this ship.
    const other = (await json(fetchFn, WD_API, { action: "wbgetentities", ids: linked, props: "claims|labels", languages: "en" }).catch(() => null))?.entities?.[linked];
    const isCategory = (other?.claims?.P31 ?? []).some((c) => value(c) === "Q4167836");
    if (other && !isCategory)
      out.review.push({ text: `${title} is the Commons sitelink of ${other.labels?.en?.value ?? linked} (${linked}), not of this item: a duplicate, or the wrong category?`, url: `https://www.wikidata.org/wiki/${linked}` });
  }

  // IMO number from Commons' "IMO 1234567" category: the item's category itself, or the one it sits in.
  if (!live("P458").some((c) => imoValid(value(c)))) {
    const names = [pg.title, ...(pg.categories ?? []).map((c) => c.title)];
    const imos = [...new Set(names.map((n) => n.match(IMO_CATEGORY)?.[1]).filter(Boolean))];
    const valid = imos.filter(imoValid);
    for (const bad of imos.filter((x) => !imoValid(x))) out.review.push({ text: `Commons has the category IMO ${bad}, but its check digit is wrong.`, url: categoryUrl(`Category:IMO ${bad}`) });
    if (valid.length > 1) out.review.push({ text: `The Commons category sits in several IMO categories (${valid.join(", ")}), so no IMO number is proposed.`, url: categoryUrl(title) });
    else if (valid.length === 1) {
      const imo = valid[0];
      const others = (await findByStatementsLive(fetchFn, [{ property: "P458", value: imo }]).catch(() => [])).filter((x) => x.qid !== qid);
      const cat = `Category:IMO ${imo}`;
      if (others.length) out.review.push({ text: `Commons files this ship under IMO ${imo}, but ${others.map((x) => x.qid).join(", ")} already has that number: the same hull under another item? Merge or link them.`, url: `https://www.wikidata.org/wiki/${others[0].qid}` });
      else out.additions.push({ key: `P458|${imo}`, kind: "statement", property: "P458", value: imo, reason: `from Commons' ${cat} (the check digit is right)`, reference: { importedFrom: COMMONS, url: categoryUrl(cat) }, on: true });
    }
  }
  return out;
}

/** QuickStatements V1 lines for the chosen additions. */
export function enrichmentCommands(qid, additions) {
  const q = (v) => `"${String(v).replace(/["\t\n\r]/g, " ")}"`;
  return additions.map((a) => a.kind === "sitelink" ? `${qid}\tS${a.site}\t${q(a.value)}`
    : `${qid}\t${a.property}\t${q(a.value)}` + (a.reference ? `\tS143\t${a.reference.importedFrom}\tS4656\t${q(a.reference.url)}` : "")).join("\n");
}
