"""Coach mode: turns model output into plain football language.

No percentages, no xG, no jargon — just how hard the game is, how the opponent plays,
what our plan is, what each player does, and what to train. The numbers still come
from the engine; this module only translates them into words.
"""
from __future__ import annotations

PLAIN_STYLE = {
    "Possession & High Press": "They keep the ball a lot and chase you hard when they lose it.",
    "Controlled Possession": "They like to keep the ball with short passes and are patient.",
    "Wide Balanced Block": "They play a balanced game and like to attack down the wings.",
    "Counter-Attacking Low Block": "They sit deep, defend in numbers and break forward fast.",
    "Direct & Physical": "They play long balls forward quickly and fight for second balls.",
    "Compact Mid Block": "They stay compact and organised and mix short and long passes.",
}

ZONE_PLAIN = {
    "left wing": "left wing", "right wing": "right wing", "centre": "middle",
    "left half-space": "left side of the box", "right half-space": "right side of the box",
}


DANGER_PLAIN = {
    "Their press vs your build-up": ("They'll press you high", "They chase hard when you have the ball at the back. Don't take risks near your own goal — go long if you're under pressure."),
    "Space behind your high line": ("Balls in behind", "They hit long balls over the top quickly. Defenders: don't push up too high and watch the runners."),
    "Long spells without the ball": ("You'll defend a lot", "They keep the ball well. Stay patient and compact — don't chase shadows — and make every turnover count."),
    "Wide overloads": ("Danger down the wings", "They attack wide with lots of players. Wingers must help their full-backs."),
    "Press could be bypassed": ("Good passers", "They pass well, so chasing them everywhere can leave gaps. Press together or not at all."),
    "Set-piece threat": ("Dangerous at set pieces", "They score a lot from corners and free kicks. Mark tightly and attack the first ball."),
    "No major style mismatch": ("No big surprises", "Their style suits yours — the game will come down to effort, concentration and taking chances."),
}


FOCUS_PLAIN = {
    "Counter-attacks against": ("Stop counter-attacks", "You get caught out when you lose the ball going forward. Keep 2–3 players back when you attack."),
    "Late-game concessions": ("Finish games strongly", "You concede a lot late on. Work on fitness and on staying switched on in the last 20 minutes."),
    "Ball security": ("Keep the ball better", "You give the ball away too often. Practise passing and moving under pressure."),
    "Chances conceded": ("Defend as a team", "You let the opponent create too much. Work on staying compact without the ball."),
    "Chance creation": ("Create more chances", "You don't create enough. Practise getting into the box with quick combinations."),
    "Defending set pieces": ("Defend set pieces", "This opponent is dangerous from corners and free kicks. Rehearse your marking."),
    "Set-piece threat": ("Score from set pieces", "You rarely threaten from corners and free kicks — an easy way to get goals."),
}


def _join_zones(items) -> str:
    names = list(dict.fromkeys(ZONE_PLAIN[a["zone"]] for a in items))
    pair = set(names)
    if pair == {"left wing", "right wing"}:
        return "both wings"
    if pair == {"left side of the box", "right side of the box"}:
        return "both sides of the box"
    if not names:
        return ""
    return " and ".join(f"the {n}" for n in names)


def _change_words(usual: dict, new: dict) -> str:
    parts = []
    if new["formation"] != usual["formation"]:
        parts.append(f"switch to {new['formation']}")
    for lev, (up, down) in {"press": ("press higher", "drop deeper"), "tempo": ("play forward quicker", "keep the ball more"),
                            "width": ("play wider", "play narrower")}.items():
        if new[lev] > usual[lev]:
            parts.append(up)
        elif new[lev] < usual[lev]:
            parts.append(down)
    text = " and ".join(parts) or "keep your usual set-up"
    return text[0].upper() + text[1:]


def _level(v: int) -> str:
    return "high" if v >= 65 else ("low" if v <= 35 else "mid")


def difficulty(win: float, loss: float) -> dict:
    if win < 0.04 and loss > 0.85:
        return {"label": "Very, very difficult", "tone": "bad",
                "text": "They're a far stronger side — professional level. Realistically, winning is close to impossible. "
                        "Aim to stay compact, keep the score respectable and learn from the experience."}
    if win > 0.85 and loss < 0.04:
        return {"label": "Huge favourites", "tone": "good",
                "text": "You're at a far higher level. The only danger is complacency — stay focused and professional."}
    if win < 0.15 and loss > 0.65:
        return {"label": "Very tough game", "tone": "bad",
                "text": "They're much stronger. Be organised, hard to beat and take any chance that comes."}
    if win >= 0.55:
        return {"label": "You're favourites", "tone": "good",
                "text": "You should have the upper hand — stay focused and don't take them lightly."}
    if win >= 0.42 and win > loss:
        return {"label": "Slight edge to you", "tone": "good",
                "text": "A close game you can win if you stick to the plan."}
    if abs(win - loss) < 0.08:
        return {"label": "Even game", "tone": "neutral",
                "text": "It could go either way — small details like set pieces and concentration will decide it."}
    if loss >= 0.55:
        return {"label": "Tough game", "tone": "bad",
                "text": "They're the stronger side on paper. Be hard to beat, stay compact and take your chances."}
    return {"label": "Slight edge to them", "tone": "bad",
            "text": "They're a bit stronger — a disciplined performance can still get a result."}


def instructions(t: dict, zones: dict) -> list[dict]:
    """Team instructions in plain language from the tactic levers."""
    out = []
    press, tempo, width = _level(t["press"]), _level(t["tempo"]), _level(t["width"])
    out.append({"title": {"high": "Press high", "mid": "Stay compact, press in midfield", "low": "Defend deep and counter"}[press],
                "text": {"high": "When they have the ball at the back, close down their defenders and goalkeeper straight away.",
                         "mid": "Hold a tight shape around halfway. Go and win the ball when it goes wide or they turn their back.",
                         "low": "Drop back into our half, stay tight together, and break forward fast when we win it."}[press]})
    out.append({"title": {"high": "Play forward quickly", "mid": "Mix it up", "low": "Keep the ball"}[tempo],
                "text": {"high": "When we win it, look forward first — find runners in behind early.",
                         "mid": "Pass short when it's on, go forward quickly when there's space behind.",
                         "low": "Pass short, be patient, and move the ball until the gap appears."}[tempo]})
    out.append({"title": {"high": "Use the whole width", "mid": "Balanced shape", "low": "Stay narrow"}[width],
                "text": {"high": "Wide players stay on the touchline to stretch them; switch play when they crowd one side.",
                         "mid": "Keep a balanced shape — wide players come inside when the ball is on the other side.",
                         "low": "Stay close together and combine through the middle; protect the centre."}[width]})
    if zones.get("attack"):
        z = _join_zones(zones["attack"])
        out.append({"title": "Where to attack", "text": f"They leave space on {z} — get the ball there."})
    if zones.get("protect"):
        z = _join_zones(zones["protect"])
        out.append({"title": "Where to be careful", "text": f"Most of their attacks come down {z} — double up there."})
    return out


def roles(t: dict, zones: dict) -> list[dict]:
    """One short job per position group."""
    press, tempo = _level(t["press"]), _level(t["tempo"])
    back3 = t["formation"] in ("3-5-2", "3-4-3")
    protect = _join_zones(zones.get("protect", [])) or "the wings"
    attack = _join_zones(zones.get("attack", [])) or "the channels"
    out = [
        {"group": "Goalkeeper", "jobs": [
            "Kick long to the strikers when they press you." if tempo == "high" else "Play short to the centre-backs; go long only if they press.",
            "Organise the back line — talk all game."]},
        {"group": "Defenders", "jobs": [
            {"high": "Hold a high line and step up together.", "mid": "Stay connected with the midfield — no big gaps.",
             "low": "Stay deep and compact; don't get pulled out of position."}[press],
            f"Watch {protect} — that's where they attack most."]},
    ]
    if back3:
        out.append({"group": "Wing-backs", "jobs": ["Give us width going forward.", "Sprint back as soon as we lose the ball."]})
    out.append({"group": "Midfielders", "jobs": [
        {"high": "Close down quickly when they receive the ball.", "mid": "Screen the middle; force them wide.",
         "low": "Protect the space in front of our defence."}[press],
        {"high": "Look forward first — find the runners.", "mid": "Keep it simple; switch play when one side is crowded.",
         "low": "Offer angles and keep the ball moving."}[tempo]]})
    out.append({"group": "Forwards", "jobs": [
        {"high": "Press their centre-backs and force them wide.", "mid": "Block passes into their midfield.",
         "low": "Stay high as an outlet for the counter-attack."}[press],
        f"Make runs into {attack}."]})
    return out


def _int(v, default):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def subs_advice(t: dict, club: dict | None = None) -> str:
    """Timing scaled to the club's match length and substitution rules."""
    club = club or {}
    half = _int(club.get("half_length"), 45)
    full = 2 * half
    max_subs = str(club.get("max_subs") or "").strip()
    rolling = club.get("subs_rule") == "rolling"
    pressing = _level(t["press"]) == "high"
    first = round(full * (0.6 if pressing else 0.68) / 5) * 5
    late = max(5, round(full * 0.12 / 5) * 5)
    if rolling:
        rest = max(5, round(full * 0.1 / 5) * 5)
        text = (f"Subs are rolling, so rotate fresh legs in and out. Give your hardest-working players a {rest}-minute rest "
                f"in each half, starting around minute {round(half * 0.6)}" + (", especially up front and in midfield because pressing is tiring" if pressing else "") + ".")
        if max_subs and max_subs.isdigit():
            text += f" Check whether players going back on count towards your {max_subs}."
        return text
    count = f"your {max_subs} changes" if max_subs.isdigit() else "your changes"
    if pressing:
        return (f"Pressing high is tiring. Make your first changes around minute {first}, especially up front and in midfield, "
                f"and keep one of {count} for the last {late} minutes.")
    return f"Make your first change around minute {first} and keep one of {count} for the last {late} minutes to protect a result."


def verdicts(impact: dict) -> list[dict]:
    """Words, not numbers, for what a change does."""
    out = []
    if impact["xg_for"] > 0.04:
        out.append({"text": "Creates more chances", "good": True})
    elif impact["xg_for"] < -0.04:
        out.append({"text": "Creates fewer chances", "good": False})
    if impact["xg_against"] < -0.04:
        out.append({"text": "Gives away fewer chances", "good": True})
    elif impact["xg_against"] > 0.04:
        out.append({"text": "Gives away more chances", "good": False})
    if impact.get("fatigue_change", 0) > 0.01:
        out.append({"text": "More tiring — needs fresh legs", "good": False})
    if not out:
        out.append({"text": "Small improvement overall", "good": True})
    return out


def describe_tactics(t: dict) -> str:
    return (f"{t['formation']}, "
            f"{ {'high': 'pressing high', 'mid': 'compact in midfield', 'low': 'defending deep'}[_level(t['press'])] }, "
            f"{ {'high': 'playing forward quickly', 'mid': 'mixing short and long', 'low': 'keeping the ball'}[_level(t['tempo'])] }")


def simple_drill(d: dict) -> dict:
    return {"id": d["id"], "name": d["name"], "minutes": d["minutes"], "players": d["players"], "area": d["area"],
            "why": d["objective"], "how": d["setup"], "tips": d["coaching_points"], "next": d["progression"],
            "diagram": d["diagram"]}


def _option(engine, us, opp, venue, usual, base, tactics, name, recommended=False, confidence=None):
    """Compare a way of playing with the usual one, in words."""
    ev = engine.evaluate(us, opp, tactics, venue, "normal")
    ff_u, fa_u = engine._avg_fatigue(usual, "normal")
    ff_n, fa_n = engine._avg_fatigue(tactics, "normal")
    impact = {"xg_for": ev["xg_for"] - base["xg_for"], "xg_against": ev["xg_against"] - base["xg_against"],
              "fatigue_change": fa_n - fa_u}
    gain = ev["xpts"] - base["xpts"]
    v = verdicts(impact)
    if gain < -0.03:
        v.insert(0, {"text": "Slightly worse overall for this game", "good": False})
    return {"name": name, "tactics": tactics, "summary": describe_tactics(tactics), "verdicts": v,
            "recommended": recommended, "confidence": confidence, "gain": round(gain, 3)}


def _difficulty_with_plan(base_p, plan_p, changed: bool) -> dict:
    d = difficulty(base_p[0], base_p[2])
    gain = (3 * plan_p[0] + plan_p[1]) - (3 * base_p[0] + base_p[1])
    if changed and gain > 0.03:
        d = {**d, "text": d["text"] + " Our plan below improves your chances."}
    elif changed and gain < -0.03:
        d = {**d, "text": d["text"] + " The plan you picked is slightly riskier than your usual way."}
    return d


def game_plan(engine, team_id: str, opponent_id: str, venue: str, drills_for, chosen: dict | None = None,
              all_drills: list | None = None) -> dict:
    us, opp = engine.team(team_id), engine.team(opponent_id)
    mu = engine.matchup(team_id, opponent_id)
    usual = engine.default_tactics(us)
    both_pro = team_id in engine.pro and opponent_id in engine.pro
    rec = engine.recommend(team_id, opponent_id, usual, venue)
    best = rec["recommendations"][0] if rec["recommendations"] else None
    # Two professional teams: both play their usual way, so the result doesn't depend on which side is "mine".
    plan_t = {**usual, **chosen} if chosen else (usual if both_pro or not best else best["tactics"])
    ev = engine.evaluate(us, opp, plan_t, venue, "normal")
    base = engine.evaluate(us, opp, usual, venue, "normal")
    p = ev["p"]

    options = [{"name": "Your usual way", "tactics": usual, "summary": describe_tactics(usual),
                "verdicts": [{"text": "What the players already know", "good": True}],
                "recommended": not best or both_pro, "gain": 0.0}]
    seen = {tuple(sorted(usual.items()))}
    for i, r in enumerate(rec["recommendations"][:2]):
        options.append(_option(engine, us, opp, venue, usual, base, r["tactics"], _change_words(usual, r["tactics"]),
                               recommended=(i == 0 and not both_pro),
                               confidence={"high": "We're confident this helps", "moderate": "Likely to help",
                                           "low": "Might help"}[r["confidence_label"]]))
        seen.add(tuple(sorted(r["tactics"].items())))
    # Always offer a safer and a bolder alternative so the coach has real choices.
    safer = {**usual, "press": max(10, usual["press"] - 25), "width": max(10, usual["width"] - 10)}
    bolder = {**usual, "press": min(90, usual["press"] + 25), "tempo": min(90, usual["tempo"] + 20)}
    for t, name in ((safer, "Safer: drop deeper and stay compact"), (bolder, "Bolder: press higher and play forward quicker")):
        if len(options) >= 3:
            break
        if tuple(sorted(t.items())) not in seen:
            options.append(_option(engine, us, opp, venue, usual, base, t, name))
            seen.add(tuple(sorted(t.items())))

    acc = getattr(engine, "accounts", None)
    owner = acc.owner_of(team_id) if acc and not team_id.startswith("opp-") and team_id not in engine.pro else None
    club = (acc.club(owner) if owner else None) or {}
    next_fx = None
    if owner:
        import datetime as _dt
        today = _dt.date.today().isoformat()
        nxt = [f for f in acc.fixtures(owner) if f["opponent"].lower() == opp["label"].lower() and f.get("goals_for") is None and f["date"] >= today]
        next_fx = nxt[0] if nxt else None
    tags = (best["drill_tags"] if best else []) + [t for w in rec["weaknesses"] for t in w["tags"]]
    drills = [simple_drill(d) for d in drills_for(tags, 3)] if tags else [simple_drill(d) for d in drills_for(["possession", "pressing", "transition"], 3)]

    DANGER_PLAIN.setdefault("Huge difference in level", ("A much higher level", "They're professional or international players. Expect to defend for long spells — stay compact, help each other and don't get frustrated."))
    DANGER_PLAIN.setdefault("You're the much stronger side", ("Don't get complacent", "You're at a far higher level. Keep the tempo high and finish your chances."))
    unknown = opp.get("source") == "scouted" and not (opp.get("scouting") or {}).get("press_rating") and not (opp.get("scouting") or {}).get("formation")
    dangers = [dict(zip(("title", "text"), DANGER_PLAIN.get(r["title"], (r["title"], r["detail"])))) for r in mu["risks"][:3]]
    if unknown:
        dangers = [d for d in dangers if d["title"] != "No big surprises"]
        dangers.insert(0, {"title": "Not scouted yet", "text": "We don't know how they play. Watch the first 10 minutes closely, "
                           "keep your shape, and add scouting notes after the game so next time's plan is sharper."})
        dangers = dangers[:3]
    style = ("Not scouted yet — add notes on the Season page to learn their style."
             if unknown else PLAIN_STYLE.get(opp["archetype"]["name"], opp["archetype"]["description"]))
    past = mu.get("h2h") or []
    formation_known = not unknown
    return {
        "team": {"id": us["id"], "name": us["label"].split(" · ")[0], "formation": us["formation"],
                 "roster": us.get("roster") or []},
        "opponent": {"id": opp["id"], "name": opp["label"].split(" · ")[0],
                     "formation": opp["formation"] if formation_known else None,
                     "style": style, "style_name": opp["archetype"]["name"], "scouted": not unknown},
        "difficulty": _difficulty_with_plan(base["p"], p, plan_t != usual),
        "dangers": dangers,
        "plan": {"tactics": plan_t, "summary": describe_tactics(plan_t),
                 "changed": plan_t != usual, "change_title": _change_words(usual, plan_t) if plan_t != usual else None,
                 "instructions": instructions(plan_t, mu["zones"]), "roles": roles(plan_t, mu["zones"]),
                 "subs": subs_advice(plan_t, club)},
        "zones": mu["zones"],
        "past_meetings": past,
        "both_pro": both_pro,
        "chances": {"win": round(p[0], 3), "draw": round(p[1], 3), "loss": round(p[2], 3)},
        "options": options,
        "focus": [dict(zip(("title", "text"), FOCUS_PLAIN.get(w["title"], (w["title"], w["detail"])))) for w in rec["weaknesses"][:3]],
        "drills": drills,
        "week": weekly_training(best["drill_tags"] if best else [], [t for w in rec["weaknesses"] for t in w["tags"]],
                                [d["title"] for d in dangers], opp["label"].split(" · ")[0], club,
                                next_fx["date"] if next_fx else None, all_drills or [], plan_t["formation"], opp["id"]),
    }


# ---------------------------------------------------------------- weekly training schedule
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

CONDITIONED_GAMES = {
    "pressing": "{n} game: a goal scored within 8 seconds of winning the ball counts double.",
    "counter-press": "{n} game: if you lose the ball, win it back within 5 seconds for a bonus point.",
    "transition": "{n} game: after every turnover, the team that wins it must shoot within 10 seconds.",
    "wide-play": "{n} game with wide channels: goals from a cross or cut-back count double.",
    "defensive-shape": "{n} game: the defending team scores a point for every 5 passes they force sideways or backwards.",
    "compact-block": "{n} game: coach freezes play to check the distances between your lines.",
    "possession": "{n} game: 6 passes in a row earns a point; goals still count.",
    "build-up": "{n} game: goal kicks must be played short; if pressed, go long into a target zone.",
    "set-pieces": "{n} game: every stoppage restarts with a corner or wide free kick to practise routines.",
    "fitness": "4 x 4-minute {n} games at full intensity, 2 minutes rest between.",
    "game-management": "Scenario game: '1-0 up, 10 minutes left' — then swap to '0-1 down, 10 minutes left'.",
    "final-third": "{n} game: all goals must come from inside the box; first-time finishes count double.",
    "technique": "{n} game: two-touch maximum, and every player must touch the ball before a goal counts.",
    "fun-games": "{n} mini-tournament: short games, winners stay on, keep a league table.",
    "recovery": "Relaxed {n} keep-ball at walking pace — no tackles.",
}

THEMES = {
    "recovery": ("Recovery", "Help the legs recover from the last game and talk it through.", ["recovery", "possession"], "low"),
    "weakness": ("Fix our weaknesses", "Work on what your results say needs improving.", None, "high"),
    "technique": ("Technique & finishing", "Sharpen first touch, passing and finishing.", ["technique", "first-touch", "shooting", "final-third", "goalkeeping"], "medium"),
    "skills": ("Skills & fun", "Lots of touches, dribbling and small games — the best way for young players to improve.", ["technique", "dribbling", "fun-games", "passing"], "medium"),
    "plan": ("Game plan", "Rehearse how you'll play this week's opponent.", None, "high"),
    "prep": ("Match prep — light & sharp", "Short, sharp and fresh legs: set pieces, patterns and game situations.", ["set-pieces", "build-up", "game-management", "passing"], "low"),
    "single": ("Game plan + our weaknesses", "One session to cover the essentials.", None, "high"),
}

FORMATION_TAGS = {"3-5-2": ["back-three", "wing-backs"], "3-4-3": ["back-three", "wing-backs", "front-three"],
                  "4-3-3": ["front-three", "midfield-triangle"], "4-2-3-1": ["double-pivot", "number-10"],
                  "4-4-2": ["two-strikers", "banks-of-four"], "4-1-4-1": ["single-pivot", "compact-block"]}


def _parse_days(text: str) -> list[str]:
    import re
    out = []
    for part in re.split(r"[^A-Za-z]+", str(text or "")):
        p = part.strip().lower()
        if len(p) < 2 or p == "and":
            continue
        for d in DAYS:
            if d.lower().startswith(p[:3]) and d not in out:
                out.append(d)
    return sorted(out, key=DAYS.index)


def _age_years(age_group: str) -> int:
    g = str(age_group or "")
    if g.startswith("U") and g[1:].isdigit():
        return int(g[1:])
    return 30 if g in ("Senior", "Veterans (35+)", "") else 18


def _pick(all_drills, tags, used, youth, salt, k=2):
    import hashlib
    scored = []
    for d in all_drills:
        if d["id"] in used or (youth and d.get("ages") == "12+"):
            continue
        overlap = [t for t in d["tags"] if t in tags]
        if not overlap:
            continue
        score = sum(1 / (1 + tags.index(t)) for t in overlap) + 0.5 * len(overlap)
        if youth and any(t in d["tags"] for t in ("technique", "fun-games", "dribbling")):
            score += 0.6
        # rotate between equally good drills from week to week / opponent to opponent
        jitter = int(hashlib.md5(f"{salt}:{d['id']}".encode()).hexdigest()[:4], 16) / 65535 * 0.9
        scored.append((score + jitter, d))
    scored.sort(key=lambda x: -x[0])
    return [d for _, d in scored[:k]]


def weekly_training(plan_tags: list, weakness_tags: list, danger_titles: list, opp_name: str, club: dict,
                    match_date: str | None, all_drills: list, formation: str, salt: str) -> dict:
    import datetime as _dt
    club = club or {}
    days = _parse_days(club.get("training_days", "")) or ["Tuesday", "Thursday"]
    match_day = None
    if match_date:
        try:
            match_day = DAYS[_dt.date.fromisoformat(match_date).weekday()]
        except ValueError:
            pass
    md = DAYS.index(match_day) if match_day else 5  # assume a Saturday game when no fixture is set
    days = [d for d in days if d != DAYS[md]] or [DAYS[(md - 2) % 7]]
    # order sessions as the week builds towards the game: earliest (furthest from the match) first
    days = sorted(days, key=lambda d: -((md - DAYS.index(d)) % 7))[:5]
    gap = {d: (md - DAYS.index(d)) % 7 for d in days}

    age = _age_years(club.get("age_group"))
    youth = age <= 12
    fmt = str(club.get("match_format") or "11-a-side")
    small = {"5-a-side": "3v3", "7-a-side": "4v4", "9-a-side": "6v6"}.get(fmt, "8v8")
    if youth:
        lengths = {"warmup": 8, "drill": 12, "game": 15, "cool": 5}
    elif age <= 15:
        lengths = {"warmup": 10, "drill": 15, "game": 20, "cool": 5}
    else:
        lengths = {"warmup": 12, "drill": 18, "game": 22, "cool": 8}

    n = len(days)
    if n == 1:
        keys = ["single"]
    elif n == 2:
        keys = ["weakness", "plan"]
    elif n == 3:
        keys = ["weakness", "plan", "prep"]
    elif n == 4:
        keys = ["weakness", "technique", "plan", "prep"]
    else:
        keys = ["recovery", "weakness", "technique", "plan", "prep"]
    if youth:
        keys = ["skills" if k in ("technique", "recovery") else k for k in keys]
        if n >= 2 and "skills" not in keys:
            keys[0] = "skills"
    # the session the day before the game is always light
    if n >= 2 and gap[days[-1]] == 1 and keys[-1] != "prep":
        keys[-1] = "prep" if n >= 3 else keys[-1]

    extra = (["set-pieces"] if any("set piece" in t.lower() for t in danger_titles) else []) + \
            (["wide-play", "defensive-shape"] if any("wing" in t.lower() for t in danger_titles) else [])
    form_tags = FORMATION_TAGS.get(formation, [])
    used, sessions = set(), []
    for day, key in zip(days, keys):
        title, why, tags, intensity = THEMES[key]
        if key == "weakness":
            tags = (weakness_tags or []) + ["possession", "fitness"]
        elif key == "plan":
            tags = (plan_tags or []) + extra + form_tags + ["transition", "build-up"]
            title = f"Game plan vs {opp_name}"
        elif key == "single":
            tags = (plan_tags or [])[:2] + (weakness_tags or [])[:2] + extra[:1] + form_tags[:1]
            title = f"Game plan vs {opp_name} + our weaknesses"
        if gap[day] == 1:
            intensity = "low"
        if key in ("plan", "single"):
            # one drill for the main tactical change, one for the formation / opponent's dangers
            first = _pick(all_drills, (plan_tags or []) + ["pressing", "transition"], used, youth, f"{salt}:{day}:a", 1)
            second_tags = extra + form_tags + ["transition", "build-up", "wide-play", "final-third"]
            second = _pick(all_drills, second_tags, used | {d["id"] for d in first}, youth, f"{salt}:{day}:b", 1)
            picks = first + second
        else:
            picks = _pick(all_drills, tags, used, youth, f"{salt}:{day}")
        if len(picks) < 2:
            picks += _pick(all_drills, ["possession", "technique", "final-third", "passing"], used | {d["id"] for d in picks}, youth, salt, 2 - len(picks))
        used.update(d["id"] for d in picks)
        low = intensity == "low"
        game_tag = next((t for t in tags if t in CONDITIONED_GAMES), "possession")
        blocks = [{"type": "warmup", "name": "Warm-up", "minutes": lengths["warmup"],
                   "text": ("Fun tag games and ball mastery — everyone with a ball." if youth else
                            "Light jog, mobility and a relaxed passing rondo." if low else
                            "Jog, mobility and passing in pairs, finishing with a few short sprints.")}]
        for d in picks:
            blocks.append({"type": "drill", "name": d["name"], "minutes": min(d["minutes"], lengths["drill"] - (3 if low else 0)),
                           "drill": simple_drill(d)})
        blocks.append({"type": "game", "name": "Conditioned game", "minutes": lengths["game"] - (5 if low else 0),
                       "text": CONDITIONED_GAMES[game_tag].format(n=small)})
        blocks.append({"type": "cooldown", "name": "Cool-down & key messages", "minutes": lengths["cool"],
                       "text": "Easy jog and stretch. Finish with the 2–3 messages for the next game."})
        sessions.append({"day": day, "title": title, "why": why, "intensity": intensity,
                         "days_before_match": gap[day], "minutes": sum(b["minutes"] for b in blocks), "blocks": blocks})
    note = "Based on your training days in My Club." if club.get("training_days") else "Using Tuesday and Thursday — set your training days in My Club."
    if not match_date:
        note += " No fixture date yet, so we've assumed a weekend game."
    return {"sessions": sessions, "match_day": DAYS[md], "match_date": match_date, "note": note}
