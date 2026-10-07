"""Step 1: download StatsBomb open data and cache compact per-match summaries.

    .venv/bin/python scripts/fetch_data.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.etl.statsbomb import COMPETITIONS, fetch_competition  # noqa: E402

if __name__ == "__main__":
    for comp_id, season_id, label in COMPETITIONS:
        print(f"Fetching {label} ...")
        fetch_competition(comp_id, season_id, label, ROOT / "data" / "cache")
    print("Done.")
