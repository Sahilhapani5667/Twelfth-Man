"""Accounts, club profiles, season fixtures and scouted opponents.

Stored in the same local SQLite file as club match data (data/local.db). Passwords are
hashed with scrypt + a per-user salt; sessions are random tokens in an HttpOnly cookie.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

SESSION_DAYS = 30
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(ValueError):
    pass


def _hash(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32).hex()


class Accounts:
    def __init__(self, path: Path):
        self.path = path
        self._fails: dict[str, list[float]] = {}
        with self._conn() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                pw_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at REAL);
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS clubs (
                user_id TEXT PRIMARY KEY, team_id TEXT, data TEXT NOT NULL, updated_at REAL);
            CREATE TABLE IF NOT EXISTS opponents (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS fixtures (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, data TEXT NOT NULL);
            """)
            cols = [r[1] for r in c.execute("PRAGMA table_info(local_teams)")]
            if cols and "owner_id" not in cols:
                c.execute("ALTER TABLE local_teams ADD COLUMN owner_id TEXT")

    def _conn(self):
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        return c

    # ------------------------------------------------------------ auth
    def signup(self, email: str, name: str, password: str) -> dict:
        email = (email or "").strip().lower()
        name = (name or "").strip()
        if not EMAIL_RE.match(email):
            raise AuthError("Please enter a valid email address.")
        if not name:
            raise AuthError("Please enter your name.")
        if len(password or "") < 8:
            raise AuthError("Password must be at least 8 characters.")
        salt = secrets.token_bytes(16)
        uid = "u-" + uuid.uuid4().hex[:12]
        try:
            with self._conn() as c:
                c.execute("INSERT INTO users VALUES (?,?,?,?,?,?)", (uid, email, name, _hash(password, salt), salt.hex(), time.time()))
        except sqlite3.IntegrityError:
            raise AuthError("An account with this email already exists. Try signing in.")
        return {"id": uid, "email": email, "name": name}

    def login(self, email: str, password: str) -> dict:
        email = (email or "").strip().lower()
        now = time.time()
        fails = [t for t in self._fails.get(email, []) if now - t < 600]
        if len(fails) >= 8:
            raise AuthError("Too many attempts. Please wait a few minutes and try again.")
        with self._conn() as c:
            r = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not r or not hmac.compare_digest(r["pw_hash"], _hash(password or "", bytes.fromhex(r["salt"]))):
            self._fails[email] = fails + [now]
            raise AuthError("Email or password is incorrect.")
        self._fails.pop(email, None)
        return {"id": r["id"], "email": r["email"], "name": r["name"]}

    def new_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._conn() as c:
            c.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES (?,?,?)", (token, user_id, time.time() + SESSION_DAYS * 86400))
        return token

    def user_for(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self._conn() as c:
            r = c.execute("""SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token = ? AND s.expires > ?""", (token, time.time())).fetchone()
        if not r:
            return None
        u = dict(r)
        u["guest"] = u["id"].startswith("g-")
        return u

    def end_session(self, token: str | None):
        if token:
            with self._conn() as c:
                c.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def create_guest(self) -> dict:
        """A throwaway account so visitors can explore the demo without signing up."""
        uid = "g-" + uuid.uuid4().hex[:12]
        with self._conn() as c:
            # tidy up guest accounts nobody has used for 30 days
            old = [r[0] for r in c.execute("""SELECT u.id FROM users u WHERE u.id LIKE 'g-%' AND u.created_at < ?
                     AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires > ?)""",
                                           (time.time() - 30 * 86400, time.time()))]
            for gid in old:
                for t in ("sessions", "clubs", "opponents", "fixtures"):
                    c.execute(f"DELETE FROM {t} WHERE user_id = ?", (gid,))
                c.execute("DELETE FROM local_matches WHERE team_id IN (SELECT id FROM local_teams WHERE owner_id = ?)", (gid,))
                c.execute("DELETE FROM local_teams WHERE owner_id = ?", (gid,))
                c.execute("DELETE FROM users WHERE id = ?", (gid,))
            c.execute("INSERT INTO users VALUES (?,?,?,?,?,?)", (uid, f"{uid}@guest.local", "Guest coach", "-", "-", time.time()))
        return {"id": uid, "email": f"{uid}@guest.local", "name": "Guest coach"}

    # ------------------------------------------------------------ club profile
    def club(self, user_id: str) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM clubs WHERE user_id = ?", (user_id,)).fetchone()
        return {"team_id": r["team_id"], **json.loads(r["data"])} if r else None

    def save_club(self, user_id: str, data: dict, team_id: str) -> dict:
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO clubs VALUES (?,?,?,?)", (user_id, team_id, json.dumps(data), time.time()))
        return self.club(user_id)

    def owns_team(self, user_id: str, team_id: str) -> bool:
        with self._conn() as c:
            return c.execute("SELECT 1 FROM local_teams WHERE id = ? AND owner_id = ?", (team_id, user_id)).fetchone() is not None

    def team_ids(self, user_id: str) -> set[str]:
        with self._conn() as c:
            return {r[0] for r in c.execute("SELECT id FROM local_teams WHERE owner_id = ?", (user_id,))}

    def owner_of(self, team_id: str) -> str | None:
        with self._conn() as c:
            r = c.execute("SELECT owner_id FROM local_teams WHERE id = ?", (team_id,)).fetchone()
        return r["owner_id"] if r else None

    def set_owner(self, team_id: str, user_id: str):
        with self._conn() as c:
            c.execute("UPDATE local_teams SET owner_id = ? WHERE id = ?", (user_id, team_id))

    # ------------------------------------------------------------ opponents
    def opponents(self, user_id: str) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM opponents WHERE user_id = ? ORDER BY name", (user_id,)).fetchall()
        return [{"id": r["id"], "name": r["name"], **json.loads(r["data"])} for r in rows]

    def opponent(self, opp_id: str) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM opponents WHERE id = ?", (opp_id,)).fetchone()
        return {"id": r["id"], "user_id": r["user_id"], "name": r["name"], **json.loads(r["data"])} if r else None

    def find_opponent(self, user_id: str, name: str) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT id FROM opponents WHERE user_id = ? AND lower(name) = lower(?)", (user_id, name.strip())).fetchone()
        return self.opponent(r["id"]) if r else None

    def upsert_opponent(self, user_id: str, name: str, data: dict, opp_id: str | None = None) -> dict:
        name = (name or "").strip()
        if not name:
            raise AuthError("Opponent name is required.")
        existing = self.opponent(opp_id) if opp_id else self.find_opponent(user_id, name)
        if existing and existing.get("user_id", user_id) != user_id:
            raise AuthError("Not your opponent.")
        merged = {k: v for k, v in (existing or {}).items() if k not in ("id", "user_id", "name")}
        merged.update({k: v for k, v in data.items() if k not in ("id", "user_id", "name")})
        oid = existing["id"] if existing else "opp-" + uuid.uuid4().hex[:10]
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO opponents VALUES (?,?,?,?)", (oid, user_id, name, json.dumps(merged)))
        return self.opponent(oid)

    def delete_opponent(self, user_id: str, opp_id: str):
        with self._conn() as c:
            c.execute("DELETE FROM opponents WHERE id = ? AND user_id = ?", (opp_id, user_id))

    # ------------------------------------------------------------ fixtures
    def fixtures(self, user_id: str) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM fixtures WHERE user_id = ?", (user_id,)).fetchall()
        out = [{"id": r["id"], **json.loads(r["data"])} for r in rows]
        return sorted(out, key=lambda f: (f.get("date") or "", f.get("time") or ""))

    def save_fixture(self, user_id: str, data: dict, fixture_id: int | None = None) -> dict:
        with self._conn() as c:
            if fixture_id:
                c.execute("UPDATE fixtures SET data = ? WHERE id = ? AND user_id = ?", (json.dumps(data), fixture_id, user_id))
                fid = fixture_id
            else:
                fid = c.execute("INSERT INTO fixtures (user_id, data) VALUES (?,?)", (user_id, json.dumps(data))).lastrowid
        return {"id": fid, **data}

    def delete_fixture(self, user_id: str, fixture_id: int):
        with self._conn() as c:
            c.execute("DELETE FROM fixtures WHERE id = ? AND user_id = ?", (fixture_id, user_id))


def parse_league_table(text: str) -> list[dict]:
    """Parse a pasted league table: one team per line, e.g. '1 Riverside FC 10 4 3 3 17 14 3 15'
    or CSV/TSV 'Pos,Team,P,W,D,L,GF,GA,GD,Pts'. Numbers after the name are read as P W D L GF GA."""
    rows = []
    for line in (text or "").splitlines():
        tokens = [t for t in re.split(r"[,\t;|]+|\s+", line.strip()) if t]
        if not tokens or tokens[0].lower() in ("pos", "team", "#", "position", "club"):
            continue
        pos = None
        if re.fullmatch(r"\d+\.?", tokens[0]):
            pos = int(tokens[0].rstrip("."))
            tokens = tokens[1:]
        name_parts, nums = [], []
        for t in tokens:
            if re.fullmatch(r"[+-]?\d+", t) and name_parts:
                nums.append(int(t))
            elif not nums:
                name_parts.append(t)
        if len(nums) < 6 or not name_parts:
            continue
        p, w, d, l, gf, ga = nums[:6]
        if p <= 0 or w + d + l != p:
            continue
        rows.append({"name": " ".join(name_parts), "position": pos, "played": p, "won": w, "drawn": d,
                     "lost": l, "gf": gf, "ga": ga})
    for i, r in enumerate(rows):
        if r["position"] is None:
            r["position"] = i + 1
    return rows
