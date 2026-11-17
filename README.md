# koetai-bibliography

A GitHub template for running your own Scholia-style scholarly profile site, with no server.

Each page (a researcher, a work, a topic or a venue) is one RDF graph, merged in your visitors' browsers from **Wikidata, ORCID, Crossref, DataCite and OpenAlex** and queried with [Comunica](https://comunica.dev). GitHub Pages hosts the site, and a GitHub Action keeps pre-built snapshots of the pages you feature. You add your own visualizations as a SPARQL query plus a few lines of config.

Inspired by [Scholia](https://github.com/WDscholia/scholia). The aim is to go native on RDF and go beyond Wikidata. (Developed under the working name frugalScholia.)

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
| `sources` | Which of `wikidata`, `orcid`, `crossref`, `datacite`, `openalex` to use |
| `wikidataEndpoint` | Wikidata SPARQL endpoint (default QLever, which holds the full graph) |
| `liveHarvest` | `false` limits the site to its snapshots: no live API calls from visitors' browsers |
| `seeds` | Entities to pre-build and feature on the home page: `orcid:…`, `doi:…`, `issn:…`, `wikidata:Q…`, `openalex:A…/W…/S…/T…`. An object `{ "key": "…", "aspect": "author" }` forces the page type |
| `panels` | Per page type (`author`, `work`, `topic`, `venue`, `common`): `hide` built-in panels by id, `add` your own |

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

## How it works

```
                      adapters (src/adapters/*.js), each → schema.org, one named graph per source
Wikidata  ── SPARQL CONSTRUCT via Comunica (QLever)  ┐
ORCID     ── public API v3                           │
Crossref  ── REST API                                ├─► reconcile (src/reconcile.js): merge nodes that share
DataCite  ── REST API (Zenodo, figshare, arXiv, …)   │   an ORCID / DOI / QID / ISSN / OpenAlex id
OpenAlex  ── REST API (authors, venues, topics,      ┘                 │
              citing works)                              one merged N-Quads graph per entity
                                                      │                                  │
                                GitHub Action → data/**/*.nq.gz            browser → harvested live
                                                      └──────────────┬───────────────────┘
                                                                     ▼
                                     Comunica runs each panel's SPARQL over the graph → tables and charts
```

The same harvesting code (`src/harvest.js`) runs in Node for snapshots and in the browser for live pages.

### Data model

Everything is mapped to [schema.org](https://schema.org). Each source writes to its own named graph `urn:koetai-bibliography:source:<name>`, so panels can query provenance with `GRAPH ?g { … }`. Panels query the union of all graphs.

| Concept | Terms |
|---|---|
| Work | `schema:ScholarlyArticle` (or `Dataset`, `SoftwareSourceCode`, …), `schema:name`, `schema:datePublished` (`xsd:date` / `gYearMonth` / `gYear`), `schema:author`, `schema:isPartOf`, `schema:about`, `schema:citation` |
| Person | `schema:Person`, `schema:name`, `schema:description` |
| Venue | `schema:Periodical`, `schema:name`, `schema:issn` |
| Topic | Wikidata items and OpenAlex topics (`schema:DefinedTerm`), `schema:name` |
| Identity | `schema:sameAs` to `https://orcid.org/…`, `https://doi.org/…`, `http://www.wikidata.org/entity/Q…`, `urn:issn:…`, `https://openalex.org/…` |
| Extras | `kb:citedByCount`, `kb:authorship` → `kb:agent` + `kb:position` (author order), where `kb:` = `urn:koetai-bibliography:vocab:` |

**Reconciliation.** Nodes linked by `schema:sameAs` are merged under one canonical IRI: ORCID > DOI > Wikidata > ISSN > OpenAlex. Within a single work, authors from different sources are also joined by name: an exact full-name match between identified authors, or a family name plus first initial for authors who only have a per-work ID. Matching never crosses works, so namesakes on different papers stay separate.

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

Write `src/adapters/<name>.js` returning quads in graph `urn:koetai-bibliography:source:<name>`, and use the IRI helpers in `src/model.js` so identities line up. Call it from `src/harvest.js`, add the name to `SOURCES` in `src/model.js`, and give it a badge colour in `src/style.css`. A source with a SPARQL endpoint can be queried through Comunica, as the Wikidata adapter does.

## Known limits

- **Partial lists:** each panel shows at most 1,000 rows. Topic and venue pages fetch only each source's newest works (Crossref 500, OpenAlex 600), so their "works per year" charts over-weight recent years. Likewise, a work's "cited by" list and citations-per-year chart include only Wikidata's citing works plus OpenAlex's newest 200. The headline `citedByCount` is the full figure. A fix would use the sources' facet counts.
- **Live pages:** a live page appears once its slowest source answers. Crossref sometimes takes 10–15 seconds.
- **OpenAlex quota:** anonymous use is metered at about 1,000 requests per day per IP. That's ample for visitors; snapshot runs should use `OPENALEX_API_KEY`.
- **Wikidata author order:** Wikidata's author ordinals (`P1545`) are not mapped yet. Author order comes from Crossref, DataCite and OpenAlex.
- **Language and search:** labels are English only, and name search uses Wikidata's search API.
- **Large pages:** a journal page (about 120k quads) takes several seconds to query in the browser.
- **Tests:** there are no automated tests yet. Behaviour was checked by hand with `npm run check` and in a browser.

## AI acknowledgement

This project was developed with substantial help from generative AI, as recommended by emerging norms for disclosing AI use in research software.

- **Tool:** Claude Code, running the Claude Opus 5.5 model (Anthropic), in November 2026.
- **What the AI did:**
  - proposed the architecture: source adapters → schema.org named graphs → reconciliation → Comunica over static or live graphs, packaged as a configurable template;
  - wrote the code, SPARQL queries, GitHub workflow and this README;
  - probed the Wikidata, QLever, ORCID, Crossref, DataCite and OpenAlex APIs to confirm formats, CORS and rate limits;
  - ran the manual tests described above.
- **What the human did:** set the goals (a frugal Scholia that lives on GitHub, uses Comunica, is native RDF across Wikidata, ORCID, Crossref and further sources, and can be reused as a template), steered the design, and is responsible for reviewing, maintaining and publishing the code.
- **Verification:** the AI-generated code was tested by hand against live data. It has no automated test suite and has not had an independent line-by-line review, so treat it as a prototype.
- **Scholia:** no Scholia source code was copied. The panel ideas follow Scholia; the queries were written fresh for the schema.org model.

If you build an instance from this template, keep this section and add your own changes, including any made with AI tools.

## License

MIT, see [LICENSE](LICENSE). Data shown by an instance keeps its source licences: Wikidata, ORCID public data and OpenAlex are CC0; Crossref and DataCite metadata are generally CC0 or open.
