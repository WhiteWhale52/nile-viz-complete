#!/usr/bin/env python3
"""
extract_hierarchical.py

Converts multi-level shapefiles + population raster + climate .nc files
into a hierarchy.json (geometry + metadata) and a partitioned Parquet
dataset (flat climate time series table) ready for the interactive chart.

BEFORE RUNNING:
1. Edit the CONFIG section below to match your actual file paths and column names
2. Ensure all shapefiles, raster, and .nc files exist and are readable
3. Run: pip install xarray netcdf4 geopandas regionmask rasterstats rasterio numpy pandas pyarrow

Outputs:
  data/hierarchy.json              — geometry + metadata for all hierarchy levels
  data/climate_parquet/level=N/*.parquet  — flat climate time series table,
                                             partitioned by level only
"""

import json
import sys
import numpy as np
import xarray as xr
import geopandas as gpd
import regionmask
from rasterstats import zonal_stats
import time
from affine import Affine
import pandas as pd
from pathlib import Path

from rasterio.features import geometry_mask
import rasterio
import warnings

warnings.filterwarnings("ignore", message=".*rasterize.*")
warnings.filterwarnings("ignore", category=UserWarning)

# ════════════════════════════════════════════════════════════════════════════
# CONFIG — EDIT THESE TO MATCH YOUR DATA
# ════════════════════════════════════════════════════════════════════════════

BASE_DIR = Path(__file__).resolve().parent

GPKG_DIR = BASE_DIR / "GKPKG"
POPULATION_DIR = BASE_DIR / "Population"
NETCDF_DIR = Path("D:/Climate Data")
OUTPUT_DIR = BASE_DIR / "data"

# Two population rasters:
#   - basin-clipped raster, used for the "basins" dataset
#   - full-extent raster, used for whole-country population/area on "countries"
POPULATION_RASTER_BASIN = POPULATION_DIR / "NileBasinPop.tif"
POPULATION_RASTER_COUNTRY = POPULATION_DIR / "GroupedCountriesPop.tif"  # ⚠ UPDATE to your real filename

# ────────────────────────────────────────────────────────────────────────────
# LEVEL_SETS: one entry per independent dataset the frontend can switch
# between ("Basins" vs "Countries"). Each dataset needs TWO keys:
#   "levels"            — list of per-level shapefile configs (as before)
#   "population_raster" — which raster to run zonal population stats against
#
# No geometric clipping is applied anywhere — each region (basin OR
# country) always uses its full, unmodified shapefile geometry, for both
# population/area AND climate. Your NetCDF climate files were already
# spatially prepared during your QGIS preprocessing, so any part of a
# country outside the actual Nile basin naturally comes back as NaN from
# the source data itself — no extra basin-intersection logic needed.
# ────────────────────────────────────────────────────────────────────────────
LEVEL_SETS = {
    "basins": {
        "levels": [
            {"id": 0, "shapefile": GPKG_DIR / "NileBasin.gpkg", "name_field": "Name", "id_field": "ID", "area": "Area", "description": "Nile Basin (whole)"},
            {"id": 1, "shapefile": GPKG_DIR / "SubBasins.gpkg", "name_field": "name", "id_field": "hybas_id", "area": "area", "description": "Nile Basins (sub-basins)"},
        ],
        "population_raster": POPULATION_RASTER_BASIN,
    },
    "countries": {
        "levels": [
            {"id": 0, "shapefile": GPKG_DIR / "Country_View_Level_00.gpkg", "name_field": "ADM0_NAME", "id_field": "ADM0_CODE", "description": "Nile Countries"},
            {"id": 1, "shapefile": GPKG_DIR / "Country_View_Level_01.gpkg", "name_field": "ADM1_NAME", "id_field": "ADM1_CODE", "country_name": "ADM0_NAME", "description": "Nile Countries (admin-1)"},
        ],
        "population_raster": POPULATION_RASTER_COUNTRY,
    },
}

# Climate variables — templated across the full year range. {year} is
# substituted for each year in YEAR_RANGE. Update YEAR_RANGE to match
# how many years of .nc files you actually have.
YEAR_RANGE = range(1983, 2026)  # 1984 through 2023 inclusive

NC_FILES = {
    "tasmax": {
        "path_template": str(NETCDF_DIR / "tasmax_era5" / "tasmax_{year}.nc"),
        "var": "temp",
        "units": "C/day",
    },
    "tasmin": {
        "path_template": str(NETCDF_DIR / "tasmin_era5" / "tasmin_{year}.nc"),
        "var": "temp",
        "units": "C/day",
    },
    "pr": {
        "path_template": str(NETCDF_DIR / "ref_data_v3" / "precip_{year}.nc"),
        "var": "precip",
        "units": "mm/day",
    },
    "cid": {
        "path_template": str(NETCDF_DIR / "cid" / "cid_annual_{year}.nc"),
        "variables": "auto",  # auto-discover every (time, lat, lon) variable in the file
    },
}

# Output paths are generated per-dataset inside main() as:
#   OUTPUT_DIR / f"hierarchy_{dataset_name}.json"
#   OUTPUT_DIR / f"climate_parquet_{dataset_name}"
#   OUTPUT_DIR / f"climate_parquet_manifest_{dataset_name}.json"

# ════════════════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ════════════════════════════════════════════════════════════════════════════

def normalize_nc_coords(ds):
    """Normalize NetCDF longitude from [0, 360] to [-180, 180] if needed."""
    if (ds.lon.values > 180).any():
        print("    ⚠ Converting lon from [0, 360] to [-180, 180]...")
        ds['lon'] = (ds.lon.values + 180) % 360 - 180
        ds = ds.sortby('lon')
    return ds


def check_spatial_overlap(gdf, da, level_key):
    """Debug function: check if GeoJSON and .nc grid actually overlap."""
    bounds = gdf.total_bounds
    print(f"\n    [DEBUG {level_key}]")
    print(f"      GeoJSON extent:  Lon [{bounds[0]:.2f}, {bounds[2]:.2f}]  Lat [{bounds[1]:.2f}, {bounds[3]:.2f}]")
    print(f"      .nc grid extent: Lon [{da.lon.values.min():.2f}, {da.lon.values.max():.2f}]  "
          f"Lat [{da.lat.values.min():.2f}, {da.lat.values.max():.2f}]")
    lon_overlap = not (bounds[2] < da.lon.values.min() or bounds[0] > da.lon.values.max())
    lat_overlap = not (bounds[3] < da.lat.values.min() or bounds[1] > da.lat.values.max())
    if not (lon_overlap and lat_overlap):
        print(f"      ⚠ WARNING: No spatial overlap detected!")
        print(f"        Lon overlap: {lon_overlap}, Lat overlap: {lat_overlap}")
    else:
        print(f"      ✓ Spatial extents overlap (good)")


def convert_units(da, units):
    if units == "kelvin":
        return da - 273.15
    if units == "kg_m2_s":
        return da * 86400.0
    return da

def discover_climate_vars(ds):
    """
    Discover every climate variable in `ds` that has spatial dimensions,
    and classify its temporal resolution from the length of its time axis.
 
    Returns a list of dicts:
        [{"name": "tasmean", "resolution": "daily", "time_length": 365}, ...]
    """
    variables = []
 
    for name, da in ds.data_vars.items():
        if {"time", "lat", "lon"} - set(da.dims):
            continue
 
        t = da.sizes["time"]
 
        if t > 300:
            resolution = "daily"
        elif t >= 12:
            resolution = "monthly"
        else:
            resolution = "annual"
 
        variables.append({
            "name": name,
            "resolution": resolution,
            "time_length": t,
        })
 
    return variables
 
 

def prepare_variable(ds, var_name):
    """
    Return a DataArray for var_name normalized to (time, lat, lon) dims,
    regardless of whether the source variable was stored as
    (time, lat, lon) or (lat, lon, time) — some CID indicators
    (e.g. spi_12_amdd, spei_12_adm) use the latter.
    """
    da = ds[var_name]
    if da.dims != ("time", "lat", "lon"):
        da = da.transpose("time", "lat", "lon")
    return da


def format_time_strings(times, resolution):

    if resolution == "daily":
        return [
            pd.Timestamp(t).strftime("%Y-%m-%d")
            for t in times
        ]

    if resolution == "monthly":
        return [
            pd.Timestamp(t).strftime("%Y-%m")
            for t in times
        ]

    return [
        str(pd.Timestamp(times[0]).year)
    ]

def spatial_mean_by_region(data_flat, valid_labels, n_regions):
    """
    Compute the per-region mean for every timestep in one shot via
    np.bincount, instead of looping over regions. Cost is
    O(n_time * n_valid_pixels), independent of n_regions.
 
    data_flat: (n_time, n_valid_pixels) array, already subset to pixels
               that belong to some region.
    valid_labels: (n_valid_pixels,) region index for each of those pixels.
    """
    n_time = data_flat.shape[0]
    means = np.full((n_time, n_regions), np.nan, dtype=np.float64)
 
    for t in range(n_time):
        vals_t = data_flat[t]
        good = ~np.isnan(vals_t)
        if not good.any():
            continue
 
        labs_t = valid_labels[good]
        v_t = vals_t[good]
 
        sums = np.bincount(labs_t, weights=v_t, minlength=n_regions)
        counts = np.bincount(labs_t, minlength=n_regions)
 
        with np.errstate(invalid="ignore", divide="ignore"):
            row_means = sums / counts
        row_means[counts == 0] = np.nan
 
        means[t] = row_means
 
    return means
 
def get_dataset_variables(ds, cfg, dataset_key=None):
    """
    Returns a list of {"name": ..., "output_key": ..., "resolution": ...}
    dicts for the variables this dataset config wants extracted.

    "name" is the variable name as stored INSIDE the NetCDF file (used to
    read the data). "output_key" is the column name written to the output
    table (used by the frontend, e.g. "tasmax"/"tasmin"). These are NOT
    always the same string — e.g. both the tasmax and tasmin source files
    store their data under an internal variable literally called "temp",
    so using "name" as the output column too would make both datasets
    collide into a single "temp" column and silently clobber each other.

    - cfg with no "variables" key: single fixed variable, assumed daily
      (matches legacy single-var configs like ERA5). Output column is the
      outer NC_FILES key (dataset_key), NOT cfg["var"].
    - cfg["variables"] == "auto": discover from the dataset itself
      (e.g. CID files that may mix daily/monthly/annual variables).
      Output column is the variable's own name (already unique).
    - cfg["variables"] == [...]: fixed variable list, assumed daily.
      Output column is the variable's own name.
    """
    if "variables" not in cfg:
        return [{"name": cfg["var"], "output_key": dataset_key, "resolution": "daily"}]
 
    if cfg["variables"] == "auto":
        return [{**v, "output_key": v["name"]} for v in discover_climate_vars(ds)]
 
    return [{"name": v, "output_key": v, "resolution": "daily"} for v in cfg["variables"]]
 

def build_region_label_array(gdf, geojson, level_cfg, da):
    """
    Build ONE label array for the current grid, instead of one boolean
    mask per region. label_array has the same (lat, lon) shape as the
    climate grid; each pixel holds the integer index of the region that
    owns it, or -1 if it belongs to no region.

    This is what makes the bincount-based aggregation in
    extract_timeseries_flat() possible: instead of looping over regions
    and doing a full-grid np.where/np.nanmean per region (cost scales as
    O(n_regions * n_pixels * n_timesteps)), we can compute every region's
    mean in one vectorized np.bincount call per timestep (cost scales as
    O(n_pixels * n_timesteps), independent of n_regions). For a level
    with thousands of small sub-basins this is the dominant cost, so this
    is the single biggest speedup available.

    Each region's FULL geometry is used as-is — no clipping against the
    basin boundary. Any part of a region (e.g. a country) that lies
    outside where the source NetCDF climate data actually has values
    naturally contributes NaN pixels, which the nanmean/bincount logic
    already skips — so "no climate data outside the basin, full
    population regardless" falls out of the source data itself, without
    needing any geometric intersection here.

    Returns:
        label_array : np.ndarray[int32], shape (lat_len, lon_len)
        region_ids  : list[str], region_ids[i] is the region_id owning
                      label value i (i.e. label_array == i)
    """
    print("    Building region label array...")

    lon_res = float(da.lon.values[1] - da.lon.values[0])
    lat_res = float(da.lat.values[1] - da.lat.values[0])

    affine_transform = (
        Affine.translation(
            float(da.lon.values[0]) - lon_res / 2,
            float(da.lat.values[0]) - lat_res / 2,
        )
        * Affine.scale(lon_res, lat_res)
    )

    lat_len = len(da.lat)
    lon_len = len(da.lon)

    label_array = np.full((lat_len, lon_len), -1, dtype=np.int32)
    region_ids = []
    idx = 0

    for feature in geojson["features"]:

        region_id = feature["properties"]["id"]

        match = gdf[
            gdf[level_cfg["id_field"]].astype(str).str.strip()
            == str(region_id).strip()
        ]

        if match.empty:
            continue

        geom = match.geometry.iloc[0]

        mask = geometry_mask(
            [geom],
            out_shape=(lat_len, lon_len),
            transform=affine_transform,
            invert=True,
        )

        if mask.sum() == 0:
            continue

        label_array[mask] = idx
        region_ids.append(region_id)
        idx += 1

    print(f"    ✓ Cached {len(region_ids)} region labels")

    return label_array, region_ids


def write_variable_rows(level_id, region_ids, means, dates, resolution, var_key):
    """
    Turn a (n_time, n_regions) means array + matching date labels into flat
    output rows, skipping regions that are entirely NaN and individual
    NaN timesteps within a region.
    """
    rows = []
    regions_processed = 0
    regions_skipped = 0
 
    for region_idx, region_id in enumerate(region_ids):
        column = means[:, region_idx]
 
        if np.all(np.isnan(column)):
            regions_skipped += 1
            continue
 
        for date_str, value in zip(dates, column):
            if np.isnan(value):
                continue
            rows.append({
                "level": level_id,
                "region_id": region_id,
                "date": date_str,
                "resolution": resolution,
                var_key: round(float(value), 3),
            })
 
        regions_processed += 1
 
    return rows, regions_processed, regions_skipped
 
 

def process_dataset_year(nc_path, cfg, dataset_key, level_id, region_ids,
                          valid_pixel_mask, valid_labels, n_regions):
    """
    Open one NetCDF file for one dataset/year, extract every discovered
    variable, aggregate spatially per region, and return flat output rows
    for that file. Returns [] (with a warning printed) if the file is
    missing or unreadable — never fatal.
    """
    try:
        ds = xr.open_dataset(nc_path, chunks="auto")
    except FileNotFoundError:
        print(f"    WARNING: file not found, skipping this year: {nc_path}")
        return []
    except Exception as e:
        print(f"    WARNING: could not open {nc_path}: {e} — skipping this year")
        return []
 
    ds = normalize_nc_coords(ds)
 
    var_list = get_dataset_variables(ds, cfg, dataset_key)
    missing = [v["name"] for v in var_list if v["name"] not in ds.data_vars]
    if missing:
        print(f"    WARNING: variables {missing} not found in {nc_path}, skipping them")
        print(f"      Available variables: {list(ds.data_vars)}")
        var_list = [v for v in var_list if v["name"] not in missing]
 
    file_rows = []
 
    for var_info in var_list:
        var_key = var_info["name"]           # name INSIDE the .nc file (for reading)
        out_key = var_info["output_key"]      # name written to the output table
        resolution = var_info["resolution"]
 
        print(f"\n  Processing {var_key} -> column '{out_key}' ({resolution}) ({nc_path})...")
 
        da = prepare_variable(ds, var_key)
        if "units" in cfg:
            da = convert_units(da, cfg["units"])
        da = da.sortby("lat", ascending=False)
 
        print("    Loading full array into memory...")
        load_start = time.time()
        data_all_days = da.values
        print(f"    ✓ Loaded in {time.time() - load_start:.2f}s  shape={data_all_days.shape}")
 
        n_time = data_all_days.shape[0]
 
        # Flatten spatial dims once, subset to region pixels only.
        data_flat = data_all_days.reshape(n_time, -1)[:, valid_pixel_mask]
 
        print(f"    Aggregating {n_regions} regions via bincount...")
        agg_start = time.time()
        means = spatial_mean_by_region(data_flat, valid_labels, n_regions)
        print(f"    ✓ Aggregated in {time.time() - agg_start:.2f}s")
 
        dates = format_time_strings(da.time.values, resolution)
 
        rows, processed, skipped = write_variable_rows(
            level_id, region_ids, means, dates, resolution, out_key
        )
        file_rows.extend(rows)
 
        print(f"    ✓ {processed} regions processed, {skipped} skipped")
 
    return file_rows
 

# ════════════════════════════════════════════════════════════════════════════
# STEP 1: Build hierarchy from shapefiles + population raster
# ════════════════════════════════════════════════════════════════════════════

def compute_population_sums(gdf, population_raster, raster_crs):
    """
    Vectorized zonal population sum: rasterize every region's geometry into
    ONE label array in a single pass (one rasterize call, one raster read),
    then aggregate per-region sums via np.bincount — instead of
    rasterstats.zonal_stats doing one windowed raster read PER POLYGON.

    For a level with hundreds/thousands of features (sub-basins, admin-1
    units), that per-feature I/O is the dominant cost and can turn a run
    that should take seconds into one that takes many minutes. This
    mirrors the same label-array + bincount trick already used for the
    climate NetCDF aggregation elsewhere in this file.

    Returns a list of population ints, aligned with gdf's row order.
    """
    from rasterio.features import rasterize

    gdf_for_zonal = gdf if gdf.crs == raster_crs else gdf.to_crs(raster_crs)

    with rasterio.open(population_raster) as src:
        transform = src.transform
        out_shape = (src.height, src.width)
        nodata = src.nodata if src.nodata is not None else -99999
        data = src.read(1).astype(np.float64)

    shapes = list(enumerate(gdf_for_zonal.geometry))
    shapes = [(geom, idx) for idx, geom in shapes]

    label_array = rasterize(
        shapes, out_shape=out_shape, transform=transform,
        fill=-1, dtype=np.int32,
    )

    valid = (label_array != -1) & (data != nodata) & ~np.isnan(data)
    sums = np.bincount(
        label_array[valid], weights=data[valid], minlength=len(gdf_for_zonal)
    )
    return [int(round(s)) for s in sums]


def build_hierarchy(levels, population_raster):
    """
    For each hierarchy level: load shapefile, compute population zonal
    stats against `population_raster`, compute area in km², build a
    GeoJSON FeatureCollection.
    """
    hierarchy = {}

    with rasterio.open(population_raster) as src:
        raster_crs = src.crs
    print(f"\nPopulation raster CRS: {raster_crs}")

    for level_cfg in levels:
        level_id = level_cfg["id"]
        level_key = f"level {level_id}"
        shapefile_path = level_cfg["shapefile"]
        name_field = level_cfg["name_field"]
        id_field = level_cfg["id_field"]

        print(f"\n{'='*70}")
        print(f"Processing {level_key}: {shapefile_path}")
        print(f"{'='*70}")

        try:
            gdf = gpd.read_file(shapefile_path)
        except FileNotFoundError:
            print(f"ERROR: Shapefile not found: {shapefile_path}")
            sys.exit(1)
        except Exception as e:
            print(f"ERROR reading shapefile: {e}")
            sys.exit(1)

        print(f"  Loaded {len(gdf)} features")
        print(f"  Shapefile CRS: {gdf.crs}")

        if name_field not in gdf.columns:
            print(f"ERROR: Column '{name_field}' not found in {shapefile_path}")
            print(f"  Available columns: {list(gdf.columns)}")
            sys.exit(1)
        if id_field not in gdf.columns:
            print(f"ERROR: Column '{id_field}' not found in {shapefile_path}")
            print(f"  Available columns: {list(gdf.columns)}")
            sys.exit(1)

        print(f"  Computing population per region (vectorized zonal sum on {population_raster})...")
        pop_start = time.time()
        try:
            pop_sums = compute_population_sums(gdf, population_raster, raster_crs)
        except FileNotFoundError:
            print(f"ERROR: Population raster not found: {population_raster}")
            sys.exit(1)
        except Exception as e:
            print(f"ERROR computing zonal statistics: {e}")
            sys.exit(1)
        print(f"  ✓ Population computed in {time.time() - pop_start:.2f}s")

        # Reproject the WHOLE gdf to an equal-area CRS ONCE for area calc,
        # instead of reprojecting one row at a time in a loop (same
        # per-feature-I/O mistake as the old zonal_stats call above, just
        # for area instead of population — also slow for many features).
        area_start = time.time()
        gdf_area = gdf.to_crs("EPSG:6933")
        area_km2_all = (gdf_area.geometry.area / 1e6).round().astype(int)
        print(f"  ✓ Area computed in {time.time() - area_start:.2f}s")

        # Build GeoJSON features directly from gdf (original CRS, e.g. 4326)
        features = json.loads(gdf.to_json())["features"]

        total_population = 0
        for feature, pop_int, area_km2, (_, row) in zip(features, pop_sums, area_km2_all, gdf.iterrows()):
            feature["properties"] = {}  # drop original shapefile columns, keep only what the frontend needs
            feature["properties"]["population"] = pop_int
            feature["properties"]["name"] = str(row[name_field])
            feature["properties"]["id"] = str(row[id_field])
            if "country_name" in level_cfg and level_cfg["country_name"] in row:
                feature["properties"]["parent_name"] = str(row[level_cfg["country_name"]])
            feature["properties"]["area_km2"] = int(area_km2)
            total_population += pop_int

        stats = features
        hierarchy[level_key] = {
            "type": "FeatureCollection",
            "level": level_id,
            "description": level_cfg["description"],
            "features": stats,
        }
        print(f"  ✓ {len(stats)} regions processed")
        print(f"  ✓ Total population summed across this level: {total_population:,}")
        print(f"    (sanity check: level 0 of 'basins' should be ~250 million if the "
              f"basin-clipped raster is correct)")

    return hierarchy


def get_label_data_for_cfg(cfg, dataset_key, gdf, geojson, level_cfg, level_key, grid_cache):
    """
    Resolve the (region_ids, valid_pixel_mask, valid_labels, n_regions)
    tuple that spatial_mean_by_region() needs, for whichever grid this
    NC_FILES entry (`cfg`) is defined on.

    Different NC_FILES entries can sit on different grids (e.g. a CID
    file at one resolution vs ERA5 files at another), so the label array
    has to be built per-grid, not once per level. Sources that DO share a
    grid are only rasterized once — grid_cache is keyed by grid shape
    (lat/lon sizes + first/last coordinate, which is enough to detect
    "same grid" without comparing every coordinate) and reused across
    NC_FILES entries within the same level.

    We only need ONE .nc file from this source to read its grid — the
    first year in YEAR_RANGE that actually exists on disk. We are not
    reading any climate values here, just lat/lon coordinates, so this is
    cheap even though it opens a real file.
    """
    # Find one real file for this source to read the grid from.
    da = None
    for year in YEAR_RANGE:
        probe_path = cfg["path_template"].format(year=year)
        try:
            probe_ds = xr.open_dataset(probe_path, chunks="auto")
        except (FileNotFoundError, OSError):
            continue
        probe_ds = normalize_nc_coords(probe_ds)
        var_list = get_dataset_variables(probe_ds, cfg, dataset_key)
        var_list = [v for v in var_list if v["name"] in probe_ds.data_vars]
        if not var_list:
            probe_ds.close()
            continue
        da = prepare_variable(probe_ds, var_list[0]["name"])
        da = da.sortby("lat", ascending=False)
        break

    if da is None:
        print(f"    WARNING: no readable file found for '{dataset_key}' in YEAR_RANGE — "
              f"skipping this source for {level_key}")
        return [], np.zeros(0, dtype=bool), np.zeros(0, dtype=np.int32), 0

    grid_key = (
        da.sizes["lat"], da.sizes["lon"],
        round(float(da.lat.values[0]), 6), round(float(da.lat.values[-1]), 6),
        round(float(da.lon.values[0]), 6), round(float(da.lon.values[-1]), 6),
    )

    cache_key = (level_key, grid_key)
    if cache_key in grid_cache:
        return grid_cache[cache_key]

    label_array, region_ids = build_region_label_array(gdf, geojson, level_cfg, da)

    flat_labels = label_array.reshape(-1)
    valid_pixel_mask = flat_labels != -1
    valid_labels = flat_labels[valid_pixel_mask].astype(np.int32)
    n_regions = len(region_ids)

    result = (region_ids, valid_pixel_mask, valid_labels, n_regions)
    grid_cache[cache_key] = result
    return result


# ════════════════════════════════════════════════════════════════════════════
# STEP 2: Extract climate time series → flat row table, across all years
# ════════════════════════════════════════════════════════════════════════════

def extract_timeseries_flat(hierarchy, levels):
    """
    For each hierarchy level, each climate variable, and each year in
    YEAR_RANGE: mask + aggregate to monthly means per region, and append
    flat rows of the form:

        {"level": int, "region_id": str, "date": "YYYY-MM",
         "tasmax": float | None, "tasmin": float | None, "pr": float | None}

    A missing .nc file for one (variable, year) is skipped with a warning,
    not fatal — so a gap in your raw data doesn't kill the whole run.

    Region geometry is built PER SOURCE (see get_label_data_for_cfg below),
    not once for the whole level — different NC_FILES entries can be on
    different grids (e.g. a CID file at one resolution vs ERA5 files at
    another), so a label array built from one grid can't be reused to
    index into another. Sources that DO share a grid are still only
    rasterized once, cached by grid shape. Per-region spatial means are
    computed for ALL regions at once via np.bincount, instead of looping
    over regions and masking the full grid once per region — this is what
    makes large region counts (e.g. thousands of sub-basins at level 5)
    fast instead of the dominant cost.

    Each region (including countries) uses its FULL geometry — no basin
    clipping. Any part of a region outside where the source NetCDF data
    has valid values naturally comes back as NaN and is skipped by the
    nanmean/bincount logic, so "no climate data" for the non-basin part
    of a country happens automatically from the source data.

    Returns a pandas DataFrame, one row per (level, region_id, date), with
    tasmax/tasmin/pr merged into the same row when they share level+region+date.
    """
    rows = []
 
    for level_key, geojson in hierarchy.items():
        print(f"\n{'='*70}")
        print(f"Extracting climate time series for {level_key}")
        print(f"{'='*70}")
 
        level_id = geojson["level"]
        level_cfg = [c for c in levels if c["id"] == level_id][0]
 
        try:
            gdf = gpd.read_file(level_cfg["shapefile"])
            if gdf.crs != "EPSG:4326":
                gdf = gdf.to_crs("EPSG:4326")
        except FileNotFoundError:
            print(f"ERROR: Shapefile not found: {level_cfg['shapefile']}")
            sys.exit(1)
 
        # Sources sharing a grid are only rasterized once per level.
        grid_cache = {}
 
        for dataset_key, cfg in NC_FILES.items():
            region_ids, valid_pixel_mask, valid_labels, n_regions = get_label_data_for_cfg(
                cfg, dataset_key, gdf, geojson, level_cfg, level_key, grid_cache
            )
 
            for year in YEAR_RANGE:
                nc_path = cfg["path_template"].format(year=year)
                rows.extend(process_dataset_year(
                    nc_path, cfg, dataset_key, level_id, region_ids,
                    valid_pixel_mask, valid_labels, n_regions,
                ))
 
    if not rows:
        print("\nWARNING: no rows extracted at all — check your NC_FILES paths and YEAR_RANGE.")
        return pd.DataFrame(columns=["level", "region_id", "date", "resolution"])
 
    # Merge rows sharing (level, region_id, date, resolution) into a single
    # row with all variable columns combined. "resolution" is included so
    # an annual observation and a monthly observation that happen to share
    # a "date" string never collide.
    df = pd.DataFrame(rows)
    df = df.groupby(["level", "region_id", "date", "resolution"], as_index=False).first()
    return df


# ════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("\n" + "="*70)
    print("NILE BASIN HIERARCHICAL EXTRACTION (Parquet output, multi-dataset)")
    print("="*70)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    REBUILD_HIERARCHY = {
        "basins": True,
        "countries": True,
    }

    for dataset_name, dataset_cfg in LEVEL_SETS.items():
        levels = dataset_cfg["levels"]
        population_raster = dataset_cfg["population_raster"]

        output_hierarchy = OUTPUT_DIR / f"hierarchy_{dataset_name}.json"
        output_parquet_dir = OUTPUT_DIR / f"climate_parquet_{dataset_name}"
        manifest_path = OUTPUT_DIR / f"climate_parquet_manifest_{dataset_name}.json"

        print("\n" + "#"*70)
        print(f"# DATASET: {dataset_name}")
        print("#"*70)

        if REBUILD_HIERARCHY.get(dataset_name, False) or not output_hierarchy.exists():
            print(f"\n[1/2] Building hierarchy for '{dataset_name}'...")
            hierarchy = build_hierarchy(levels, population_raster)
        else:
            print(f"\n[1/2] Loading existing hierarchy from {output_hierarchy}...")
            with open(output_hierarchy) as f:
                hierarchy = json.load(f)

        print(f"\n[2/2] Extracting climate time series for '{dataset_name}'...")
        df = extract_timeseries_flat(hierarchy, levels)

        with open(output_hierarchy, "w") as f:
            json.dump(hierarchy, f, indent=2)

        output_parquet_dir.mkdir(parents=True, exist_ok=True)
        # Wipe any parquet files left over from a previous (possibly
        # interrupted, possibly differently-shaped) run before writing new
        # ones. to_parquet() with partition_cols gives every file a random
        # UUID name and never overwrites/cleans old ones — so without this,
        # re-running the script accumulates stale files, and the manifest
        # built below can end up listing files that no longer match what's
        # actually being served (or were removed), causing 404s in the
        # browser at query time instead of a clear error here.
        for stale_file in output_parquet_dir.rglob("*.parquet"):
            stale_file.unlink()
        df.to_parquet(output_parquet_dir, index=False, engine="pyarrow",
                       compression="snappy", partition_cols=["level"])

        parquet_files = sorted(
            str(p.relative_to(OUTPUT_DIR)).replace("\\", "/")
            for p in output_parquet_dir.rglob("*.parquet")
        )
        with open(manifest_path, "w") as f:
            json.dump({"files": parquet_files}, f, indent=2)