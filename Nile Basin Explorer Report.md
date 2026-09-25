Nile Basin Explorer Project Report
----------------------------------

#### By: Mohamed Tarek Mohamed

#### Date: 03/09/2026

#### Project URL: [nile-viz-complete](https://github.com/WhiteWhale52/nile-viz-complete/tree/dev)

### Overview

This project was created to give people the ability to view the climate around the Nile River, the geographical area called the Nile Basin. Raw climate data — drought levels, precipitation, number of dry days, max temperature, and more — spanning over 42 years is preprocessed into JSON and Parquet files, which the JavaScript front end then loads to drive a multi-level D3.js interface with four coordinated views: a map, a table, a line chart, and a year grid, sharing a drill-down hierarchy (basin → country → subregion) and a comparison mode. A user can browse the 42 years of climate data at both yearly and daily granularity, drill from the whole basin down to an individual subregion, and directly compare any two days or any two years to see how a given variable's value differed between them.

Beyond the core browsing and comparison flow, the explorer includes a daily animation mode (12 fps, with a hover-preview and a fullscreen mode), a side-by-side compare view for line charts, a draggable range bar on the timeline sliders, and dynamic, per-variable color scales — including a few purpose-built schemes (drought severity, tropical precipitation bursts, and NWS-style temperature banding) alongside a shared categorical colour scale that keeps each region's identity consistent across the map and the other views, independent of whatever gradient the map is currently showing. Pan/zoom state and drill-down transitions are preserved and animated as the user moves between levels, so switching between basin, country, and subregion views feels continuous rather than like a page reset.

### Architecture

The application is entirely front-end, D3.js-driven, similar in spirit to how Our World in Data displays its diagrams and graphs — there is no server, and all querying happens in the browser. The project exists as three files: `index.html` (page structure and layout), `styles.css` (all visual styling), and `app.js` (application logic — data loading, state management, and view rendering).

The code is organized into two layers. The **data layer** uses DuckDB-WASM to load Parquet files directly in the browser, through methods like `loadDataset` and `loadYearlyAggregates`, caching results in a `state.datasets` object keyed by dataset name so a given dataset is only queried once. The **view layer** is driven by a single global state object read by all four tabs — Map, Table, Line Chart, and Year Grid — each with its own render function, all triggered through `updateView()` or `renderActiveTab()`. Shared controls (the drill-down breadcrumb, the variable picker, the timeline slider, the compare-mode toggle) write into that same global state, and each tab's render function reads from it independently, so a single control change propagates to whichever tab is active without the tabs needing to know about each other directly.

On the data-preparation side, the Parquet files the app reads are produced by a companion Python extraction pipeline (`extract_hierarchical.py`, now past its 12th revision), which processes raw ERA5 and CID NetCDF climate files into the partitioned Parquet layout the front end expects — handling multiple variables per file, annual-vs-daily granularity, and the differing grid shapes across source datasets.

Functions are fully documented with comments, and there is a top-level explanation of the architecture at the head of `app.js`. Because the code lives in a public GitHub repository, anyone can get it running locally by cloning the repo, running a static file server such as `python -m http.server 8080` from the project directory, and opening `localhost:8080` in a browser — no build step, dependency install, or backend setup required.

### Resources

* [**D3.js documentation**](https://d3js.org/) — the core library the whole front end is built on; the [D3 gallery](https://observablehq.com/@d3/gallery) is useful for finding a working example close to a given chart type before writing one from scratch.
* [**DuckDB-WASM documentation**](https://duckdb.org/docs/stable/clients/wasm/overview) — covers instantiation (CDN vs. bundler), querying, and reading Parquet/CSV/JSON directly in the browser; directly relevant to the `loadDataset`/`loadYearlyAggregates` data layer.
* [**Apache Parquet documentation**](https://parquet.apache.org/docs/) — background on the file format itself (columnar layout, row groups, metadata), useful when deciding how to partition new data for the extraction pipeline.
* **[Our World in Data](https://ourworldindata.org/)** — the design reference for this project's chart style; worth revisiting directly for layout and interaction ideas as the UI/UX work continues.
* **[FastAPI documentation](https://fastapi.tiangolo.com/)** — the leading candidate framework for the planned backend.
* **[Nile Basin Initiative](https://nilebasin.org/)** — the main intergovernmental body for the basin; a starting point for the agency-collaboration work above, and a reference for what basin-wide monitoring systems already exist.
