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


def subs_advice(t: dict) -> str:
    if _level(t["press"]) == "high":
        return ("Pressing high is tiring. Plan your first changes around 55–60 minutes, especially up front and in midfield, "
                "and keep one change for the last 10 minutes.")
    return "Make your first change around 60–65 minutes and keep one change for the last 10 minutes to protect a result."


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


def game_plan(engine, team_id: str, opponent_id: str, venue: str, drills_for, chosen: dict | None = None) -> dict:
    us, opp = engine.team(team_id), engine.team(opponent_id)
    mu = engine.matchup(team_id, opponent_id)
    usual = engine.default_tactics(us)
    rec = engine.recommend(team_id, opponent_id, usual, venue)
    best = rec["recommendations"][0] if rec["recommendations"] else None
    plan_t = {**usual, **chosen} if chosen else (best["tactics"] if best else usual)
    ev = engine.evaluate(us, opp, plan_t, venue, "normal")
    p = ev["p"]

    options = [{"name": "Your usual way", "tactics": usual, "summary": describe_tactics(usual),
                "verdicts": [{"text": "What the players already know", "good": True}], "recommended": not best}]
    for i, r in enumerate(rec["recommendations"][:2]):
        options.append({"name": _change_words(usual, r["tactics"]), "tactics": r["tactics"], "summary": describe_tactics(r["tactics"]),
                        "verdicts": verdicts(r["impact"]), "recommended": i == 0,
                        "confidence": {"high": "We're confident this helps", "moderate": "Likely to help",
                                       "low": "Might help"}[r["confidence_label"]]})

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
    dangers = [dict(zip(("title", "text"), DANGER_PLAIN.get(r["title"], (r["title"], r["detail"])))) for r in mu["risks"][:3]]
    past = mu.get("h2h") or []
    return {
        "team": {"id": us["id"], "name": us["label"].split(" · ")[0], "formation": us["formation"],
                 "roster": us.get("roster") or []},
        "opponent": {"id": opp["id"], "name": opp["label"].split(" · ")[0], "formation": opp["formation"],
                     "style": PLAIN_STYLE.get(opp["archetype"]["name"], opp["archetype"]["description"]),
                     "style_name": opp["archetype"]["name"]},
        "difficulty": difficulty(p[0], p[2]),
        "dangers": dangers,
        "plan": {"tactics": plan_t, "summary": describe_tactics(plan_t),
                 "changed": plan_t != usual, "change_title": _change_words(usual, plan_t) if plan_t != usual else None,
                 "instructions": instructions(plan_t, mu["zones"]), "roles": roles(plan_t, mu["zones"]),
                 "subs": subs_advice(plan_t)},
        "zones": mu["zones"],
        "past_meetings": past,
        "chances": {"win": round(p[0], 3), "draw": round(p[1], 3), "loss": round(p[2], 3)},
        "options": options,
        "focus": [dict(zip(("title", "text"), FOCUS_PLAIN.get(w["title"], (w["title"], w["detail"])))) for w in rec["weaknesses"][:3]],
        "drills": drills,
        "week": weekly_training(best["drill_tags"] if best else [], [t for w in rec["weaknesses"] for t in w["tags"]],
                                [d["title"] for d in dangers], opp["label"].split(" · ")[0], club.get("training_days", ""),
                                next_fx["date"] if next_fx else None, drills_for),
    }


# ---------------------------------------------------------------- weekly training schedule
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

CONDITIONED_GAMES = {
    "pressing": "8v8 game: a goal scored within 8 seconds of winning the ball counts double.",
    "counter-press": "8v8 game: if you lose the ball, win it back within 5 seconds for a bonus point.",
    "transition": "8v8 game: after every turnover, the team that wins it must shoot within 10 seconds.",
    "wide-play": "8v8 game with wide channels: goals from a cross or cut-back count double.",
    "defensive-shape": "8v8 game: defending team scores a point for every 5 passes they force sideways or backwards.",
    "compact-block": "8v8 game: defenders may not let a pass go between their lines — coach freezes play to check distances.",
    "possession": "8v8 game: 6 passes in a row earns a point; goals still count.",
    "build-up": "8v8 game: goal kicks must be played short; if pressed, go long into a target zone.",
    "set-pieces": "8v8 game: every stoppage restarts with a corner or wide free kick to practise routines.",
    "fitness": "4 x 4-minute small-sided games at full intensity, 2 minutes rest between.",
    "game-management": "11v11 scenario: '1-0 up, 10 minutes left' — then swap: '0-1 down, 10 minutes left'.",
    "final-third": "8v8 game: all goals must come from inside the box, first-time finishes count double.",
}


def _parse_days(text: str) -> list[str]:
    out = []
    for part in str(text or "").replace("/", ",").replace("&", ",").replace(" and ", ",").split(","):
        p = part.strip().lower()[:3]
        for d in DAYS:
            if p and d.lower().startswith(p) and d not in out:
                out.append(d)
    return sorted(out, key=DAYS.index) or ["Tuesday", "Thursday"]


def weekly_training(plan_tags: list, weakness_tags: list, danger_titles: list, opp_name: str,
                    training_days: str, match_date: str | None, drills_for) -> dict:
    import datetime as _dt
    days = _parse_days(training_days)
    match_day = None
    if match_date:
        try:
            match_day = DAYS[_dt.date.fromisoformat(match_date).weekday()]
        except ValueError:
            pass
    extra_tags = (["set-pieces"] if any("set piece" in t.lower() for t in danger_titles) else []) + \
                 (["wide-play", "defensive-shape"] if any("wing" in t.lower() for t in danger_titles) else [])
    themes = [
        ("Fix our weaknesses", "Work on what your results say needs improving.", weakness_tags or ["possession", "fitness"], "high"),
        (f"Game plan vs {opp_name}", "Rehearse how you'll play this week's opponent.", (plan_tags or []) + extra_tags or ["pressing"], "high"),
        ("Match prep — light & sharp", "Short, sharp and fresh legs: set pieces and game situations.", ["set-pieces", "game-management"], "low"),
        ("Fitness & finishing", "Build the engine and sharpen up in front of goal.", ["fitness", "final-third"], "medium"),
    ]
    if len(days) == 1:
        themes = [(f"Game plan vs {opp_name} + our weaknesses", "One session to cover the essentials.",
                   (plan_tags or [])[:2] + (weakness_tags or [])[:2] + extra_tags[:1], "high")]
    used, sessions = set(), []
    for i, day in enumerate(days[:4]):
        title, why, tags, intensity = themes[min(i, len(themes) - 1)] if len(days) > 1 else themes[0]
        if len(days) == 2 and i == 1:
            tags = tags + ["set-pieces"]
        picks = [d for d in drills_for(tags, 8) if d["id"] not in used][:2] or drills_for(tags, 2)
        used.update(d["id"] for d in picks)
        game_tag = next((t for t in tags if t in CONDITIONED_GAMES), "possession")
        low = intensity == "low"
        blocks = [{"type": "warmup", "name": "Warm-up", "minutes": 10,
                   "text": "Jog, mobility and passing in pairs, finishing with a few short sprints." if not low
                   else "Light jog, mobility and a passing rondo — keep it relaxed."}]
        for d in picks:
            blocks.append({"type": "drill", "name": d["name"], "minutes": min(d["minutes"], 15 if low else 20), "drill": simple_drill(d)})
        blocks.append({"type": "game", "name": "Conditioned game", "minutes": 15 if low else 20, "text": CONDITIONED_GAMES[game_tag]})
        blocks.append({"type": "cooldown", "name": "Cool-down & key messages", "minutes": 5,
                       "text": "Easy jog and stretch. Finish with the 2–3 messages for the weekend."})
        sessions.append({"day": day, "title": title, "why": why, "intensity": intensity,
                         "minutes": sum(b["minutes"] for b in blocks), "blocks": blocks})
    return {"sessions": sessions, "match_day": match_day, "match_date": match_date,
            "note": "Based on your training days in My Club." if training_days else "Using Tuesday and Thursday — set your training days in My Club."}
