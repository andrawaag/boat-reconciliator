# koetai-reconciliator

**koetai reconciliator** reconciles entities across linked-data sources into one RDF graph per entity, and publishes the result as a static site with no server. It's a GitHub template, so anyone can run their own instance.

It covers scholarly entities and ontology terms. Each page (a researcher, a work, a topic or a venue) is one RDF graph, merged in your visitors' browsers from **Wikidata, ORCID, Crossref, DataCite, OpenAlex, OBO ontologies (via OLS), PubMed and TogoID/NANDO (both via [RDF Portal](https://rdfportal.org))**, with every terminology code checked in OLS, and queried with [Comunica](https://comunica.dev). GitHub Pages hosts the site, and a GitHub Action keeps pre-built snapshots of the pages you feature. You add your own visualizations as a SPARQL query plus a few lines of config.

Inspired by [Scholia](https://github.com/WDscholia/scholia). The aim is to go native on RDF and go beyond Wikidata: the same adapter → reconcile → query pipeline is meant to extend to other domains and terminologies, OBO Foundry ontologies are the first: an ontology term's page reconciles its cross-references to SNOMED CT, MeSH, ICD-9/10/11, UMLS and others against Wikidata. (Developed under the working names frugalScholia and koetai-bibliography.)

---

## Start your own instance

1. On this repository's page, click **Use this template → Create a new repository**.
2. In the new repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Edit **`site.config.json`** (in the GitHub web editor if you like): set your title, intro and accent colour, and list the researchers, works, topics or venues you want to feature under `seeds`.
4. Commit. The `site` workflow builds snapshots for your new seeds, drops the template's ones, and publishes the site at `https://<you>.github.io/<repo>/`.
5. Optional: add a repository secret **`OPENALEX_API_KEY`** (free from OpenAlex) so weekly snapshot runs aren't limited by OpenAlex's anonymous quota.

Snapshots refresh every Monday. Run the workflow by hand (**Actions → site → Run workflow**) to refresh them now.

## `site.config.json`

| Key | What it does |
|---|---|
| `title`, `tagline`, `intro` | Site name, home page heading and intro text |
| `accent` | Accent colour (any CSS colour); the dark theme derives from it |
| `sources` | Which of `wikidata`, `orcid`, `crossref`, `datacite`, `openalex`, `obo` to use |
| `wikidataEndpoint` | Wikidata SPARQL endpoint (default QLever, which holds the full graph) |
| `liveHarvest` | `false` limits the site to its snapshots: no live API calls from visitors' browsers |
| `wikidataCreate` | `false` hides the "Not on Wikidata yet" panel on author pages (default `true`) |
| `wikidataWorks` | `false` hides the "Works missing on Wikidata" panel on author pages (default `true`) |
| `wikidataFixes` | `false` hides the "Improve Wikidata" panel on ontology term and topic pages (default `true`) |
| `wikipediaCoverage` | `false` hides the "Wikipedia articles" and Orphanet "Subtypes" panels (default `true`) |
| `wikipediaLanguages` | languages checked for missing Wikipedia articles, first one preselected (default: en, de, fr, es, it, nl, pt, pl, ru, ja, zh, ar) |
| `searchOntologies` | OLS ontologies the search box covers, e.g. `["ordo", "mondo"]` (default: all) |
| `seeds` | Entities to pre-build and feature on the home page: `orcid:…`, `doi:…`, `issn:…`, `wikidata:Q…`, `openalex:A…/W…/S…/T…`, `obo:MONDO_0005148` (an OBO term; `MONDO:0005148` works too). An object `{ "key": "…", "aspect": "author" }` forces the page type |
| `panels` | Per page type (`author`, `work`, `topic`, `venue`, `term`, `common`): `hide` built-in panels by id, `add` your own |

## Add your own visualizations

A panel is a SPARQL query plus a renderer.

1. Write a query in `queries/custom/<aspect>/<id>.rq`. It runs over the page's merged graph (vocabulary below), and `{{iri}}` stands for the page's entity.
2. Register it in `site.config.json`:

```json
"panels": {
  "author": {
    "add": [
      {
        "id": "sources-per-year",
        "title": "Works per year, by source",
        "query": "queries/custom/author/sources-per-year.rq",
        "after": "per-year",
        "wide": true,
        "render": "vega-lite",
        "spec": {
          "mark": { "type": "bar", "tooltip": true },
          "encoding": {
            "x": { "field": "year", "type": "ordinal" },
            "xOffset": { "field": "source" },
            "y": { "field": "works", "type": "quantitative" },
            "color": { "field": "source", "type": "nominal" }
          }
        }
      }
    ],
    "hide": ["venues"]
  }
}
```

Renderers:

| `render` | Shows |
|---|---|
| `table` | All columns. Columns named `work`, `author`, `coauthor`, `venue` or `topic` become links to other pages, a `<col>Label` column gives their text, and a `sources` column becomes provenance badges |
| `bars` | Bar chart: the first column is the label and the second the value. Integer labels (years) get gaps filled |
| `kv` | The first row as a list of key/value pairs |
| `vega-lite` | Any [Vega-Lite](https://vega.github.io/vega-lite/) chart. Put the spec in `spec`; the query results are passed in as `data`. Vega is loaded only on pages that use it |

Every panel has a **SPARQL** toggle that shows the exact query that ran, and each page can be downloaded as N-Quads, so visitors can reuse the data.

Two examples ship with the template: `queries/custom/author/sources-per-year.rq` (Vega-Lite) and `queries/custom/work/citations-per-year.rq` (bars).

## Add a missing author to Wikidata

When an author page's graph has no Wikidata item for the person, the page shows a **Not on Wikidata yet** panel. The panel:

- lists the identifiers that ORCID and OpenAlex state for this person: ORCID iD (P496), OpenAlex ID (P10283), Scopus author ID (P1153), ResearcherID (P1053), Loop ID (P2798), ISNI (P213) and GitHub username (P2037). Identifiers or names that were only joined through name matching are left out;
- checks the Wikidata endpoint for an item that already carries any of these identifiers. If one does, the commands add only the missing identifiers to that item;
- lists Wikidata items with the same name, each with an **add identifiers to this item** button, so you can avoid creating a duplicate;
- generates [QuickStatements](https://www.wikidata.org/wiki/Help:QuickStatements) V1 commands in an editable box. A new item gets an English label, the description "researcher", aliases from ORCID's other names, P31 human (Q5), P106 researcher (Q1650915) and the identifiers. Each statement has a reference: stated in (S248) ORCID (Q51044) or OpenAlex (Q107507571), reference URL (S854) and retrieved (S813).

**Open in QuickStatements** opens the commands there, and you run them under your own Wikimedia account; the site never writes to Wikidata itself. Review the commands before you run them.

### After you run the edits: Wikidata's SPARQL lag

The SPARQL endpoint's copy of Wikidata (QLever by default) can lag behind edits by hours or days. So identifier and DOI checks also ask Wikidata's own search (`haswbstatement`), which sees new items within about a minute (`src/wikidata-live.js`), and check the hits against the items' claims:

- **Harvest:** if SPARQL finds no item for an ORCID, DOI, ISSN, OpenAlex or OBO ID, live search is tried. An item found that way is read through the Wikidata API, so the page links to it at once. The page log notes "found by live search".
- **"Not on Wikidata yet":** live search finds items created minutes ago. If one already carries every identifier, the panel says so instead of proposing edits.
- **Works missing on Wikidata:** DOIs and PubMed IDs that SPARQL doesn't know are checked by live search, so a work created in an earlier batch is never proposed again. Before proposing to add the author to an existing item, the item's author statements (P50) are read live; items that already name the author are listed as "Not proposed".
- **Adding to an existing item:** when you choose an item (from the identifier matches or "add identifiers to this item" under the name matches), its statements are read live, and only the identifiers it lacks are proposed. The panel lists the ones left out.
- **Improve Wikidata (terms):** before proposing, the item is read live. Codes it already holds are not proposed again, and codes already deprecated are dropped.

After running a batch, press **Refresh** (live pages) or **Fetch live instead** (snapshot pages) to harvest the page again. Snapshots are rebuilt on the next workflow run. Until SPARQL catches up, lists that come from SPARQL queries (for example the author's works on Wikidata) may still miss the new statements.

## PubMed (via RDF Portal)

The `pubmed` adapter (`src/adapters/pubmed.js`) reads [PubMed](https://pubmed.ncbi.nlm.nih.gov) from RDF Portal's NCBI SPARQL endpoint.

- **Work pages:** the PubMed record for the DOI: PMID, title, date, journal, the ordered author list and the MeSH subjects (with their names). PubMed authors join the other sources' authors by name within the work, so they add a `pubmed` badge rather than extra rows. A work page also opens from a PMID: `pmid:26978244` or a PubMed URL.
- **Author pages:** the author's DOIs are looked up in batches (about 4 seconds for 600 DOIs). Works found in PubMed get their PMID and major MeSH subjects.
- **Wikidata:** new items proposed in "Works missing on Wikidata" get the PubMed ID (P698), cited as stated in PubMed (Q180686). Works are also checked on Wikidata by PubMed ID, so an item that has the PMID but no DOI isn't created twice.

PubMed keeps DOIs in their original case. Lookups use Virtuoso's full-text index, which ignores case, and then check the match exactly.

## Find an author's works missing on Wikidata

Author pages have a **Works missing on Wikidata** panel. It lists works with a DOI that ORCID, Crossref, DataCite or OpenAlex attribute to the person but that Wikidata doesn't link to them (no author statement, P50). **Check against Wikidata** looks the DOIs up on Wikidata (P356) and sorts them into groups, each with checkboxes:

- **Add this author to existing items:** the work is on Wikidata and its author list names this person. The command adds P50 with the series ordinal (P1545) and the name as written (P1932). It can also remove the matching author name string (P2093), as the Author Disambiguator tool does. Ticked by default.
- **Create new items:** the work is not on Wikidata. A new item gets a label, a type (P31: scholarly article, preprint, conference paper, chapter, data set, software, book or thesis, from the Crossref or OpenAlex work type), the title (P1476), DOI, publication date with matching precision, venue (P1433, by ISSN) and all authors in order. Authors with a Wikidata item (found by ORCID) become P50, the others P2093 name strings. Papers are ticked by default; data sets, software and books are not.
- **Only claimed by ORCID:** on Wikidata, but the person isn't in the work's author list (for example a group author). Unticked.
- **Not proposed:** works with no author list from Crossref, DataCite or OpenAlex, unsupported types, and duplicates. A duplicate is a DOI whose title matches another candidate's, such as Zenodo's version DOIs; only one item per title is proposed, and none if one of them is already on Wikidata.

Every statement cites the metadata source (stated in Crossref Q5188229, DataCite Q821542, OpenAlex Q107507571 or ORCID Q51044), the DOI URL and the retrieval date. Titles get language `en` by default; change it in the panel. If the person has no Wikidata item yet, create it first with the **Not on Wikidata yet** panel. Otherwise new items list them as a name string.

## Ontology terms and terminology mappings

Any OBO Foundry term, and any Orphanet disorder (see below), has a page: search by name (results come from Wikidata and from [OLS](https://www.ebi.ac.uk/ols4/)), or paste an ID such as `MONDO:0005148`, `DOID:9352`, `GO:0006915` or `HP:0005978`.

1. **The ontology.** The `obo` adapter (`src/adapters/obo.js`) reads the term from EBI's Ontology Lookup Service: label, definition, synonyms with their OBO scope, obsolete status, is-a parents and children, and the term's cross-references.
2. **Wikidata.** The item is found through the ontology's own Wikidata property (P5270 MONDO, P699 DOID, P686 GO, P3841 HPO, …) or P2888 exact match. If none carries the term's ID, the item that shares the most of the term's exact cross-references is used, and the page shows which codes matched.
3. **TogoID (RDF Portal).** The `rdfportal` adapter (`src/adapters/rdfportal.js`) reads the term's links in [TogoID](https://togoid.dbcls.jp), DBCLS's ID-link dataset, from RDF Portal's SPARQL endpoint. TogoID's "is equivalent to" becomes an `exact` mapping, and "is nearly equivalent to" a `close` one.
4. **Mappings.** Codes from all sources are turned into the same IRIs (`src/vocab.js`), for example `http://snomed.info/id/44054006` or `http://id.nlm.nih.gov/mesh/D003924`. Where two sources give the same code, they meet on one node.

The term page shows:
- **Agreement between sources:** per terminology, how many codes both sources give, and how many only one does.
- **Mappings to other terminologies:** each code with its relation (`exact` for an exact match, a Wikidata external ID or TogoID equivalence, `close` for TogoID near-equivalence, `xref` for a plain database cross-reference), source badges, and the concept check (see below).
- The parents, children and synonyms, plus works about the term on Wikidata (the newest 1,000).

Example: for type 2 diabetes (`MONDO:0005148`), MONDO and Wikidata agree on DOID, ICD-10, ICD-11, MeSH, NCIt and UMLS, and TogoID confirms DOID, MeSH, OMIM, UMLS and NANDO. But Wikidata's MONDO ID for the item points to an obsolete term, and MONDO's SNOMED CT code is not on Wikidata.

### Concept check through EBI's OLS and RDF Portal

Every code a term or topic page maps to, whether it comes from the ontology or from a Wikidata external ID, is looked up in [EBI's Ontology Lookup Service](https://www.ebi.ac.uk/ols4/) (`src/adapters/ols.js`, graph `urn:koetai-reconciliator:source:ols`). NANDO codes, which OLS doesn't have, are looked up in NANDO on RDF Portal instead. The mappings table shows the code's name there, its status, and which service checked it:

- **current**: OLS has the code and it is in use.
- **obsolete**: OLS marks it obsolete, with its replacement where the ontology gives one.
- **not found**: OLS loads that terminology but has no such code (often a typo or a retired code on Wikidata).
- **empty**: not checked, because OLS does not cover the terminology (ICD, OMIM, …).

OLS covers all OBO ontologies it loads, SNOMED CT, MeSH, Orphanet (ORDO) and EFO under the same IRIs this site uses. UMLS CUIs are checked through MedGen, which reuses them; a CUI that MedGen lacks is left unchecked. Codes of other OBO ontologies that OLS doesn't load are left unchecked as well. NANDO names show the English and Japanese label, for example "Diabetes mellitus type 2 (2型糖尿病)".

If OLS is slow or down, each request times out after 12 seconds. After three failures in a row, the check stops and the page log says "OLS unavailable", so the page still appears.

Wikidata topic pages that carry such codes get the same checked mappings panel. Topic pages without codes don't show it.

### Orphanet (rare diseases)

Orphanet disorders and groups have term pages too: paste `ORPHA:558`, `Orphanet_558` or an orpha.net disease URL, or search by name (Orphanet hits are listed first). They keep Orphanet's own IRIs (`http://www.orpha.net/ORDO/Orphanet_558`) and are read from ORDO through OLS:

- **Facts:** disorder type, mode of inheritance, age of onset, prevalence, and the orpha.net page, in the details panel.
- **Classification:** Orphanet groups disorders with part-of links, so its parents and subtypes come from OLS's hierarchical relations.
- **Mapping types:** Orphanet qualifies each cross-reference. E becomes `exact`, NTBT (the target code is broader) `broad`, BTNT `narrow`; mappings it marks wrong (W) are left out.
- **TogoID:** links for the Orphanet code (MONDO, MeSH, OMIM, MedGen, MedDRA) and the number of ClinVar variants TogoID relates to it.
- **Improve Wikidata:** besides the Orphanet ID (P1550) and exact matches, it offers Orphanet's broad and narrow mappings (with mapping relation type broad or narrow match, unticked) and Orphanet's mode of inheritance (P1199). Statements cite Orphanet (Q1515833) and the orpha.net page.

A specialised instance built on this lives at [rare-disease-reconciliator](https://github.com/andrawaag/rare-disease-reconciliator).

### Associated genes

Term pages for diseases list the genes linked to them on Wikidata (genetic association, P2293), read live from the Wikidata API. Each gene shows its HGNC ID, the sources its statements cite (OMIM, UniProt, Open Targets, GWAS papers, …) and how the link was found (for example, genome-wide association study). OLS's copy of Orphanet has no disease–gene links. Orphanet's own gene data is published only as downloadable files, so Wikidata is the open source that can be queried here.

### Wikipedia coverage

Term and topic pages linked to a Wikidata item get a **Wikipedia articles** panel: which Wikipedias have an article (the item's sitelinks, read live), which of the languages in `wikipediaLanguages` lack one, and a link to translate it from the best existing article with Wikipedia's Content Translation tool.

Orphanet pages with subtypes also get **Subtypes on Wikidata and Wikipedia**: each subtype's Wikidata item (found by Orphanet ID, live search as fallback), how many Wikipedias cover it, and whether the chosen language has an article. Before anything is created, each subtype without an item is looked up on Wikidata in three ways, so the same disorder under another name isn't duplicated:

- **By identifier:** the codes Orphanet maps it to exactly (OMIM, MONDO, MeSH, ICD-10, UMLS, GARD, …), searched live.
- **By name and synonym:** Wikidata's entity search on the Orphanet label and each Orphanet synonym.
- **Full-text:** Wikidata's text search on the label, leaving out scholarly articles and people.

If an item shares an identifier and has no other Orphanet ID, the default is to add the Orphanet ID to it. Name matches are shown as suggestions, and the default is to skip. A new item (label, description "rare disease", instance of type of disease Q112193867, Orphanet ID, subclass of the parent's item, all citing Orphanet) is proposed only when nothing was found. Each subtype also links to Wikidata's own search. Example: ORPHA:622925, "X-linked severe syndromic thoracic aortic aneurysm and dissection", has no item with its Orphanet ID. But Q55782524, "Meester-Loeys syndrome" (an Orphanet synonym), shares OMIM 300989 and UMLS C4310811, so the panel proposes adding the Orphanet ID to it.

### Improve Wikidata from a term page

When a term is linked to a Wikidata item, an **Improve Wikidata** panel compares the two and proposes QuickStatements edits, each with a checkbox:

- **Add the term's own ID** (e.g. P5270 for MONDO) when the item was only matched through shared codes.
- **Add codes the ontology states as exact matches** but the item lacks (e.g. SNOMED CT P5806), with qualifier mapping relation type (P4390) = exact match (Q39893449).
- **Add missing codes on topic pages**: a Wikidata item's page (e.g. `#/topic/wikidata:Q208562`) reads the item's own current Orphanet, MONDO and Disease Ontology terms in OLS. Codes these terms map to that the item lacks are proposed, citing the ontology that states them: exact matches ticked, Orphanet's broader and narrower mappings unticked. Codes OLS reports obsolete or unknown are left out, as are codes in an ontology the item already holds a current term of (MONDO's Orphanet code is not added as a second Orphanet ID). When an obsolete code has a replacement, the replacement is proposed too. For Marfan syndrome (Q208562), it proposes MedDRA 10026829 and OMIM 610168 (broad match) from Orphanet, and SNOMED CT 19346006 from MONDO.
- **Deprecate an obsolete ID**: when the item holds a code, in any terminology with a Wikidata property, that OLS reports as obsolete. The statement is not removed: it is set to deprecated rank with reason for deprecated rank (P2241) "withdrawn identifier value" (Q21441764), so the old code stays findable. QuickStatements can't change ranks, so this edit opens in Wikidata's [API sandbox](https://www.wikidata.org/wiki/Special:ApiSandbox) as a `wbeditentity` request that keeps the statement's qualifiers and references. You check it and press "Make request" while logged in. Unticked by default. It also appears on Wikidata topic pages.

An exact match that OLS reports as obsolete or not found is not proposed for adding; it is listed for review instead.

Additions are referenced with stated in (S248) the ontology's Wikidata item (MONDO Q27468140, DO Q5282129, HPO Q17027854, GO Q135085), reference URL (S854) to the term's PURL, and retrieved (S813). New IDs use the spelling most common on Wikidata for that property (e.g. `MONDO_0005148`, `GO:0006915`). Codes that only Wikidata has are listed for review, without proposed edits. As on author pages, you run the edits in QuickStatements under your own account.

For type 2 diabetes (`MONDO:0005148`) the panel proposes adding MONDO_0005148 and SNOMED CT 44054006 to Q3025883, and offers to deprecate MONDO_0015887 ("obsolete rare diabetes mellitus type 2").

Supported terminologies: SNOMED CT, MeSH, ICD-9-CM, ICD-10, ICD-10-CM, ICD-11, UMLS, OMIM, Orphanet, MedGen, NANDO, and OBO ontologies (MONDO, DOID, HPO, GO, NCIt, UBERON, CL, ChEBI, NCBITaxon, SO, ENVO; other OBO prefixes get PURLs, anything else a [Bioregistry](https://bioregistry.io) IRI). Add one in `VOCABS` in `src/vocab.js`.

## How it works

```
                      adapters (src/adapters/*.js), each → schema.org, one named graph per source
Wikidata  ── SPARQL CONSTRUCT via Comunica (QLever)  ┐
ORCID     ── public API v3                           │
Crossref  ── REST API                                │
DataCite  ── REST API (Zenodo, figshare, arXiv, …)   ├─► reconcile (src/reconcile.js): merge nodes that share an
OpenAlex  ── REST API (authors, venues, topics,      │   ORCID / DOI / OBO term / QID / ISSN / OpenAlex id;
              citing works)                          │   codes in other terminologies stay mappings (src/vocab.js)
OBO       ── OLS4 API (terms, hierarchy, xrefs)      │
OLS check ── OLS4 API (status of every mapped code)  │
RDF Portal── SPARQL (TogoID links, NANDO check)      │
PubMed    ── SPARQL on RDF Portal (records, MeSH)    ┘                         │
                                                              one merged N-Quads graph per entity
                                                       ┌───────────────────────┴───────────────────┐
                                        GitHub Action → data/**/*.nq.gz              browser → harvested live
                                                       └───────────────────────┬───────────────────┘
                                                                               ▼
                                          Comunica runs each panel's SPARQL over the graph → tables and charts
```

The same harvesting code (`src/harvest.js`) runs in Node for snapshots and in the browser for live pages.

### Data model

Everything is mapped to [schema.org](https://schema.org). Each source writes to its own named graph `urn:koetai-reconciliator:source:<name>`, so panels can query provenance with `GRAPH ?g { … }`. Panels query the union of all graphs.

| Concept | Terms |
|---|---|
| Work | `schema:ScholarlyArticle` (or `Dataset`, `SoftwareSourceCode`, …), `schema:name`, `schema:datePublished` (`xsd:date` / `gYearMonth` / `gYear`), `schema:author`, `schema:isPartOf`, `schema:about`, `schema:citation` |
| Person | `schema:Person`, `schema:name`, `schema:description` |
| Venue | `schema:Periodical`, `schema:name`, `schema:issn` |
| Topic | Wikidata items and OpenAlex topics (`schema:DefinedTerm`), `schema:name` |
| Ontology term | `schema:DefinedTerm`, `schema:termCode`, `schema:inDefinedTermSet`, `rdfs:subClassOf`, `oboInOwl:has…Synonym`, `owl:deprecated` |
| Mapping | `skos:exactMatch`, `skos:closeMatch`, `skos:broadMatch`, `skos:narrowMatch` or `oboInOwl:hasDbXref` to a code node with `kr:vocabulary` and `kr:code` |
| Concept check | on the code node, in the checker's graph (`ols` or `rdfportal`): `kr:checkStatus` (`current`, `obsolete`, `not found`), `kr:checkedName`, `kr:checkedOntology`, `obo:IAO_0100001` (replaced by) |
| Identity | `schema:sameAs` to `https://orcid.org/…`, `https://doi.org/…`, `http://www.wikidata.org/entity/Q…`, `urn:issn:…`, `https://openalex.org/…`, `http://purl.obolibrary.org/obo/…`, `http://rdf.ncbi.nlm.nih.gov/pubmed/…` (PMID) |
| Extras | `kr:citedByCount`, `kr:authorship` → `kr:agent` + `kr:position` (author order), where `kr:` = `urn:koetai-reconciliator:vocab:` |

**Reconciliation.** Nodes linked by `schema:sameAs` are merged under one canonical IRI: ORCID > DOI > OBO term > Wikidata > ISSN > OpenAlex. Mappings (`skos:exactMatch`, cross-references) are never merged, so one concept's codes in other terminologies stay visible as separate rows. Within a single work, authors from different sources are also joined by name: an exact full-name match between identified authors, or a family name plus first initial for authors who only have a per-work ID. Matching never crosses works, so namesakes on different papers stay separate.

### Snapshots and live pages

`npm run snapshot` harvests the seeds into `data/<aspect>/<key>.nq.gz` and `data/manifest.json`. The manifest maps every ID of an entity to its snapshot, so its ORCID, Wikidata QID and OpenAlex ID all open the same file. Visitors can choose snapshot or live in the **Data** menu, unless `liveHarvest` is off.

## Running locally

```bash
npm install
npm run build                 # bundles Comunica + N3 into vendor/comunica.js
npm run serve                 # http://localhost:8799
npm run snapshot              # rebuild every seed
npm run snapshot -- --missing # only seeds without a snapshot; drop removed seeds
npm run check -- openalex:A5029012304   # harvest live and run every panel in Node
```

Environment variables: `WIKIDATA_ENDPOINT`, `OPENALEX_API_KEY`, `MAX_QUADS` (snapshot size cap, default 200,000; larger entities are served live).

## Adding a source

Write `src/adapters/<name>.js` returning quads in graph `urn:koetai-reconciliator:source:<name>`, and use the IRI helpers in `src/model.js` so identities line up. Call it from `src/harvest.js`, add the name to `SOURCES` in `src/model.js`, and give it a badge colour in `src/style.css`. A source with a SPARQL endpoint can be queried through Comunica, as the Wikidata adapter does.

## Known limits

- **Partial lists:** each panel shows at most 1,000 rows. Topic and venue pages fetch only each source's newest works (Crossref 500, OpenAlex 600), so their "works per year" charts over-weight recent years. Likewise, a work's "cited by" list and citations-per-year chart include only Wikidata's citing works plus OpenAlex's newest 200. The headline `citedByCount` is the full figure. A fix would use the sources' facet counts.
- **Live pages:** a live page appears once its slowest source answers. Crossref sometimes takes 10–15 seconds.
- **OpenAlex quota:** anonymous use is metered at about 1,000 requests per day per IP. That's ample for visitors; snapshot runs should use `OPENALEX_API_KEY`.
- **Wikidata author order:** Wikidata's author ordinals (`P1545`) are not mapped yet. Author order comes from Crossref, DataCite and OpenAlex.
- **Terminology pages:** only OBO terms and Orphanet disorders have their own pages. SNOMED CT, MeSH and ICD codes are shown as mappings and link out. OLS checks SNOMED CT and MeSH codes, but they don't have pages of their own yet. Term pages show only the newest 1,000 works about the term from Wikidata.
- **Language and search:** labels are English only, and name search uses Wikidata's search API.
- **Large pages:** a journal page (about 120k quads) takes several seconds to query in the browser.
- **RDF Portal:** TogoID and NANDO are used on term pages, and PubMed on work and author pages. RDF Portal's PubTator, ClinVar and MedGen data are not used yet. PubMed has no ORCIDs, so it confirms author lists but can't find people. Its Virtuoso endpoints time out on open-ended patterns, so queries stay anchored on known IRIs. Requests time out after 30 seconds.
- **Tests:** there are no automated tests yet. Behaviour was checked by hand with `npm run check` and in a browser.

## AI acknowledgement

This project was developed with substantial help from generative AI, as recommended by emerging norms for disclosing AI use in research software.

- **Tool:** Claude Code, running the Claude Opus 5.5 model (Anthropic), in November 2026.
- **What the AI did:**
  - proposed the architecture: source adapters → schema.org named graphs → reconciliation → Comunica over static or live graphs, packaged as a configurable template;
  - wrote the code, SPARQL queries, GitHub workflow and this README;
  - probed the Wikidata, QLever, ORCID, Crossref, DataCite, OpenAlex, OLS and RDF Portal APIs to confirm formats, CORS and rate limits;
  - ran the manual tests described above.
- **What the human did:** set the goals (a frugal Scholia that lives on GitHub, uses Comunica, is native RDF across Wikidata, ORCID, Crossref and further sources, and can be reused as a template), steered the design, and is responsible for reviewing, maintaining and publishing the code.
- **Verification:** the AI-generated code was tested by hand against live data. It has no automated test suite and has not had an independent line-by-line review, so treat it as a prototype.
- **Scholia:** no Scholia source code was copied. The panel ideas follow Scholia; the queries were written fresh for the schema.org model.

If you build an instance from this template, keep this section and add your own changes, including any made with AI tools.

## License

MIT, see [LICENSE](LICENSE). Data shown by an instance keeps its source licences: Wikidata, ORCID public data and OpenAlex are CC0; Crossref and DataCite metadata are generally CC0 or open. OBO ontologies are mostly CC BY 4.0 or CC0 (check each ontology). SNOMED CT, ICD and UMLS codes appear only as identifiers taken from OBO cross-references and Wikidata; their content is licensed separately.
