"""The Twelfth Man — FastAPI app. Serves the API under /api and the web app at /."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import coach, usage
from .accounts import Accounts, AuthError, parse_league_table
from .assistant import Assistant, offline_answer
from .engine import Engine
from .client import CoachClient
from .formations import FAMILIES
from .store import Store, ValidationError, template_csv

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
DRILLS = json.loads((Path(__file__).parent / "content" / "drills.json").read_text())


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    return o


class NumpyJSON(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(_clean(content), allow_nan=False).encode()


app = FastAPI(title="The Twelfth Man", default_response_class=NumpyJSON)
store = Store(Path(os.environ.get("TWELFTH_MAN_DB", DATA / "local.db")))
accounts = Accounts(store.path)
engine = Engine(DATA / "processed", store)
engine.accounts = accounts
conn = CoachClient()
assistant = Assistant(conn, DRILLS)


def _demo_roster(name):
    names = ["Sam Okafor", "Leo Brennan", "Kai Patel", "Josh Reid", "Theo Marsh", "Ollie Grant", "Ben Ade",
             "Max Turner", "Ryan Cole", "Zac Hughes", "Eli Ward", "Noah Price", "Finn Doyle", "Ali Hassan", "Jake Moss",
             "Callum Shaw"]
    pos = ["GK", "RB", "CB", "CB", "LB", "RM", "CM", "CM", "LM", "ST", "ST", "CM", "CB", "ST", "RB", "LM"]
    return [{"name": n, "position": p, "number": i + 1} for i, (n, p) in enumerate(zip(names, pos))]


# ------------------------------------------------------------------ auth middleware
COOKIE = "tm_session"
PUBLIC_API = {"/api/meta", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/guest",
              "/api/local/template.csv"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    request.state.user = accounts.user_for(request.cookies.get(COOKIE))
    if path.startswith("/api/") and path not in PUBLIC_API and request.state.user is None:
        return NumpyJSON({"detail": "Please sign in."}, status_code=401)
    return await call_next(request)


def _user(request: Request) -> dict:
    return request.state.user


def _can_use(user: dict, team_id: str) -> bool:
    if team_id in engine.pro:
        return True
    if team_id.startswith("opp-"):
        o = accounts.opponent(team_id)
        return bool(o and o["user_id"] == user["id"])
    return accounts.owns_team(user["id"], team_id)


def _own_local(request: Request, team_id: str):
    if not accounts.owns_team(_user(request)["id"], team_id):
        raise HTTPException(404, "Unknown team")


# ------------------------------------------------------------------ schemas

class Tactics(BaseModel):
    formation: str | None = None
    press: int | None = Field(None, ge=0, le=100)
    tempo: int | None = Field(None, ge=0, le=100)
    width: int | None = Field(None, ge=0, le=100)


class Sub(BaseModel):
    minute: int = Field(60, ge=1, le=89)
    type: str = "like-for-like"


class SimRequest(BaseModel):
    team_id: str
    opponent_id: str
    tactics: Tactics = Tactics()
    venue: str = "home"
    conditions: str = "normal"
    subs: list[Sub] = []
    n_sims: int = Field(10000, ge=500, le=50000)
    seed: int = 7


class RecRequest(BaseModel):
    team_id: str
    opponent_id: str
    tactics: Tactics = Tactics()
    venue: str = "home"
    conditions: str = "normal"


class MatchupRequest(BaseModel):
    team_id: str
    opponent_id: str


class TeamCreate(BaseModel):
    name: str
    level: str = ""
    roster: list[dict] = []


def _tactics(t: Tactics) -> dict:
    d = {k: v for k, v in t.model_dump().items() if v is not None}
    if "formation" in d and d["formation"] not in FAMILIES:
        raise HTTPException(422, f"formation must be one of {FAMILIES}")
    return d


def _check(team_id, opponent_id, request: Request | None = None):
    if team_id == opponent_id:
        raise HTTPException(422, "Pick two different teams")
    for t in (team_id, opponent_id):
        if request is not None and not _can_use(_user(request), t):
            raise HTTPException(404, f"Unknown team '{t}'")
        try:
            engine.team(t)
        except KeyError:
            raise HTTPException(404, f"Unknown team '{t}' (local teams need at least one match)")


def _drills_for(tags: list[str], limit: int = 3) -> list[dict]:
    scored = []
    for d in DRILLS:
        overlap = len(set(d["tags"]) & set(tags))
        if overlap:
            # earlier tags matter more
            score = overlap + sum(1 / (1 + tags.index(t)) for t in d["tags"] if t in tags)
            scored.append((score, d))
    scored.sort(key=lambda x: -x[0])
    return [d for _, d in scored[:limit]]


# ------------------------------------------------------------------ API

@app.get("/api/meta")
def meta():
    m = engine.meta()
    m["assistant"] = {"enabled": conn.enabled, "reason": conn.reason}
    return m


@app.get("/api/teams")
def teams(request: Request):
    return engine.list_teams(_user(request))


@app.get("/api/teams/{team_id}")
def team(team_id: str, request: Request):
    if not _can_use(_user(request), team_id):
        raise HTTPException(404, "Unknown team")
    try:
        t = engine.team(team_id)
    except KeyError:
        raise HTTPException(404, "Unknown team")
    out = engine._summary(t)
    out["trend"] = t.get("trend")
    out["shots"] = t.get("shots")
    out["roster"] = t.get("roster")
    out["data_quality"] = t.get("data_quality")
    out["formations_used"] = t.get("formations_used")
    return out


@app.post("/api/matchup")
def matchup(req: MatchupRequest, request: Request):
    _check(req.team_id, req.opponent_id, request)
    return engine.matchup(req.team_id, req.opponent_id)


@app.post("/api/simulate")
def simulate(req: SimRequest, request: Request):
    _check(req.team_id, req.opponent_id, request)
    return engine.simulate(req.team_id, req.opponent_id, _tactics(req.tactics), req.venue, req.conditions,
                           [s.model_dump() for s in req.subs], req.n_sims, req.seed)


@app.post("/api/recommend")
def recommend(req: RecRequest, request: Request):
    _check(req.team_id, req.opponent_id, request)
    rec = engine.recommend(req.team_id, req.opponent_id, _tactics(req.tactics), req.venue, req.conditions)
    for r in rec["recommendations"]:
        r["drills"] = _drills_for(r["drill_tags"])
    for w in rec["weaknesses"]:
        w["drills"] = _drills_for(w["tags"], 2)
    rec["explanation_source"] = "template"
    return rec


@app.post("/api/report")
def report(req: SimRequest, request: Request):
    _check(req.team_id, req.opponent_id, request)
    tactics = _tactics(req.tactics)
    subs = [s.model_dump() for s in req.subs]
    sim = engine.simulate(req.team_id, req.opponent_id, tactics, req.venue, req.conditions, subs, req.n_sims, req.seed)
    rec = engine.recommend(req.team_id, req.opponent_id, tactics, req.venue, req.conditions)
    for r in rec["recommendations"]:
        r["drills"] = _drills_for(r["drill_tags"])
    mu = engine.matchup(req.team_id, req.opponent_id)
    weak_tags = [t for w in rec["weaknesses"] for t in w["tags"]]
    rec_tags = [t for r in rec["recommendations"][:1] for t in r["drill_tags"]]
    session = _drills_for(rec_tags + weak_tags, 3)
    payload = {"team": sim["team"]["label"], "opponent": sim["opponent"]["label"], "tactics": sim["tactics"],
               "simulation": {k: sim[k] for k in ["win", "draw", "loss", "xg_for", "xg_against", "clean_sheet",
                                                  "late_concede", "risk", "drivers"]},
               "subs": subs, "risks": mu["risks"], "zones": mu["zones"],
               "recommendations": [{"change": r["title"], "impact": r["impact"]} for r in rec["recommendations"]],
               "weaknesses": rec["weaknesses"]}
    return {"simulation": sim, "matchup": mu, "recommendations": rec, "session": session,
            "plan": _template_plan(sim, mu, rec, subs)}


def _template_plan(sim, mu, rec, subs):
    t = sim["tactics"]
    press_word = "high press" if t["press"] >= 65 else ("mid-block" if t["press"] >= 35 else "low block")
    tempo_word = "direct" if t["tempo"] >= 60 else ("patient" if t["tempo"] <= 40 else "mixed")
    attack = " and ".join(z["zone"] for z in mu["zones"]["attack"])
    protect = " and ".join(z["zone"] for z in mu["zones"]["protect"])
    fat = sim["risk"]["fatigue_index"]
    sub_txt = ("Plan changes around 60' and 70' — the press is demanding and the model shows late concessions "
               "rising without fresh legs." if fat > 0.6 else
               "Standard rotation: first change around 60', keep one sub for game management after 75'.")
    if subs:
        sub_txt += " Planned: " + ", ".join(f"{s['minute']}' ({s['type']})" for s in subs) + "."
    return {
        "summary": f"{t['formation']} with a {press_word} and {tempo_word} build-up. The model gives about "
                   f"{sim['win']:.0%} win / {sim['draw']:.0%} draw / {sim['loss']:.0%} loss, with roughly "
                   f"{sim['xg_for']:.1f} xG for and {sim['xg_against']:.1f} against.",
        "key_messages": [f"{r['title']}: {r['detail'].split('. ')[0].rstrip('.')}." for r in mu["risks"][:2]] +
                        [f"Attack the {attack}.", f"Protect our {protect}."],
        "in_possession": [f"Target the {attack} — they defend these areas least.",
                          "Play forward early when their press is not set." if t["tempo"] >= 50 else
                          "Circulate patiently; switch when they shift across.",
                          "Keep a rest-defence of 3 behind the ball."],
        "out_of_possession": [f"{press_word.capitalize()}: hold distances of 10-15 m between lines.",
                              f"Double up in the {protect}.",
                              "React to losing the ball within 5 seconds, then recover shape."],
        "substitution_plan": sub_txt,
    }


class PlanRequest(BaseModel):
    team_id: str
    opponent_id: str
    venue: str = "home"
    tactics: Tactics | None = None  # a chosen option; defaults to the best recommendation


@app.post("/api/gameplan")
def gameplan(req: PlanRequest, request: Request):
    """Coach mode: the whole plan in plain football language."""
    _check(req.team_id, req.opponent_id, request)
    chosen = _tactics(req.tactics) if req.tactics else None
    return coach.game_plan(engine, req.team_id, req.opponent_id, req.venue, _drills_for, chosen, DRILLS)


class AskRequest(BaseModel):
    team_id: str
    opponent_id: str
    venue: str = "home"
    question: str = Field(..., min_length=1, max_length=1000)
    history: list[dict] = []
    tactics: Tactics | None = None


# Spending guards for a public site: questions per visitor per day, and a daily budget for the whole site.
def _env_number(name: str, default: float, kind=float):
    try:
        return kind(os.environ.get(name, default))
    except ValueError:
        return kind(default)


ASK_PER_DAY = _env_number("TWELFTH_MAN_ASK_PER_DAY", 8, int)
DAILY_BUDGET = _env_number("TWELFTH_MAN_DAILY_BUDGET", 1.00)
_asked: dict[tuple[str, int], int] = {}


@app.post("/api/ask")
def ask(req: AskRequest, request: Request):
    """Ask Coach Twelve: answers grounded in this match's game plan and the match engine."""
    _check(req.team_id, req.opponent_id, request)
    chosen = _tactics(req.tactics) if req.tactics else None
    plan = coach.game_plan(engine, req.team_id, req.opponent_id, req.venue, _drills_for, chosen, DRILLS)
    uid = _user(request)["id"]
    day = int(time.time() // 86400)
    if conn.enabled:
        if _asked.get((uid, day), 0) >= ASK_PER_DAY:
            return {"answer": offline_answer(req.question, plan), "source": "offline",
                    "note": f"You've used today's {ASK_PER_DAY} full answers, so this one comes from the game plan. Full answers are back tomorrow."}
        if usage.spent_today() >= DAILY_BUDGET:
            return {"answer": offline_answer(req.question, plan), "source": "offline",
                    "note": "Coach Twelve has answered a lot of questions today, so this answer comes from the game plan. Full answers are back tomorrow."}
        _asked[(uid, day)] = _asked.get((uid, day), 0) + 1
    return assistant.ask(engine, req.team_id, req.opponent_id, req.venue, req.question.strip(), req.history, plan,
                         viewer_id=uid)


@app.get("/api/drills")
def drills():
    return DRILLS


@app.get("/api/model-card")
def model_card():
    return engine.model_card()


@app.get("/api/archetype-map")
def archetype_map(request: Request):
    return engine.archetype_map(_user(request))


# ---- local club data

@app.get("/api/local/teams")
def local_teams(request: Request):
    mine = accounts.team_ids(_user(request)["id"])
    return [t for t in store.list_teams() if t["id"] in mine]


@app.post("/api/local/teams")
def create_local_team(req: TeamCreate, request: Request):
    try:
        return store.create_team(req.name, req.level, req.roster, owner_id=_user(request)["id"])
    except ValidationError as e:
        raise HTTPException(422, {"errors": e.errors})


@app.delete("/api/local/teams/{team_id}")
def delete_local_team(team_id: str, request: Request):
    _own_local(request, team_id)
    store.delete_team(team_id)
    return {"ok": True}


@app.put("/api/local/teams/{team_id}/roster")
def update_roster(team_id: str, roster: list[dict], request: Request):
    _own_local(request, team_id)
    store.update_roster(team_id, roster)
    return {"ok": True}


@app.get("/api/local/teams/{team_id}/matches")
def local_matches(team_id: str, request: Request):
    _own_local(request, team_id)
    return store.matches(team_id)


@app.post("/api/local/teams/{team_id}/matches")
def add_local_match(team_id: str, match: dict, request: Request):
    _own_local(request, team_id)
    try:
        return store.add_match(team_id, match)
    except ValidationError as e:
        raise HTTPException(422, {"errors": e.errors})


@app.delete("/api/local/teams/{team_id}/matches/{match_id}")
def delete_local_match(team_id: str, match_id: int, request: Request):
    _own_local(request, team_id)
    store.delete_match(team_id, match_id)
    return {"ok": True}


@app.post("/api/local/teams/{team_id}/upload")
async def upload_csv(request: Request, team_id: str, file: UploadFile = File(...), replace: bool = Form(False)):
    _own_local(request, team_id)
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, "CSV too large (2 MB max)")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    try:
        res = store.import_csv(team_id, text, replace)
    except ValidationError as e:
        raise HTTPException(422, {"errors": e.errors})
    t = engine.team(team_id)
    res["profile"] = {"archetype": t["archetype"], "rating": t["rating"], "matches": t["matches"]}
    return res


@app.get("/api/local/template.csv")
def csv_template():
    return PlainTextResponse(template_csv(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=twelfth-man-template.csv"})


# ---- accounts
class SignupRequest(BaseModel):
    name: str = Field(..., max_length=80)
    email: str = Field(..., max_length=200)
    password: str = Field(..., max_length=200)


class LoginRequest(BaseModel):
    email: str = Field(..., max_length=200)
    password: str = Field(..., max_length=200)


def _is_https(request: Request | None) -> bool:
    if request is None:
        return False
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https"


def _session_response(user: dict, request: Request | None = None) -> NumpyJSON:
    resp = NumpyJSON({"user": user, "club": accounts.club(user["id"])})
    resp.set_cookie(COOKIE, accounts.new_session(user["id"]), httponly=True, samesite="lax",
                    secure=_is_https(request), max_age=30 * 86400, path="/")
    return resp


_guest_starts: dict[str, list[float]] = {}
GUESTS_PER_HOUR = _env_number("TWELFTH_MAN_GUESTS_PER_HOUR", 20, int)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")


@app.post("/api/auth/signup")
def signup(req: SignupRequest, request: Request):
    try:
        return _session_response(accounts.signup(req.email, req.name, req.password), request)
    except AuthError as e:
        raise HTTPException(422, str(e))


@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request):
    try:
        return _session_response(accounts.login(req.email, req.password), request)
    except AuthError as e:
        raise HTTPException(401, str(e))


@app.post("/api/auth/guest")
def guest(request: Request):
    """Start a demo session instantly: a private guest account pre-filled with the demo club."""
    ip = _client_ip(request)
    now = time.time()
    recent = [t for t in _guest_starts.get(ip, []) if now - t < 3600]
    if len(recent) >= GUESTS_PER_HOUR:
        raise HTTPException(429, "Too many demo sessions from this connection. Please try again later.")
    _guest_starts[ip] = recent + [now]
    u = accounts.create_guest()
    u["guest"] = True
    request.state.user = u
    load_demo(request)
    return _session_response(u, request)


@app.post("/api/auth/logout")
def logout(request: Request):
    accounts.end_session(request.cookies.get(COOKIE))
    resp = NumpyJSON({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
def me(request: Request):
    u = request.state.user
    if not u:
        return {"user": None, "club": None}
    return {"user": u, "club": accounts.club(u["id"])}


# ---- club profile
CLUB_FIELDS = ["club_name", "team_name", "age_group", "category", "level", "colours", "founded",
               "country", "region", "city", "area", "postcode", "ground_name", "ground_address",
               "league", "division", "season", "match_format", "half_length", "subs_rule", "max_subs",
               "pitch_surface", "pitch_size", "training_days", "coach_role", "squad_size", "goals_this_season"]


@app.get("/api/club")
def get_club(request: Request):
    return accounts.club(_user(request)["id"])


@app.put("/api/club")
def save_club(data: dict, request: Request):
    u = _user(request)
    clean = {k: (str(v).strip()[:200] if v is not None else "") for k, v in data.items() if k in CLUB_FIELDS}
    if not clean.get("club_name"):
        raise HTTPException(422, "Club name is required.")
    existing = accounts.club(u["id"])
    team_id = existing["team_id"] if existing else None
    label = f"{clean['club_name']}" + (f" {clean['team_name']}" if clean.get("team_name") else "")
    if not team_id or not accounts.owns_team(u["id"], team_id):
        team_id = store.create_team(label, clean.get("age_group", ""), owner_id=u["id"])["id"]
    else:
        with store._conn() as c:
            c.execute("UPDATE local_teams SET name = ?, level = ? WHERE id = ?", (label, clean.get("age_group", ""), team_id))
    return accounts.save_club(u["id"], clean, team_id)


# ---- opponents & fixtures
@app.get("/api/opponents")
def list_opponents(request: Request):
    u = _user(request)
    out = []
    for o in accounts.opponents(u["id"]):
        try:
            p = engine.team(o["id"])
            o["profile"] = {"rating": p["rating"], "record": p["record"], "archetype": p["archetype"]["name"],
                            "style_in_words": coach.PLAIN_STYLE.get(p["archetype"]["name"], ""),
                            "sources": p["data_quality"]["sources"], "note": p["data_quality"]["note"]}
        except KeyError:
            pass
        out.append(o)
    return out


@app.post("/api/opponents")
def save_opponent(data: dict, request: Request):
    u = _user(request)
    payload = {}
    if "scouting" in data and isinstance(data["scouting"], dict):
        sc = {k: data["scouting"].get(k) for k in ("formation", "press_rating", "directness_rating", "width_rating",
                                                   "possession", "key_players", "notes", "set_piece_threat")}
        if sc.get("formation") and sc["formation"] not in FAMILIES:
            raise HTTPException(422, f"formation must be one of {FAMILIES}")
        payload["scouting"] = sc
    for k in ("ground", "contact"):
        if k in data:
            payload[k] = str(data[k])[:200]
    try:
        return accounts.upsert_opponent(u["id"], data.get("name", ""), payload, data.get("id"))
    except AuthError as e:
        raise HTTPException(422, str(e))


@app.delete("/api/opponents/{opp_id}")
def delete_opponent(opp_id: str, request: Request):
    accounts.delete_opponent(_user(request)["id"], opp_id)
    return {"ok": True}


class TableRequest(BaseModel):
    text: str = Field(..., max_length=20000)


@app.post("/api/league-table")
def import_league_table(req: TableRequest, request: Request):
    u = _user(request)
    rows = parse_league_table(req.text)
    if not rows:
        raise HTTPException(422, "Couldn't read any rows. Use one team per line: position, team name, P, W, D, L, GF, GA.")
    club = accounts.club(u["id"]) or {}
    own_names = {(club.get("club_name") or "").lower(), f"{club.get('club_name', '')} {club.get('team_name', '')}".strip().lower()}
    imported, own_row = [], None
    for r in rows:
        if r["name"].lower() in own_names:
            own_row = r
            continue
        accounts.upsert_opponent(u["id"], r["name"], {"table": r})
        imported.append(r["name"])
    if own_row and club:
        accounts.save_club(u["id"], {**{k: v for k, v in club.items() if k != "team_id"}, "table": own_row}, club["team_id"])
    return {"imported": imported, "own_row": own_row, "count": len(rows)}


class FixtureRequest(BaseModel):
    opponent: str = Field(..., min_length=1, max_length=120)
    date: str = Field(..., max_length=10)
    time: str = Field("", max_length=5)
    venue: str = "home"
    competition: str = Field("League", max_length=80)
    goals_for: int | None = Field(None, ge=0, le=50)
    goals_against: int | None = Field(None, ge=0, le=50)


@app.get("/api/fixtures")
def list_fixtures(request: Request):
    u = _user(request)
    opps = {o["name"].lower(): o["id"] for o in accounts.opponents(u["id"])}
    out = []
    for f in accounts.fixtures(u["id"]):
        f["opponent_id"] = opps.get(f["opponent"].lower())
        out.append(f)
    return out


def _validate_fixture(req: FixtureRequest) -> dict:
    import datetime as _dt
    try:
        _dt.date.fromisoformat(req.date)
    except ValueError:
        raise HTTPException(422, "Date must be YYYY-MM-DD.")
    if req.venue not in ("home", "away", "neutral"):
        raise HTTPException(422, "Venue must be home, away or neutral.")
    return req.model_dump()


@app.post("/api/fixtures")
def add_fixture(req: FixtureRequest, request: Request):
    u = _user(request)
    data = _validate_fixture(req)
    accounts.upsert_opponent(u["id"], req.opponent.strip(), {})  # make sure the opponent exists
    return accounts.save_fixture(u["id"], data)


@app.put("/api/fixtures/{fixture_id}")
def update_fixture(fixture_id: int, req: FixtureRequest, request: Request):
    u = _user(request)
    data = _validate_fixture(req)
    accounts.upsert_opponent(u["id"], req.opponent.strip(), {})
    return accounts.save_fixture(u["id"], data, fixture_id)


@app.delete("/api/fixtures/{fixture_id}")
def delete_fixture(fixture_id: int, request: Request):
    accounts.delete_fixture(_user(request)["id"], fixture_id)
    return {"ok": True}


@app.post("/api/demo")
def load_demo(request: Request):
    """Fill a new account with a complete example season (club, results, squad, league table, fixtures, scouting)."""
    u = _user(request)
    if accounts.club(u["id"]):
        raise HTTPException(409, "You already have a club set up.")
    club = {"club_name": "Riverside FC", "team_name": "U18", "age_group": "U18", "category": "Boys", "level": "Grassroots",
            "colours": "Sky blue & white", "country": "United Kingdom", "region": "Greater Manchester", "city": "Salford",
            "area": "Riverside Park", "ground_name": "Riverside Park pitch 2", "league": "Salford & District Youth League",
            "division": "U18 Division 1", "season": "2026-27", "match_format": "11-a-side", "half_length": "40",
            "subs_rule": "rolling", "max_subs": "5", "pitch_surface": "Grass", "pitch_size": "Standard",
            "training_days": "Tuesday, Thursday, Friday", "coach_role": "Head coach"}
    saved = save_club(club, request)
    tid = saved["team_id"]
    store.update_roster(tid, _demo_roster("Riverside FC"))
    store.import_csv(tid, (ROOT / "sample_data" / "riverside_fc.csv").read_text())
    import_league_table(TableRequest(text=(ROOT / "sample_data" / "league_table.txt").read_text()), request)
    accounts.upsert_opponent(u["id"], "Northgate Athletic", {"scouting": {
        "formation": "4-3-3", "press_rating": 5, "directness_rating": 2, "width_rating": 4, "possession": 60,
        "key_players": "Quick right winger (#7); tall centre-back strong in the air", "notes": "Press high from kick-off; struggled vs long balls at Westbrook.",
        "set_piece_threat": True}})
    accounts.upsert_opponent(u["id"], "Kingsbridge Rovers", {"scouting": {"formation": "4-4-2", "press_rating": 3, "directness_rating": 4, "width_rating": 3}})
    import datetime as _dt
    today = _dt.date.today()
    first_sat = today + _dt.timedelta(days=(5 - today.weekday()) % 7 or 7)  # next Saturday
    for weeks, opp, venue in [(0, "Northgate Athletic", "home"), (1, "Harbour Town", "away"), (2, "St. Mary's Colts", "home"),
                              (3, "Westbrook Youth", "away"), (4, "Kingsbridge Rovers", "home"), (5, "Valley Rangers", "away")]:
        accounts.save_fixture(u["id"], {"opponent": opp, "date": (first_sat + _dt.timedelta(weeks=weeks)).isoformat(), "time": "10:30",
                                         "venue": venue, "competition": "League", "goals_for": None, "goals_against": None})
    return {"ok": True, "club": accounts.club(u["id"])}


# ---- web app
# Assets are served under a version path (/static/v<hash>/...) that changes whenever any
# frontend file changes, so a browser can never run a stale copy of the app.
FRONTEND = ROOT / "frontend"


def _asset_version() -> str:
    import hashlib
    hsh = hashlib.sha1()
    for f in sorted(FRONTEND.rglob("*")):
        if f.is_file():
            st = f.stat()
            hsh.update(f"{f}:{st.st_mtime_ns}:{st.st_size}".encode())
    return hsh.hexdigest()[:10]


@app.get("/static/v{ver}/{path:path}")
def versioned_asset(ver: str, path: str):
    target = (FRONTEND / path).resolve()
    if not str(target).startswith(str(FRONTEND.resolve())) or not target.is_file():
        raise HTTPException(404)
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable"})


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    html = (FRONTEND / "index.html").read_text().replace("/static/", f"/static/v{_asset_version()}/")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
