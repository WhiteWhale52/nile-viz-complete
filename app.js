/*
 * Nile Basin Explorer
 * ===================
 * PURPOSE
 * -------
 * Interactive browser-based visualization of the preprocessed
 * Nile Basin climate dataset.
 * The application consumes:
 *     - hierarchy JSON files for geographic metadata and geometry
 *     - partitioned Parquet files for climate time series
 * It does not process the original GeoPackages, rasters, or NetCDF
 * files. Those are handled by extract_hierarchical_V*.py.
 *
 * APPLICATION MAP
 * ---------------
 *                     Preprocessed Data
 *                            │
 *               ┌────────────┴────────────┐
 *               ▼                         ▼
 *        Hierarchy JSON               Parquet
 *               │                         │
 *               └────────────┬────────────┘
 *                            ▼
 *                     Data Loading
 *                            │
 *                            ▼
 *                     Data Selection
 *                            │
 *               ┌────────────┼────────────┐
 *               ▼            ▼            ▼
 *             Map          Table        Charts
 *               │            │            │
 *               └────────────┼────────────┘
 *                            ▼
 *                     User Interaction
 *
 * MAIN APPLICATION COMPONENTS
 * ----------------------------
 * 1. Data loading
 *    Loads the hierarchy and climate data required by the explorer.
 * 2. Geographic hierarchy
 *    Represents the available geographic levels and regions.
 * 3. Map visualization
 *    Displays climate values geographically.
 * 4. Table view
 *    Displays the underlying values for the selected region/time
 *    period.
 * 5. Time-series visualization
 *    Shows how selected indicators change through time.
 * 6. Grid/tile view
 *    Provides a tiled geographic representation of the data.
 * 7. User controls
 *    Control dataset, geographic level, region, indicator, date,
 *    and visualization state.
 *
 * DATA FLOW
 * ---------
 * User selection
 *     │
 *     ▼
 * Selected dataset / level / region / indicator / date
 *     │
 *     ▼
 * Data filtering
 *     │
 *     ├──> Map
 *     ├──> Table
 *     ├──> Line graph
 *     └──> Grid view
 *
 * All visualizations are different representations of the same
 * underlying preprocessed dataset.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

/* ════════════════════════════════════════════════════════════════════
   DATASET CONFIGURATION & CLIMATE VARIABLES
   ════════════════════════════════════════════════════════════════════ */

const DATASET_CONFIGS = {
  basins: {
    hierarchy: "data/hierarchy_basins.json",
    manifest: "data/climate_parquet_manifest_basins.json",
  },
  countries: {
    hierarchy: "data/hierarchy_countries.json",
    manifest: "data/climate_parquet_manifest_countries.json",
  },
};

const lajollaColors = [
  "#FFFECA", "#F6D672", "#E79452",
  "#B7633F", "#683F20", "#1C1B02"
];

const interpolateLajolla = d3.interpolateRgbBasis(lajollaColors);

function makeStopInterpolator(colors, stops) {
  const scale = d3.scaleLinear()
    .domain(stops)
    .range(colors)
    .interpolate(d3.interpolateRgb)
    .clamp(true);
  return t => scale(t);
}

// ── Drought Severity: pale cream → oranges → brick red → deep purple ──
const interpolateDroughtSeverity = makeStopInterpolator(
  ["#FDF5D0","#FCEAA1","#F8E070","#F4B354","#EC8439","#E05020",
   "#C84232","#AF3540","#96274B","#7C1B55","#600F5F","#3E0668"],
  [0, 0.09, 0.18, 0.27, 0.36, 0.45, 0.55, 0.64, 0.73, 0.82, 0.91, 1.0]
);

// ── Precip Tropical Burst: pale → green/teal → blue → violet → magenta ──
const interpolatePrecipTropicalBurst = makeStopInterpolator(
  ["#FEFCF3","#DBEFDA","#B7E0C1","#7CD1BA","#00BFC3","#00A5CA",
   "#2485D0","#4967D4","#6F3BBA","#970094"],
  [0, 0.11, 0.22, 0.33, 0.44, 0.56, 0.67, 0.78, 0.89, 1.0]
);

// ── Temperature (NWS-style): icy white → navy → teal/green → yellow → red → deep red ──
const interpolateTempNws = makeStopInterpolator(
  ["#F8FAFF","#E8F2FC","#D4E7F8","#C0DAF2","#A8CBEA","#90BADC","#7BAACE",
   "#6899BF","#5788AE","#1C2D6B","#1F3878","#234688","#3A618C","#2D6B80",
   "#2E7070","#4A7A5A","#7A8840","#AAAA30","#C8A020","#CC7818","#C04830",
   "#AE2A50","#921828","#760E14","#5C0A0A"],
  [0, 0.04, 0.08, 0.13, 0.17, 0.21, 0.25, 0.29, 0.33, 0.38, 0.42, 0.46,
   0.50, 0.54, 0.58, 0.63, 0.67, 0.71, 0.75, 0.79, 0.83, 0.88, 0.92, 0.96, 1.0]
);


/**
 * Full variable catalog derived from the preprocessed xclim/xarray indicators.
 * - category: "heat" | "wet" | "dry" — used to group the dropdown and pick a
 *   sensible color family.
 * - daily: whether this variable has a genuine daily value (raw CHIRTS-ERA5
 *   fields) vs. being an annual-only index (heatwave counts, SPI/SPEI, etc.)
 *   that has no meaning on a single day.
 * - interpolator: a d3-scale-chromatic continuous color function.
 * - diverging: true for indices centered on 0 (SPI/SPEI), which get a
 *   diverging scale instead of a sequential one.
 */
const CLIMATE_VARS = {
  // ── HEAT ──────────────────────────────────────────────────────────
  tasmean:      { label: "Mean Temperature",               unit: "°C",       category: "heat", daily: false, interpolator: interpolateTempNws, diverging: true,  fixedDomain: [7, 12, 32.089] },
  tasmax:       { label: "Max Temperature",               unit: "°C",       category: "heat", daily: true,  interpolator: interpolateTempNws, diverging: true,  fixedDomain: [7, 12, 44.962] },
  tasmin:       { label: "Min Temperature",                unit: "°C",       category: "heat", daily: true,  interpolator: interpolateTempNws, diverging: true,  fixedDomain: [7, 12, 32.456]},
  dtr:          { label: "Diurnal Temperature Range",      unit: "°C",       category: "heat", daily: false,  interpolator: d3.interpolateOranges },
  gdd:          { label: "Growing Degree Days (>10°C)",    unit: "°C·days",  category: "heat", daily: false, interpolator: d3.interpolateYlOrRd },
  cdd:          { label: "Cooling Degree Days (>24°C)",    unit: "°C·days",  category: "heat", daily: false, interpolator: d3.interpolateYlOrRd },
  HWN:          { label: "Heatwave Count",                 unit: "events",   category: "heat", daily: false, interpolator: d3.interpolateReds },
  HWD:          { label: "Heatwave Max Duration",          unit: "days",     category: "heat", daily: false, interpolator: d3.interpolateReds },
  HWF:          { label: "Heatwave Total Days",            unit: "days",     category: "heat", daily: false, interpolator: d3.interpolateReds },
  wsdi:         { label: "Warm Spell Duration Index",      unit: "days",     category: "heat", daily: false, interpolator: d3.interpolateYlOrRd },
  tr:           { label: "Tropical Nights (Tmin>24°C)",    unit: "days",     category: "heat", daily: false, interpolator: d3.interpolateYlOrRd },

  // ── WET ───────────────────────────────────────────────────────────
  precip:       { label: "Precipitation",                  unit: "mm",       category: "wet",  daily: true,  interpolator: interpolatePrecipTropicalBurst },
  prcptot:      { label: "Total Precipitation",             unit: "mm",       category: "wet",  daily: false, interpolator: interpolatePrecipTropicalBurst  },
  cwd:          { label: "Consecutive Wet Days",            unit: "days",     category: "wet",  daily: false, interpolator: d3.interpolateBlues },
  sdii:         { label: "Simple Daily Intensity Index",    unit: "mm/day",   category: "wet",  daily: false, interpolator: d3.interpolateBlues },
  rx1day:       { label: "Max 1-Day Precipitation",         unit: "mm",       category: "wet",  daily: false, interpolator: d3.interpolateBlues },
  rx5day:       { label: "Max 5-Day Precipitation",         unit: "mm",       category: "wet",  daily: false, interpolator: d3.interpolateBlues },
  rx1daytot:    { label: "% Precip From Wettest Day",       unit: "%",        category: "wet",  daily: false, interpolator: d3.interpolatePuBu },
  rx5daytot:    { label: "% Precip From Wettest 5 Days",    unit: "%",        category: "wet",  daily: false, interpolator: d3.interpolatePuBu },
  pci:          { label: "Precipitation Concentration Index", unit: "index",  category: "wet",  daily: false, interpolator: d3.interpolatePuBu },
  r95p:         { label: "Very Wet Days (>95th pct)",       unit: "days",     category: "wet",  daily: false, interpolator: d3.interpolateBlues },
  r95ptot:      { label: "% Precip From Very Wet Days",     unit: "%",        category: "wet",  daily: false, interpolator: d3.interpolatePuBu },

  // ── DRY ───────────────────────────────────────────────────────────
  cdd_dry:      { label: "Consecutive Dry Days",            unit: "days",     category: "dry",  daily: false, interpolator: interpolateDroughtSeverity  },
  spi_12:       { label: "SPI-12 (Std. Precip. Index)",     unit: "σ",        category: "dry",  daily: false, interpolator: d3.interpolateBrBG, diverging: true },
  spi_12_amdd:  { label: "SPI-12 Max Drought Duration",     unit: "months",   category: "dry",  daily: false, interpolator: d3.interpolateYlOrBr },
  spi_12_adm:   { label: "SPI-12 Drought Magnitude",        unit: "σ·months", category: "dry",  daily: false, interpolator: d3.interpolateYlOrBr },
  spei_12:      { label: "SPEI-12 (with PET)",              unit: "σ",        category: "dry",  daily: false, interpolator: d3.interpolateBrBG, diverging: true },
  spei_12_amdd: { label: "SPEI-12 Max Drought Duration",    unit: "months",   category: "dry",  daily: false, interpolator: d3.interpolateYlOrBr },
  spei_12_adm:  { label: "SPEI-12 Drought Magnitude",       unit: "σ·months", category: "dry",  daily: false, interpolator: d3.interpolateYlOrBr },
  ai:           { label: "Aridity Index (P/PET)",           unit: "ratio",    category: "dry",  daily: false, interpolator: interpolateLajolla },
};

const CATEGORY_LABELS = { heat: "Heat", wet: "Wet", dry: "Dry / Drought" };

// A representative solid color for each variable, used for line/dot strokes
// (the map itself uses the full interpolator as a gradient, not one color).
function varLineColor(varMeta) {
  return varMeta.interpolator(varMeta.diverging ? 0.85 : 0.72);
}


const POPULATION_PALETTE = ["#e4efe8", "#8fb9a0", "#3f8867", "#245c40"];

// Rough continental bounding box, used to fit an optional basemap image

const YEAR_RANGE = { min: 1983, max: 2025 };

/* ════════════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════════════ */

const state = {
  dataset: "basins",           // current active dataset
  datasets: {},                // { dataset_name -> { hierarchy, yearlyByLevel, parquetPaths, monthlyByYear } }
  
  currentLevel: 0,
  climateVar: "tasmax",
  mapYear: 1983,
  mapDay: 1,        // day-of-year (1-365/366), used when granularity === "monthly" (daily-in-a-year view)
  granularity: "yearly",       // "yearly" or "monthly"
  chartShowMean: false,        // chart tab: overlay each region's mean as a dashed horizontal line
  chartShowTrend: false,       // chart tab: overlay each region's linear best-fit trend line

  // Temporal range filters — restrict yearly/daily aggregation (table mean/trend,
  // chart, map color-scale extent) to a sub-window instead of the full dataset.
  yearRangeStart: YEAR_RANGE.min,
  yearRangeEnd: YEAR_RANGE.max,
  dayRangeStart: 1,            // day-of-year, inclusive. Must be <= dayRangeEnd (no wrap-around yet).
  dayRangeEnd: 365,
  sameDateMode: false,          // when true, both years compare the SAME calendar date (locked together)
  showDeltaTile: false,         // "What Changed??" — opt-in extra grid tile showing the delta between the two compared points
  activeYearHandle: "end",      // "start" or "end" — which year's date the single-day slider currently edits (cross-year mode only)
  compareModeEnabled: false,   // gates the side-by-side comparison view — even when the two
                                // handles are apart, compare view only renders when this is on

  // Which parent feature (by name) was clicked to drill down one level, so
  // renders can show only that parent's children instead of the whole level.
  // Reset to null at level 0. Requires child features to carry a
  // `parent_name` property (see extract_hierarchical_V9.py) — falls back to
  // showing all children if that property is missing from the data.
  drilldownParentName: null,

  activeTab: "map",            // "map" | "table" | "chart" — shared across all views
  tableSort: { key: "mean", dir: "desc" },
  expandedRegionId: null,      // which table row is expanded
  chartHoveredId: null,        // which region line is highlighted in the chart tab
  chartLockedId: null,         // which region line is click-locked highlighted in the chart tab (persists until click elsewhere)

  colorBy: "variable",         // "variable" | "population"
  showCountryOutline: false,
  showWaterBodies: true, // always on — no UI toggle; water bodies (rivers & seas) are a permanent base layer

  width: 900,
  height: 560,
};

/* ════════════════════════════════════════════════════════════════════
   DOM ELEMENTS
   ════════════════════════════════════════════════════════════════════ */

const svg = d3.select("#nc-svg").attr("viewBox", `0 0 ${state.width} ${state.height}`);
const zoomLayer = svg.append("g").attr("class", "zoom-layer");

// Ordered sub-layers so basemap sits behind country outlines, which sit behind regions
const countryLayer   = zoomLayer.append("g").attr("class", "country-outline-layer");
const regionsLayer   = zoomLayer.append("g").attr("class", "regions-layer");
const compareLayer   = zoomLayer.append("g").attr("class", "compare-layer");
const waterLayer     = zoomLayer.append("g").attr("class", "water-layer"); // drawn last so rivers/seas sit visibly over the colored basin regions

// Fixed (non-panning) scale bar, drawn directly on the svg
const scaleBarG = svg.append("g").attr("class", "scale-bar-group");
const scaleBarLine  = scaleBarG.append("line").attr("y1", 0).attr("y2", 0);
const scaleBarTick1  = scaleBarG.append("line").attr("y1", -4).attr("y2", 4).attr("x1", 0).attr("x2", 0);
const scaleBarTick2  = scaleBarG.append("line").attr("y1", -4).attr("y2", 4);
const scaleBarLabel = scaleBarG.append("text").attr("y", -8).attr("text-anchor", "middle");

let currentZoomK = 1;
let savedMapTransform = d3.zoomIdentity; // persists pan/zoom across tab switches, variable changes, etc.
const zoomBehavior = d3.zoom()
  .scaleExtent([1, 8])
  .on("zoom", (e) => {
    zoomLayer.attr("transform", e.transform);
    currentZoomK = e.transform.k;
    savedMapTransform = e.transform;
    updateScaleBar();
  });
svg.call(zoomBehavior);

const mapWrapEl   = document.getElementById("nc-map-wrap");
const mainEl      = document.getElementById("nc-main");
const hintEl      = document.getElementById("nc-hint");
const backBtn     = document.getElementById("nc-back");
const zoomInBtn    = document.getElementById("nc-zoom-in");
const zoomOutBtn   = document.getElementById("nc-zoom-out");
const zoomResetBtn = document.getElementById("nc-zoom-reset");
const breadcrumb  = document.getElementById("nc-breadcrumb");
const statusEl    = document.getElementById("data-status");
const statusText  = document.getElementById("status-text");
const varSelect   = document.getElementById("var-select");
const datasetSelect = document.getElementById("dataset-select");
const titleEl = document.getElementById("nc-title");
const subEl   = document.getElementById("nc-sub");

function populateVarSelect() {
  varSelect.innerHTML = "";
  ["heat", "wet", "dry"].forEach(cat => {
    const keys = Object.keys(CLIMATE_VARS).filter(k => CLIMATE_VARS[k].category === cat);
    if (!keys.length) return;
    const group = document.createElement("optgroup");
    group.label = CATEGORY_LABELS[cat];
    keys.forEach(key => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = CLIMATE_VARS[key].label;
      group.appendChild(opt);
    });
    varSelect.appendChild(group);
  });
  varSelect.value = state.climateVar;
}

function refreshVarSelectAvailability() {
  const isDaily = state.granularity === "monthly";
  let needsSwitch = false;

  if (isDaily && !CLIMATE_VARS[state.climateVar].daily) {
    needsSwitch = true;
  }
  if (needsSwitch) {
    state.climateVar = "tasmax"; // always daily-available, safe default
  }

  // Rebuild the option list from scratch so non-daily variables are fully
  // removed from the DOM (and can't be selected via keyboard/screen reader)
  // in daily view, rather than merely greyed out with `disabled`.
  varSelect.innerHTML = "";
  ["heat", "wet", "dry"].forEach(cat => {
    const keys = Object.keys(CLIMATE_VARS).filter(k => CLIMATE_VARS[k].category === cat && (!isDaily || CLIMATE_VARS[k].daily));
    if (!keys.length) return;
    const group = document.createElement("optgroup");
    group.label = CATEGORY_LABELS[cat];
    keys.forEach(key => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = CLIMATE_VARS[key].label;
      group.appendChild(opt);
    });
    varSelect.appendChild(group);
  });
  varSelect.value = state.climateVar;
}

populateVarSelect();
const playBtn     = document.getElementById("play-btn");
const dayPlayBtn  = document.getElementById("day-play-btn");
const yearRangeSliderMin = document.getElementById("year-range-slider-min");
const yearRangeSliderMax = document.getElementById("year-range-slider-max");
const yearRangeDualWrap = document.getElementById("year-range-dual-wrap");
const yearSingleWrap = document.getElementById("year-single-wrap");
const yearSingleSlider = document.getElementById("year-single-slider");
const yearRangeProgressEl = document.getElementById("year-range-progress");
const yearRangeHandleLabelStart = document.getElementById("year-range-handle-label-start");
const yearRangeHandleLabelEnd   = document.getElementById("year-range-handle-label-end");
const dayRangeRowEl    = document.getElementById("day-range-row");
const yearRangeRowEl   = document.getElementById("year-range-row");
const dayRangeSliderMin = document.getElementById("day-range-slider-min");
const dayRangeSliderMax = document.getElementById("day-range-slider-max");
const dayRangeProgressEl = document.getElementById("day-range-progress");
const sameDateToggle = document.getElementById("same-date-toggle");
const compareAcrossYearsRow = document.getElementById("compare-across-years-row");
const dayRangeDualWrap = document.getElementById("day-range-dual-wrap");
const daySingleWrap = document.getElementById("day-single-wrap");
const daySingleSlider = document.getElementById("day-single-slider");
const daySingleContextLabel = document.getElementById("day-single-context-label");
const dayRangeHandleLabelStart = document.getElementById("day-range-handle-label-start");
const dayRangeHandleLabelEnd   = document.getElementById("day-range-handle-label-end");
const compareModeToggle    = document.getElementById("compare-mode-toggle");

const optCountryOutline = document.getElementById("opt-country-outline");
const colorbyVariableBtn   = document.getElementById("colorby-variable");
const colorbyPopulationBtn = document.getElementById("colorby-population");

let playing = false;
let playInterval = null;

const hoverCard        = document.getElementById("hover-card");
const hoverCardName    = document.getElementById("hover-card-name");
const hoverCardPopVal  = document.getElementById("hover-card-pop-val");
const hoverCardVarLabel = document.getElementById("hover-card-var-label");
const hoverCardChartEl = document.getElementById("hover-card-chart");
const hoverCardDrillEl = document.getElementById("hover-card-drill");

const tabsEl        = document.getElementById("nc-tabs");
const mapMainEl      = document.getElementById("nc-main");
const layoutEl        = document.getElementById("nc-layout");
const timelineDrawerEl   = document.getElementById("nc-timeline-drawer");
const timelineReadoutBtn = document.getElementById("nc-timeline-readout");
const tablePaneEl    = document.getElementById("nc-table-pane");
const gridPaneEl     = document.getElementById("nc-grid-pane");
const deltaGridToggleRow = document.getElementById("delta-grid-toggle-row");
const deltaGridToggle    = document.getElementById("delta-grid-toggle");
deltaGridToggle.addEventListener("change", (e) => {
  state.showDeltaTile = e.target.checked;
  renderYearGrid();
});
const tableBodyEl    = document.getElementById("region-table-body");
const chartPaneEl    = document.getElementById("nc-chart-pane");
const chartSvgEl     = document.getElementById("line-chart-svg");
const chartLegendEl  = document.getElementById("chart-legend");
const chartPlotAreaEl     = document.getElementById("chart-plot-area");
const chartZoomHintEl     = document.getElementById("chart-zoom-hint");
const chartZoomResetBtn   = document.getElementById("chart-zoom-reset-btn");
const chartModeBackBtn    = document.getElementById("chart-mode-back-btn");

// ── Chart zoom (brush-to-zoom on the yearly line chart) ─────────────
// This is intentionally NOT the same thing as the global year-range
// slider: it's a local, chart-only view window over the already-loaded
// yearly points. Zooming never refetches data on its own — only the
// threshold-triggered swap into daily mode (below) fetches anything,
// and only for the single year that was zoomed into.
//
// chartZoomWindows: { yearly, monthly } — each either null (full extent) or
// {start, end, yMin, yMax}. start/end are in the current mode's x units
// (calendar year for yearly, day-of-year for monthly/daily); yMin/yMax are
// in the current variable's data units. Kept separate per mode so zooming
// into a daily window doesn't get clobbered by (or leak into) the yearly
// chart's own zoom, and switching granularity/tabs never has to guess
// which window still applies. Set by ctrl-drag-selecting a rectangle
// directly on the main chart, in either mode.
// chartZoomAutoSwitched: true once a *yearly* zoom crossed the threshold
// and auto-swapped the chart into daily/monthly mode for one year — used
// to show the "back to yearly" affordance and to know this was a zoom-
// triggered switch rather than a manual granularity-select change.
let chartZoomWindows = { yearly: null, monthly: null };
function getZoomModeKey() { return state.granularity === "monthly" ? "monthly" : "yearly"; }
function getChartZoomWindow() { return chartZoomWindows[getZoomModeKey()]; }
function setChartZoomWindow(win) { chartZoomWindows[getZoomModeKey()] = win; }
let chartZoomAutoSwitched = false;
let chartZoomSwitchTimer = null;
const CHART_ZOOM_DAILY_IN_THRESHOLD_YEARS  = 1;   // span <= this → eligible to switch to daily
const CHART_ZOOM_SETTLE_DELAY_MS  = 550;          // let the zoom-in motion finish before switching modes
const CHART_ZOOM_DAILY_HINT_THRESHOLD_YEARS = 2;  // span <= this → show the "zoom in further" hint
const CHART_ZOOM_ANIM_MS = 650;                   // duration of the rectangle-zoom motion
const CHART_ZOOM_MIN_DRAG_PX = 8;                 // ignore accidental micro-drags

// Ctrl-drag-to-zoom on the main line chart: track the Ctrl key globally so
// the chart's cursor can flip to a crosshair ("+") the moment it's held,
// independent of any particular render.
let chartCtrlHeld = false;
function setChartCtrlHeld(v) {
  if (chartCtrlHeld === v) return;
  chartCtrlHeld = v;
  chartPlotAreaEl.classList.toggle("ctrl-zoom-active", v);
}
window.addEventListener("keydown", (e) => { if (e.key === "Control") setChartCtrlHeld(true); });
window.addEventListener("keyup", (e) => { if (e.key === "Control") setChartCtrlHeld(false); });
window.addEventListener("blur", () => setChartCtrlHeld(false));

function resetChartZoom({ rerender = true } = {}) {
  setChartZoomWindow(null);
  chartZoomAutoSwitched = false;
  clearTimeout(chartZoomSwitchTimer);
  chartZoomSwitchTimer = null;
  if (rerender) renderActiveTab();
}

// Called when a zoom on the yearly chart has narrowed to a single-year
// window and settled there (debounced). Swaps the chart into daily mode
// for that one year — mirrors what the granularity-select "Daily (one
// year)" option does, so the rest of the app (day-range UI, etc.) stays
// consistent — but is triggered by the zoom gesture instead of the
// dropdown, and remembers that it got here via zoom so it can offer a
// quick way back.
async function switchChartToDailyModeForYear(year) {
  chartZoomAutoSwitched = true;
  state.granularity = "monthly";
  document.getElementById("granularity-select").value = "monthly";
  applyYearRange(year, year);
  yearRangeRowEl.querySelector("#year-range-hint").textContent =
    "Drag both handles apart to pick a second year — then set each year's date below.";
  dayRangeRowEl.style.display = "flex";
  refreshVarSelectAvailability();
  await ensureDailyDataLoaded(year);
  refreshDayRangeUI();
  chartZoomWindows.monthly = null; // fresh daily view — no leftover daily zoom from a prior visit
  // Telegraph the mode swap with a brief crossfade rather than a hard cut.
  const svgEl = d3.select(chartSvgEl);
  svgEl.classed("chart-mode-fading", true);
  setTimeout(() => {
    renderActiveTab();
    requestAnimationFrame(() => svgEl.classed("chart-mode-fading", false));
  }, 160);
}

chartZoomResetBtn.addEventListener("click", () => resetChartZoom());
chartModeBackBtn.addEventListener("click", async () => {
  state.granularity = "yearly";
  document.getElementById("granularity-select").value = "yearly";
  applyYearRange(state.yearRangeStart, YEAR_RANGE.max);
  yearRangeRowEl.querySelector("#year-range-hint").textContent =
    "Drag the handle to set the start year — the window always runs through 2025.";
  dayRangeRowEl.style.display = "none";
  refreshVarSelectAvailability();
  resetChartZoom();
});

// Click-to-lock highlighting in the chart tab: clicking a line or its legend
// entry keeps that region highlighted until you click it again or click
// anywhere else. chartApplyHighlightFn always points at whichever render
// function's applyHighlight() is current, since the chart tab has several
// different render functions (single, compare, timeline compare, etc.)
// each with their own closure over the current D3 selections.
let chartApplyHighlightFn = null;
function toggleChartLock(id) {
  state.chartLockedId = state.chartLockedId === id ? null : id;
  if (chartApplyHighlightFn) chartApplyHighlightFn();
}
// Scoped to the chart pane itself (plot area + legend) rather than the
// whole document — clicking a timeline handle, a table row, a tab, etc.
// lives outside #nc-chart-pane and must never touch the lock, so you can
// scrub the year/day range while a region stays highlighted in the chart.
chartPaneEl.addEventListener("click", (e) => {
  if (state.chartLockedId === null) return;
  if (e.target.closest(".chart-line, .legend-item")) return;
  state.chartLockedId = null;
  if (chartApplyHighlightFn) chartApplyHighlightFn();
});
// Right-click anywhere in the chart pane (including directly on a line)
// also clears the lock, per the requested "select a different region or
// right-click in the line graph" behavior.
chartPaneEl.addEventListener("contextmenu", (e) => {
  if (state.chartLockedId === null) return;
  e.preventDefault();
  state.chartLockedId = null;
  if (chartApplyHighlightFn) chartApplyHighlightFn();
});


const statPopEl   = document.getElementById("stat-pop");
const statAreaEl  = document.getElementById("stat-area");
const statMeanEl  = document.getElementById("stat-mean");
const statMeanLabelEl = document.getElementById("stat-mean-label");
const statTrendLabelEl = document.getElementById("stat-trend-label");
const statTrendEl = document.getElementById("stat-trend");

let geoProjection = null;
let geoPathGen = null;
let colorScale = null;
let currentLegendExtent = null; // [lo, hi] value range the legend gradient currently spans, for positioning the hover marker
let hoverHideTimer = null;
let duckdbConn = null;
let countriesGeoCache = null; // lazily loaded, used only for the background outline layer
let oceanGeoCache = null;     // lazily loaded Natural Earth ocean polygons
let riversGeoCache = null;    // lazily loaded Natural Earth river/lake centerlines

// Natural Earth 1:50m vector data (public domain), served from GitHub raw
const OCEAN_GEOJSON_URL  = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_ocean.geojson";
const RIVERS_GEOJSON_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson";

/* ════════════════════════════════════════════════════════════════════
   UTILITIES
   ════════════════════════════════════════════════════════════════════ */

const dayOfYearFormatter = d3.timeFormat("%b %d");

function dateStrFromDayOfYear(year, day) {
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + (day - 1));
  return d.toISOString().slice(0, 10);
}

function dayOfYearFromDateStr(dateStr) {
  const dt = new Date(dateStr + "T00:00:00Z");
  const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.floor((dt - start) / 86400000) + 1;
}

async function ensureDailyDataLoaded(year, level = state.currentLevel) {
  const dataset = state.datasets[state.dataset];
  const levelKey = getLevelKey(level);
  if (!dataset.monthlyByYear[year]) dataset.monthlyByYear[year] = {};
  if (dataset.monthlyByYear[year][levelKey]) return; // this level already cached for this year
  setStatus("Loading daily data...", "loading");
  const levelData = await loadMonthlyForYear(duckdbConn, dataset.parquetPaths, year, level);
  Object.assign(dataset.monthlyByYear[year], levelData);
  setStatus("Ready");
}

function setStatus(message, type = "ready") {
  statusEl.className = "data-status";
  if (type !== "ready") statusEl.classList.add(type);
  statusText.textContent = message;
}

/**
 * Convert a numeric hierarchy level (0, 1, ...) into the string key used
 * to index into a dataset's hierarchy object, e.g. `1` -> "level 1".
 * @param {number} level - Numeric hierarchy level.
 * @returns {string} The corresponding hierarchy key, e.g. "level 1".
 */
function getLevelKey(level) {
  return `level ${level}`;
}

/**
 * Inverse of getLevelKey(): recover the numeric level from a hierarchy
 * key such as "level 1".
 * @param {string} levelKey - Hierarchy key, e.g. "level 1".
 * @returns {number} The numeric level, e.g. 1.
 */
function levelKeyToNumber(levelKey) {
  return parseInt(String(levelKey).split(" ")[1], 10);
}

/**
 * Look up the GeoJSON FeatureCollection for a given hierarchy level
 * within the currently active dataset (state.dataset).
 * @param {number} level - Numeric hierarchy level to fetch.
 * @returns {object|null} The level's GeoJSON FeatureCollection, or null
 *   if the active dataset hasn't finished loading yet.
 */
function getLevelData(level) {
  const ds = state.datasets[state.dataset];
  if (!ds) return null;
  return ds.hierarchy[getLevelKey(level)];
}

/* ════════════════════════════════════════════════════════════════════
   DUCKDB INITIALIZATION
   ════════════════════════════════════════════════════════════════════ */

/**
 * Spin up an in-browser DuckDB-wasm instance and return an open
 * connection. DuckDB is used so the app can run SQL (aggregation,
 * filtering, column unions) directly against the partitioned Parquet
 * files fetched over HTTP, instead of loading and reducing them in JS.
 * @returns {Promise<object>} An open DuckDB async connection.
 */
async function initDuckDB() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const conn = await db.connect();
  return conn;
}

/**
 * Fetch and validate a dataset's Parquet manifest, which lists the
 * relative paths of every partitioned Parquet file that makes up that
 * dataset's climate data (produced by extract_hierarchical_V*.py).
 * @param {string} manifestUrl - URL of the manifest JSON file.
 * @returns {Promise<string[]>} The list of Parquet file paths.
 * @throws {Error} If the manifest can't be fetched or lists no files.
 */
async function fetchParquetManifest(manifestUrl) {
  const resp = await fetch(manifestUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch manifest at ${manifestUrl}: HTTP ${resp.status}`);
  }
  const manifest = await resp.json();
  if (!manifest.files || !manifest.files.length) {
    throw new Error(`Manifest at ${manifestUrl} lists no files`);
  }
  return manifest.files;
}

/**
 * The parquet files behind a dataset can come from different extraction
 * runs with slightly different schemas (e.g. some use "pr", others
 * "precip" or "prcptot" for precipitation, or lack a column entirely).
 * We detect which columns actually exist before building a query, so a
 * `read_parquet([...], union_by_name = true)` glob never fails and never
 * references a column that doesn't exist anywhere in the file set.
 */
async function getAvailableColumns(conn, fileListSql) {
  const sql = `SELECT * FROM read_parquet([${fileListSql}], hive_partitioning = true, union_by_name = true) LIMIT 0`;
  const result = await conn.query(sql);
  return result.schema.fields.map(f => f.name);
}

function buildVarExpr(columns, candidates) {
  const present = candidates.filter(c => columns.includes(c));
  if (present.length === 0) return "NULL";
  if (present.length === 1) return present[0];
  return `COALESCE(${present.join(", ")})`;
}

const VAR_COLUMN_CANDIDATES = Object.fromEntries(
  Object.keys(CLIMATE_VARS).map(key => [key, key === "precip" ? ["precip", "pr"] : [key]])
);

function buildVarSelectClauses(columns, { agg = null } = {}) {
  return Object.keys(CLIMATE_VARS).map(key => {
    const expr = buildVarExpr(columns, VAR_COLUMN_CANDIDATES[key]);
    const wrapped = agg ? `${agg}(${expr})` : expr;
    return `${wrapped} AS ${key}`;
  });
}

function parseVarRow(row) {
  const out = {};
  for (const key of Object.keys(CLIMATE_VARS)) {
    out[key] = row[key] === null || row[key] === undefined ? undefined : Number(row[key]);
  }
  return out;
}

/**
 * Load one row per (level, region_id, year) by averaging the daily/annual
 * climate columns across each calendar year, via a single DuckDB query
 * over all of a dataset's Parquet files. This is the data backing the
 * default yearly-granularity map, table, and chart views.
 * @param {object} conn - Open DuckDB connection (see initDuckDB()).
 * @param {string[]} parquetPaths - Relative Parquet file paths from the
 *   dataset's manifest.
 * @returns {Promise<object>} Nested object keyed as
 *   `result[levelKey][region_id] -> [{ year, <climate vars> }, ...]`.
 */
async function loadYearlyAggregates(conn, parquetPaths) {
  const fileListSql = parquetPaths
    .map(p => `'${new URL(`data/${p}`, window.location.href).href}'`)
    .join(", ");

  const columns = await getAvailableColumns(conn, fileListSql);
  const varClauses = buildVarSelectClauses(columns, { agg: "AVG" });

  const sql = `
    SELECT
      level,
      region_id,
      CAST(substr(date, 1, 4) AS INTEGER) AS year,
      ${varClauses.join(",\n      ")}
    FROM read_parquet([${fileListSql}], hive_partitioning = true, union_by_name = true)
    GROUP BY level, region_id, year
    ORDER BY level, region_id, year
  `;

  const result = await conn.query(sql);
  const rows = result.toArray().map(r => r.toJSON ? r.toJSON() : r);

  const out = {};
  for (const row of rows) {
    const levelKey = `level ${row.level}`;
    if (!out[levelKey]) out[levelKey] = {};
    if (!out[levelKey][row.region_id]) out[levelKey][row.region_id] = [];
    out[levelKey][row.region_id].push({
      year: Number(row.year),
      ...parseVarRow(row),
    });
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════
   LOAD DATASET (caches & reuses across switches)
   ════════════════════════════════════════════════════════════════════ */

/**
 * Load (or return from cache) everything the explorer needs for one
 * named dataset ("basins" or "countries"): its geographic hierarchy,
 * the list of its Parquet files, and their yearly climate aggregates.
 * Monthly/daily data is intentionally NOT loaded here — it's fetched
 * on-demand per year via loadMonthlyForYear() and cached in
 * `monthlyByYear` to avoid pulling the full daily resolution up front.
 * @param {string} name - Dataset key, e.g. "basins" or "countries".
 * @returns {Promise<object>} The cached dataset object:
 *   `{ hierarchy, yearlyByLevel, parquetPaths, monthlyByYear }`.
 */
async function loadDataset(name) {
  // Return cached dataset if already loaded
  if (state.datasets[name]) {
    return state.datasets[name];
  }

  const cfg = DATASET_CONFIGS[name];

  // Load hierarchy (GeoJSON with feature properties)
  const hierarchy = await d3.json(cfg.hierarchy);

  // Fetch parquet manifest (list of file paths)
  const parquetPaths = await fetchParquetManifest(cfg.manifest);

  // Load yearly aggregates from parquet files
  const yearlyByLevel = await loadYearlyAggregates(duckdbConn, parquetPaths);

  // Cache the dataset
  state.datasets[name] = {
    hierarchy,
    yearlyByLevel,
    parquetPaths,
    monthlyByYear: {},  // populated on-demand when user switches to monthly granularity
  };

  return state.datasets[name];
}

/**
 * Load daily-resolution rows for one (year, hierarchy level) pair,
 * grouped by date to merge same-date rows that originate from separate
 * per-variable Parquet files (e.g. tasmax vs precip). Results are cached
 * by the caller in `dataset.monthlyByYear[year]` so switching to
 * monthly/daily granularity only pays this cost once per year visited.
 * @param {object} conn - Open DuckDB connection.
 * @param {string[]} parquetPaths - Relative Parquet file paths.
 * @param {number} year - Calendar year to load.
 * @param {number} level - Numeric hierarchy level to filter to.
 * @returns {Promise<object>} Nested object keyed as
 *   `result[levelKey][region_id] -> [{ date, <daily climate vars> }, ...]`.
 */
async function loadMonthlyForYear(conn, parquetPaths, year, level) {
  const fileListSql = parquetPaths
    .map(p => `'${new URL(`data/${p}`, window.location.href).href}'`)
    .join(", ");

  const columns = await getAvailableColumns(conn, fileListSql);
  const dailyKeys = Object.keys(CLIMATE_VARS).filter(k => CLIMATE_VARS[k].daily);
  const varClauses = dailyKeys.map(key => `AVG(${buildVarExpr(columns, VAR_COLUMN_CANDIDATES[key])}) AS ${key}`);

  // GROUP BY date (not just a plain SELECT) because the daily variables can
  // come from separate per-variable parquet files (e.g. tasmax vs precip).
  // union_by_name = true concatenates those files' rows rather than joining
  // them, so the same (level, region_id, date) can appear more than once,
  // each row populated for only its own file's columns and NULL elsewhere.
  // Without this aggregation, a variable's non-null values can end up spread
  // across duplicate date rows in a way that leaves only one row where both
  // the plotted variable AND that specific date line up — which is what
  // produced charts that appeared to have just a single data point.
  const avgClauses = dailyKeys.map(
  key => `AVG(${buildVarExpr(columns, VAR_COLUMN_CANDIDATES[key])}) AS ${key}`
  );

  const sql = `
    SELECT
        level,
        region_id,
        date,
        ${avgClauses.join(",\n      ")}
    FROM read_parquet(
        [${fileListSql}],
        hive_partitioning = true,
        union_by_name = true
    )
    WHERE date LIKE '${year}%'
      AND level = ${level}
    GROUP BY
        level,
        region_id,
        date
    ORDER BY
        level,
        region_id,
        date
  `;

  const result = await conn.query(sql);
  const rows = result.toArray().map(r => r.toJSON ? r.toJSON() : r);

  const out = {};
  for (const row of rows) {
    const levelKey = `level ${row.level}`;
    if (!out[levelKey]) out[levelKey] = {};
    if (!out[levelKey][row.region_id]) out[levelKey][row.region_id] = [];
    const normDate = normalizeDateStr(row.date);
    if (normDate === undefined) continue; // couldn't parse this row's date — skip rather than corrupt the series
    const values = {};
    for (const key of dailyKeys) {
      values[key] = row[key] === null || row[key] === undefined ? undefined : Number(row[key]);
    }
    out[levelKey][row.region_id].push({
      date: normDate,
      ...values,
    });
  }
  return out;
}

// DuckDB-wasm can hand back a DATE column as a JS Date object, a
// duckdb-arrow date wrapper, an epoch-day integer, or a string with a time
// component — not always the plain "YYYY-MM-DD" string dateStrFromDayOfYear()
// produces. Without normalizing, the map's day-lookup (`r.date === targetDate`)
// silently fails to match, so every region falls back to the "no data" grey
// fill instead of its actual color. Normalize once here so downstream string
// equality checks are reliable.
function epochNumToIso(num) {
  // duckdb-arrow date columns can surface as either days-since-epoch
  // (small, e.g. ~4750-20000 for 1983-2025) or milliseconds-since-epoch
  // (large, e.g. ~4e11-1.7e12 for the same range). Guess which by magnitude
  // rather than assuming one — assuming wrong sends Date() out of range,
  // and toISOString() throws on an invalid date, which used to abort the
  // whole load partway through and truncate that year's series.
  const ms = Math.abs(num) > 1e6 ? num : num * 86400000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function normalizeDateStr(v) {
  try {
    if (v === null || v === undefined) return undefined;
    if (v instanceof Date) {
      return isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
    }
    if (typeof v === "number") return epochNumToIso(v);
    if (typeof v === "string") return v.slice(0, 10);
    // Some duckdb-arrow builds return a wrapper object with a numeric day
    // or millisecond value (e.g. { value: <n> }) instead of a plain number.
    if (typeof v === "object" && typeof v.valueOf === "function") {
      const num = v.valueOf();
      if (typeof num === "number") return epochNumToIso(num);
    }
    return String(v).slice(0, 10);
  } catch {
    // Never let one malformed row abort the whole year's load — better to
    // drop that single date than silently truncate everything after it.
    return undefined;
  }
}

/* ════════════════════════════════════════════════════════════════════
   INITIALIZATION
   ════════════════════════════════════════════════════════════════════ */

/**
 * Application entry point. Boots DuckDB, loads the default dataset,
 * sets up the map projection/scales from the level-0 geometry, computes
 * the global population extent used for population-coloring, and then
 * performs the first render. Called once on page load.
 */
async function init() {
  try {
    setStatus("Starting query engine...", "loading");
    duckdbConn = await initDuckDB();

    setStatus("Loading initial dataset...", "loading");
    await loadDataset(state.dataset);  // Load "basins" (default)

    setStatus("Ready");
  } catch (e) {
    setStatus(`⚠ Error: ${e.message}`, "error");
    hintEl.textContent = "Error initializing. Check data/ folder and manifest files.";
    console.error(e);
    return;
  }

  // Set up projection and scales
  const dataset = state.datasets[state.dataset];
  const level0GeoJSON = getLevelData(0);
  if (!level0GeoJSON) {
    setStatus(`⚠ No level 0 data found`, "error");
    return;
  }

  geoProjection = d3.geoMercator().fitSize([state.width, state.height], level0GeoJSON);
  geoPathGen = d3.geoPath().projection(geoProjection);

  // Compute population extent across all levels (used when coloring by population)
  let allPops = [];
  Object.keys(dataset.hierarchy)
    .filter(k => k.startsWith("level"))
    .forEach(levelKey => {
      dataset.hierarchy[levelKey].features.forEach(f => allPops.push(f.properties.population));
    });
  state.popExtentAll = d3.extent(allPops);

  refreshMapLayers();
  updateView();
}

function refreshMapLayers() {
  updateWaterBodies();
  updateScaleBar();
  updateCountryOutline();
}

/* ════════════════════════════════════════════════════════════════════
   RENDER FUNCTIONS
   ════════════════════════════════════════════════════════════════════ */

/**
 * Central re-render entry point: refreshes the title, basin stats,
 * breadcrumb, the currently active tab (map/table/chart/grid), and the
 * timeline readout. Call this after any change to selection state
 * (dataset, level, region, variable, date range, granularity, etc.)
 * instead of calling individual render functions directly.
 */
function updateView() {
  updateTitle();
  renderBasinStats();
  updateBreadcrumb();
  renderActiveTab();
  updateTimelineReadout();
}

function updateTimelineReadout() {
  const textEl = document.getElementById("nc-timeline-readout-text");
  if (!textEl) return;
  const dayLabel = (day) => dayOfYearFormatter(new Date(2001, 0, day));

  if (state.granularity === "monthly") {
    const isComparing = state.compareModeEnabled &&
      (state.dayRangeStart !== state.dayRangeEnd || state.yearRangeStart !== state.yearRangeEnd);
    textEl.textContent = isComparing
      ? `${dayLabel(state.dayRangeStart)}, ${state.yearRangeStart}  vs  ${dayLabel(state.dayRangeEnd)}, ${state.yearRangeEnd}`
      : `${state.yearRangeEnd} · ${dayLabel(state.mapDay)}`;
  } else {
    textEl.textContent = (state.compareModeEnabled && state.yearRangeStart !== state.yearRangeEnd)
      ? `${state.yearRangeStart} vs ${state.yearRangeEnd}`
      : `${state.yearRangeStart}\u2013${state.yearRangeEnd}`;
  }
}

/**
 * Builds an OWID-style dynamic title: "{Variable}, {Region}, {date range}"
 * e.g. "Max Temperature, River Basins, 1983 to 2025"
 *  or  "Max Temperature, River Basins, Jan 1 to Dec 31, 2001" (daily view)
 */
function updateTitle() {
  const varMeta = CLIMATE_VARS[state.climateVar] || {};
  const varLabel = varMeta.label || state.climateVar;
  const datasetLabel = datasetSelect.options[datasetSelect.selectedIndex]
    ? datasetSelect.options[datasetSelect.selectedIndex].text
    : state.dataset;

  let rangeLabel;
  if (state.granularity === "monthly") {
    const start = dayOfYearFormatter(new Date(2001, 0, state.dayRangeStart ?? 1));
    const end   = dayOfYearFormatter(new Date(2001, 0, state.dayRangeEnd ?? 365));
    rangeLabel = `${start} to ${end}, ${state.mapYear}`;
  } else {
    const start = state.yearRangeStart ?? yearRangeSliderMin?.min ?? 1983;
    const end   = state.yearRangeEnd ?? yearRangeSliderMax?.max ?? 2025;
    rangeLabel = (start === end) ? `${start}` : `${start} to ${end}`;
  }

  const regionSuffix = state.drilldownParentName ? `, ${state.drilldownParentName}` : "";
  titleEl.textContent = `${varLabel}, ${datasetLabel}${regionSuffix}, ${rangeLabel}`;
  subEl.textContent = varMeta.unit
    ? `${varMeta.diverging ? "Diverging from the reference period mean, " : ""}in ${varMeta.unit} · hover a region for its trend · click to zoom in`
    : "Hover a region for its trend · click to zoom in";
}

/**
 * Show/hide the four view panes (map, table, chart, grid) based on
 * `state.activeTab`, and render whichever one is now visible. The color
 * scale/legend is recomputed here even for non-map tabs, since the
 * legend is a persistent element shown on every tab.
 */
function renderActiveTab() {
  layoutEl.style.display     = state.activeTab === "map"   ? "flex"  : "none";
  tablePaneEl.style.display  = state.activeTab === "table" ? "block" : "none";
  chartPaneEl.classList.toggle("active-flex", state.activeTab === "chart");
  gridPaneEl.classList.toggle("active-block", state.activeTab === "grid");

  if (state.activeTab === "map") {
    renderMap(); // computes the color scale + legend as part of the map render
  } else if (state.activeTab === "grid") {
    renderYearGrid(); // computes its own shared color scale + legend
  } else {
    // Map isn't rendering (and therefore not calling computeColorScaleAndLegend),
    // but the legend is now a persistent element visible on every tab — so
    // refresh it here too, using the same dataset/level the map would use.
    const dataset = state.datasets[state.dataset];
    if (dataset) {
      const levelKey = getLevelKey(state.currentLevel);
      const visibleFeatures = getVisibleFeatures(dataset, levelKey);
      computeColorScaleAndLegend(dataset, levelKey, visibleFeatures);
    }
    if (state.activeTab === "table") renderTable();
    else renderLineChart();
  }
}

/* ── SHARED: per-region mean + linear trend for the current selection ── */

function linearRegression(pts) {
  if (pts.length < 2) return null;
  const xMean = d3.mean(pts, d => d.x);
  const yMean = d3.mean(pts, d => d.value);
  const denom = d3.sum(pts, d => (d.x - xMean) ** 2);
  const slope = denom ? d3.sum(pts, d => (d.x - xMean) * (d.value - yMean)) / denom : 0;
  const intercept = yMean - slope * xMean;
  return { slope, intercept };
}

function computeRegionSummary(regionId) {
  const series = getRegionSeries(regionId);
  const pts = seriesToPoints(series);
  const vals = pts.map(d => d.value);
  const mean = vals.length ? d3.mean(vals) : undefined;

  let trend;
  const reg = linearRegression(pts);
  if (reg) {
    trend = reg.slope * (pts[pts.length - 1].x - pts[0].x);
  }

  return { pts, mean, trend };
}

/* ── TABLE TAB ───────────────────────────────────────────────────── */

/**
 * Table tab entry point. Builds one row per currently visible region
 * (mean value + trend for the selected variable/date range), sorts them
 * per the active column sort, and renders them into #region-table.
 */
function renderTable() {
  const dataset = state.datasets[state.dataset];
  const varMeta = CLIMATE_VARS[state.climateVar];
  const levelKey = getLevelKey(state.currentLevel);
  const features = getVisibleFeatures(dataset, levelKey);

  const rangeLabel = state.granularity === "monthly"
    ? `${dayOfYearFormatter(new Date(2001, 0, state.dayRangeStart))}\u2013${dayOfYearFormatter(new Date(2001, 0, state.dayRangeEnd))}, ${state.mapYear}`
    : `${state.yearRangeStart}-${state.yearRangeEnd}`;
  const trendHeaderEl = document.getElementById("table-trend-header");
  if (trendHeaderEl) trendHeaderEl.textContent = `(${rangeLabel}) trend`;

  const rows = features.map(f => {
    const { pts, mean, trend } = computeRegionSummary(f.properties.id);
    return { feature: f, props: f.properties, pts, mean, trend };
  });

  const { key, dir } = state.tableSort;
  const sortVal = (r) => {
    if (key === "name") return r.props.name || "";
    if (key === "population") return r.props.population ?? -Infinity;
    if (key === "area_km2") return r.props.area_km2 ?? -Infinity;
    if (key === "trend") return r.trend ?? -Infinity;
    return r.mean ?? -Infinity; // "mean"
  };
  rows.sort((a, b) => {
    const av = sortVal(a), bv = sortVal(b);
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return dir === "asc" ? cmp : -cmp;
  });

  document.querySelectorAll("#region-table thead th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === key);
  });

  const drillable = canDrillDown();
  const tableDrillHintEl = document.getElementById("table-drill-hint");
  if (tableDrillHintEl) tableDrillHintEl.style.display = drillable ? "" : "none";

  tableBodyEl.innerHTML = "";
  rows.forEach(r => {
    const isExpanded = state.expandedRegionId === r.props.id;

    const tr = document.createElement("tr");
    tr.className = "region-row" + (isExpanded ? " expanded" : "") + (drillable ? " drillable" : "");
    if (drillable) tr.title = `Right-click to zoom into ${r.props.name || "this region"} · click for trend preview`;
    tr.innerHTML = `
      <td><span class="region-name-cell"><span class="expand-caret">${drillable ? "→" : "▸"}</span>${r.props.name || "Region " + r.props.id}</span></td>
      <td class="num">${r.props.population !== undefined ? Number(r.props.population).toLocaleString() : "—"}</td>
      <td class="num">${r.props.area_km2 !== undefined ? Number(r.props.area_km2).toLocaleString() : "—"}</td>
      <td class="num">${r.mean !== undefined ? r.mean.toFixed(1) + " " + varMeta.unit : "—"}</td>
      <td class="num">${trendCellHtml(r.trend, varMeta)}</td>
    `;
    // Left click always toggles the inline trend preview (never drills down,
    // even when this row is drillable) — right click is the only way to
    // zoom into subdivisions now, so a plain click can't accidentally lose
    // your place in the table.
    tr.addEventListener("click", () => {
      state.expandedRegionId = isExpanded ? null : r.props.id;
      renderTable();
    });
    // Right click drills into subdivisions (when available) instead of
    // showing the browser context menu.
    tr.addEventListener("contextmenu", (event) => {
      if (!drillable) return;
      event.preventDefault();
      drillIntoRegionId(event, features, r.props.id);
    });
    tableBodyEl.appendChild(tr);

    if (isExpanded) {
      const expandTr = document.createElement("tr");
      expandTr.className = "expand-row";
      const td = document.createElement("td");
      td.colSpan = 5;
      const contentDiv = document.createElement("div");
      contentDiv.className = "expand-content";
      td.appendChild(contentDiv);
      expandTr.appendChild(td);
      tableBodyEl.appendChild(expandTr);

      const isMonthly = state.granularity === "monthly";
      const currentX = isMonthly ? state.mapDay : state.mapYear;
      drawTrendChart(contentDiv, r.pts, varMeta, { width: 420, height: 80, highlightX: currentX,
        regionId: r.props.id
       });
    }
  });
}

function trendCellHtml(trend, varMeta) {
  if (trend === undefined || isNaN(trend)) return "—";
  const dir = trend > 0.05 ? "up" : trend < -0.05 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
  return `<span class="region-trend-mini ${dir}">${arrow} ${trend >= 0 ? "+" : ""}${trend.toFixed(2)} ${varMeta.unit}</span>`;
}

document.querySelectorAll("#region-table thead th").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.tableSort.key === key) {
      state.tableSort.dir = state.tableSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.tableSort = { key, dir: "desc" };
    }
    renderTable();
  });
});

/* ── LINE GRAPH TAB ──────────────────────────────────────────────── */

// Yearly trend view: fixed categorical palette, one solid hue per region.
const chartColorScaleYearly = d3.scaleOrdinal(d3.schemeTableau10 || d3.schemeCategory10);

// Daily (one-year) view: regions are colored along the current variable's
// own gradient interpolator instead, so the daily view reads visually
// distinct from the yearly view (a themed gradient vs. flat categorical hues).
function findSaturatedAnchor(interpolator) {
  const candidates = [0.15, 0.3, 0.7, 0.85, 0.5];
  let best = null, bestScore = -Infinity;
  for (const t of candidates) {
    const c = d3.hsl(interpolator(t));
    // reward saturation, penalize extreme lightness (too pale or too dark)
    const score = c.s - Math.abs(c.l - 0.45) * 1.5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
// One consistent region → color mapping, used by yearly compare chart,
// daily chart, legend swatches, and map hover states alike. Region colors
// are categorical (identity), not tied to variable value — only the map's
// gradient legend (buildLegend) encodes value.
const regionColorScale = d3.scaleOrdinal(d3.schemeTableau10);

function colorForRegion(regionId) {
  return regionColorScale(regionId);
}
function computeIsCompare() {
  return state.compareModeEnabled && (state.granularity === "monthly"
    ? (state.dayRangeStart !== state.dayRangeEnd || state.yearRangeStart !== state.yearRangeEnd)
    : state.yearRangeStart !== state.yearRangeEnd);
}

// The two points being compared — shared by the map's side-by-side panels,
// the chart's compare rendering, the table's A/B columns, and the basin
// stats card, so they always agree on exactly what "A" and "B" mean.
function getComparePanels() {
  const isMonthly = state.granularity === "monthly";
  return isMonthly
    ? [
        { year: state.yearRangeStart, day: state.dayRangeStart,
          label: `${dayOfYearFormatter(new Date(2001, 0, state.dayRangeStart))}, ${state.yearRangeStart}` },
        { year: state.yearRangeEnd, day: state.dayRangeEnd,
          label: `${dayOfYearFormatter(new Date(2001, 0, state.dayRangeEnd))}, ${state.yearRangeEnd}` },
      ]
    : [
        { year: state.yearRangeStart, day: state.mapDay, label: String(state.yearRangeStart) },
        { year: state.yearRangeEnd,   day: state.mapDay, label: String(state.yearRangeEnd) },
      ];
}

/**
 * Chart tab entry point. Resets zoom/mode-switch UI to its default
 * state, then dispatches to the correct chart renderer based on
 * granularity (yearly vs monthly) and whether compare mode is active:
 * a continuous single-line timeline, a two-point slope/compare chart,
 * or a side-by-side monthly compare panel.
 */
function renderLineChart() {
  const dataset = state.datasets[state.dataset];
  const levelKey = getLevelKey(state.currentLevel);
  const features = getVisibleFeatures(dataset, levelKey);

  const chartDrillHintEl = document.getElementById("chart-drill-hint");
  if (chartDrillHintEl) chartDrillHintEl.style.display = canDrillDown() ? "" : "none";

  // The zoom strip / hint / reset / back affordances only apply to the
  // single-line yearly view — hide them by default and let
  // renderLineChartSingle turn them back on when relevant, so switching
  // to compare mode or drilling down doesn't leave stale controls up.
  chartZoomHintEl.classList.remove("visible");
  chartZoomHintEl.style.display = "none";
  chartZoomResetBtn.style.display = "none";
  chartModeBackBtn.style.display = "none";

  if (computeIsCompare()) {
    if (state.granularity === "monthly") {
      renderLineChartTimelineCompareSideBySide(dataset, levelKey, features);
    } else {
      renderLineChartCompare(dataset, levelKey, features);
    }
  } else {
    renderLineChartSingle(dataset, levelKey, features);
  }
}

// Compare mode for the chart view (yearly granularity): instead of a
// continuous time series, draw a two-category "slope" chart connecting
// each region's value at panel A to its value at panel B (the same two
// points the map's side-by-side compare view uses). Yearly data is one
// point per region per year, so a two-point slope chart — rather than a
// continuous timeline — is the natural comparison here.
function renderLineChartCompare(dataset, levelKey, features) {
  const varMeta = CLIMATE_VARS[state.climateVar];
  const panels = getComparePanels();

  const regions = features.map(f => ({
    id: f.properties.id,
    name: f.properties.name || `Region ${f.properties.id}`,
    values: panels.map(p => getFillValueAt(f, dataset, levelKey, p.year, p.day)),
  })).filter(r => r.values.every(v => v !== undefined && !isNaN(v)));

  const svgEl = d3.select(chartSvgEl);
  svgEl.selectAll("*").remove();

  const plotWrap = document.getElementById("chart-plot-area");
  const width = plotWrap.clientWidth || 620;
  const height = 520;
  const margin = { top: 16, right: 90, bottom: 34, left: 46 };
  svgEl.attr("viewBox", `0 0 ${width} ${height}`);

  chartLegendEl.innerHTML = "";

  if (regions.length === 0) {
    svgEl.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "var(--text-faint)")
      .attr("font-size", 12)
      .text("No data for this selection");
    return;
  }

  const x = d3.scalePoint()
    .domain([0, 1])
    .range([margin.left, width - margin.right])
    .padding(0.5);
  const allVals = regions.flatMap(r => r.values);
  const y = d3.scaleLinear()
    .domain(d3.extent(allVals)).nice()
    .range([height - margin.bottom, margin.top]);

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).tickFormat((d, i) => panels[i].label));

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6));

  svgEl.append("text")
    .attr("x", margin.left).attr("y", 12)
    .attr("fill", "var(--text-dim)").attr("font-size", 11)
    .text(`${varMeta.label} (${varMeta.unit})`);

  const colorFor = (id) => colorForRegion(id);

  const linesG = svgEl.append("g");
  const pointsG = svgEl.append("g");
  const labelsG = svgEl.append("g");

  function applyHighlight() {
    const activeId = state.chartLockedId !== null ? state.chartLockedId : state.chartHoveredId;
    linesG.selectAll(".chart-line")
      .classed("hovered", d => d.id === activeId)
      .classed("dimmed", d => activeId !== null && d.id !== activeId);
    d3.select(chartLegendEl).selectAll(".legend-item")
      .classed("dimmed", d => activeId !== null && d.id !== activeId)
      .classed("locked", d => d.id === state.chartLockedId);
  }
  chartApplyHighlightFn = applyHighlight;
  applyHighlight();

  const lineGen = d3.line().x((d, i) => x(i)).y(d => y(d));

  linesG.selectAll(".chart-line")
    .data(regions, d => d.id)
    .enter().append("path")
    .attr("class", "chart-line")
    .attr("stroke", d => colorFor(d.id))
    .attr("d", d => lineGen(d.values))
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  regions.forEach(r => {
    pointsG.selectAll(null)
      .data(r.values.map((v, i) => ({ id: r.id, x: i, value: v })))
      .enter().append("circle")
      .attr("class", "chart-point-dot")
      .attr("cx", d => x(d.x))
      .attr("cy", d => y(d.value))
      .attr("r", 3.5)
      .attr("fill", colorFor(r.id));
  });

  // Right-edge value labels (name + value) for the panel-B endpoint, like a
  // slope-chart legend, so regions are identifiable without a hover.
  regions.forEach(r => {
    labelsG.append("text")
      .attr("x", x(1) + 8)
      .attr("y", y(r.values[1]))
      .attr("dy", "0.32em")
      .attr("fill", colorFor(r.id))
      .attr("stroke", "var(--bg)")
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("font-size", 11)
      .text(`${r.name} (${r.values[1].toFixed(1)})`);
  });

  // Legend (reuses the same markup/behavior as the single-series chart)
  const legendItems = d3.select(chartLegendEl).selectAll(".legend-item")
    .data(regions, d => d.id)
    .enter().append("div")
    .attr("class", "legend-item")
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  legendItems.append("span")
    .attr("class", "legend-swatch")
    .style("background", d => colorFor(d.id));
  legendItems.append("span")
    .attr("class", "legend-name")
    .text(d => `${d.name}: ${d.values[0].toFixed(1)} → ${d.values[1].toFixed(1)}`);
}

// Pulls a region's daily points across the compared span, restricted to
// dayRangeStart..365 in the start year and 1..dayRangeEnd in the end year
// (collapsing to the plain dayRangeStart..dayRangeEnd window when both
// years are the same). Real Date objects are used so chronology — including
// the calendar gap between the two years if they aren't adjacent — is
// accurate rather than approximated by day-of-year.
function getRegionCompareTimelineSeries(regionId, dataset, levelKey) {
  const years = state.yearRangeStart === state.yearRangeEnd
    ? [state.yearRangeStart]
    : [state.yearRangeStart, state.yearRangeEnd];

  const points = [];
  years.forEach(year => {
    const dayMin = (year === state.yearRangeStart) ? state.dayRangeStart : 1;
    const dayMax = (year === state.yearRangeEnd) ? state.dayRangeEnd : 365;
    const series = ((dataset.monthlyByYear[year] || {})[levelKey] || {})[regionId] || [];
    series.forEach(r => {
      const v = r[state.climateVar];
      if (v === undefined || isNaN(v)) return;
      const day = dayOfYearFromDateStr(r.date);
      if (day < dayMin || day > dayMax) return;
      points.push({ date: new Date(r.date), value: v });
    });
  });
  points.sort((a, b) => a.date - b.date);
  return points;
}

// Comparison mode for the chart view, daily granularity: a single
// continuous real-calendar timeline running from the start year's picked
// date (leftmost point) to the end year's picked date (rightmost point),
// rather than two separate years or a two-point dumbbell. If the two years
// aren't adjacent, the line breaks across the unloaded years in between
// instead of drawing a misleading straight diagonal.
function renderLineChartTimelineCompare(dataset, levelKey, features) {
  const varMeta = CLIMATE_VARS[state.climateVar];

  const regions = features.map(f => ({
    id: f.properties.id,
    name: f.properties.name || `Region ${f.properties.id}`,
    pts: getRegionCompareTimelineSeries(f.properties.id, dataset, levelKey),
  })).filter(r => r.pts.length > 0);

  const svgEl = d3.select(chartSvgEl);
  svgEl.selectAll("*").remove();

  const plotWrap = document.getElementById("chart-plot-area");
  const width = plotWrap.clientWidth || 620;
  const height = 520;
  const margin = { top: 16, right: 20, bottom: 34, left: 46 };
  svgEl.attr("viewBox", `0 0 ${width} ${height}`);

  chartLegendEl.innerHTML = "";

  if (regions.length === 0) {
    svgEl.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "var(--text-faint)")
      .attr("font-size", 12)
      .text("No data for this selection");
    return;
  }

  const allPts = regions.flatMap(r => r.pts);
  const x = d3.scaleTime()
    .domain(d3.extent(allPts, d => d.date))
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear()
    .domain(d3.extent(allPts, d => d.value)).nice()
    .range([height - margin.bottom, margin.top]);

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(8).tickFormat(d3.timeFormat("%b %d, %Y")));

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6));

  svgEl.append("text")
    .attr("x", margin.left).attr("y", 12)
    .attr("fill", "var(--text-dim)").attr("font-size", 11)
    .text(`${varMeta.label} (${varMeta.unit})`);

  const colorFor = (id) => colorForRegion(id);

  // Break the line across any gap bigger than ~10 days — the real gap
  // between the loaded years when they aren't adjacent — instead of
  // interpolating a straight diagonal across years with no data.
  const GAP_MS = 10 * 24 * 60 * 60 * 1000;
  const lineGen = d3.line()
    .x(d => x(d.date))
    .y(d => y(d.value))
    .defined((d, i, arr) => i === 0 || (d.date - arr[i - 1].date) <= GAP_MS);

  const linesG = svgEl.append("g");
  const pointsG = svgEl.append("g");

  function applyHighlight() {
    const activeId = state.chartLockedId !== null ? state.chartLockedId : state.chartHoveredId;
    linesG.selectAll(".chart-line")
      .classed("hovered", d => d.id === activeId)
      .classed("dimmed", d => activeId !== null && d.id !== activeId);
    d3.select(chartLegendEl).selectAll(".legend-item")
      .classed("dimmed", d => activeId !== null && d.id !== activeId)
      .classed("locked", d => d.id === state.chartLockedId);
  }
  chartApplyHighlightFn = applyHighlight;
  applyHighlight();

  linesG.selectAll(".chart-line")
    .data(regions, d => d.id)
    .enter().append("path")
    .attr("class", "chart-line")
    .attr("stroke", d => colorFor(d.id))
    .attr("d", d => lineGen(d.pts))
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  if (state.chartShowMean) {
    linesG.selectAll(".chart-mean-line")
      .data(regions, d => d.id)
      .enter().append("line")
      .attr("class", "chart-line chart-mean-line")
      .attr("x1", margin.left)
      .attr("x2", width - margin.right)
      .attr("y1", d => y(d3.mean(d.pts, p => p.value)))
      .attr("y2", d => y(d3.mean(d.pts, p => p.value)))
      .attr("stroke", d => colorFor(d.id))
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4,3")
      .attr("opacity", 0.65)
      .attr("fill", "none");
  }

  if (state.chartShowTrend) {
    linesG.selectAll(".chart-trend-line")
      .data(regions, d => d.id)
      .enter().append("line")
      .attr("class", "chart-line chart-trend-line")
      .each(function (d) {
        if (d.pts.length < 2) return;
        const pts = d.pts.map(p => ({ x: p.date.getTime(), value: p.value }));
        const reg = linearRegression(pts);
        if (!reg) return;
        const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
        d3.select(this)
          .attr("x1", x(new Date(x0))).attr("x2", x(new Date(x1)))
          .attr("y1", y(reg.slope * x0 + reg.intercept))
          .attr("y2", y(reg.slope * x1 + reg.intercept));
      })
      .attr("stroke", d => colorFor(d.id))
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "8,3")
      .attr("opacity", 0.85)
      .attr("fill", "none");
  }

  // Mark the leftmost (start date) and rightmost (end date) point per
  // region so the two compared endpoints stay identifiable at a glance.
  regions.forEach(r => {
    const endpoints = [r.pts[0], r.pts[r.pts.length - 1]];
    pointsG.selectAll(null)
      .data(endpoints.map(p => ({ id: r.id, date: p.date, value: p.value })))
      .enter().append("circle")
      .attr("class", "chart-point-dot")
      .attr("cx", d => x(d.date))
      .attr("cy", d => y(d.value))
      .attr("r", 3.5)
      .attr("fill", colorFor(r.id));
  });

  const legendItems = d3.select(chartLegendEl).selectAll(".legend-item")
    .data(regions, d => d.id)
    .enter().append("div")
    .attr("class", "legend-item")
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  legendItems.append("span")
    .attr("class", "legend-swatch")
    .style("background", d => colorFor(d.id));
  legendItems.append("span")
    .attr("class", "legend-name")
    .text(d => d.name);
}

// Side-by-side variant of the daily compare chart: instead of one
// continuous real-calendar timeline, draw two independent panels — one per
// compared year — each spanning dayRangeStart..dayRangeEnd (day-of-year) for
// that year. The y-axis is shared across both panels so magnitudes stay
// directly comparable; the x-axis (day-of-year) is independent per panel
// since the two years are not chronologically adjacent in general.
function renderLineChartTimelineCompareSideBySide(dataset, levelKey, features) {
  const varMeta = CLIMATE_VARS[state.climateVar];
  const years = [state.yearRangeStart, state.yearRangeEnd];

  // Pull each region's daily points for a single year, restricted to the
  // dayRangeStart..dayRangeEnd window, keyed by day-of-year (not Date) so
  // the two panels' x-axes align on "day N of the range" regardless of year.
  function seriesForYear(regionId, year) {
    const series = ((dataset.monthlyByYear[year] || {})[levelKey] || {})[regionId] || [];
    const pts = [];
    series.forEach(r => {
      const v = r[state.climateVar];
      if (v === undefined || isNaN(v)) return;
      const day = dayOfYearFromDateStr(r.date);
      if (day < state.dayRangeStart || day > state.dayRangeEnd) return;
      pts.push({ day, value: v, date: new Date(r.date) });
    });
    pts.sort((a, b) => a.day - b.day);
    return pts;
  }

  const panels = years.map(year => ({
    year,
    regions: features.map(f => ({
      id: f.properties.id,
      name: f.properties.name || `Region ${f.properties.id}`,
      pts: seriesForYear(f.properties.id, year),
    })).filter(r => r.pts.length > 0),
  }));

  const svgEl = d3.select(chartSvgEl);
  svgEl.selectAll("*").remove();

  const plotWrap = document.getElementById("chart-plot-area");
  const width = plotWrap.clientWidth || 620;
  const height = 520;
  const gap = 32;
  const panelWidth = (width - gap) / 2;
  const margin = { top: 28, right: 16, bottom: 34, left: 46 };
  svgEl.attr("viewBox", `0 0 ${width} ${height}`);

  chartLegendEl.innerHTML = "";

  const allRegions = panels.flatMap(p => p.regions);
  if (allRegions.length === 0) {
    svgEl.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "var(--text-faint)")
      .attr("font-size", 12)
      .text("No data for this selection");
    return;
  }

  // Shared y-domain across both panels so heights are directly comparable.
  const allVals = panels.flatMap(p => p.regions.flatMap(r => r.pts.map(pt => pt.value)));
  const y = d3.scaleLinear()
    .domain(d3.extent(allVals)).nice()
    .range([height - margin.bottom, margin.top]);

  const colorFor = (id) => colorForRegion(id);

  const linesG = svgEl.append("g");
  const pointsG = svgEl.append("g");

  function applyHighlight() {
    const activeId = state.chartLockedId !== null ? state.chartLockedId : state.chartHoveredId;
    linesG.selectAll(".chart-line")
      .classed("hovered", d => d.id === activeId)
      .classed("dimmed", d => activeId !== null && d.id !== activeId);
    d3.select(chartLegendEl).selectAll(".legend-item")
      .classed("dimmed", d => activeId !== null && d.id !== activeId)
      .classed("locked", d => d.id === state.chartLockedId);
  }
  chartApplyHighlightFn = applyHighlight;
  applyHighlight();

  panels.forEach((panel, panelIdx) => {
    const panelX0 = panelIdx === 0 ? 0 : panelWidth + gap;
    const x = d3.scaleLinear()
      .domain([state.dayRangeStart, state.dayRangeEnd])
      .range([panelX0 + margin.left, panelX0 + panelWidth - margin.right]);

    // Panel title (year)
    svgEl.append("text")
      .attr("x", panelX0 + margin.left).attr("y", 14)
      .attr("fill", "var(--text-dim)").attr("font-size", 12)
      .attr("font-weight", 600)
      .text(String(panel.year));

    svgEl.append("g")
      .attr("class", "chart-axis")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d => dayOfYearFormatter(new Date(2001, 0, d))));

    // Only the left panel gets a y-axis with labels; the right panel gets a
    // borderless axis (ticks only) so the shared scale is still legible
    // without duplicating value labels.
    if (panelIdx === 0) {
      svgEl.append("g")
        .attr("class", "chart-axis")
        .attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).ticks(6));
      svgEl.append("text")
        .attr("x", margin.left).attr("y", 28)
        .attr("fill", "var(--text-dim)").attr("font-size", 11)
        .text(`${varMeta.label} (${varMeta.unit})`);
    } else {
      svgEl.append("g")
        .attr("class", "chart-axis")
        .attr("transform", `translate(${panelX0 + margin.left},0)`)
        .call(d3.axisLeft(y).ticks(6).tickFormat(""));
    }

    // Vertical divider between panels (skip before the first panel).
    if (panelIdx > 0) {
      svgEl.append("line")
        .attr("x1", panelX0 - gap / 2).attr("x2", panelX0 - gap / 2)
        .attr("y1", margin.top).attr("y2", height - margin.bottom)
        .attr("stroke", "var(--border)").attr("stroke-width", 1);
    }

    const lineGen = d3.line().x(d => x(d.day)).y(d => y(d.value));

    linesG.selectAll(`.chart-line-p${panelIdx}`)
      .data(panel.regions, d => d.id)
      .enter().append("path")
      .attr("class", "chart-line")
      .attr("data-panel", panelIdx)
      .attr("stroke", d => colorFor(d.id))
      .attr("d", d => lineGen(d.pts))
      .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
      .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
      .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

    if (state.chartShowMean) {
      linesG.selectAll(null)
        .data(panel.regions, d => d.id)
        .enter().append("line")
        .attr("class", "chart-line chart-mean-line")
        .attr("x1", panelX0 + margin.left).attr("x2", panelX0 + panelWidth - margin.right)
        .attr("y1", d => y(d3.mean(d.pts, p => p.value)))
        .attr("y2", d => y(d3.mean(d.pts, p => p.value)))
        .attr("stroke", d => colorFor(d.id))
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "4,3")
        .attr("opacity", 0.65)
        .attr("fill", "none");
    }

    if (state.chartShowTrend) {
      linesG.selectAll(null)
        .data(panel.regions, d => d.id)
        .enter().append("line")
        .attr("class", "chart-line chart-trend-line")
        .each(function (d) {
          if (d.pts.length < 2) return;
          const pts = d.pts.map(p => ({ x: p.day, value: p.value }));
          const reg = linearRegression(pts);
          if (!reg) return;
          const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
          d3.select(this)
            .attr("x1", x(x0)).attr("x2", x(x1))
            .attr("y1", y(reg.slope * x0 + reg.intercept))
            .attr("y2", y(reg.slope * x1 + reg.intercept));
        })
        .attr("stroke", d => colorFor(d.id))
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "8,3")
        .attr("opacity", 0.85)
        .attr("fill", "none");
    }

    panel.regions.forEach(r => {
      const endpoints = [r.pts[0], r.pts[r.pts.length - 1]];
      pointsG.selectAll(null)
        .data(endpoints.map(p => ({ id: r.id, day: p.day, value: p.value })))
        .enter().append("circle")
        .attr("class", "chart-point-dot")
        .attr("cx", d => x(d.day))
        .attr("cy", d => y(d.value))
        .attr("r", 3.5)
        .attr("fill", colorFor(r.id));
    });
  });

  // One legend, shared across both panels (regions are the same set).
  const legendItems = d3.select(chartLegendEl).selectAll(".legend-item")
    .data(features.map(f => ({ id: f.properties.id, name: f.properties.name || `Region ${f.properties.id}` })), d => d.id)
    .enter().append("div")
    .attr("class", "legend-item")
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  legendItems.append("span")
    .attr("class", "legend-swatch")
    .style("background", d => colorFor(d.id));
  legendItems.append("span")
    .attr("class", "legend-name")
    .text(d => d.name);
}

function renderLineChartSingle(dataset, levelKey, features) {
  const varMeta = CLIMATE_VARS[state.climateVar];
  const regions = features.map(f => ({
    id: f.properties.id,
    name: f.properties.name || `Region ${f.properties.id}`,
    pts: seriesToPoints(getRegionSeries(f.properties.id)),
  })).filter(r => r.pts.length > 0);

  const svgEl = d3.select(chartSvgEl);
  svgEl.selectAll("*").remove();

  const plotWrap = document.getElementById("chart-plot-area");
  const width = plotWrap.clientWidth || 620;
  const height = 460;
  const margin = { top: 16, right: 20, bottom: 34, left: 46 };
  svgEl.attr("viewBox", `0 0 ${width} ${height}`);

  chartLegendEl.innerHTML = "";

  const isMonthly = state.granularity === "monthly";

  if (isMonthly) {
    chartModeBackBtn.style.display = chartZoomAutoSwitched ? "" : "none";
  }

  if (regions.length === 0) {
    svgEl.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "var(--text-faint)")
      .attr("font-size", 12)
      .text("No data for this selection");
    return;
  }

  const allPts = regions.flatMap(r => r.pts);
  const fullXExtent = d3.extent(allPts, d => d.x);
  const fullYExtent = d3.extent(allPts, d => d.value);
  // Clamp the remembered zoom window to the current data's actual extent
  // (e.g. after a dataset switch) rather than trusting it blindly. The
  // window covers both axes — a ctrl-drag rectangle zooms into whatever
  // x/y box was selected, not just a time range.
  let xDomain = fullXExtent;
  let yDomain = null;
  const activeZoomWindow = getChartZoomWindow();
  if (activeZoomWindow) {
    const start = Math.max(fullXExtent[0], activeZoomWindow.start);
    const end = Math.min(fullXExtent[1], activeZoomWindow.end);
    const yMin = Math.max(fullYExtent[0], activeZoomWindow.yMin);
    const yMax = Math.min(fullYExtent[1], activeZoomWindow.yMax);
    if (start < end && yMin < yMax) {
      xDomain = [start, end];
      yDomain = [yMin, yMax];
    } else {
      setChartZoomWindow(null);
    }
  }
  const x = d3.scaleLinear()
    .domain(xDomain)
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear()
    .domain(yDomain || fullYExtent)
    .range([height - margin.bottom, margin.top]);
  if (!yDomain) y.nice(); // full view: round to nice ticks; a zoomed selection stays exact

  // Clip plotted content to the axes box so a zoomed-in window never lets
  // lines/points bleed out past the margins.
  svgEl.append("clipPath")
    .attr("id", "chart-plot-clip")
    .append("rect")
    .attr("x", margin.left).attr("y", margin.top)
    .attr("width", Math.max(0, width - margin.left - margin.right))
    .attr("height", Math.max(0, height - margin.top - margin.bottom));

  const dayFormatter = d3.timeFormat("%b %d");
  const xAxisFormat = isMonthly ? (day) => dayFormatter(new Date(2001, 0, day)) : d3.format("d");

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("id", "chart-axis-x")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(isMonthly ? 10 : 10).tickFormat(xAxisFormat));

  svgEl.append("g")
    .attr("class", "chart-axis")
    .attr("id", "chart-axis-y")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6));

  svgEl.append("text")
    .attr("x", margin.left).attr("y", 12)
    .attr("fill", "var(--text-dim)").attr("font-size", 11)
    .text(`${varMeta.label} (${varMeta.unit})`);

  const lineGen = d3.line().x(d => x(d.x)).y(d => y(d.value)).curve(d3.curveMonotoneX);

  const colorFor = (id) => colorForRegion(id);

  const linesG = svgEl.append("g").attr("clip-path", "url(#chart-plot-clip)");
  const pointsG = svgEl.append("g").attr("clip-path", "url(#chart-plot-clip)");

  function applyHighlight() {
    const activeId = state.chartLockedId !== null ? state.chartLockedId : state.chartHoveredId;
    linesG.selectAll(".chart-line")
      .classed("hovered", d => d.id === activeId)
      .classed("dimmed", d => activeId !== null && d.id !== activeId);
    d3.select(chartLegendEl).selectAll(".legend-item")
      .classed("dimmed", d => activeId !== null && d.id !== activeId)
      .classed("locked", d => d.id === state.chartLockedId);
  }
  chartApplyHighlightFn = applyHighlight;
  applyHighlight();

  linesG.selectAll(".chart-line")
    .data(regions, d => d.id)
    .enter().append("path")
    .attr("class", "chart-line")
    .attr("stroke", d => colorFor(d.id))
    .attr("d", d => lineGen(d.pts))
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  pointsG.selectAll(".chart-point-dot")
  .data(
    regions.flatMap(r =>
      r.pts.length === 1
        ? [{
            region: r.id,
            x: r.pts[0].x,
            value: r.pts[0].value
          }]
        : []
    )
  )
  .enter()
  .append("circle")
  .attr("class", "chart-point-dot")
  .attr("cx", d => x(d.x))
  .attr("cy", d => y(d.value))
  .attr("r", 3)
  .attr("fill", d => colorFor(d.region));


  if (state.chartShowMean) {
    linesG.selectAll(".chart-mean-line")
      .data(regions, d => d.id)
      .enter().append("line")
      .attr("class", "chart-line chart-mean-line")
      .attr("x1", margin.left)
      .attr("x2", width - margin.right)
      .attr("y1", d => y(d3.mean(d.pts, p => p.value)))
      .attr("y2", d => y(d3.mean(d.pts, p => p.value)))
      .attr("stroke", d => colorFor(d.id))
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4,3")
      .attr("opacity", 0.65)
      .attr("fill", "none");
  }

  if (state.chartShowTrend) {
    linesG.selectAll(".chart-trend-line")
      .data(regions, d => d.id)
      .enter().append("line")
      .attr("class", "chart-line chart-trend-line")
      .each(function (d) {
        const reg = linearRegression(d.pts);
        if (!reg || d.pts.length < 2) return;
        const x0 = d.pts[0].x, x1 = d.pts[d.pts.length - 1].x;
        d3.select(this)
          .attr("x1", x(x0)).attr("x2", x(x1))
          .attr("y1", y(reg.slope * x0 + reg.intercept))
          .attr("y2", y(reg.slope * x1 + reg.intercept));
      })
      .attr("stroke", d => colorFor(d.id))
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "8,3")
      .attr("opacity", 0.85)
      .attr("fill", "none");
  }

  const playheadX = x(
    isMonthly
      ? state.mapDay
      : state.mapYear
  );

  svgEl.append("line")
    .attr("class", "chart-playhead-line")
    .attr("clip-path", "url(#chart-plot-clip)")
    .attr("x1", playheadX)
    .attr("x2", playheadX)
    .attr("y1", margin.top)
    .attr("y2", height - margin.bottom);


  const playheadDots = [];

for (const region of regions) {

  const pt = region.pts.find(p =>
    p.x === (isMonthly ? state.mapDay : state.mapYear)
  );

  if (!pt) continue;

  playheadDots.push({
    region: region.id,
    x: pt.x,
    value: pt.value
  });
}

svgEl.append("g")
  .attr("clip-path", "url(#chart-plot-clip)")
  .selectAll(".chart-playhead-dot")
  .data(playheadDots)
  .enter()
  .append("circle")
  .attr("class", "chart-playhead-dot")
  .attr("cx", d => x(d.x))
  .attr("cy", d => y(d.value))
  .attr("r", 4)
  .attr("fill", d => colorFor(d.region));

  // Rescale everything already on the chart to a new x AND y domain —
  // used to animate the ctrl-drag rectangle zoom. Cheap (no data refetch,
  // no DOM rebuild) since yearly points are already all loaded; this is
  // called on every tick of the zoom-in motion, then once more at rest.
  function rescaleChart(newX, newY) {
    const newLineGen = d3.line().x(d => newX(d.x)).y(d => newY(d.value)).curve(d3.curveMonotoneX);
    linesG.selectAll(".chart-line").attr("d", d => newLineGen(d.pts));
    linesG.selectAll(".chart-mean-line")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", d => newY(d3.mean(d.pts, p => p.value)))
      .attr("y2", d => newY(d3.mean(d.pts, p => p.value)));
    linesG.selectAll(".chart-trend-line").each(function (d) {
      const reg = linearRegression(d.pts);
      if (!reg || d.pts.length < 2) return;
      const x0 = d.pts[0].x, x1 = d.pts[d.pts.length - 1].x;
      d3.select(this)
        .attr("x1", newX(x0)).attr("x2", newX(x1))
        .attr("y1", newY(reg.slope * x0 + reg.intercept))
        .attr("y2", newY(reg.slope * x1 + reg.intercept));
    });
    pointsG.selectAll(".chart-point-dot").attr("cx", d => newX(d.x)).attr("cy", d => newY(d.value));
    svgEl.select("#chart-axis-x").call(d3.axisBottom(newX).ticks(10).tickFormat(xAxisFormat));
    svgEl.select("#chart-axis-y").call(d3.axisLeft(newY).ticks(6));
    const newPlayheadX = newX(isMonthly ? state.mapDay : state.mapYear);
    svgEl.select(".chart-playhead-line").attr("x1", newPlayheadX).attr("x2", newPlayheadX);
    svgEl.selectAll(".chart-playhead-dot").attr("cx", d => newX(d.x)).attr("cy", d => newY(d.value));
  }

  setupChartRectZoom({ svgEl, x, y, width, height, margin, fullXExtent, fullYExtent, rescaleChart, isMonthly });
  // Legend
  const legendItems = d3.select(chartLegendEl).selectAll(".legend-item")
    .data(regions, d => d.id)
    .enter().append("div")
    .attr("class", "legend-item")
    .on("mouseenter", (e, d) => { state.chartHoveredId = d.id; applyHighlight(); })
    .on("mouseleave", () => { state.chartHoveredId = null; applyHighlight(); })
    .on("click", (e, d) => { e.stopPropagation(); toggleChartLock(d.id); })
    .on("dblclick", (e, d) => { e.stopPropagation(); drillIntoRegionId(e, features, d.id); });

  legendItems.append("span")
    .attr("class", "legend-swatch")
    .style("background", d => colorFor(d.id));
  legendItems.append("span")
    .attr("class", "legend-name")
    .text(d => d.name);
}

// Ctrl-drag-to-zoom directly on the main yearly chart: hold Ctrl and drag
// a rectangle over the plot to zoom into exactly that x/y box (independent
// axes — an x-heavy or y-heavy rectangle zooms accordingly, not locked to
// a fixed aspect ratio). A transparent capture rect sits on top of the
// chart and only accepts pointer events while Ctrl is held (see
// chartCtrlHeld / .ctrl-zoom-active), so normal hover/click/dblclick
// gestures on the lines and legend are completely undisturbed otherwise.
function setupChartRectZoom({ svgEl, x, y, width, height, margin, fullXExtent, fullYExtent, rescaleChart, isMonthly }) {
  const activeWindow = getChartZoomWindow();
  chartZoomHintEl.style.display = "";
  chartZoomResetBtn.style.display = activeWindow ? "" : "none";
  // chartModeBackBtn ("← back to yearly") only ever makes sense once
  // already in monthly/daily mode — the caller sets it there based on
  // chartZoomAutoSwitched; in yearly mode it's always hidden.
  if (!isMonthly) chartModeBackBtn.style.display = "none";
  updateChartZoomHint(activeWindow ? (activeWindow.end - activeWindow.start) : Infinity, isMonthly);

  const boxX0 = margin.left, boxX1 = width - margin.right;
  const boxY0 = margin.top, boxY1 = height - margin.bottom;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const capture = svgEl.append("rect")
    .attr("class", "chart-zoom-capture")
    .attr("x", boxX0).attr("y", boxY0)
    .attr("width", Math.max(0, boxX1 - boxX0))
    .attr("height", Math.max(0, boxY1 - boxY0));

  let dragging = false;
  let startPx = null; // {x, y} in svg viewBox units
  let selectRect = null;

  function svgPoint(event) {
    const [px, py] = d3.pointer(event, svgEl.node());
    return { x: clamp(px, boxX0, boxX1), y: clamp(py, boxY0, boxY1) };
  }

  capture.on("mousedown", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    dragging = true;
    startPx = svgPoint(event);
    selectRect = svgEl.append("rect")
      .attr("class", "chart-zoom-select-rect")
      .attr("x", startPx.x).attr("y", startPx.y)
      .attr("width", 0).attr("height", 0);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  function onMove(event) {
    if (!dragging) return;
    const p = svgPoint(event);
    const rx = Math.min(p.x, startPx.x), ry = Math.min(p.y, startPx.y);
    const rw = Math.abs(p.x - startPx.x), rh = Math.abs(p.y - startPx.y);
    selectRect.attr("x", rx).attr("y", ry).attr("width", rw).attr("height", rh);
  }

  function onUp(event) {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const p = svgPoint(event);
    const rx0 = Math.min(p.x, startPx.x), rx1 = Math.max(p.x, startPx.x);
    const ry0 = Math.min(p.y, startPx.y), ry1 = Math.max(p.y, startPx.y);
    const rect = selectRect;
    selectRect = null;
    if (rx1 - rx0 < CHART_ZOOM_MIN_DRAG_PX || ry1 - ry0 < CHART_ZOOM_MIN_DRAG_PX) {
      // Too small to be an intentional drag — just a ctrl-click. Discard.
      rect.remove();
      return;
    }

    let start = Math.max(fullXExtent[0], Math.min(fullXExtent[1], x.invert(rx0)));
    let end = Math.max(fullXExtent[0], Math.min(fullXExtent[1], x.invert(rx1)));
    let yMax = Math.max(fullYExtent[0], Math.min(fullYExtent[1], y.invert(ry0))); // pixel-top = higher value
    let yMin = Math.max(fullYExtent[0], Math.min(fullYExtent[1], y.invert(ry1)));
    if (end - start < 1e-6 || yMax - yMin < 1e-6) { rect.remove(); return; }

    rect.transition().duration(180).style("opacity", 0).remove();

    // Motion design: animate the current x/y domains smoothly into the
    // selected rectangle, redrawing lines/points/axes on every tick.
    const interpX = d3.interpolate(x.domain(), [start, end]);
    const interpY = d3.interpolate(y.domain(), [yMin, yMax]);
    d3.transition().duration(CHART_ZOOM_ANIM_MS).ease(d3.easeCubicInOut)
      .tween("chartRectZoom", () => (t) => {
        const nx = d3.scaleLinear().domain(interpX(t)).range(x.range());
        const ny = d3.scaleLinear().domain(interpY(t)).range(y.range());
        rescaleChart(nx, ny);
      })
      .on("end", () => {
        setChartZoomWindow({ start, end, yMin, yMax });
        chartZoomResetBtn.style.display = "";
        const span = end - start;
        updateChartZoomHint(span, isMonthly);
        // The zoom-crosses-into-daily-detail auto-switch only makes sense
        // when zooming the *yearly* chart — in monthly/daily mode we're
        // already at day-of-year resolution, so just settle the zoom.
        if (!isMonthly && span <= CHART_ZOOM_DAILY_IN_THRESHOLD_YEARS) {
          chartZoomSwitchTimer = setTimeout(() => {
            switchChartToDailyModeForYear(Math.round(end));
          }, CHART_ZOOM_SETTLE_DELAY_MS);
        } else {
          // Re-render fully so axes/ticks/clip and the next drag's scale
          // references reflect the settled zoom window exactly.
          renderActiveTab();
        }
      });
  }
}

function updateChartZoomHint(span, isMonthly) {
  const activeWindow = getChartZoomWindow();
  if (!isMonthly && span <= CHART_ZOOM_DAILY_IN_THRESHOLD_YEARS) {
    chartZoomHintEl.textContent = "Zooming in on daily detail…";
  } else if (!isMonthly && span <= CHART_ZOOM_DAILY_HINT_THRESHOLD_YEARS) {
    chartZoomHintEl.textContent = "Zoom in further for daily detail";
  } else if (activeWindow) {
    chartZoomHintEl.textContent = "Ctrl + drag to zoom further · Reset zoom to zoom back out";
  } else {
    chartZoomHintEl.textContent = "Hold Ctrl and drag a box on the chart to zoom in";
  }
  chartZoomHintEl.classList.add("visible");
}

function getFillValueAt(feature, dataset, levelKey, year, day) {
  if (state.colorBy === "population") return feature.properties.population;

  if (state.granularity === "monthly") {
    const regionSeries = ((dataset.monthlyByYear[year] || {})[levelKey] || {})[feature.properties.id] || [];
    const targetDate = dateStrFromDayOfYear(year, day);
    const match = regionSeries.find(r => r.date === targetDate);
    return match ? match[state.climateVar] : undefined;
  }

  const series = (dataset.yearlyByLevel[levelKey] || {})[feature.properties.id] || [];
  const match = series.find(r => r.year === year);
  return match ? match[state.climateVar] : undefined;
}

function getFillValue(feature, dataset, levelKey) {
  return getFillValueAt(feature, dataset, levelKey, state.mapYear, state.mapDay);
}

// Always reads day-by-day data for one fixed year, regardless of the
// global Period dropdown (state.granularity). getFillValueAt only looks
// at daily data when granularity === "monthly", which is right for the
// main map/table/chart views but wrong for the grid's hover-to-animate
// and maximize players: those should show daily change for the clicked
// year even while the dropdown is still set to "Yearly trend".
function getDailyFillValueAt(feature, dataset, levelKey, year, day) {
  if (state.colorBy === "population") return feature.properties.population;
  const regionSeries = ((dataset.monthlyByYear[year] || {})[levelKey] || {})[feature.properties.id] || [];
  const targetDate = dateStrFromDayOfYear(year, day);
  const match = regionSeries.find(r => r.date === targetDate);
  return match ? match[state.climateVar] : undefined;
}

function computeColorScaleAndLegend(dataset, levelKey, visibleFeatures) {
  if (state.colorBy === "population") {
    const extent = state.popExtentAll || [0, 1];
    colorScale = d3.scaleSequential().domain(extent)
      .interpolator(d3.interpolateRgbBasis(POPULATION_PALETTE));
    buildLegend(extent, { mode: "population" });
    return;
  }

  const varMeta = CLIMATE_VARS[state.climateVar];
  const vals = [];
  const visibleIds = new Set((visibleFeatures || []).map(f => f.properties.id));

  if (state.granularity === "monthly") {
    // Domain spans the selected day-range within the loaded year(s) so a
    // hot/wet day stands out against that window. When two different
    // years are selected (cross-year daily compare), pull from both
    // years' loaded data so the shared color scale is fair to whichever
    // year runs hotter/wetter, instead of only reflecting one of them.
    const yearsToScan = state.yearRangeStart === state.yearRangeEnd
      ? [state.yearRangeStart]
      : [state.yearRangeStart, state.yearRangeEnd];
    yearsToScan.forEach(yr => {
      const levelData = (dataset.monthlyByYear[yr] || {})[levelKey] || {};
      Object.entries(levelData).forEach(([regionId, series]) => {
        if (visibleIds.size && !visibleIds.has(regionId)) return;
        series.forEach(r => {
          if (r[state.climateVar] === undefined) return;
          if (!isDayInRange(dayOfYearFromDateStr(r.date))) return;
          vals.push(r[state.climateVar]);
        });
      });
    });
  } else {
    Object.entries(dataset.yearlyByLevel[levelKey] || {}).forEach(([regionId, series]) => {
      if (visibleIds.size && !visibleIds.has(regionId)) return;
      series.forEach(r => {
        if (r[state.climateVar] === undefined) return;
        if (!isYearInRange(r.year)) return;
        vals.push(r[state.climateVar]);
      });
    });
  }

  const extent = vals.length ? d3.extent(vals) : [0, 1];

  // Power exponent < 1 biases the color mapping toward the more saturated
  // end of the interpolator, instead of spending a linear share of the
  // range on the pale near-white colors most sequential/diverging d3
  // interpolators start/center on. Net effect: more visible contrast
  // between regions for the same underlying data spread. Tune this one
  // number if colors ever look too contrasty/artificial in the other
  // direction (closer to 1 = more linear/subtle, further from 1 = punchier).
  const CONTRAST_EXPONENT = 0.6;

  if (varMeta.diverging && varMeta.fixedDomain) {
    // Fixed diverging scale anchored to real observed percentiles, not a
    // guessed range. fixedDomain is [p1, median, p99] — using the median
    // as the midpoint (not the arithmetic mean of min/max) means the color
    // scale's white/neutral point sits where the bulk of the data actually
    // is, so a skewed distribution still gets good contrast on both sides
    // instead of being lopsided toward one color.
    const [domMin, domMid, domMax] = varMeta.fixedDomain;
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT)
      .domain([domMin, domMid, domMax]);
    buildLegend([domMin, domMax], { mode: "variable", varMeta });
  } else if (varMeta.diverging) {
    // Center the scale on 0 (e.g. SPI/SPEI are z-scores: negative = dry, positive = wet)
    const maxAbs = Math.max(Math.abs(extent[0]), Math.abs(extent[1]), 0.5);
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT)
      .domain([-maxAbs, 0, maxAbs]);
    buildLegend([-maxAbs, maxAbs], { mode: "variable", varMeta });
  } else if (varMeta.fixedDomain) {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT)
      .domain(varMeta.fixedDomain);
    buildLegend(varMeta.fixedDomain, { mode: "variable", varMeta });
  } else {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT)
      .domain(extent);
    buildLegend(extent, { mode: "variable", varMeta });
  }
}

/**
 * Map tab entry point. Computes the color scale/legend for the current
 * selection, then dispatches to either the single full-size map
 * (renderMapSingle) or the two-panel side-by-side compare view
 * (renderMapCompare) depending on whether compare mode is active and
 * the selected date range actually spans two distinct points.
 */
function renderMap() {
  const dataset = state.datasets[state.dataset];
  const levelKey = getLevelKey(state.currentLevel);
  const geojson = dataset.hierarchy[levelKey];
  if (!geojson) return;

  const visibleFeatures = getVisibleFeatures(dataset, levelKey);
  computeColorScaleAndLegend(dataset, levelKey, visibleFeatures);

  const isCompare = state.compareModeEnabled && (state.granularity === "monthly"
    ? (state.dayRangeStart !== state.dayRangeEnd || state.yearRangeStart !== state.yearRangeEnd)
    : state.yearRangeStart !== state.yearRangeEnd);

  if (isCompare) {
    renderMapCompare(dataset, levelKey, visibleFeatures);
  } else {
    renderMapSingle(dataset, levelKey, visibleFeatures);
  }

  // The water/country context layers are drawn for the full-size single
  // map only — the two compare panels are a simpler side-by-side color
  // comparison without the overlaid full-size river/outline geometry.
  waterLayer.style("display", isCompare ? "none" : null);
  countryLayer.style("display", isCompare ? "none" : null);

  // Re-renders here (variable change, tab switch back to Map, granularity
  // toggle, etc.) rebuild the region paths from scratch but must not
  // disturb the user's current pan/zoom — reassert the last known
  // transform. Cheap and idempotent when nothing has actually moved;
  // zoomIntoFeature/zoomOut/reset intentionally update savedMapTransform
  // themselves (via the zoom behavior's own "zoom" event) before this runs.
  if (!isCompare) {
    svg.call(zoomBehavior.transform, savedMapTransform);
  }
}

function renderMapSingle(dataset, levelKey, visibleFeatures) {
  compareLayer.selectAll("*").remove();
  regionsLayer.style("display", null);

  const paths = regionsLayer.selectAll(".region-path")
    .data(visibleFeatures, d => d.properties.id);

  paths.exit().remove();

  paths.enter()
    .append("path")
    .attr("class", "region-path")
    .attr("d", d => geoPathGen(d))
    .merge(paths)
    .attr("d", d => geoPathGen(d))
    .attr("fill", d => {
      const v = getFillValue(d, dataset, levelKey);
      return v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v);
    })
    .on("mouseenter", onRegionEnter)
    .on("mousemove", onRegionMove)
    .on("mouseleave", onRegionLeave)
    .on("click", onRegionClick);
}

// Renders two smaller maps side by side — a "before" snapshot and an
// "after" snapshot — sharing one color scale (computed across the whole
// selected window by computeColorScaleAndLegend, not just these two
// points) so the two panels stay visually comparable.
function renderMapCompare(dataset, levelKey, visibleFeatures) {
  regionsLayer.selectAll("*").remove();
  regionsLayer.style("display", "none");
  compareLayer.selectAll("*").remove();

  const panels = getComparePanels();

  const panelScale = 0.46;
  const panelGapFrac = 0.06;
  const panelXs = [0, state.width * (panelScale + panelGapFrac)];

  panels.forEach((panel, i) => {
    const g = compareLayer.append("g")
      .attr("transform", `translate(${panelXs[i]},18) scale(${panelScale})`);

    g.selectAll(".region-path")
      .data(visibleFeatures, d => d.properties.id)
      .enter().append("path")
      .attr("class", "region-path")
      .attr("d", d => geoPathGen(d))
      .attr("fill", d => {
        const v = getFillValueAt(d, dataset, levelKey, panel.year, panel.day);
        return v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v);
      })
      .on("mouseenter", onRegionEnter)
      .on("mousemove", onRegionMove)
      .on("mouseleave", onRegionLeave)
      .on("click", onRegionClick);

    compareLayer.append("text")
      .attr("x", panelXs[i] + (state.width * panelScale) / 2)
      .attr("y", 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 13)
      .attr("font-weight", 650)
      .attr("fill", "var(--text)")
      .text(panel.label);
  });

  compareLayer.append("line")
    .attr("x1", state.width / 2).attr("x2", state.width / 2)
    .attr("y1", 0).attr("y2", state.height)
    .attr("stroke", "var(--border)")
    .attr("stroke-width", 1);
}

/* ── YEAR GRID TAB (static 12-tile grid — one map snapshot per year) ──
   Picks 12 evenly-spaced years across the full dataset span and draws a
   small static map for each, all sharing ONE color scale (built from the
   values across all 12 years) so tiles are honestly comparable side by
   side — unlike the single map view, this never re-scales per tile. */

function gridTileCount(min, max) {
  // Fewer tiles for narrower selected ranges, so tiles stay meaningfully
  // spaced apart instead of crowding years right on top of each other.
  const span = max - min;
  if (span < 10) return 4;
  if (span < 30) return 9;
  return 12;
}

function pickGridYears(n) {
  // Respects the user's selected year-range (state.yearRangeStart/End)
  // rather than the full dataset span, and — unless a tile count is
  // explicitly passed — picks that count based on how narrow the
  // selected range is (see gridTileCount).
  const min = state.yearRangeStart ?? YEAR_RANGE.min;
  const max = state.yearRangeEnd ?? YEAR_RANGE.max;
  const span = max - min;
  const count = Math.max(1, n || gridTileCount(min, max));
  const years = [];
  for (let i = 0; i < count; i++) {
    years.push(count === 1 ? min : Math.round(min + (i * span) / (count - 1)));
  }
  return [...new Set(years)]; // guard against duplicate rounds on tiny ranges
}

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Day-of-year (1-based) for the 1st of a given calendar month.
function monthStartDayOfYear(year, monthIndex) {
  return Math.round((Date.UTC(year, monthIndex, 1) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

// Same shape as computeGridColorScale, but keyed on a fixed year and a set
// of specific days-of-year (the 1st of each month) instead of a spread of
// years — used by the single-year grid view's 12 month tiles so the shared
// color scale actually reflects the daily values being shown, rather than
// each year's annual mean.
function computeGridColorScaleForMonths(dataset, levelKey, visibleFeatures, year, days) {
  if (state.colorBy === "population") {
    const extent = state.popExtentAll || [0, 1];
    colorScale = d3.scaleSequential().domain(extent)
      .interpolator(d3.interpolateRgbBasis(POPULATION_PALETTE));
    buildLegend(extent, { mode: "population" });
    return;
  }

  const varMeta = CLIMATE_VARS[state.climateVar];
  const vals = [];
  days.forEach(day => {
    visibleFeatures.forEach(f => {
      const v = getFillValueAt(f, dataset, levelKey, year, day);
      if (v !== undefined && !isNaN(v)) vals.push(v);
    });
  });
  const extent = vals.length ? d3.extent(vals) : [0, 1];
  const CONTRAST_EXPONENT = 0.6;

  if (varMeta.diverging && varMeta.fixedDomain) {
    const [domMin, domMid, domMax] = varMeta.fixedDomain;
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain([domMin, domMid, domMax]);
    buildLegend([domMin, domMax], { mode: "variable", varMeta });
  } else if (varMeta.diverging) {
    const maxAbs = Math.max(Math.abs(extent[0]), Math.abs(extent[1]), 0.5);
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain([-maxAbs, 0, maxAbs]);
    buildLegend([-maxAbs, maxAbs], { mode: "variable", varMeta });
  } else if (varMeta.fixedDomain) {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain(varMeta.fixedDomain);
    buildLegend(varMeta.fixedDomain, { mode: "variable", varMeta });
  } else {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain(extent);
    buildLegend(extent, { mode: "variable", varMeta });
  }
}

function computeGridColorScale(dataset, levelKey, visibleFeatures, years) {
  if (state.colorBy === "population") {
    const extent = state.popExtentAll || [0, 1];
    colorScale = d3.scaleSequential().domain(extent)
      .interpolator(d3.interpolateRgbBasis(POPULATION_PALETTE));
    buildLegend(extent, { mode: "population" });
    return;
  }

  const varMeta = CLIMATE_VARS[state.climateVar];
  const vals = [];
  years.forEach(yr => {
    const series = (dataset.yearlyByLevel[levelKey] || {});
    visibleFeatures.forEach(f => {
      const regionSeries = series[f.properties.id] || [];
      const match = regionSeries.find(r => r.year === yr);
      if (match && match[state.climateVar] !== undefined && !isNaN(match[state.climateVar])) {
        vals.push(match[state.climateVar]);
      }
    });
  });
  const extent = vals.length ? d3.extent(vals) : [0, 1];
  const CONTRAST_EXPONENT = 0.6;

  if (varMeta.diverging && varMeta.fixedDomain) {
    const [domMin, domMid, domMax] = varMeta.fixedDomain;
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain([domMin, domMid, domMax]);
    buildLegend([domMin, domMax], { mode: "variable", varMeta });
  } else if (varMeta.diverging) {
    const maxAbs = Math.max(Math.abs(extent[0]), Math.abs(extent[1]), 0.5);
    colorScale = d3.scaleDivergingPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain([-maxAbs, 0, maxAbs]);
    buildLegend([-maxAbs, maxAbs], { mode: "variable", varMeta });
  } else if (varMeta.fixedDomain) {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain(varMeta.fixedDomain);
    buildLegend(varMeta.fixedDomain, { mode: "variable", varMeta });
  } else {
    colorScale = d3.scaleSequentialPow(varMeta.interpolator)
      .exponent(CONTRAST_EXPONENT).domain(extent);
    buildLegend(extent, { mode: "variable", varMeta });
  }
}

/* ── YEAR ANIMATION ENGINE (hover-to-animate grid tiles + fullscreen player) ──
   Drives the same renderer/data path as the static grid tiles and the main
   map — this just steps `day` 1..365/366 for one fixed year and repaints
   existing <path> fills in place, using the grid's shared color scale.
   Real-time in-DOM playback (no pre-rendered video, no separate pipeline),
   throttled to a fixed rate (12 days/sec) via a timestamp-checked rAF loop
   so it stays correct even if the tab is briefly throttled. */

const YEAR_ANIM_FPS = 12;
const activeYearAnimations = new Map(); // container element -> anim state

function daysInYear(year) {
  return Math.round((Date.UTC(year, 11, 31) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

function isVariableDaily() {
  const varMeta = CLIMATE_VARS[state.climateVar];
  return !!(varMeta && varMeta.daily);
}

function stopYearAnimation(container) {
  const anim = activeYearAnimations.get(container);
  if (!anim) return;
  if (anim.rafId) cancelAnimationFrame(anim.rafId);
  activeYearAnimations.delete(container);
  anim.paths.forEach((path, regionId) => {
    const original = anim.originalFill.get(regionId);
    if (original !== undefined) path.setAttribute("fill", original);
  });
  if (anim.dayLabelEl) {
    anim.dayLabelEl.textContent = "";
    anim.dayLabelEl.style.display = "none";
    anim.dayLabelEl.classList.remove("grid-tile-nodaily-note");
  }
  container.classList.remove("nc-animating", "nc-loading", "nc-nodaily");
}

function stopAllYearAnimations() {
  Array.from(activeYearAnimations.keys()).forEach(stopYearAnimation);
}

function paintYearFrame(anim, day) {
  anim.paths.forEach((path, regionId) => {
    const f = anim.featuresById.get(regionId);
    const v = getDailyFillValueAt(f, anim.dataset, anim.levelKey, anim.year, day);
    path.setAttribute("fill", v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v));
  });
  if (anim.dayLabelEl) {
    anim.dayLabelEl.textContent = dayOfYearFormatter(new Date(Date.UTC(anim.year, 0, day)));
    anim.dayLabelEl.style.display = "";
  }
}

/**
 * Starts (or restarts) a fixed-rate animation loop stepping through every
 * day of one fixed year, repainting `paths` (Map regionId -> <path>) in
 * place on `container` (a grid tile or the fullscreen card — whichever
 * element should carry the loading/animating state classes).
 *
 * opts: { dataset, levelKey, features, year, paths, dayLabelEl, fps,
 *         startDay, endDay } — startDay/endDay (both 1-based day-of-year,
 *         inclusive) restrict the loop to a sub-range (e.g. one month)
 *         instead of the whole year; omitted, it loops the full year.
 */
async function startYearAnimation(container, opts) {
  stopYearAnimation(container);

  const { dataset, levelKey, features, year, paths, dayLabelEl, fps = YEAR_ANIM_FPS, startDay, endDay } = opts;

  if (!isVariableDaily()) {
    // Annual-only variable (e.g. dtr): there's no day-by-day series to
    // step through, so surface a clear sign instead of just doing
    // nothing on hover, which reads as broken rather than "not available".
    // Registered as a no-op "animation" purely so stopYearAnimation (fired
    // on mouseleave) knows to clean the note back up.
    activeYearAnimations.set(container, { rafId: null, paths: new Map(), originalFill: new Map(), dayLabelEl });
    if (dayLabelEl) {
      dayLabelEl.textContent = "No daily data";
      dayLabelEl.classList.add("grid-tile-nodaily-note");
      dayLabelEl.style.display = "";
    }
    container.classList.add("nc-nodaily");
    return;
  }

  const featuresById = new Map(features.map(f => [f.properties.id, f]));
  const originalFill = new Map();
  paths.forEach((path, regionId) => originalFill.set(regionId, path.getAttribute("fill")));

  const anim = { rafId: null, dataset, levelKey, year, paths, featuresById, originalFill, dayLabelEl };
  activeYearAnimations.set(container, anim);

  if (!dataset.monthlyByYear[year]?.[levelKey]) {
    container.classList.add("nc-loading");
    try {
      await ensureDailyDataLoaded(year, levelKeyToNumber(levelKey));
    } catch (err) {
      console.error("Failed to load daily data for animation:", err);
      container.classList.remove("nc-loading");
      if (activeYearAnimations.get(container) === anim) activeYearAnimations.delete(container);
      return;
    }
  }

  // Hover may have already ended (or a fullscreen may have been closed)
  // while the data was still loading — bail out rather than starting a
  // loop nobody asked for anymore.
  if (activeYearAnimations.get(container) !== anim) return;
  container.classList.remove("nc-loading");
  container.classList.add("nc-animating");

  const totalDays = daysInYear(year);
  const rangeStart = Math.max(1, startDay || 1);
  const rangeEnd = Math.min(totalDays, endDay || totalDays);
  const frameInterval = 1000 / fps;
  let day = rangeStart;
  let lastTs = null;

  function frame(ts) {
    if (activeYearAnimations.get(container) !== anim) return; // stopped elsewhere
    if (lastTs === null) lastTs = ts;
    if (ts - lastTs >= frameInterval) {
      lastTs += frameInterval;
      paintYearFrame(anim, day);
      day = day >= rangeEnd ? rangeStart : day + 1;
    }
    anim.rafId = requestAnimationFrame(frame);
  }
  anim.rafId = requestAnimationFrame(frame);
}

/* ── FULLSCREEN YEAR PLAYER ─────────────────────────────────────────
   Clicking a grid tile maximizes it into a full-detail map with real
   playback controls: play/pause and a scrub timeline, instead of an
   uncontrollable auto-play loop. Two frame modes share one engine:
     - "daily"  (variable has day-by-day data): scrubs through every day
       of the clicked year, same 12 fps pace as the old hover preview.
     - "yearly" (annual-only variable): scrubs through every year in the
       dataset, one frame per second, so a slow multi-decade trend is
       actually watchable instead of being a single static tile. */

let fullscreenAnimEl = null; // kept so grid-tile hover previews (unrelated engine) still resolve correctly
let fsPlayer = null; // { mode, frames, index, playing, paths, featuresById, dataset, levelKey, fixedYear, lastTs, rafId }

const fsControlsEl    = document.getElementById("nc-fullscreen-controls");
const fsPlayPauseBtn  = document.getElementById("nc-fullscreen-playpause");
const fsScrubEl       = document.getElementById("nc-fullscreen-scrub");
const fsScrubLabelEl  = document.getElementById("nc-fullscreen-scrub-label");

function fsPaintFrame() {
  if (!fsPlayer) return;
  const { mode, frames, index, paths, featuresById, dataset, levelKey, fixedYear } = fsPlayer;
  const frame = frames[index];
  const year = mode === "yearly" ? frame : fixedYear;
  const day  = mode === "daily"  ? frame : state.mapDay;
  paths.forEach((path, regionId) => {
    const f = featuresById.get(regionId);
    const v = mode === "daily"
      ? getDailyFillValueAt(f, dataset, levelKey, year, day)
      : getFillValueAt(f, dataset, levelKey, year, day);
    path.setAttribute("fill", v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v));
  });
  fsUpdateTooltipValue();

  const dayLabelEl = document.getElementById("nc-fullscreen-daylabel");
  if (mode === "daily") {
    dayLabelEl.style.display = "";
    const label = dayOfYearFormatter(new Date(Date.UTC(fixedYear, 0, frame)));
    dayLabelEl.textContent = label;
    fsScrubLabelEl.textContent = label;
  } else {
    dayLabelEl.style.display = "none";
    fsScrubLabelEl.textContent = String(frame);
    document.getElementById("nc-fullscreen-title").textContent = String(frame);
  }
  fsScrubEl.value = index;
}

const fsTooltipEl = document.getElementById("nc-fullscreen-tooltip");

function fsHideTooltip() {
  if (fsTooltipEl) fsTooltipEl.style.display = "none";
}

function fsPositionTooltip(event) {
  if (!fsTooltipEl || fsTooltipEl.style.display === "none") return;
  const bodyRect = fsTooltipEl.offsetParent
    ? fsTooltipEl.offsetParent.getBoundingClientRect()
    : { left: 0, top: 0 };
  fsTooltipEl.style.left = `${event.clientX - bodyRect.left + 14}px`;
  fsTooltipEl.style.top = `${event.clientY - bodyRect.top + 14}px`;
}

// Refreshes the tooltip's value for the currently-hovered region against
// whatever frame the player is on right now — called both on hover and
// on every repaint, so scrubbing/playing while hovering stays accurate.
function fsUpdateTooltipValue() {
  if (!fsPlayer || !fsPlayer.hoveredRegionId || !fsTooltipEl) return;
  const { mode, frames, index, featuresById, dataset, levelKey, fixedYear, hoveredRegionId } = fsPlayer;
  const frame = frames[index];
  const year = mode === "yearly" ? frame : fixedYear;
  const day  = mode === "daily"  ? frame : state.mapDay;
  const f = featuresById.get(hoveredRegionId);
  if (!f) return;
  const varMeta = CLIMATE_VARS[state.climateVar] || {};
  const v = state.colorBy === "population"
    ? f.properties.population
    : (mode === "daily" ? getDailyFillValueAt(f, dataset, levelKey, year, day) : getFillValueAt(f, dataset, levelKey, year, day));
  const name = f.properties.name || `Region ${f.properties.id}`;
  const valueText = (v === undefined || v === null || isNaN(v))
    ? "no data"
    : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${varMeta.unit ? " " + varMeta.unit : ""}`;
  fsTooltipEl.innerHTML = `<span class="nc-fst-name">${name}</span><span class="nc-fst-value">${valueText}</span>`;
  fsTooltipEl.style.display = "block";
}

function fsPlayerLoop(ts) {
  if (!fsPlayer || !fsPlayer.playing) return;
  const frameInterval = fsPlayer.mode === "daily" ? (1000 / YEAR_ANIM_FPS) : 1000; // 1 sec/year in yearly mode
  if (fsPlayer.lastTs === null) fsPlayer.lastTs = ts;
  if (ts - fsPlayer.lastTs >= frameInterval) {
    fsPlayer.lastTs += frameInterval;
    fsPlayer.index = (fsPlayer.index + 1) % fsPlayer.frames.length;
    fsPaintFrame();
  }
  fsPlayer.rafId = requestAnimationFrame(fsPlayerLoop);
}

function fsPlayerPlay() {
  if (!fsPlayer) return;
  fsPlayer.playing = true;
  fsPlayer.lastTs = null;
  fsPlayPauseBtn.textContent = "⏸";
  fsPlayPauseBtn.title = "Pause";
  fsPlayer.rafId = requestAnimationFrame(fsPlayerLoop);
}

function fsPlayerPause() {
  if (!fsPlayer) return;
  fsPlayer.playing = false;
  if (fsPlayer.rafId) cancelAnimationFrame(fsPlayer.rafId);
  fsPlayPauseBtn.textContent = "▶";
  fsPlayPauseBtn.title = "Play";
}

fsPlayPauseBtn.addEventListener("click", () => {
  if (!fsPlayer) return;
  if (fsPlayer.playing) fsPlayerPause(); else fsPlayerPlay();
});
fsScrubEl.addEventListener("input", () => {
  if (!fsPlayer) return;
  fsPlayerPause(); // scrubbing takes manual control; press play to resume
  fsPlayer.index = Math.max(0, Math.min(parseInt(fsScrubEl.value, 10) || 0, fsPlayer.frames.length - 1));
  fsPaintFrame();
});

function closeYearFullscreen() {
  const overlay = document.getElementById("nc-fullscreen-overlay");
  fsPlayerPause();
  fsPlayer = null;
  fullscreenAnimEl = null;
  fsHideTooltip();
  overlay.classList.remove("active");
  const gridEl = document.getElementById("nc-grid");
  if (gridEl) gridEl.style.display = "";
}

async function openYearFullscreen(dataset, levelKey, features, year, opts = {}) {
  const overlay = document.getElementById("nc-fullscreen-overlay");
  const svgEl = document.getElementById("nc-fullscreen-svg");
  const titleEl = document.getElementById("nc-fullscreen-title");
  const subEl = document.getElementById("nc-fullscreen-sub");
  const dayLabelEl = document.getElementById("nc-fullscreen-daylabel");
  const annualNoteEl = document.getElementById("nc-fullscreen-annual-note");
  const loadingEl = document.getElementById("nc-fullscreen-loading");

  const varMeta = CLIMATE_VARS[state.climateVar] || {};
  const datasetLabel = datasetSelect.options[datasetSelect.selectedIndex]
    ? datasetSelect.options[datasetSelect.selectedIndex].text
    : state.dataset;
  titleEl.textContent = String(year);
  subEl.textContent = `${varMeta.label || state.climateVar}, ${datasetLabel}`;
  annualNoteEl.style.display = "none";
  fsControlsEl.style.display = "flex";
  dayLabelEl.style.display = "none";
  dayLabelEl.textContent = "";
  fsHideTooltip();

  const svgNS = "http://www.w3.org/2000/svg";
  svgEl.innerHTML = "";
  const FS_W = 960, FS_H = 620;
  svgEl.setAttribute("viewBox", `0 0 ${FS_W} ${FS_H}`);
  const fc = { type: "FeatureCollection", features };
  const projection = d3.geoMercator().fitSize([FS_W, FS_H], fc);
  const pathGen = d3.geoPath().projection(projection);

  const paths = new Map();
  features.forEach(f => {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("class", "grid-tile-region");
    path.setAttribute("d", pathGen(f) || "");
    const v = getFillValueAt(f, dataset, levelKey, year, state.mapDay);
    path.setAttribute("fill", v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v));
    // Region-level detail on hover: name + this frame's value, kept live
    // as the player advances (see fsUpdateTooltipValue / fsPaintFrame).
    path.addEventListener("mouseenter", () => {
      if (fsPlayer) fsPlayer.hoveredRegionId = f.properties.id;
      fsUpdateTooltipValue();
    });
    path.addEventListener("mousemove", (event) => fsPositionTooltip(event));
    path.addEventListener("mouseleave", () => {
      if (fsPlayer) fsPlayer.hoveredRegionId = null;
      fsHideTooltip();
    });
    svgEl.appendChild(path);
    paths.set(f.properties.id, path);
  });

  overlay.classList.add("active");
  const gridElToHide = document.getElementById("nc-grid");
  if (gridElToHide) gridElToHide.style.display = "none";
  fullscreenAnimEl = overlay;
  fsPlayerPause();
  const featuresById = new Map(features.map(f => [f.properties.id, f]));

  // forceYearly (from the Period dropdown's "year-per-second video" option)
  // plays the year-by-year trend even for daily-capable variables, instead
  // of only kicking in automatically for annual-only ones.
  if (isVariableDaily() && !opts.forceYearly) {
    const totalDays = daysInYear(year);
    const startIndex = Math.max(0, Math.min(totalDays - 1, (opts.startDay || 1) - 1));
    fsScrubEl.min = 0; fsScrubEl.max = totalDays - 1; fsScrubEl.step = 1; fsScrubEl.value = startIndex;
    fsPlayer = {
      mode: "daily",
      frames: Array.from({ length: totalDays }, (_, i) => i + 1),
      index: startIndex, playing: false, paths, featuresById, dataset, levelKey, fixedYear: year,
      hoveredRegionId: null, lastTs: null, rafId: null,
    };
    if (!dataset.monthlyByYear[year]?.[levelKey]) {
      overlay.classList.add("nc-loading");
      try {
        await ensureDailyDataLoaded(year, levelKeyToNumber(levelKey));
      } catch (err) {
        console.error("Failed to load daily data for animation:", err);
        overlay.classList.remove("nc-loading");
        return;
      }
    }
    overlay.classList.remove("nc-loading");
    if (fullscreenAnimEl !== overlay) return; // closed while data was loading
    fsPaintFrame();
    fsPlayerPlay();
  } else {
    // Annual-only variable, or an explicit yearly-video request: instead
    // of a static tile, play through every year in the dataset — one
    // frame per second — so the long-run trend is watchable rather than
    // requiring repeated clicks.
    annualNoteEl.style.display = "block";
    annualNoteEl.textContent = isVariableDaily()
      ? "Playing the year-by-year trend, one year per second."
      : "This variable is only available at annual resolution, so there's no day-by-day animation to play — playing the year-by-year trend instead, one year per second.";
    const yearsSeq = [];
    for (let y = YEAR_RANGE.min; y <= YEAR_RANGE.max; y++) yearsSeq.push(y);
    const startIdx = Math.max(0, yearsSeq.indexOf(year));
    fsScrubEl.min = 0; fsScrubEl.max = yearsSeq.length - 1; fsScrubEl.step = 1; fsScrubEl.value = startIdx;
    fsPlayer = {
      mode: "yearly",
      frames: yearsSeq,
      index: startIdx, playing: false, paths, featuresById, dataset, levelKey,
      hoveredRegionId: null, lastTs: null, rafId: null,
    };
    fsPaintFrame();
    fsPlayerPlay();
  }
}

document.getElementById("nc-fullscreen-close").addEventListener("click", closeYearFullscreen);
document.getElementById("nc-fullscreen-overlay").addEventListener("click", (event) => {
  if (event.target.id === "nc-fullscreen-overlay") closeYearFullscreen();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.getElementById("nc-fullscreen-overlay").classList.contains("active")) {
    closeYearFullscreen();
  }
  if (event.key === " " && document.getElementById("nc-fullscreen-overlay").classList.contains("active") && fsPlayer) {
    event.preventDefault();
    if (fsPlayer.playing) fsPlayerPause(); else fsPlayerPlay();
  }
});


/**
 * Grid/tile tab entry point. Renders one small map tile per year (or a
 * delta tile when compare mode is active) for the currently visible
 * regions, letting the user scan how a variable evolves across the full
 * year range at a glance.
 */
function renderYearGrid() {
  const gridEl = document.getElementById("nc-grid");
  const titleEl2 = document.getElementById("nc-grid-title");
  const dataset = state.datasets[state.dataset];
  stopAllYearAnimations();
  closeYearFullscreen();
  if (!dataset) { gridEl.innerHTML = ""; return; }

  const levelKey = getLevelKey(state.currentLevel);
  const visibleFeatures = getVisibleFeatures(dataset, levelKey);
  const drillable = canDrillDown();

  // "What Changed??" only makes sense once two distinct points are
  // actually being compared — hide the toggle otherwise, and don't
  // leave a stale delta tile showing from a prior compare selection.
  const isCompare = computeIsCompare();
  deltaGridToggleRow.style.display = isCompare ? "flex" : "none";
  if (!isCompare && state.showDeltaTile) {
    state.showDeltaTile = false;
    deltaGridToggle.checked = false;
  }

  // In compare mode, show exactly the two points being compared (plus
  // the delta tile below) instead of the usual evenly-spaced spread —
  // otherwise the delta tile ends up diffing two years that aren't even
  // the two tiles sitting next to it, which reads as arbitrary. Every
  // other compare surface in the app (map, chart, table) already only
  // ever shows the two selected points, so this brings the grid in line.
  const comparePanels = isCompare ? getComparePanels() : null;
  const compareYears = comparePanels ? [...new Set(comparePanels.map(p => p.year))] : null;
  const years = (compareYears && compareYears.length >= 2) ? compareYears : pickGridYears();

  // A single year drilled into daily detail (Period → one-year daily view,
  // or a chart zoom that dropped into it) has nothing meaningful to spread
  // across evenly-spaced year tiles — show one tile per month instead (the
  // 1st of each month), each still hoverable/expandable exactly like a
  // year tile.
  const singleYearView = state.granularity === "monthly" && !isCompare && isVariableDaily() && state.colorBy !== "population";
  const singleYear = years[0];
  const monthDays = singleYearView ? MONTH_ABBR.map((_, m) => monthStartDayOfYear(singleYear, m)) : null;

  if (singleYearView) {
    computeGridColorScaleForMonths(dataset, levelKey, visibleFeatures, singleYear, monthDays);
  } else {
    computeGridColorScale(dataset, levelKey, visibleFeatures, years);
  }

  const varMeta = CLIMATE_VARS[state.climateVar] || {};
  const datasetLabel = datasetSelect.options[datasetSelect.selectedIndex]
    ? datasetSelect.options[datasetSelect.selectedIndex].text
    : state.dataset;
  titleEl2.textContent = singleYearView
    ? `${varMeta.label || state.climateVar}, ${datasetLabel}, ${singleYear} by month`
    : `${varMeta.label || state.climateVar}, ${datasetLabel}, ${years[0]}–${years[years.length - 1]}`;
  const gridHintEl = document.querySelector("#nc-grid-pane .grid-hint");
  if (gridHintEl) {
    const countLabel = singleYearView
      ? "12 months"
      : (compareYears && compareYears.length >= 2)
        ? `Comparing ${years[0]} → ${years[years.length - 1]}`
        : `${years.length} evenly-spaced year${years.length === 1 ? "" : "s"}`;
    gridHintEl.textContent = drillable
      ? `${countLabel} · one shared color scale · click a region to zoom in`
      : `${countLabel} · one shared color scale`;
  }

  // One shared projection/path generator, fit once to the visible
  // geometry, reused for all 12 tiles so they line up identically —
  // only the fill colors differ tile to tile.
  const TILE_W = 300, TILE_H = 232;
  const fc = { type: "FeatureCollection", features: visibleFeatures };
  const tileProjection = d3.geoMercator().fitSize([TILE_W, TILE_H], fc);
  const tilePathGen = d3.geoPath().projection(tileProjection);
  const pathD = new Map(visibleFeatures.map(f => [f.properties.id, tilePathGen(f)]));

  const isDaily = isVariableDaily();
  const hoverHint = state.colorBy === "population"
    ? ""
    : singleYearView
      ? " · hover a tile to play that month · click to play the whole year"
      : isDaily
        ? " · hover to play the year day-by-day · click to maximize"
        : " · click to maximize (annual data only)";
  if (gridHintEl && state.colorBy !== "population") {
    gridHintEl.textContent = gridHintEl.textContent + hoverHint;
  }

  // Builds one tile — either a year tile (normal grid) or a month tile
  // (single-year view). `day` is the day-of-year used both to read the
  // fill value and as the starting point if the tile's video is played.
  function buildGridTile({ yr, day, labelText, tileIndex, playStartDay, playEndDay }) {
    const tile = document.createElement("div");
    tile.className = "grid-tile";
    tile.style.animationDelay = `${Math.min(tileIndex * 18, 220)}ms`;

    const svgNS = "http://www.w3.org/2000/svg";
    const svgEl = document.createElementNS(svgNS, "svg");
    svgEl.setAttribute("viewBox", `0 0 ${TILE_W} ${TILE_H}`);

    const pathsById = new Map();
    let sum = 0, count = 0;
    visibleFeatures.forEach(f => {
      const v = getFillValueAt(f, dataset, levelKey, yr, day);
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("class", "grid-tile-region" + (drillable ? " drillable" : ""));
      path.setAttribute("d", pathD.get(f.properties.id) || "");
      path.setAttribute("fill", v === undefined || isNaN(v) ? "#e5e5e0" : colorScale(v));
      if (drillable) {
        const label = f.properties.name || `Region ${f.properties.id}`;
        path.setAttribute("data-tooltip", label);
        const titleEl = document.createElementNS(svgNS, "title");
        titleEl.textContent = `Click to zoom into ${label}`;
        path.appendChild(titleEl);
        path.addEventListener("click", (event) => {
          event.stopPropagation();
          drillIntoRegionId(event, visibleFeatures, f.properties.id);
        });
      }
      svgEl.appendChild(path);
      pathsById.set(f.properties.id, path);
      if (v !== undefined && !isNaN(v)) { sum += v; count++; }
    });
    tile.appendChild(svgEl);

    const label = document.createElement("span");
    label.className = "grid-tile-label";
    label.textContent = labelText;
    tile.appendChild(label);

    if (count && state.colorBy !== "population") {
      const stat = document.createElement("span");
      stat.className = "grid-tile-stat";
      stat.textContent = `${(sum / count).toFixed(1)}${varMeta.unit ? " " + varMeta.unit : ""}`;
      tile.appendChild(stat);
    }

    const dayLabelEl = document.createElement("span");
    dayLabelEl.className = "grid-tile-daylabel";
    dayLabelEl.style.display = "none";
    tile.appendChild(dayLabelEl);

    const loadingEl = document.createElement("span");
    loadingEl.className = "grid-tile-loading";
    loadingEl.textContent = "Loading daily data\u2026";
    tile.appendChild(loadingEl);

    if (state.colorBy !== "population") {
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "grid-tile-expand-btn";
      expandBtn.title = singleYearView ? "Play the year" : "Maximize";
      expandBtn.textContent = "\u2922";
      expandBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        stopYearAnimation(tile);
        openYearFullscreen(dataset, levelKey, visibleFeatures, yr, { startDay: playStartDay });
      });
      tile.appendChild(expandBtn);

      tile.addEventListener("mouseenter", () => {
        startYearAnimation(tile, {
          dataset, levelKey, features: visibleFeatures, year: yr, paths: pathsById, dayLabelEl,
          startDay: playStartDay, endDay: playEndDay,
        });
      });
      tile.addEventListener("mouseleave", () => stopYearAnimation(tile));
      tile.addEventListener("click", () => {
        stopYearAnimation(tile);
        openYearFullscreen(dataset, levelKey, visibleFeatures, yr, { startDay: playStartDay });
      });
    }

    return tile;
  }

  gridEl.innerHTML = "";
  if (singleYearView) {
    MONTH_ABBR.forEach((abbr, m) => {
      const startDay = monthDays[m];
      const endDay = m < 11 ? monthDays[m + 1] - 1 : daysInYear(singleYear);
      gridEl.appendChild(buildGridTile({
        yr: singleYear, day: startDay, labelText: abbr, tileIndex: m,
        playStartDay: startDay, playEndDay: endDay,
      }));
    });
  } else {
    years.forEach((yr, tileIndex) => {
      gridEl.appendChild(buildGridTile({
        yr, day: state.mapDay, labelText: String(yr), tileIndex,
        playStartDay: undefined, playEndDay: undefined,
      }));
    });
  }

  if (isCompare && state.showDeltaTile && state.colorBy !== "population") {
    appendDeltaTile(gridEl, dataset, levelKey, visibleFeatures, pathD, TILE_W, TILE_H, drillable);
  }
}

// One extra tile, opt-in via "What Changed?": instead of two independent
// snapshots, colors each region by (value at panel B) − (value at panel
// A) on a diverging scale, so growth/decline reads directly instead of
// requiring the viewer to compare two color legends by eye.
function appendDeltaTile(gridEl, dataset, levelKey, visibleFeatures, pathD, TILE_W, TILE_H, drillable) {
  const [panelA, panelB] = getComparePanels();
  const varMeta = CLIMATE_VARS[state.climateVar] || {};

  const deltas = new Map();
  const deltaVals = [];
  visibleFeatures.forEach(f => {
    const va = getFillValueAt(f, dataset, levelKey, panelA.year, panelA.day);
    const vb = getFillValueAt(f, dataset, levelKey, panelB.year, panelB.day);
    if (va !== undefined && !isNaN(va) && vb !== undefined && !isNaN(vb)) {
      const d = vb - va;
      deltas.set(f.properties.id, d);
      deltaVals.push(d);
    }
  });

  const maxAbs = deltaVals.length ? Math.max(...deltaVals.map(Math.abs), 1e-6) : 1;
  // Variables that already have a genuine diverging palette (tasmean, SPI,
  // SPEI...) keep it — it already passes through a meaningful neutral
  // midpoint. Everything else uses a fixed, direction-coded fallback
  // (red = increase, blue = decrease) instead of stretching a one-way
  // sequential palette (e.g. light→dark blue for precip) across positive
  // and negative deltas, which made increase and decrease hard to tell
  // apart since both ends were still the same hue.
  const deltaInterpolator = (varMeta.diverging && varMeta.interpolator)
    ? varMeta.interpolator
    : (t => d3.interpolateRdBu(1 - t));
  const deltaScale = d3.scaleDivergingPow(deltaInterpolator)
    .exponent(0.6).domain([-maxAbs, 0, maxAbs]);

  const tile = document.createElement("div");
  tile.className = "grid-tile grid-tile-delta";

  const svgNS = "http://www.w3.org/2000/svg";
  const svgEl = document.createElementNS(svgNS, "svg");
  svgEl.setAttribute("viewBox", `0 0 ${TILE_W} ${TILE_H}`);
  visibleFeatures.forEach(f => {
    const d = deltas.get(f.properties.id);
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("class", "grid-tile-region" + (drillable ? " drillable" : ""));
    path.setAttribute("d", pathD.get(f.properties.id) || "");
    path.setAttribute("fill", d === undefined ? "#e5e5e0" : deltaScale(d));
    const label = f.properties.name || `Region ${f.properties.id}`;
    const titleEl = document.createElementNS(svgNS, "title");
    titleEl.textContent = d === undefined
      ? `${label}: no data`
      : `${label}: ${d >= 0 ? "+" : ""}${d.toFixed(2)}${varMeta.unit ? " " + varMeta.unit : ""} (${d >= 0 ? "increase" : "decrease"})`;
    path.appendChild(titleEl);
    if (drillable) {
      path.addEventListener("click", (event) => {
        event.stopPropagation();
        drillIntoRegionId(event, visibleFeatures, f.properties.id);
      });
    }
    svgEl.appendChild(path);
  });
  tile.appendChild(svgEl);

  const label = document.createElement("span");
  label.className = "grid-tile-label";
  label.textContent = `Δ ${panelA.label} → ${panelB.label}`;
  tile.appendChild(label);

  const stat = document.createElement("span");
  stat.className = "grid-tile-stat";
  const meanDelta = deltaVals.length ? deltaVals.reduce((s, v) => s + v, 0) / deltaVals.length : 0;
  stat.textContent = `${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(2)}${varMeta.unit ? " " + varMeta.unit : ""} avg (unweighted)`;
  tile.appendChild(stat);

  // Its own mini legend — the delta tile uses a completely different
  // (diverging, zero-centered) scale from every other tile's shared
  // legend, so it needs its own key rather than relying on that one.
  const legendWrap = document.createElement("div");
  legendWrap.className = "grid-tile-delta-legend";
  const legendBar = document.createElement("div");
  legendBar.className = "grid-tile-delta-legend-bar";
  const stops = d3.range(0, 1.01, 0.1).map(t => deltaScale(-maxAbs + t * 2 * maxAbs));
  legendBar.style.background = `linear-gradient(to right, ${stops.join(",")})`;
  const legendLabels = document.createElement("div");
  legendLabels.className = "grid-tile-delta-legend-labels";
  const unitSuffix = varMeta.unit ? ` ${varMeta.unit}` : "";
  legendLabels.innerHTML =
    `<span>\u2212${maxAbs.toFixed(1)}${unitSuffix}</span><span>0</span><span>+${maxAbs.toFixed(1)}${unitSuffix}</span>`;
  legendWrap.appendChild(legendBar);
  legendWrap.appendChild(legendLabels);
  tile.appendChild(legendWrap);

  // Maximize, for parity with the regular tiles — there's no time
  // dimension to animate for a single delta, so this opens a larger
  // static change map with the same hover detail rather than a player.
  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "grid-tile-expand-btn";
  expandBtn.title = "Maximize";
  expandBtn.textContent = "\u2922";
  expandBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openDeltaFullscreen(visibleFeatures, deltas, deltaScale, maxAbs, varMeta, panelA, panelB);
  });
  tile.appendChild(expandBtn);
  tile.addEventListener("click", () => {
    openDeltaFullscreen(visibleFeatures, deltas, deltaScale, maxAbs, varMeta, panelA, panelB);
  });

  gridEl.appendChild(tile);
}

// Static (non-playing) fullscreen view of the delta tile — reuses the
// same overlay as the year player but skips the play/scrub controls and
// paints one fixed set of diverging colors, with the same live
// region-hover tooltip (name + this region's change) as the animated player.
function openDeltaFullscreen(features, deltas, deltaScale, maxAbs, varMeta, panelA, panelB) {
  const overlay = document.getElementById("nc-fullscreen-overlay");
  const svgEl = document.getElementById("nc-fullscreen-svg");
  const titleEl = document.getElementById("nc-fullscreen-title");
  const subEl = document.getElementById("nc-fullscreen-sub");
  const dayLabelEl = document.getElementById("nc-fullscreen-daylabel");
  const annualNoteEl = document.getElementById("nc-fullscreen-annual-note");

  fsPlayerPause();
  fsPlayer = null;
  fullscreenAnimEl = null;
  fsHideTooltip();

  titleEl.textContent = `Δ ${panelA.label} → ${panelB.label}`;
  subEl.textContent = `${varMeta.label || state.climateVar} — change over the selected period`;
  dayLabelEl.style.display = "none";
  dayLabelEl.textContent = "";
  fsControlsEl.style.display = "none";
  annualNoteEl.style.display = "block";
  annualNoteEl.textContent = "Static change map — a single delta between two points has nothing to animate.";

  const svgNS = "http://www.w3.org/2000/svg";
  svgEl.innerHTML = "";
  const FS_W = 960, FS_H = 620;
  svgEl.setAttribute("viewBox", `0 0 ${FS_W} ${FS_H}`);
  const fc = { type: "FeatureCollection", features };
  const projection = d3.geoMercator().fitSize([FS_W, FS_H], fc);
  const pathGen = d3.geoPath().projection(projection);

  features.forEach(f => {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("class", "grid-tile-region");
    path.setAttribute("d", pathGen(f) || "");
    const d = deltas.get(f.properties.id);
    path.setAttribute("fill", d === undefined ? "#e5e5e0" : deltaScale(d));
    path.addEventListener("mouseenter", () => {
      const name = f.properties.name || `Region ${f.properties.id}`;
      const valueText = d === undefined
        ? "no data"
        : `${d >= 0 ? "+" : ""}${d.toFixed(2)}${varMeta.unit ? " " + varMeta.unit : ""}`;
      fsTooltipEl.innerHTML = `<span class="nc-fst-name">${name}</span><span class="nc-fst-value">${valueText}</span>`;
      fsTooltipEl.style.display = "block";
    });
    path.addEventListener("mousemove", (event) => fsPositionTooltip(event));
    path.addEventListener("mouseleave", fsHideTooltip);
    svgEl.appendChild(path);
  });

  overlay.classList.add("active");
  fullscreenAnimEl = overlay;
}

/* ── OPTIONAL BASE MAP IMAGE ─────────────────────────────────────── */

/* ── WATER BODIES (Nile, lakes, seas — vector layer from Natural Earth, always on) ── */

async function updateWaterBodies() {
  waterLayer.selectAll("*").remove();
  if (!geoPathGen) return;

  try {
    if (!oceanGeoCache) oceanGeoCache = await d3.json(OCEAN_GEOJSON_URL);
    if (!riversGeoCache) riversGeoCache = await d3.json(RIVERS_GEOJSON_URL);
  } catch (e) {
    console.error("Could not load water body layers:", e);
    return;
  }

  // Oceans/seas — filled polygons, drawn first (bottom of this layer)
  if (oceanGeoCache) {
    waterLayer.selectAll(".ocean-path")
      .data(oceanGeoCache.features)
      .enter().append("path")
      .attr("class", "ocean-path")
      .attr("d", d => geoPathGen(d));
  }

  // Rivers & lake centerlines (includes the Nile) — thin strokes on top
  if (riversGeoCache) {
    waterLayer.selectAll(".river-path")
      .data(riversGeoCache.features)
      .enter().append("path")
      .attr("class", d => {
        const name = (d.properties && (d.properties.name || d.properties.NAME)) || "";
        return "river-path" + (/nile/i.test(name) ? " major" : "");
      })
      .attr("d", d => geoPathGen(d));
  }
}

/* ── OPTIONAL COUNTRY OUTLINES (background context) ─────────────── */

async function updateCountryOutline() {
  countryLayer.selectAll("*").remove();
  if (!state.showCountryOutline || !geoPathGen) return;

  if (!countriesGeoCache) {
    try {
      countriesGeoCache = await d3.json(DATASET_CONFIGS.countries.hierarchy);
    } catch (e) {
      console.error("Could not load country outlines:", e);
      return;
    }
  }
  // Only re-draw if this option is still checked (user may have unchecked while loading)
  if (!state.showCountryOutline) return;

  const level0 = countriesGeoCache["level 0"] || countriesGeoCache.level0;
  if (!level0) return;

  countryLayer.selectAll(".country-outline-path")
    .data(level0.features)
    .enter().append("path")
    .attr("class", "country-outline-path")
    .attr("d", d => geoPathGen(d));
}

/* ── SCALE BAR (updates with zoom level) ─────────────────────────── */

function projectionKmPerPixel() {
  if (!geoProjection) return null;
  const p0 = [state.width / 2, state.height / 2];
  const p1 = [state.width / 2 + 100, state.height / 2];
  const g0 = geoProjection.invert(p0);
  const g1 = geoProjection.invert(p1);
  if (!g0 || !g1) return null;
  const angularDist = d3.geoDistance(g0, g1); // radians
  const EARTH_RADIUS_KM = 6371;
  return (angularDist * EARTH_RADIUS_KM) / 100; // km per unzoomed screen pixel
}

const SCALE_BAR_NICE_KM = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 250, 500, 750, 1000, 1500, 2000, 3000];

function updateScaleBar() {
  const kmPerPxBase = projectionKmPerPixel();
  if (!kmPerPxBase) { scaleBarG.style("display", "none"); return; }
  scaleBarG.style("display", null);

  const kmPerScreenPx = kmPerPxBase / (currentZoomK || 1);
  const maxBarPx = 110;

  let chosenKm = SCALE_BAR_NICE_KM[0];
  for (const km of SCALE_BAR_NICE_KM) {
    if (km / kmPerScreenPx <= maxBarPx) chosenKm = km; else break;
  }
  const barPx = chosenKm / kmPerScreenPx;

  const marginLeft = 24, bottomY = state.height - 22;
  scaleBarG.attr("transform", `translate(${marginLeft},${bottomY})`);
  scaleBarLine.attr("x1", 0).attr("x2", barPx);
  scaleBarTick1.attr("x1", 0).attr("x2", 0);
  scaleBarTick2.attr("x1", barPx).attr("x2", barPx);
  scaleBarLabel.attr("x", barPx / 2).text(`${chosenKm} km`);
}

/* ── HOVER CARD: population + line chart ────────────────────────── */

function onRegionEnter(event, feature) {
  clearTimeout(hoverHideTimer);
  showHoverCard(feature, event);
  updateLegendMarkerForFeature(feature);
}

function onRegionMove(event, feature) {
  positionHoverCard(event);
}

function onRegionLeave() {
  hoverHideTimer = setTimeout(() => {
    hoverCard.classList.remove("visible");
  }, 60);
  hideLegendMarker();
}

// Positions the little triangular marker on top of the legend gradient at
// the hovered region's value, tying the map interaction directly to the
// legend that explains its color. Uses the same value the region's fill
// color was computed from (getFillValue), and the same extent the legend
// gradient itself was built from (currentLegendExtent), so the marker
// always lines up with what's actually on screen.
function updateLegendMarkerForFeature(feature) {
  const dataset = state.datasets[state.dataset];
  const levelKey = getLevelKey(state.currentLevel);
  const v = getFillValue(feature, dataset, levelKey);
  updateLegendMarker(v);
}

function updateLegendMarker(value) {
  const markerEl = document.getElementById("nc-legend-marker");
  if (!markerEl) return;
  if (value === undefined || value === null || isNaN(value) || !currentLegendExtent) {
    markerEl.classList.remove("visible");
    return;
  }
  const [lo, hi] = currentLegendExtent;
  const span = (hi - lo) || 1;
  const pct = Math.min(100, Math.max(0, ((value - lo) / span) * 100));
  markerEl.style.left = pct + "%";
  markerEl.classList.add("visible");
}

function hideLegendMarker() {
  const markerEl = document.getElementById("nc-legend-marker");
  if (markerEl) markerEl.classList.remove("visible");
}

function showHoverCard(feature, event) {
  const props = feature.properties;
  const varMeta = CLIMATE_VARS[state.climateVar];

  hoverCardName.textContent = props.name || `Region ${props.id}`;
  hoverCardPopVal.textContent = props.population !== undefined
    ? Number(props.population).toLocaleString() : "—";
  hoverCardVarLabel.textContent = state.granularity === "monthly"
    ? `${varMeta.label}, by day (${state.mapYear})`
    : `${varMeta.label}, by year`;
  if (hoverCardDrillEl) {
    const drillable = canDrillDown();
    hoverCardDrillEl.classList.toggle("visible", drillable);
    if (drillable) hoverCardDrillEl.textContent = `Click to zoom into ${props.name || "this region"} ↗`;
  }

  const series = getRegionSeries(props.id);
  renderHoverChart(series, varMeta);

  positionHoverCard(event);
  hoverCard.classList.add("visible");
}

function positionHoverCard(event) {
  const mainRect = mainEl.getBoundingClientRect();
  const cardW = hoverCard.offsetWidth || 300;
  const cardH = hoverCard.offsetHeight || 160;

  let x = event.clientX - mainRect.left + 16;
  let y = event.clientY - mainRect.top - cardH / 2;

  if (x + cardW > mainRect.width - 8) x = event.clientX - mainRect.left - cardW - 16;
  if (y < 8) y = 8;
  if (y + cardH > mainRect.height - 8) y = mainRect.height - cardH - 8;

  hoverCard.style.left = `${x}px`;
  hoverCard.style.top = `${y}px`;
}

function seriesToPoints(series) {
  const isMonthly = state.granularity === "monthly";
  const raw = series
    .filter(d => d[state.climateVar] !== undefined && !isNaN(d[state.climateVar]))
    .map(d => ({
      x: isMonthly ? dayOfYearFromDateStr(d.date) : d.year,
      value: d[state.climateVar],
    }));

  // Safety net: if the same x (date/year) appears more than once — e.g. from
  // duplicate rows across merged data sources — average them into one point
  // instead of letting the line generator zig-zag or effectively collapse.
  const byX = d3.rollup(raw, vals => d3.mean(vals, v => v.value), d => d.x);
  return Array.from(byX, ([x, value]) => ({ x, value })).sort((a, b) => a.x - b.x);
}

/**
 * Generic small trend-line chart, shared by the map hover card and the
 * table tab's expandable row. Draws axes, a line, dots, and (optionally)
 * a highlighted "current" point.
 */
function drawTrendChart(containerEl, pts, varMeta, { width = 268, height = 90, 
  highlightX = null, emptyMsg = "No data yet for this region", regionId = null
} = {}) {
  containerEl.innerHTML = "";

  if (pts.length === 0) {
    containerEl.innerHTML = `<div class="hover-empty">${emptyMsg}</div>`;
    return;
  }

  const isMonthly = state.granularity === "monthly";
  const margin = { top: 6, right: 8, bottom: 16, left: 32 };

  const svgEl = d3.select(containerEl).append("svg")
    .attr("width", width).attr("height", height);

  const x = d3.scaleLinear()
    .domain(d3.extent(pts, d => d.x))
    .range([margin.left, width - margin.right]);

  const yExtent = d3.extent(pts, d => d.value);
  const pad = (yExtent[1] - yExtent[0]) * 0.15 || 1;
  const y = d3.scaleLinear()
    .domain([yExtent[0] - pad, yExtent[1] + pad])
    .range([height - margin.bottom, margin.top]);

  const dayFormatter = d3.timeFormat("%b %d");
  const xAxisFormat = isMonthly
    ? (day) => dayFormatter(new Date(2001, 0, day))
    : d3.format("d");

  const tickCount = Math.min(pts.length, isMonthly ? 6 : 4);
  svgEl.append("g")
    .attr("class", "hover-axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(tickCount).tickFormat(xAxisFormat).tickSize(3));

  svgEl.append("g")
    .attr("class", "hover-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSize(3));

  const line = d3.line()
    .x(d => x(d.x))
    .y(d => y(d.value))
    .curve(d3.curveMonotoneX);

  const strokeColor = regionId !== null ? colorForRegion(regionId) : "var(--accent)";

  svgEl.append("path")
    .datum(pts)
    .attr("class", "hover-line")
    .attr("stroke", strokeColor)
    .attr("d", line);

  svgEl.selectAll(".hover-dot")
    .data(pts)
    .enter().append("circle")
    .attr("class", "hover-dot")
    .attr("cx", d => x(d.x))
    .attr("cy", d => y(d.value))
    .attr("r", pts.length === 1 ? 3 : 2)
    .attr("fill", strokeColor);

  if (highlightX !== null) {
    const currentPt = pts.find(d => d.x === highlightX);
    if (currentPt) {
      svgEl.append("circle")
        .attr("class", "hover-dot-current")
        .attr("cx", x(currentPt.x))
        .attr("cy", y(currentPt.value))
        .attr("r", 4)
        .attr("fill", strokeColor);
    }
  }
}

function renderHoverChart(series, varMeta) {
  const pts = seriesToPoints(series);
  const isMonthly = state.granularity === "monthly";
  const currentX = isMonthly ? state.mapDay : state.mapYear;
  drawTrendChart(hoverCardChartEl, pts, varMeta, { width: 268, height: 90, highlightX:
     currentX, regionId: state.selectedRegionId });
}

function isYearInRange(year) {
  return year >= state.yearRangeStart && year <= state.yearRangeEnd;
}

function isDayInRange(day) {
  // No wrap-around support yet — dayRangeStart must be <= dayRangeEnd.
  return day >= state.dayRangeStart && day <= state.dayRangeEnd;
}

function getRegionSeries(regionId) {
  const dataset = state.datasets[state.dataset];
  const levelKey = getLevelKey(state.currentLevel);
  if (state.granularity === "monthly") {
    const series = ((dataset.monthlyByYear[state.mapYear] || {})[levelKey] || {})[regionId] || [];
    return series.filter(r => isDayInRange(dayOfYearFromDateStr(r.date)));
  }
  // Return yearly data, restricted to the selected year range.
  const series = (dataset.yearlyByLevel[levelKey] || {})[regionId] || [];
  return series.filter(r => isYearInRange(r.year));
}

function getVisibleFeatures(dataset, levelKey) {
  const features = (dataset.hierarchy[levelKey] || {}).features || [];
  if (!state.drilldownParentName) return features;
  const filtered = features.filter(f => f.properties.parent_name === state.drilldownParentName);
  // If the data doesn't carry parent_name (old hierarchy.json not yet
  // regenerated with the country-linking fix), fall back to showing
  // everything rather than an empty map.
  return filtered.length ? filtered : features;
}

/* ── CLICK: zoom in ──────────────────────────────────────────────── */

function onRegionClick(event, feature) {
  event.stopPropagation();
  const nextLevelKey = getLevelKey(state.currentLevel + 1);
  const dataset = state.datasets[state.dataset];
  if (!dataset.hierarchy[nextLevelKey]) return; // already at deepest level

  // Play a quick "dive in" pulse on the clicked map region itself (only
  // applies when the click actually originated on a .region-path — table/
  // chart/grid-triggered drills route through here too but have no map
  // shape under the pointer to animate).
  const targetPath = event.currentTarget;
  if (targetPath && targetPath.classList && targetPath.classList.contains("region-path")) {
    targetPath.classList.remove("nc-drilling"); // restart animation if retriggered mid-flight
    void targetPath.offsetWidth; // force reflow so the class removal/re-add isn't coalesced
    targetPath.classList.add("nc-drilling");
  }

  zoomIntoFeature(feature);
}

// Whether the current level has a deeper level to drill into (basin ->
// subbasins -> countries, etc). Shared by every view (map, table, chart,
// grid) so they all stop offering to drill in at the same, deepest level.
function canDrillDown() {
  const dataset = state.datasets[state.dataset];
  if (!dataset) return false;
  return !!dataset.hierarchy[getLevelKey(state.currentLevel + 1)];
}

// Drill-in helper for the non-map views (table rows, chart lines/legend,
// grid tiles). Looks up the full feature by id within the features array
// already in scope for that view, then reuses the map's click-to-zoom
// logic so all four views share one consistent drill-down behavior.
/**
 * Drill down into a region by id from a non-map view (table row, chart
 * line/legend entry, or grid tile). Looks the feature up in the
 * features array already in scope for that view, then reuses the map's
 * click-to-zoom logic (onRegionClick) so all four views share one
 * consistent drill-down behavior.
 * @param {Event} event - The originating DOM event.
 * @param {object[]} features - GeoJSON features currently visible in
 *   this view.
 * @param {string} id - `properties.id` of the region to drill into.
 */
function drillIntoRegionId(event, features, id) {
  if (!canDrillDown()) return;
  const feature = features.find(f => f.properties.id === id);
  if (!feature) return;
  onRegionClick(event, feature);
}

function zoomIntoFeature(feature) {
  const [[x0, y0], [x1, y1]] = geoPathGen.bounds(feature);
  const bw = x1 - x0, bh = y1 - y0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const scale = Math.min(state.width / bw, state.height / bh) * 0.65;

  const transform = d3.zoomIdentity
    .translate(state.width / 2, state.height / 2)
    .scale(scale)
    .translate(-cx, -cy);

  // A slight overshoot on the way in makes the drill-down feel like an
  // intentional "dive" rather than a mechanical pan/zoom — settles back
  // to the exact target scale/position by the end of the transition.
  svg.transition().duration(680).ease(d3.easeBackOut.overshoot(1.15))
    .call(zoomBehavior.transform, transform);

  state.currentLevel += 1;
  state.drilldownParentName = feature.properties.name;
  state.expandedRegionId = null;
  state.chartLockedId = null;
  state.chartHoveredId = null;
  chartZoomWindows = { yearly: null, monthly: null }; // region drilled — underlying series changed, drop any local chart zoom
  clearTimeout(chartZoomSwitchTimer);
  hoverCard.classList.remove("visible");
  updateTitle();

  setTimeout(updateView, 680);
  backBtn.classList.add("visible");
  hintEl.style.opacity = "0";
}

function zoomOut() {
  if (state.currentLevel === 0) return;
  state.currentLevel -= 1;
  if (state.currentLevel === 0) state.drilldownParentName = null;
  state.expandedRegionId = null;
  state.chartLockedId = null;
  state.chartHoveredId = null;
  chartZoomWindows = { yearly: null, monthly: null }; // region drilled — underlying series changed, drop any local chart zoom
  clearTimeout(chartZoomSwitchTimer);
  hoverCard.classList.remove("visible");
  updateTitle();

  svg.transition().duration(680).ease(d3.easeCubicInOut)
    .call(zoomBehavior.transform, d3.zoomIdentity);

  setTimeout(updateView, 680);
  if (state.currentLevel === 0) backBtn.classList.remove("visible");
}

/* ── BASIN-WIDE STATS ────────────────────────────────────────────── */

function renderBasinStats() {
  const dataset = state.datasets[state.dataset];
  const varMeta = CLIMATE_VARS[state.climateVar];
  const levelKey = getLevelKey(state.currentLevel);
  const features = getVisibleFeatures(dataset, levelKey);
  const visibleIds = new Set(features.map(f => f.properties.id));

  const totalPop = d3.sum(features, f => f.properties.population || 0);
  const totalArea = d3.sum(features, f => f.properties.area_km2 || 0);

  statPopEl.textContent = totalPop.toLocaleString();
  statAreaEl.innerHTML = `${totalArea.toLocaleString()}<span class="unit">km²</span>`;

  statMeanLabelEl.textContent = `Level mean (${state.mapYear})`;
  const yearlyLevel = dataset.yearlyByLevel[levelKey] || {};
  const visibleYearlyEntries = Object.entries(yearlyLevel).filter(([id]) => visibleIds.has(id));
  const yearVals = [];
  visibleYearlyEntries.forEach(([, series]) => {
    const match = series.find(r => r.year === state.mapYear);
    if (match && match[state.climateVar] !== undefined) yearVals.push(match[state.climateVar]);
  });
  statMeanEl.innerHTML = yearVals.length
    ? `${d3.mean(yearVals).toFixed(1)}<span class="unit">${varMeta.unit}</span>` : "—";

  // Trend across the selected year range only (defaults to all years)
  const allYears = new Set();
  visibleYearlyEntries.forEach(([, arr]) => arr.forEach(r => { if (isYearInRange(r.year)) allYears.add(r.year); }));
  const trendSeries = Array.from(allYears).sort().map(year => {
    let sum = 0, count = 0;
    visibleYearlyEntries.forEach(([, arr]) => {
      const match = arr.find(r => r.year === year);
      if (match && match[state.climateVar] !== undefined) { sum += match[state.climateVar]; count++; }
    });
    return { year, value: count ? sum / count : undefined };
  });
  renderTrend(trendSeries);
}

function renderTrend(series) {
  const pts = series.filter(d => d.value !== undefined && !isNaN(d.value));
  statTrendLabelEl.textContent = `(${state.yearRangeStart}-${state.yearRangeEnd}) trend`;
  if (pts.length < 2) { statTrendEl.innerHTML = "—"; return; }

  const xMean = d3.mean(pts, d => d.year);
  const yMean = d3.mean(pts, d => d.value);
  const slope = d3.sum(pts, d => (d.year - xMean) * (d.value - yMean)) / d3.sum(pts, d => (d.year - xMean) ** 2);
  const totalChange = slope * (pts[pts.length - 1].year - pts[0].year);

  const dir = totalChange > 0.05 ? "up" : totalChange < -0.05 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
  const varMeta = CLIMATE_VARS[state.climateVar];

  statTrendEl.className = `stat-trend ${dir}`;
  statTrendEl.innerHTML = `${arrow} ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(2)} ${varMeta.unit}`;
}

/* ── BREADCRUMB ──────────────────────────────────────────────────── */

function updateBreadcrumb() {
  const dataset = state.datasets[state.dataset];
  breadcrumb.innerHTML = "";
  for (let i = 0; i <= state.currentLevel; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      breadcrumb.appendChild(sep);
    }
    const crumb = document.createElement("span");
    const isCurrent = i === state.currentLevel;
    crumb.className = isCurrent ? "crumb current" : "crumb";
    crumb.textContent = i === 0
      ? (state.dataset === "basins" ? "Nile Basin" : "Countries")
      : (i === 1 && state.dataset === "basins")
      ? "Subbasins"
      : (state.drilldownParentName || `Level ${i}`);
    if (!isCurrent) {
      crumb.onclick = () => { while (state.currentLevel > i) zoomOut(); };
    }
    breadcrumb.appendChild(crumb);
  }
}

/* ── LEGEND ──────────────────────────────────────────────────────── */

function buildLegend(extent, { mode = "population", varMeta = null } = {}) {
  currentLegendExtent = extent;
  const el = document.getElementById("nc-legend-gradient");
  const stops = d3.range(0, 1.01, 0.1).map(t => colorScale(extent[0] + t * (extent[1] - extent[0])));
  el.style.background = `linear-gradient(to right, ${stops.join(",")})`;

  const labelEl = document.getElementById("nc-legend-label");
  const ticksEl = document.getElementById("nc-legend-ticks");
  ticksEl.innerHTML = "";

  // Pick a "nice" tick step so labels read like the reference legend
  // (e.g. -2°C, -1°C, 0°C, 1°C, 2°C) rather than raw min/max only.
  function renderTicks(lo, hi, fmt) {
    const span = hi - lo;
    if (!isFinite(span) || span <= 0) return;
    const rawStep = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceNorm = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    const step = niceNorm * mag;
    const first = Math.ceil(lo / step) * step;
    for (let v = first; v <= hi + 1e-9; v += step) {
      const pct = ((v - lo) / span) * 100;
      const tick = document.createElement("span");
      tick.style.left = `${Math.min(99, Math.max(1, pct))}%`;
      tick.textContent = fmt(v);
      ticksEl.appendChild(tick);
    }
  }

  if (mode === "population") {
    labelEl.textContent = "POPULATION";
    renderTicks(extent[0], extent[1], v => `${(v / 1e6).toFixed(1)}M`);
  } else {
    labelEl.textContent = `${varMeta.label.toUpperCase()} (${varMeta.unit})`;
    renderTicks(extent[0], extent[1], v => `${v.toFixed(1)} ${varMeta.unit}`);
  }
}

/* ════════════════════════════════════════════════════════════════════
   EVENT WIRING
   ════════════════════════════════════════════════════════════════════ */

// ── CLIMATE VARIABLE
varSelect.addEventListener("change", (e) => {
  state.climateVar = e.target.value;
  updateView();
});

// ── DATASET TOGGLE ────────────────────────────────────────────────── 
document.getElementById("dataset-select").addEventListener("change", async (e) => {
  const newDataset = e.target.value;
  setStatus("Loading dataset...", "loading");
  try {
    await loadDataset(newDataset);
    state.dataset = newDataset;
    state.currentLevel = 0;          // reset zoom level
    state.drilldownParentName = null; // reset country drill-down filter
    state.granularity = "yearly";    // reset to yearly (safer default)
    document.getElementById("granularity-select").value = "yearly";
    chartZoomWindows = { yearly: null, monthly: null }; // dataset changed — old zoom windows no longer apply
    chartZoomAutoSwitched = false;
    clearTimeout(chartZoomSwitchTimer);
    dayRangeRowEl.style.display = "none";
    refreshVarSelectAvailability();
    backBtn.classList.remove("visible");
    setStatus("Ready");

    // Recompute projection for new geometry
    const dataset = state.datasets[state.dataset];
    const level0GeoJSON = getLevelData(0);
    geoProjection = d3.geoMercator().fitSize([state.width, state.height], level0GeoJSON);
    geoPathGen = d3.geoPath().projection(geoProjection);

    // Recompute population extent for new geometry (used when coloring by population)
    let allPops = [];
    Object.keys(dataset.hierarchy)
      .filter(k => k.startsWith("level"))
      .forEach(levelKey => {
        dataset.hierarchy[levelKey].features.forEach(f => allPops.push(f.properties.population));
      });
    state.popExtentAll = d3.extent(allPops);

    refreshMapLayers();
    updateView();
  } catch (e) {
    setStatus(`⚠ Error: ${e.message}`, "error");
    console.error(e);
  }
});

// ── GRANULARITY TOGGLE ────────────────────────────────────────────── 
document.getElementById("granularity-select").addEventListener("change", async (e) => {
  const rawValue = e.target.value;              // "yearly" | "yearly-compare" | "monthly" | "monthly-compare"
  const wantsCompare = rawValue.endsWith("-compare");
  // A manual granularity change supersedes any zoom-driven state.
  chartZoomWindows = { yearly: null, monthly: null };
  chartZoomAutoSwitched = false;
  clearTimeout(chartZoomSwitchTimer);
  state.granularity = rawValue.startsWith("monthly") ? "monthly" : "yearly";
  setCompareModeEnabled(wantsCompare);

  if (state.granularity === "yearly" && !wantsCompare) {
    // Yearly trend, non-compare: the window always runs through to the
    // latest year — the handle only ever moves the start.
    applyYearRange(state.yearRangeStart, YEAR_RANGE.max);
  }

  yearRangeRowEl.querySelector("#year-range-hint").textContent = state.granularity === "monthly"
    ? "Drag both handles apart to pick a second year — then set each year's date below."
    : wantsCompare
    ? "Drag both handles apart to compare two years side by side."
    : "Drag the handle to set the start year — the window always runs through 2025.";
  dayRangeRowEl.style.display = state.granularity === "monthly" ? "flex" : "none";
  refreshVarSelectAvailability();
  if (state.granularity === "monthly") {
    // Two different years can now stay selected in daily view — each
    // year gets its own day-of-year pick via the two day-range handles
    // (see applyDayRange), instead of forcing a collapse to one year.
    await Promise.all([
      ensureDailyDataLoaded(state.yearRangeStart),
      ensureDailyDataLoaded(state.yearRangeEnd),
    ]);
    refreshDayRangeUI();
    updateView();
  } else {
    updateView();
  }

  if (rawValue === "yearly-video") {
    // Jump to the Year Grid tab and immediately play the whole timeline
    // as a 1-year-per-second video for whichever variable is selected,
    // instead of requiring a tile click first.
    const gridTabEl = tabsEl.querySelector('.nc-tab[data-tab="grid"]');
    if (gridTabEl && state.activeTab !== "grid") {
      state.activeTab = "grid";
      state.chartHoveredId = null;
      tabsEl.querySelectorAll(".nc-tab").forEach(t => t.classList.toggle("active", t === gridTabEl));
      moveTabsThumb();
      renderActiveTab();
    }
    const dataset = state.datasets[state.dataset];
    if (dataset) {
      const levelKey = getLevelKey(state.currentLevel);
      const visibleFeatures = getVisibleFeatures(dataset, levelKey);
      openYearFullscreen(dataset, levelKey, visibleFeatures, state.mapYear || YEAR_RANGE.min, { forceYearly: true });
    }
  }
});

document.getElementById("chart-toggle-mean").addEventListener("change", (e) => {
  state.chartShowMean = e.target.checked;
  renderActiveTab();
});
document.getElementById("chart-toggle-trend").addEventListener("change", (e) => {
  state.chartShowTrend = e.target.checked;
  renderActiveTab();
});

// ── TIME PERIOD (dual-handle, drives the main view) ──────────────────
// The two handles are now the primary navigation control, not just a
// trend-restriction filter. When they're equal, the app shows a single
// point in time as before. When they differ, it shows a true before/after
// comparison (two maps side by side; a windowed chart/table) — the
// underlying mean/trend/gradient filtering (isYearInRange/isDayInRange)
// was already written generically enough to support this unchanged.
function applyYearRange(start, end) {
  start = Math.max(YEAR_RANGE.min, Math.min(start, YEAR_RANGE.max));
  end = Math.max(YEAR_RANGE.min, Math.min(end, YEAR_RANGE.max));
  if (start > end) [start, end] = [end, start];

  state.yearRangeStart = start;
  state.yearRangeEnd = end;
  // "Current year" reference for single-value contexts (hover, map coloring).
  // In yearly trend, non-compare mode the handle only moves the start year
  // (end is pinned to the latest year), so that's the year being browsed —
  // everywhere else (compare mode, monthly/daily mode) it's still the end.
  state.mapYear = (state.granularity === "yearly" && !state.compareModeEnabled) ? start : end;
  syncYearRangeSliderUI(start, end);
  if (state.granularity === "monthly") refreshDayRangeUI();

  if (state.granularity === "monthly") {
    Promise.all([
      ensureDailyDataLoaded(state.yearRangeStart),
      ensureDailyDataLoaded(state.yearRangeEnd),
    ]).then(updateView);
  } else {
    updateView();
  }
}

function syncYearRangeSliderUI(start, end) {
  yearRangeSliderMin.value = start;
  yearRangeSliderMax.value = end;
  // In yearly trend, non-compare mode, the single handle only moves the
  // start year (end is pinned to the latest year) — so the visible slider
  // should track start, not end, or dragging it would look like it jumps
  // back to the pinned end every time.
  yearSingleSlider.value = (state.granularity === "yearly" && !state.compareModeEnabled) ? start : end;
  const span = YEAR_RANGE.max - YEAR_RANGE.min || 1;
  const pctStart = ((start - YEAR_RANGE.min) / span) * 100;
  const pctEnd   = ((end   - YEAR_RANGE.min) / span) * 100;
  yearRangeProgressEl.style.left = pctStart + "%";
  yearRangeProgressEl.style.width = (pctEnd - pctStart) + "%";
  yearRangeHandleLabelStart.textContent = start;
  yearRangeHandleLabelEnd.textContent = end;
  yearRangeHandleLabelStart.style.left = pctStart + "%";
  yearRangeHandleLabelEnd.style.left = pctEnd + "%";
}
document.getElementById("year-range-bound-min").textContent = YEAR_RANGE.min;
document.getElementById("year-range-bound-max").textContent = YEAR_RANGE.max;
yearRangeSliderMin.min = yearRangeSliderMax.min = yearSingleSlider.min = YEAR_RANGE.min;
yearRangeSliderMin.max = yearRangeSliderMax.max = yearSingleSlider.max = YEAR_RANGE.max;
syncYearRangeSliderUI(state.yearRangeStart, state.yearRangeEnd);

// Not in compare mode: a single handle picks one year (dual-thumb range
// would misleadingly suggest a span). Compare mode: dual-thumb range so
// both endpoints of the comparison can be dragged independently.
function refreshYearRangeMode() {
  if (state.compareModeEnabled) {
    yearRangeDualWrap.style.display = "block";
    yearSingleWrap.style.display = "none";
  } else {
    yearRangeDualWrap.style.display = "none";
    yearSingleWrap.style.display = "block";
    // Yearly trend, non-compare: the handle represents the *start* year
    // (the window always runs through YEAR_RANGE.max), so show start —
    // not mapYear/end — or the slider would jump to the wrong spot every
    // time this refreshes (e.g. after leaving compare mode).
    yearSingleSlider.value = state.granularity === "yearly" ? state.yearRangeStart : state.mapYear;
  }
}
refreshYearRangeMode();

yearSingleSlider.addEventListener("input", () => {
  const v = parseInt(yearSingleSlider.value, 10);
  if (state.granularity === "yearly") {
    applyYearRange(v, YEAR_RANGE.max); // window always runs through the latest year
  } else {
    applyYearRange(v, v);
  }
});

// Clicking/grabbing a year handle marks it "active" so that, once the two
// years differ, the day timeline knows which year's date it's currently
// editing (see refreshDayRangeUI). Uses pointerdown so it fires even if
// the click doesn't end up changing the handle's value.
yearRangeSliderMin.addEventListener("pointerdown", () => {
  state.activeYearHandle = "start";
  if (state.granularity === "monthly") refreshDayRangeUI();
});
yearRangeSliderMax.addEventListener("pointerdown", () => {
  state.activeYearHandle = "end";
  if (state.granularity === "monthly") refreshDayRangeUI();
});

yearRangeSliderMin.addEventListener("input", () => {
  let v = parseInt(yearRangeSliderMin.value, 10);
  const maxV = parseInt(yearRangeSliderMax.value, 10);
  if (v > maxV) v = maxV; // keep handles from crossing
  applyYearRange(v, maxV);
});
yearRangeSliderMax.addEventListener("input", () => {
  let v = parseInt(yearRangeSliderMax.value, 10);
  const minV = parseInt(yearRangeSliderMin.value, 10);
  if (v < minV) v = minV; // keep handles from crossing
  applyYearRange(minV, v);
});

// ── DAY-OF-YEAR PICKER ──────────────────────────────────────────────
// Three distinct modes, decided by refreshDayRangeUI():
//   1. sameDateMode ON            → single slider, one date, locked to
//      both years. Year handles stay freely movable.
//   2. sameDateMode OFF, one year → original dual-thumb slider: two dates
//      compared WITHIN that single year (the classic use case).
//   3. sameDateMode OFF, two different years → single slider that edits
//      whichever year's date was last "activated" by clicking that year's
//      handle (state.activeYearHandle). The other year keeps its
//      previously-chosen date in the background until you click its
//      handle to edit it too.
function applyDayRange(start, end) {
  start = Math.max(1, Math.min(start, 365));
  end = Math.max(1, Math.min(end, 365));

  if (state.sameDateMode) {
    end = start; // locked together — one date, applied to both years
  } else if (state.yearRangeStart === state.yearRangeEnd) {
    if (start > end) [start, end] = [end, start]; // classic within-year compare, order doesn't matter
  }
  // else: two different years, start/end are independent per-year dates — never swapped/forced together

  state.dayRangeStart = start;
  state.dayRangeEnd = end;
  state.mapDay = end; // "current"/reference day for single-value contexts (hover, playhead)
  syncDayRangeSliderUI(start, end);
  updateView();
}

function refreshDayRangeUI() {
  const crossYear = state.yearRangeStart !== state.yearRangeEnd;

  if (state.sameDateMode) {
    dayRangeDualWrap.style.display = "none";
    daySingleWrap.style.display = "block";
    daySingleContextLabel.style.display = "block";
    daySingleSlider.value = state.dayRangeStart;
    daySingleContextLabel.textContent = crossYear
      ? `Same date applied to both ${state.yearRangeStart} and ${state.yearRangeEnd}`
      : `Date for ${state.yearRangeStart}`;
  } else if (!crossYear) {
    // Single year selected — restore the classic two-dates-in-one-year comparison.
    dayRangeDualWrap.style.display = "block";
    daySingleWrap.style.display = "none";
    daySingleContextLabel.style.display = "none";
  } else {
    // Two different years — edit one year's date at a time, chosen by
    // whichever year handle was last clicked.
    dayRangeDualWrap.style.display = "none";
    daySingleWrap.style.display = "block";
    daySingleContextLabel.style.display = "block";
    const editingStart = state.activeYearHandle === "start";
    daySingleSlider.value = editingStart ? state.dayRangeStart : state.dayRangeEnd;
    daySingleContextLabel.textContent = `Editing date for ${editingStart ? state.yearRangeStart : state.yearRangeEnd} — click the other year handle above to set its date`;
  }

  syncDayRangeSliderUI(state.dayRangeStart, state.dayRangeEnd);
}

function syncDayRangeSliderUI(start, end) {
  dayRangeSliderMin.value = start;
  dayRangeSliderMax.value = end;
  const pctStart = ((start - 1) / 364) * 100;
  const pctEnd   = ((end   - 1) / 364) * 100;
  dayRangeProgressEl.style.left = pctStart + "%";
  dayRangeProgressEl.style.width = (pctEnd - pctStart) + "%";

  // Day-of-year handles only ever show the month/day — the year lives in
  // the separate year picker above, so repeating it here is redundant.
  dayRangeHandleLabelStart.textContent = dayOfYearFormatter(new Date(2001, 0, start));
  dayRangeHandleLabelEnd.textContent   = dayOfYearFormatter(new Date(2001, 0, end));
  dayRangeHandleLabelStart.style.left = pctStart + "%";
  dayRangeHandleLabelEnd.style.left = pctEnd + "%";
  // In same-date mode start === end, so both labels sit on top of each
  // other and garble together — show just the one shared label.
  dayRangeHandleLabelEnd.style.display = state.sameDateMode ? "none" : "";

  const staticHintEl = document.getElementById("day-range-static-hint");
  if (staticHintEl) {
    const crossYear = state.yearRangeStart !== state.yearRangeEnd;
    staticHintEl.textContent = state.sameDateMode
      ? "Drag the year handles above to compare this same date across different years."
      : crossYear
      ? "Click a year handle above, then drag the slider below to set that year's date."
      : "Drag both handles apart to compare two days side by side (within the selected year).";
  }
}
syncDayRangeSliderUI(state.dayRangeStart, state.dayRangeEnd);

dayRangeSliderMin.addEventListener("input", () => {
  let v = parseInt(dayRangeSliderMin.value, 10);
  const maxV = parseInt(dayRangeSliderMax.value, 10);
  if (v > maxV) v = maxV;
  applyDayRange(v, maxV);
});
dayRangeSliderMax.addEventListener("input", () => {
  let v = parseInt(dayRangeSliderMax.value, 10);
  const minV = parseInt(dayRangeSliderMin.value, 10);
  if (v < minV) v = minV;
  applyDayRange(minV, v);
});

daySingleSlider.addEventListener("input", () => {
  const v = parseInt(daySingleSlider.value, 10);
  if (state.sameDateMode) {
    applyDayRange(v, v);
  } else if (state.yearRangeStart === state.yearRangeEnd) {
    applyDayRange(v, v);
  } else if (state.activeYearHandle === "start") {
    applyDayRange(v, state.dayRangeEnd);
  } else {
    applyDayRange(state.dayRangeStart, v);
  }
});

sameDateToggle.addEventListener("change", (e) => {
  state.sameDateMode = e.target.checked;
  if (state.sameDateMode) {
    // Turning this on both locks the date across years AND is the trigger
    // for showing a second year handle — so make sure compare mode is on,
    // and if the two year handles are still sitting on the same year,
    // automatically split them apart onto a different year to compare
    // against (10 years back by default, or forward if that undershoots
    // the dataset's earliest year).
    if (!state.compareModeEnabled) setCompareModeEnabled(true);
    if (state.yearRangeStart === state.yearRangeEnd) {
      const current = state.yearRangeStart;
      let other = current - 10;
      if (other < YEAR_RANGE.min) other = current + 10;
      other = Math.max(YEAR_RANGE.min, Math.min(other, YEAR_RANGE.max));
      applyYearRange(Math.min(current, other), Math.max(current, other));
    }
    // Collapse to one shared date immediately (use whichever handle was
    // "current" — dayRangeEnd/state.mapDay — as the locked-in date).
    applyDayRange(state.mapDay, state.mapDay);
  } else {
    refreshDayRangeUI();
    updateView();
  }
});

// ── COMPARE MODE TOGGLE ───────────────────────────────────────────────
function setCompareModeEnabled(enabled) {
  state.compareModeEnabled = enabled;
  compareModeToggle.checked = enabled;
  if (!enabled) {
    sameDateToggle.checked = false;
    state.sameDateMode = false;
  }
  if (enabled && state.yearRangeStart === state.yearRangeEnd) {
    // Turning compare mode on with both year handles sitting on the same
    // year would otherwise show two knobs stacked on top of each other —
    // split them apart onto a different year (10 years back by default,
    // or forward if that undershoots the dataset's earliest year), same
    // as the "same date across years" toggle does.
    const current = state.yearRangeStart;
    let other = current - 10;
    if (other < YEAR_RANGE.min) other = current + 10;
    other = Math.max(YEAR_RANGE.min, Math.min(other, YEAR_RANGE.max));
    applyYearRange(Math.min(current, other), Math.max(current, other));
  }
  if (enabled && state.granularity === "monthly" && !state.sameDateMode &&
      state.yearRangeStart === state.yearRangeEnd && state.dayRangeStart === state.dayRangeEnd) {
    // Same fix for the classic within-year daily comparison: don't let
    // both day-of-year handles land on the same date.
    let otherDay = state.dayRangeStart - 30;
    if (otherDay < 1) otherDay = state.dayRangeStart + 30;
    otherDay = Math.max(1, Math.min(otherDay, 365));
    applyDayRange(Math.min(state.dayRangeStart, otherDay), Math.max(state.dayRangeStart, otherDay));
  }
  if (!enabled && state.granularity === "monthly" && state.yearRangeStart !== state.yearRangeEnd) {
    // Collapse to a single year when leaving compare mode. Without this,
    // yearRangeStart/yearRangeEnd can stay unequal (e.g. the 1983/2025
    // defaults) even though the year slider now shows a single handle —
    // and the day-of-year picker uses that inequality to decide whether
    // it's in "two different years" mode, which would wrongly collapse
    // its own dual handles into a single one.
    applyYearRange(state.yearRangeEnd, state.yearRangeEnd);
  } else if (!enabled && state.granularity === "yearly" && state.yearRangeEnd !== YEAR_RANGE.max) {
    // Yearly trend, non-compare: the window always runs through the
    // latest year. Without this, an end year left over from compare mode
    // (e.g. a dual-range drag stopped at 2010) would stick around instead
    // of snapping back to YEAR_RANGE.max.
    applyYearRange(state.yearRangeStart, YEAR_RANGE.max);
  }
  refreshYearRangeMode();
  // "Compare same date across years" only makes sense once two years are
  // actually being compared — hide it in non-compare daily mode instead
  // of leaving it clickable with nothing to lock together.
  compareAcrossYearsRow.style.display = enabled ? "flex" : "none";
  if (state.granularity === "monthly") refreshDayRangeUI();
  updateCompareHints();
  updateView();
}
function updateCompareHints() {
  const yearHint = yearRangeRowEl.querySelector("#year-range-hint");
  if (state.granularity === "monthly") {
    yearHint.textContent = "Picks which year's daily data to show.";
  } else if (!state.compareModeEnabled) {
    yearHint.textContent = "Drag the handle to set the start year — the window always runs through 2025.";
  } else {
    yearHint.textContent = state.yearRangeStart !== state.yearRangeEnd
      ? "Comparing two years side by side. Drag handles together to go back to a single year."
      : "Drag both handles apart to compare two years side by side.";
  }
}
compareModeToggle.addEventListener("change", (e) => setCompareModeEnabled(e.target.checked));
updateCompareHints();

// ── TIMELINE DRAWER (collapsed by default; click the compact readout to expand) ──
timelineReadoutBtn.addEventListener("click", () => {
  const willExpand = document.getElementById("nc-timeline-body").style.display === "none";
  document.getElementById("nc-timeline-body").style.display = willExpand ? "flex" : "none";
  timelineDrawerEl.classList.toggle("expanded", willExpand);
});

// ── DRAGGABLE WINDOW (pan both handles together, keeping their width) ──
// Clicking the highlighted bar between the two handles and dragging moves
// the whole window left/right instead of resizing it — the width (end -
// start) is preserved, and the drag clamps against the slider's bounds.
function makeRangeBarDraggable(progressEl, trackWrapEl, { min, max, getStart, getEnd, apply }) {
  let dragging = false;
  let dragStartX = 0;
  let dragStartRange = 0;
  let dragStartValue = 0;

  const valuePerPixel = () => {
    const rect = trackWrapEl.getBoundingClientRect();
    return (max - min) / (rect.width || 1);
  };

  function onPointerDown(e) {
    dragging = true;
    progressEl.classList.add("dragging");
    dragStartX = e.clientX;
    dragStartRange = getEnd() - getStart();
    dragStartValue = getStart();
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    e.preventDefault(); // don't let the click fall through to the underlying range inputs
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const deltaPx = e.clientX - dragStartX;
    const deltaVal = Math.round(deltaPx * valuePerPixel());
    let newStart = dragStartValue + deltaVal;
    // Clamp the whole window (not just one edge) so the width never changes
    // mid-drag — hitting a bound stops the pan rather than shrinking it.
    newStart = Math.max(min, Math.min(newStart, max - dragStartRange));
    apply(newStart, newStart + dragStartRange);
  }
  function onPointerUp() {
    dragging = false;
    progressEl.classList.remove("dragging");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }
  progressEl.addEventListener("pointerdown", onPointerDown);
}

makeRangeBarDraggable(yearRangeProgressEl, yearRangeProgressEl.parentElement, {
  min: YEAR_RANGE.min, max: YEAR_RANGE.max,
  getStart: () => state.yearRangeStart, getEnd: () => state.yearRangeEnd,
  apply: applyYearRange,
});
makeRangeBarDraggable(dayRangeProgressEl, dayRangeProgressEl.parentElement, {
  min: 1, max: 365,
  getStart: () => state.dayRangeStart, getEnd: () => state.dayRangeEnd,
  apply: applyDayRange,
});

// ── PLAYBACK — advances the whole window forward, keeping its width,
// wrapping around at the bounds. In compare mode this animates both
// snapshots forward together; in single-point mode it's a normal time-lapse.
function setPlayingIcon() {
  const icon = playing ? "⏸" : "▶";
  playBtn.textContent = icon;
  dayPlayBtn.textContent = icon;
}

function togglePlay() {
  playing = !playing;
  setPlayingIcon();
  if (playing) {
    playInterval = setInterval(() => {
      if (state.granularity === "monthly") {
        const span = state.dayRangeEnd - state.dayRangeStart;
        let start = state.dayRangeStart + 1, end = state.dayRangeEnd + 1;
        if (end > 365) { start = 1; end = 1 + span; }
        applyDayRange(start, end);
      } else if (state.granularity === "yearly" && !state.compareModeEnabled) {
        // Non-compare: end stays pinned to the latest year, so playback
        // only advances the start year (wrapping back to the earliest).
        let start = state.yearRangeStart + 1;
        if (start > YEAR_RANGE.max) start = YEAR_RANGE.min;
        applyYearRange(start, YEAR_RANGE.max);
      } else {
        const span = state.yearRangeEnd - state.yearRangeStart;
        let start = state.yearRangeStart + 1, end = state.yearRangeEnd + 1;
        if (end > YEAR_RANGE.max) { start = YEAR_RANGE.min; end = YEAR_RANGE.min + span; }
        applyYearRange(start, end);
      }
    }, 700);
  } else {
    clearInterval(playInterval);
  }
}

playBtn.addEventListener("click", togglePlay);
dayPlayBtn.addEventListener("click", togglePlay);

// ── ZOOM CONTROLS
backBtn.addEventListener("click", zoomOut);

// Manual free-zoom buttons (in addition to scroll/pinch, which the
// d3.zoom behavior already supports). These zoom in/out around the
// center of the map rather than requiring the mouse position, so they
// work the same from a trackpad, touch screen, or plain click.
zoomInBtn.addEventListener("click", () => {
  svg.transition().duration(220).call(zoomBehavior.scaleBy, 1.6);
});
zoomOutBtn.addEventListener("click", () => {
  svg.transition().duration(220).call(zoomBehavior.scaleBy, 1 / 1.6);
});
zoomResetBtn.addEventListener("click", () => {
  svg.transition().duration(320).call(zoomBehavior.transform, d3.zoomIdentity);
});

const tabsThumbEl = document.getElementById("nc-tabs-thumb");
function moveTabsThumb() {
  const activeEl = tabsEl.querySelector(".nc-tab.active");
  if (!activeEl || !tabsThumbEl) return;
  tabsThumbEl.style.width = activeEl.offsetWidth + "px";
  tabsThumbEl.style.transform = `translateX(${activeEl.offsetLeft - 3}px)`;
}
tabsEl.querySelectorAll(".nc-tab").forEach(tabEl => {
  tabEl.addEventListener("click", () => {
    state.activeTab = tabEl.dataset.tab;
    state.chartHoveredId = null;
    tabsEl.querySelectorAll(".nc-tab").forEach(t => t.classList.toggle("active", t === tabEl));
    moveTabsThumb();
    renderActiveTab();
  });
});
moveTabsThumb();
window.addEventListener("resize", moveTabsThumb);

// ── MAP OPTIONS: country outlines, base map, color-by ─────────────
optCountryOutline.addEventListener("change", (e) => {
  state.showCountryOutline = e.target.checked;
  updateCountryOutline();
});

colorbyVariableBtn.addEventListener("click", () => {
  state.colorBy = "variable";
  colorbyVariableBtn.classList.add("active");
  colorbyPopulationBtn.classList.remove("active");
  renderMap();
});
colorbyPopulationBtn.addEventListener("click", () => {
  state.colorBy = "population";
  colorbyPopulationBtn.classList.add("active");
  colorbyVariableBtn.classList.remove("active");
  renderMap();
});

svg.on("click", (event) => {
  if (event.target.tagName === "svg" || event.target.classList.contains("zoom-layer")) {
    if (state.currentLevel > 0) zoomOut();
  }
});

// ── INIT
init();