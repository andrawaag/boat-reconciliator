# koetai-reconciliator

**koetai reconciliator** reconciles entities across linked-data sources into one RDF graph per entity, and publishes the result as a static site with no server. It's a GitHub template, so anyone can run their own instance.

It covers scholarly entities and ontology terms. Each page (a researcher, a work, a topic or a venue) is one RDF graph, merged in your visitors' browsers from **Wikidata, ORCID, Crossref, DataCite, OpenAlex and OBO ontologies (via OLS)** and queried with [Comunica](https://comunica.dev). GitHub Pages hosts the site, and a GitHub Action keeps pre-built snapshots of the pages you feature. You add your own visualizations as a SPARQL query plus a few lines of config.

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
| `wikidataFixes` | `false` hides the "Improve Wikidata" panel on ontology term pages (default `true`) |
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

## Find an author's works missing on Wikidata

Author pages have a **Works missing on Wikidata** panel. It lists works with a DOI that ORCID, Crossref, DataCite or OpenAlex attribute to the person but that Wikidata doesn't link to them (no author statement, P50). **Check against Wikidata** looks the DOIs up on Wikidata (P356) and sorts them into groups, each with checkboxes:

- **Add this author to existing items:** the work is on Wikidata and its author list names this person. The command adds P50 with the series ordinal (P1545) and the name as written (P1932). It can also remove the matching author name string (P2093), as the Author Disambiguator tool does. Ticked by default.
- **Create new items:** the work is not on Wikidata. A new item gets a label, a type (P31: scholarly article, preprint, conference paper, chapter, data set, software, book or thesis, from the Crossref or OpenAlex work type), the title (P1476), DOI, publication date with matching precision, venue (P1433, by ISSN) and all authors in order. Authors with a Wikidata item (found by ORCID) become P50, the others P2093 name strings. Papers are ticked by default; data sets, software and books are not.
- **Only claimed by ORCID:** on Wikidata, but the person isn't in the work's author list (for example a group author). Unticked.
- **Not proposed:** works with no author list from Crossref, DataCite or OpenAlex, unsupported types, and duplicates. A duplicate is a DOI whose title matches another candidate's, such as Zenodo's version DOIs; only one item per title is proposed, and none if one of them is already on Wikidata.

Every statement cites the metadata source (stated in Crossref Q5188229, DataCite Q821542, OpenAlex Q107507571 or ORCID Q51044), the DOI URL and the retrieval date. Titles get language `en` by default; change it in the panel. If the person has no Wikidata item yet, create it first with the **Not on Wikidata yet** panel. Otherwise new items list them as a name string.

## Ontology terms and terminology mappings

Any OBO Foundry term has a page: search by name (results come from Wikidata and from [OLS](https://www.ebi.ac.uk/ols4/)), or paste an ID such as `MONDO:0005148`, `DOID:9352`, `GO:0006915` or `HP:0005978`.

1. **The ontology.** The `obo` adapter (`src/adapters/obo.js`) reads the term from EBI's Ontology Lookup Service: label, definition, synonyms with their OBO scope, obsolete status, is-a parents and children, and the term's cross-references.
2. **Wikidata.** The item is found through the ontology's own Wikidata property (P5270 MONDO, P699 DOID, P686 GO, P3841 HPO, …) or P2888 exact match. If none carries the term's ID, the item that shares the most of the term's exact cross-references is used, and the page shows which codes matched.
3. **Mappings.** Codes from both sources are turned into the same IRIs (`src/vocab.js`), for example `http://snomed.info/id/44054006` or `http://id.nlm.nih.gov/mesh/D003924`. Where two sources give the same code, they meet on one node.

The term page shows:
- **Agreement between sources:** per terminology, how many codes both sources give, and how many only one does.
- **Mappings to other terminologies:** each code with its relation (`exact` for an exact match or Wikidata external ID, `xref` for a plain database cross-reference) and source badges.
- The parents, children and synonyms, plus works about the term on Wikidata (the newest 1,000).

Example: for type 2 diabetes (`MONDO:0005148`), MONDO and Wikidata agree on DOID, ICD-10, ICD-11, MeSH, NCIt and UMLS. But Wikidata's MONDO ID for the item points to an obsolete term, and MONDO's SNOMED CT code is not on Wikidata.

### Improve Wikidata from a term page

When a term is linked to a Wikidata item, an **Improve Wikidata** panel compares the two and proposes QuickStatements edits, each with a checkbox:

- **Add the term's own ID** (e.g. P5270 for MONDO) when the item was only matched through shared codes.
- **Add codes the ontology states as exact matches** but the item lacks (e.g. SNOMED CT P5806), with qualifier mapping relation type (P4390) = exact match (Q39893449).
- **Remove an obsolete ID**: when the item holds a different ID of the same ontology and OLS reports that term as obsolete. This one is unticked by default.

Additions are referenced with stated in (S248) the ontology's Wikidata item (MONDO Q27468140, DO Q5282129, HPO Q17027854, GO Q135085), reference URL (S854) to the term's PURL, and retrieved (S813). New IDs use the spelling most common on Wikidata for that property (e.g. `MONDO_0005148`, `GO:0006915`). Codes that only Wikidata has are listed for review, without proposed edits. As on author pages, you run the edits in QuickStatements under your own account.

For type 2 diabetes (`MONDO:0005148`) the panel proposes adding MONDO_0005148 and SNOMED CT 44054006 to Q3025883, and offers to remove MONDO_0015887 ("obsolete rare diabetes mellitus type 2").

Supported terminologies: SNOMED CT, MeSH, ICD-9-CM, ICD-10, ICD-10-CM, ICD-11, UMLS, OMIM, Orphanet, MedGen, and OBO ontologies (MONDO, DOID, HPO, GO, NCIt, UBERON, CL, ChEBI, NCBITaxon, SO, ENVO; other OBO prefixes get PURLs, anything else a [Bioregistry](https://bioregistry.io) IRI). Add one in `VOCABS` in `src/vocab.js`.

## How it works

```
                      adapters (src/adapters/*.js), each → schema.org, one named graph per source
Wikidata  ── SPARQL CONSTRUCT via Comunica (QLever)  ┐
ORCID     ── public API v3                           │
Crossref  ── REST API                                │
DataCite  ── REST API (Zenodo, figshare, arXiv, …)   ├─► reconcile (src/reconcile.js): merge nodes that share an
OpenAlex  ── REST API (authors, venues, topics,      │   ORCID / DOI / OBO term / QID / ISSN / OpenAlex id;
              citing works)                          │   codes in other terminologies stay mappings (src/vocab.js)
OBO       ── OLS4 API (terms, hierarchy, xrefs)      ┘                         │
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
| Mapping | `skos:exactMatch` or `oboInOwl:hasDbXref` to a code node with `kr:vocabulary` and `kr:code` |
| Identity | `schema:sameAs` to `https://orcid.org/…`, `https://doi.org/…`, `http://www.wikidata.org/entity/Q…`, `urn:issn:…`, `https://openalex.org/…`, `http://purl.obolibrary.org/obo/…` |
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
- **Terminology pages:** only OBO terms have their own pages. SNOMED CT, MeSH and ICD codes are shown as mappings and link out. OLS also hosts SNOMED CT and MeSH, so they could become sources next. Term pages show only the newest 1,000 works about the term from Wikidata.
- **Language and search:** labels are English only, and name search uses Wikidata's search API.
- **Large pages:** a journal page (about 120k quads) takes several seconds to query in the browser.
- **Tests:** there are no automated tests yet. Behaviour was checked by hand with `npm run check` and in a browser.

## AI acknowledgement

This project was developed with substantial help from generative AI, as recommended by emerging norms for disclosing AI use in research software.

- **Tool:** Claude Code, running the Claude Opus 5.5 model (Anthropic), in November 2026.
- **What the AI did:**
  - proposed the architecture: source adapters → schema.org named graphs → reconciliation → Comunica over static or live graphs, packaged as a configurable template;
  - wrote the code, SPARQL queries, GitHub workflow and this README;
  - probed the Wikidata, QLever, ORCID, Crossref, DataCite, OpenAlex and OLS APIs to confirm formats, CORS and rate limits;
  - ran the manual tests described above.
- **What the human did:** set the goals (a frugal Scholia that lives on GitHub, uses Comunica, is native RDF across Wikidata, ORCID, Crossref and further sources, and can be reused as a template), steered the design, and is responsible for reviewing, maintaining and publishing the code.
- **Verification:** the AI-generated code was tested by hand against live data. It has no automated test suite and has not had an independent line-by-line review, so treat it as a prototype.
- **Scholia:** no Scholia source code was copied. The panel ideas follow Scholia; the queries were written fresh for the schema.org model.

If you build an instance from this template, keep this section and add your own changes, including any made with AI tools.

## License

MIT, see [LICENSE](LICENSE). Data shown by an instance keeps its source licences: Wikidata, ORCID public data and OpenAlex are CC0; Crossref and DataCite metadata are generally CC0 or open. OBO ontologies are mostly CC BY 4.0 or CC0 (check each ontology). SNOMED CT, ICD and UMLS codes appear only as identifiers taken from OBO cross-references and Wikidata; their content is licensed separately.
