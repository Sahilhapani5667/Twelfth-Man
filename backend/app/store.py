"""Local (grassroots) club data: SQLite storage, CSV import/validation, profiles.

Local data never leaves this machine and is kept separate from open data.
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
import uuid
from pathlib import Path

from .formations import FAMILIES, family_of

MATCH_FIELDS = {
    # name: (type, required, help)
    "date": (str, True, "YYYY-MM-DD"),
    "opponent": (str, True, "Opponent name"),
    "venue": (str, False, "home / away / neutral"),
    "formation": (str, True, "e.g. 4-4-2, 4-3-3, 4-2-3-1, 4-1-4-1, 3-5-2, 3-4-3"),
    "goals_for": (int, True, ""),
    "goals_against": (int, True, ""),
    "shots_for": (int, True, "All shots"),
    "shots_against": (int, True, ""),
    "sot_for": (int, False, "Shots on target"),
    "sot_against": (int, False, ""),
    "possession": (float, False, "Estimated % (0-100)"),
    "passes_attempted": (int, False, "From a tally or app"),
    "passes_completed": (int, False, ""),
    "press_rating": (int, False, "1 = deep block … 5 = very high press"),
    "directness_rating": (int, False, "1 = patient short build-up … 5 = very direct"),
    "width_rating": (int, False, "1 = very narrow … 5 = very wide"),
    "corners_for": (int, False, ""),
    "late_goals_against": (int, False, "Goals conceded after 60'"),
    "notes": (str, False, ""),
}


class ValidationError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def parse_match(raw: dict, row_label: str = "") -> dict:
    out, errors = {}, []
    for name, (typ, required, _) in MATCH_FIELDS.items():
        v = raw.get(name)
        if isinstance(v, str):
            v = v.strip()
        if v in (None, ""):
            if required:
                errors.append(f"{row_label}missing '{name}'")
            out[name] = None
            continue
        try:
            out[name] = typ(float(v)) if typ is int else typ(v)
        except (TypeError, ValueError):
            errors.append(f"{row_label}'{name}' should be a number (got {v!r})")
    if not errors:
        try:
            time.strptime(out["date"], "%Y-%m-%d")
        except ValueError:
            errors.append(f"{row_label}date must be YYYY-MM-DD (got {out['date']!r})")
        fam = family_of(out["formation"])
        if out["formation"] not in FAMILIES and out["formation"].replace("-", "") not in {f.replace("-", "") for f in FAMILIES}:
            errors.append(f"{row_label}formation must be one of {', '.join(FAMILIES)}")
        out["formation"] = fam
        for r in ("press_rating", "directness_rating", "width_rating"):
            if out[r] is not None and not 1 <= out[r] <= 5:
                errors.append(f"{row_label}{r} must be 1-5")
        if out["possession"] is not None and not 0 < out["possession"] < 100:
            errors.append(f"{row_label}possession must be between 0 and 100")
        if out["passes_attempted"] and out["passes_completed"] is not None and out["passes_completed"] > out["passes_attempted"]:
            errors.append(f"{row_label}passes_completed cannot exceed passes_attempted")
        for a, b in (("sot_for", "shots_for"), ("sot_against", "shots_against")):
            if out[a] is not None and out[b] is not None and out[a] > out[b]:
                errors.append(f"{row_label}{a} cannot exceed {b}")
        for k in ("goals_for", "goals_against", "shots_for", "shots_against"):
            if out[k] is not None and out[k] < 0:
                errors.append(f"{row_label}{k} cannot be negative")
        if out["venue"] and out["venue"].lower() not in ("home", "away", "neutral"):
            errors.append(f"{row_label}venue must be home, away or neutral")
    if errors:
        raise ValidationError(errors)
    return out


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._init()

    def _conn(self):
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        return c

    def _init(self):
        with self._conn() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS local_teams (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, level TEXT, roster TEXT, created_at REAL);
            CREATE TABLE IF NOT EXISTS local_matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES local_teams(id),
                data TEXT NOT NULL, created_at REAL);
            """)

    # ---- teams
    def list_teams(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("""SELECT t.*, COUNT(m.id) AS n FROM local_teams t
                                LEFT JOIN local_matches m ON m.team_id = t.id GROUP BY t.id ORDER BY t.created_at""").fetchall()
        return [{"id": r["id"], "name": r["name"], "level": r["level"], "matches": r["n"],
                 "roster": json.loads(r["roster"] or "[]")} for r in rows]

    def get_team(self, team_id: str) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM local_teams WHERE id = ?", (team_id,)).fetchone()
        if not r:
            return None
        return {"id": r["id"], "name": r["name"], "level": r["level"], "roster": json.loads(r["roster"] or "[]")}

    def create_team(self, name: str, level: str = "", roster: list | None = None, team_id: str | None = None,
                    owner_id: str | None = None) -> dict:
        name = (name or "").strip()
        if not name:
            raise ValidationError(["Team name is required"])
        tid = team_id or "local-" + uuid.uuid4().hex[:8]
        with self._conn() as c:
            c.execute("INSERT INTO local_teams (id, name, level, roster, created_at) VALUES (?,?,?,?,?)",
                      (tid, name, level, json.dumps(roster or []), time.time()))
            if owner_id:
                c.execute("UPDATE local_teams SET owner_id = ? WHERE id = ?", (owner_id, tid))
        return self.get_team(tid)

    def update_roster(self, team_id: str, roster: list) -> None:
        with self._conn() as c:
            c.execute("UPDATE local_teams SET roster = ? WHERE id = ?", (json.dumps(roster), team_id))

    def delete_team(self, team_id: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM local_matches WHERE team_id = ?", (team_id,))
            c.execute("DELETE FROM local_teams WHERE id = ?", (team_id,))

    # ---- matches
    def matches(self, team_id: str) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT id, data FROM local_matches WHERE team_id = ?", (team_id,)).fetchall()
        out = [{"id": r["id"], **json.loads(r["data"])} for r in rows]
        return sorted(out, key=lambda m: m["date"])

    def add_match(self, team_id: str, raw: dict) -> dict:
        m = parse_match(raw)
        with self._conn() as c:
            cur = c.execute("INSERT INTO local_matches (team_id, data, created_at) VALUES (?,?,?)",
                            (team_id, json.dumps(m), time.time()))
        return {"id": cur.lastrowid, **m}

    def delete_match(self, team_id: str, match_id: int) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM local_matches WHERE id = ? AND team_id = ?", (match_id, team_id))

    def import_csv(self, team_id: str, text: str, replace: bool = False) -> dict:
        reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
        if not reader.fieldnames:
            raise ValidationError(["CSV is empty"])
        headers = [h.strip().lower() for h in reader.fieldnames]
        missing = [f for f, (_, req, _) in MATCH_FIELDS.items() if req and f not in headers]
        if missing:
            raise ValidationError([f"Missing column(s): {', '.join(missing)}"])
        parsed, errors = [], []
        for i, row in enumerate(reader, start=2):
            row = {(k or "").strip().lower(): v for k, v in row.items()}
            if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
                continue
            try:
                parsed.append(parse_match(row, f"row {i}: "))
            except ValidationError as e:
                errors.extend(e.errors)
        if errors:
            raise ValidationError(errors[:20])
        if not parsed:
            raise ValidationError(["No match rows found"])
        with self._conn() as c:
            if replace:
                c.execute("DELETE FROM local_matches WHERE team_id = ?", (team_id,))
            c.executemany("INSERT INTO local_matches (team_id, data, created_at) VALUES (?,?,?)",
                          [(team_id, json.dumps(m), time.time()) for m in parsed])
        return {"imported": len(parsed)}

    # ---- profile
    def league_base(self, owner_id: str | None = None) -> float:
        """Average estimated xG per team-match across one coach's local data (their 'league')."""
        vals = []
        q = ("SELECT m.data FROM local_matches m JOIN local_teams t ON t.id = m.team_id WHERE t.owner_id IS ?"
             if owner_id is not None else "SELECT data FROM local_matches")
        with self._conn() as c:
            for r in c.execute(q, (owner_id,) if owner_id is not None else ()):
                m = json.loads(r["data"])
                for side, g in (("for", m["goals_for"]), ("against", m["goals_against"])):
                    shots, sot = m.get(f"shots_{side}") or 0, m.get(f"sot_{side}")
                    est = (0.30 * sot + 0.05 * max(shots - sot, 0)) if sot is not None else 0.11 * shots
                    vals.append(0.7 * est + 0.3 * g)
        return float(sum(vals) / len(vals)) if len(vals) >= 6 else 1.6

    def profile(self, team_id: str, engine) -> dict | None:
        from .engine import local_profile_from_matches
        team = self.get_team(team_id)
        if not team:
            return None
        with self._conn() as c:
            r = c.execute("SELECT owner_id FROM local_teams WHERE id = ?", (team_id,)).fetchone()
        base = self.league_base(owner_id=r["owner_id"] if r else None)
        ms = self.matches(team_id)
        if not ms:
            from .engine import blank_local_profile
            return blank_local_profile(team, engine, base)
        return local_profile_from_matches(team, ms, engine, base)


def template_csv() -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(list(MATCH_FIELDS))
    w.writerow(["2026-09-06", "Northgate Athletic", "home", "4-4-2", 2, 1, 11, 9, 5, 3, 48, 310, 220, 3, 4, 3, 5, 1, "Good second half"])
    return buf.getvalue()
