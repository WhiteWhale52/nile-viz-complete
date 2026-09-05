"""
FastAPI backend for Nile Basin climate explorer.
Loads 40 .nc files (tasmax, tasmin, precip × 1984–2023) and aggregates by region hierarchy.
"""

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import xarray as xr
import numpy as np
import json
from pathlib import Path
from functools import lru_cache
import regionmask
import rasterstats

app = FastAPI()

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
NC_DATA_DIR = Path("data/climate_nc")  # Directory with .nc files
HIERARCHY_FILE = Path("data/hierarchy.json")
CACHE_DIR = Path("data/climate_cache")
CACHE_DIR.mkdir(exist_ok=True)

YEAR_RANGE = (1984, 2023)
CLIMATE_VARS = ["tasmax", "tasmin", "precip"]

# Load hierarchy once at startup
with open(HIERARCHY_FILE) as f:
    HIERARCHY = json.load(f)


def get_level_features(level: int):
    """Extract GeoJSON features for a specific level."""
    level_key = f"level{level}"
    if level_key not in HIERARCHY:
        return {}
    
    features = {}
    for feature in HIERARCHY[level_key]["features"]:
        region_id = feature["properties"]["id"]
        geometry = feature["geometry"]
        features[region_id] = {"geometry": geometry, "properties": feature["properties"]}
    return features


@lru_cache(maxsize=120)
def load_nc_data(var: str, year: int) -> xr.Dataset:
    """Load a single .nc file from cache or disk."""
    filename = f"{var}_{year}.nc"
    filepath = NC_DATA_DIR / filename
    
    if not filepath.exists():
        raise FileNotFoundError(f"No data for {var} {year}")
    
    return xr.open_dataset(filepath)


def aggregate_to_regions(data: np.ndarray, level: int, region_geoms: dict) -> dict:
    """
    Aggregate gridded climate data to region boundaries using rasterstats.
    
    data: 2D array of climate values
    level: hierarchy level (0, 1, 2, 3, ...)
    region_geoms: dict of {region_id: {"geometry": geom, ...}}
    
    Returns: dict of {region_id: aggregated_value}
    """
    
    results = {}
    
    for region_id, info in region_geoms.items():
        geometry = info["geometry"]
        
        try:
            # Compute zonal statistics (mean, max, etc.)
            stats = rasterstats.zonal_stats(geometry, data, stats=["mean", "max", "min"])
            if stats:
                results[region_id] = {
                    "mean": stats[0].get("mean"),
                    "max": stats[0].get("max"),
                    "min": stats[0].get("min"),
                }
            else:
                results[region_id] = {"mean": None, "max": None, "min": None}
        except Exception as e:
            print(f"Error aggregating {region_id}: {e}")
            results[region_id] = {"mean": None, "max": None, "min": None}
    
    return results


@app.get("/api/climate")
async def get_climate_data(
    var: str = Query("tasmax", description="Variable: tasmax, tasmin, precip"),
    year: int = Query(2023, description="Year (1984–2023)"),
    level: int = Query(0, description="Hierarchy level (0–3+)"),
) -> JSONResponse:
    """
    Fetch climate data for a region hierarchy level.
    
    Returns aggregated statistics per region.
    """
    
    # Validation
    if var not in CLIMATE_VARS:
        return JSONResponse(
            {"error": f"Invalid variable. Choose from {CLIMATE_VARS}"},
            status_code=400
        )
    
    if year < YEAR_RANGE[0] or year > YEAR_RANGE[1]:
        return JSONResponse(
            {"error": f"Year must be between {YEAR_RANGE[0]} and {YEAR_RANGE[1]}"},
            status_code=400
        )
    
    # Check cache first
    cache_file = CACHE_DIR / f"{var}_{year}_level{level}.json"
    if cache_file.exists():
        with open(cache_file) as f:
            return JSONResponse(json.load(f))
    
    try:
        # Load .nc file
        ds = load_nc_data(var, year)
        
        # Extract data array (assumes single variable in file)
        data_var = list(ds.data_vars.keys())[0]
        data = ds[data_var].values
        
        # Normalize if needed (e.g., K to °C)
        if var in ["tasmax", "tasmin"] and data.max() > 100:
            data = data - 273.15  # Kelvin to Celsius
        
        # Get region geometries for this level
        features = get_level_features(level)
        
        # Aggregate to regions
        aggregated = aggregate_to_regions(data, level, features)
        
        # Simplify: return just the mean for each region
        result = {rid: v.get("mean") for rid, v in aggregated.items()}
        
        # Cache
        with open(cache_file, "w") as f:
            json.dump(result, f)
        
        return JSONResponse(result)
    
    except FileNotFoundError:
        return JSONResponse(
            {"error": f"Climate data not available for {var} {year}"},
            status_code=404
        )
    except Exception as e:
        return JSONResponse(
            {"error": str(e)},
            status_code=500
        )


@app.get("/api/climate/available")
async def get_available_data():
    """List all available .nc files."""
    available = {"tasmax": [], "tasmin": [], "precip": []}
    
    if NC_DATA_DIR.exists():
        for file in NC_DATA_DIR.glob("*.nc"):
            stem = file.stem
            for var in CLIMATE_VARS:
                if stem.startswith(var):
                    try:
                        year = int(stem.split("_")[1])
                        available[var].append(year)
                    except:
                        pass
    
    return {
        "available": available,
        "year_range": YEAR_RANGE,
        "variables": CLIMATE_VARS,
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
