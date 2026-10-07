"""StatsBomb open-data ingestion.

Downloads match + event JSON from the public StatsBomb open-data repo and reduces
each match to a compact per-team summary (features, spatial grids, shots, pass
network edges). Raw events are never kept on disk — only the summary is cached,
so a full rebuild is resumable and the repo stays small.

StatsBomb coordinates: 120 x 80 pitch, every event expressed in the acting
team's frame (attacking towards x = 120).
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"

# (competition_id, season_id, label)
COMPETITIONS = [
    (2, 27, "Premier League 2015/16"),
    (55, 282, "Euro 2024"),
    (43, 106, "World Cup 2022"),
]

GRID_X, GRID_Y = 12, 8  # heatmap resolution (10 x 10 unit cells)

TOUCH_TYPES = {"Pass", "Carry", "Ball Receipt*", "Shot", "Dribble"}
DEF_TYPES = {"Pressure", "Ball Recovery", "Interception", "Duel", "Block", "Clearance"}
PPDA_TYPES = {"Interception", "Foul Committed", "Duel"}  # duels filtered to tackles
SET_PIECE_PATTERNS = {"From Corner", "From Free Kick"}


def _get(url: str):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.json()


def _bin(loc):
    x = min(max(loc[0], 0), 119.999)
    y = min(max(loc[1], 0), 79.999)
    return int(x // (120 / GRID_X)), int(y // (80 / GRID_Y))


def _minute_bin(minute: int) -> int:
    return min(minute // 15, 5)  # 0-15, 15-30, ..., 75-90+


def summarise_match(match: dict, events: list[dict]) -> dict:
    home = match["home_team"]["home_team_name"]
    away = match["away_team"]["away_team_name"]
    teams = [home, away]
    opp = {home: away, away: home}

    s = {
        t: {
            "passes": 0, "passes_complete": 0, "pass_progress": 0.0, "pass_length": 0.0,
            "final_third_passes": 0, "width_sum": 0.0, "width_n": 0,
            "def_x_sum": 0.0, "def_n": 0, "ppda_def": 0, "opp_passes_own60": 0,
            "high_recoveries": 0, "shots": 0, "xg": 0.0, "goals_np": 0,
            "sp_xg": 0.0, "counter_xg": 0.0, "xg_by_15": [0.0] * 6,
            "heat": [[0] * GRID_Y for _ in range(GRID_X)],
            "def_heat": [[0] * GRID_Y for _ in range(GRID_X)],
            "shot_list": [], "formation": None,
            "lineup_pos": {}, "first_sub_index": None,
            "pos_loc": defaultdict(lambda: [0.0, 0.0, 0]), "edges": Counter(),
        }
        for t in teams
    }

    for e in events:
        etype = e["type"]["name"]
        team = e.get("team", {}).get("name")
        if team not in s:
            continue
        d = s[team]
        loc = e.get("location")

        if etype == "Starting XI":
            d["formation"] = str(e["tactics"]["formation"])
            for p in e["tactics"]["lineup"]:
                d["lineup_pos"][p["player"]["id"]] = p["position"]["name"]
            continue
        if etype == "Substitution" and d["first_sub_index"] is None:
            d["first_sub_index"] = e["index"]

        if loc and etype in TOUCH_TYPES:
            bx, by = _bin(loc)
            d["heat"][bx][by] += 1

        if etype == "Pass":
            p = e["pass"]
            if p.get("type", {}).get("name") in {"Throw-in", "Kick Off"}:
                continue
            d["passes"] += 1
            complete = "outcome" not in p
            d["passes_complete"] += complete
            end = p["end_location"]
            d["pass_progress"] += max(end[0] - loc[0], 0)
            d["pass_length"] += p["length"]
            if end[0] >= 80:
                d["final_third_passes"] += 1
            if loc[0] >= 60:
                d["width_sum"] += abs(loc[1] - 40)
                d["width_n"] += 1
            if loc[0] < 72:
                s[opp[team]]["opp_passes_own60"] += 1
            # positional pass network: starting XI only, until first substitution
            pid = e.get("player", {}).get("id")
            rid = p.get("recipient", {}).get("id")
            before_sub = d["first_sub_index"] is None
            if before_sub and pid in d["lineup_pos"]:
                pos = d["lineup_pos"][pid]
                pl = d["pos_loc"][pos]
                pl[0] += loc[0]; pl[1] += loc[1]; pl[2] += 1
                if complete and rid in d["lineup_pos"]:
                    a, b = sorted([pos, d["lineup_pos"][rid]])
                    d["edges"][f"{a}|{b}"] += 1

        if etype in DEF_TYPES and loc:
            d["def_x_sum"] += loc[0]
            d["def_n"] += 1
            bx, by = _bin(loc)
            d["def_heat"][bx][by] += 1
            if etype in {"Ball Recovery", "Interception"} and loc[0] >= 80:
                d["high_recoveries"] += 1

        if etype in PPDA_TYPES and loc and loc[0] >= 48:
            if etype != "Duel" or e.get("duel", {}).get("type", {}).get("name") == "Tackle":
                d["ppda_def"] += 1

        if etype == "Shot":
            sh = e["shot"]
            xg = sh.get("statsbomb_xg", 0.0)
            is_pen = sh.get("type", {}).get("name") == "Penalty"
            goal = sh.get("outcome", {}).get("name") == "Goal"
            d["shots"] += 1
            d["xg"] += xg
            d["xg_by_15"][_minute_bin(e["minute"])] += xg
            if not is_pen and goal:
                d["goals_np"] += 1
            pattern = e.get("play_pattern", {}).get("name")
            if pattern in SET_PIECE_PATTERNS or sh.get("type", {}).get("name") in {"Free Kick", "Penalty", "Corner"}:
                d["sp_xg"] += xg
            if pattern == "From Counter":
                d["counter_xg"] += xg
            d["shot_list"].append([round(loc[0], 1), round(loc[1], 1), round(xg, 3), int(goal)])

    out_teams = {}
    for t in teams:
        d, o = s[t], s[opp[t]]
        total_passes = d["passes"] + o["passes"]
        ft_total = d["final_third_passes"] + o["final_third_passes"]
        out_teams[t] = {
            "formation": d["formation"],
            "possession": d["passes"] / total_passes if total_passes else 0.5,
            "pass_comp": d["passes_complete"] / d["passes"] if d["passes"] else 0,
            "field_tilt": d["final_third_passes"] / ft_total if ft_total else 0.5,
            "directness": d["pass_progress"] / d["pass_length"] if d["pass_length"] else 0,
            "width": d["width_sum"] / d["width_n"] if d["width_n"] else 0,
            "press_height": d["def_x_sum"] / d["def_n"] if d["def_n"] else 0,
            "ppda": d["opp_passes_own60"] / max(d["ppda_def"], 1),
            "high_recoveries": d["high_recoveries"],
            "shots": d["shots"], "xg": d["xg"],
            "shots_against": o["shots"], "xga": o["xg"],
            "sp_xg": d["sp_xg"], "counter_xga": o["counter_xg"],
            "xg_by_15": d["xg_by_15"], "xga_by_15": o["xg_by_15"],
            "heat": d["heat"], "def_heat": d["def_heat"], "shot_list": d["shot_list"],
            "pos_loc": {k: [v[0] / v[2], v[1] / v[2], v[2]] for k, v in d["pos_loc"].items() if v[2]},
            "edges": dict(d["edges"]),
        }

    return {
        "match_id": match["match_id"],
        "date": match["match_date"],
        "home": home, "away": away,
        "home_score": match["home_score"], "away_score": match["away_score"],
        "teams": out_teams,
    }


def fetch_competition(comp_id: int, season_id: int, label: str, cache_dir: Path, workers: int = 16) -> list[dict]:
    matches = _get(f"{BASE}/matches/{comp_id}/{season_id}.json")
    cache_dir.mkdir(parents=True, exist_ok=True)

    def work(m):
        path = cache_dir / f"{m['match_id']}.json"
        if path.exists():
            return json.loads(path.read_text())
        events = _get(f"{BASE}/events/{m['match_id']}.json")
        summary = summarise_match(m, events)
        summary["competition"] = label
        path.write_text(json.dumps(summary))
        return summary

    out = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, m) for m in matches]
        for i, f in enumerate(as_completed(futures), 1):
            out.append(f.result())
            if i % 50 == 0 or i == len(futures):
                print(f"  {label}: {i}/{len(futures)} matches")
    return out
