"""Ask Coach Twelve: answers questions about the next match.

Facts come from the game plan and team profiles (sent as context) and from the match
engine, which the model can call as a tool for "what if" questions. Without an API key
it falls back to keyword answers built straight from the game plan.
"""
from __future__ import annotations

import json
import logging
import os

from . import coach, usage
from .formations import FAMILIES

log = logging.getLogger("twelfth-man.assistant")

SYSTEM = """You are "Coach Twelve", the in-house assistant coach inside "The Twelfth Man", helping a grassroots football (soccer) coach \
prepare for and manage their next match. The coach has no statistics background and often reads your answer on a phone.

Style:
- Start with the direct answer in one or two sentences. Then give only the most useful supporting points.
- Keep it short: about 150 words. Go longer only when the coach asks for a session plan, team talk or routine.
- Plain football language. Use **bold** for key phrases and "- " bullets; no headings, no tables.
- No percentages, xG or model jargon unless the coach asks for numbers. When they do, give win, draw and loss.
- Gender-neutral: say "players", "the team", "they" — never assume a boys' or men's team.
- End with at most one short follow-up offer, and only if it is genuinely useful.

Accuracy:
- Facts about the two teams, results and squad come ONLY from the MATCH CONTEXT below or from tools. Never invent \
statistics, players, results or past meetings. If something isn't there, say so briefly and suggest recording it in My Team.
- The club profile (match format, half length, substitution rules, pitch surface, league/division, training days) is \
in our_club_profile — use it: e.g. subs advice must respect max_subs and rolling/fixed subs; timings must scale to half_length.
- Don't attribute statements to the coach that they didn't make. Don't assume dates, match days or kick-off times.
- For form, runs and streaks, use the pre-computed form_facts — never count results yourself.
- This week's training schedule is in game_plan.this_weeks_training — use it for questions about sessions and days.
  Only say a drill is "in this week's plan" if it appears there; drills from find_drills are "from the drill library".
- "What if we..." about formation, pressing, tempo/directness or width → call try_tactics first and answer from its result.
- Any question with a score and/or minute (half-time, "we're 1-0 down", "2-0 up with 20 left") → call game_situation \
first and answer from its result. You may combine it with try_tactics.
- Training, drills or sessions → call find_drills for the topic and build the answer from the drills it returns; \
if none fit, give general advice and say it's general.
- General coaching knowledge is fine, but present it as general advice, not as something the data shows.
- Model results are estimates under uncertainty: never promise outcomes. Never discuss betting or odds; politely \
decline and steer back. If a question isn't about football, coaching or this match, steer back in one line."""

TOOLS = [{
    "name": "try_tactics",
    "description": ("Run the match model for a different way of playing against this opponent (whole game) and compare it "
                    "with the team's usual set-up: overall verdict, effects in plain words, and win/draw/loss estimates. "
                    "Levels: press 0 = defend very deep, 50 = mid-block, 100 = press very high; tempo 0 = patient short "
                    "passing, 100 = very direct; width 0 = very narrow, 100 = very wide. Omit a field to keep the usual value."),
    "input_schema": {
        "type": "object",
        "properties": {
            "formation": {"type": "string", "enum": FAMILIES, "description": "Omit to keep the usual formation"},
            "press": {"type": "integer", "minimum": 0, "maximum": 100},
            "tempo": {"type": "integer", "minimum": 0, "maximum": 100},
            "width": {"type": "integer", "minimum": 0, "maximum": 100},
        },
        "required": [],
    },
}, {
    "name": "game_situation",
    "description": ("For a match in progress: given the minute and the score, compare 'carry on with the plan', 'go for it' "
                    "and 'protect it' for the rest of the game, with chances to win/draw/lose from that point."),
    "input_schema": {
        "type": "object",
        "properties": {
            "minute": {"type": "integer", "minimum": 0, "maximum": 89, "description": "Minutes played; half-time = 45"},
            "our_goals": {"type": "integer", "minimum": 0},
            "their_goals": {"type": "integer", "minimum": 0},
        },
        "required": ["minute", "our_goals", "their_goals"],
    },
}, {
    "name": "find_drills",
    "description": "Search the app's drill library (with set-up, coaching points, progression) by topic, e.g. 'defending wide 1v1', 'corners', 'pressing', 'fitness', 'build-up'.",
    "input_schema": {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
        "required": ["topic"],
    },
}]


def try_tactics(engine, team_id, opponent_id, venue, args: dict) -> dict:
    us, opp = engine.team(team_id), engine.team(opponent_id)
    usual = engine.default_tactics(us)
    new = dict(usual)
    for k in ("formation", "press", "tempo", "width"):
        v = args.get(k)
        if v is None:
            continue
        if k == "formation":
            if v not in FAMILIES:
                raise ValueError(f"formation must be one of {FAMILIES}")
            new[k] = v
        else:
            new[k] = int(max(0, min(100, int(v))))
    base = engine.evaluate(us, opp, usual, venue, "normal")
    ev = engine.evaluate(us, opp, new, venue, "normal")
    ff_u, fa_u = engine._avg_fatigue(usual, "normal")
    ff_n, fa_n = engine._avg_fatigue(new, "normal")
    impact = {"xg_for": ev["xg_for"] - base["xg_for"], "xg_against": ev["xg_against"] - base["xg_against"],
              "fatigue_change": fa_n - fa_u}
    gain = ev["xpts"] - base["xpts"]
    overall = ("better than your usual way" if gain > 0.03 else "worse than your usual way" if gain < -0.03
               else "about the same as your usual way")
    return {
        "tried": {**new, "described": coach.describe_tactics(new)},
        "usual": {**usual, "described": coach.describe_tactics(usual)},
        "overall": overall,
        "effects": [v["text"] for v in coach.verdicts(impact)],
        "how_hard_the_game_is": coach.difficulty(ev["p"][0], ev["p"][2])["label"],
        "estimates_for_reference_only": {
            "win_draw_loss_usual": [round(x, 3) for x in base["p"]], "win_draw_loss_tried": [round(x, 3) for x in ev["p"]],
            "chances_created_usual": round(base["xg_for"], 2), "chances_created_tried": round(ev["xg_for"], 2),
            "chances_conceded_usual": round(base["xg_against"], 2), "chances_conceded_tried": round(ev["xg_against"], 2),
            "expected_points_change": round(gain, 3),
        },
        "note": "Estimates from a model fitted on pro data, adjusted for uncertainty; not a guarantee.",
    }


def form_facts(trend: list) -> dict:
    """Pre-computed so the model never has to count results itself."""
    res = ["W" if m["gf"] > m["ga"] else "D" if m["gf"] == m["ga"] else "L" for m in trend]
    last5 = res[-5:]
    unbeaten = winless = wins = 0
    for r in reversed(res):
        if r == "L":
            break
        unbeaten += 1
    for r in reversed(res):
        if r == "W":
            break
        winless += 1
    for r in reversed(res):
        if r != "W":
            break
        wins += 1
    l5 = trend[-5:]
    return {"last5_oldest_first": " ".join(last5), "last5_won_drawn_lost": f"{last5.count('W')}-{last5.count('D')}-{last5.count('L')}",
            "current_unbeaten_run": unbeaten, "current_winning_run": wins, "current_games_without_a_win": winless,
            "last5_goals_for": sum(m["gf"] for m in l5), "last5_goals_against": sum(m["ga"] for m in l5),
            "clean_sheets_last5": sum(1 for m in l5 if m["ga"] == 0)}


def context_for(plan: dict, engine, team_id, opponent_id, viewer_id: str | None = None) -> dict:
    us, opp = engine.team(team_id), engine.team(opponent_id)

    def team_facts(t):
        r = t.get("record") or {}
        return {"name": t["label"], "source": "your club's own match records" if t.get("source") == "local" else t.get("competition"),
                "matches_on_record": t.get("matches"), "record_won_drawn_lost": f"{r.get('W')}-{r.get('D')}-{r.get('L')}",
                "goals_for_against": f"{r.get('gf')}-{r.get('ga')}",
                "usual_formation": t.get("formation") if not (t.get("source") == "scouted" and not (t.get("scouting") or {}).get("formation")) else "unknown (not scouted)",
                "style": t["archetype"]["name"], "style_in_words": coach.PLAIN_STYLE.get(t["archetype"]["name"], ""),
                "creates_chances_vs_average": round(t["rating"]["attack"], 2), "concedes_chances_vs_average": round(t["rating"]["defence"], 2),
                "recent_results_oldest_first": [f"{m.get('date')} vs {m.get('opp')}: {m.get('gf')}-{m.get('ga')}" for m in (t.get("trend") or [])[-5:]],
                "form_facts": form_facts(t.get("trend") or []),
                "squad": [f"{p.get('number', '')} {p['name']} ({p.get('position', '')})" for p in (t.get("roster") or [])]}
    club_info, next_fixture = {}, None
    acc = getattr(engine, "accounts", None)
    owner = (acc.owner_of(team_id) if acc else None) or viewer_id
    if owner and acc:
        club = acc.club(owner) or {}
        club_info = {k: v for k, v in club.items() if k not in ("team_id", "table") and v not in (None, "")}
        if club.get("table"):
            club_info["our_league_table_row"] = club["table"]
        upcoming = [f for f in acc.fixtures(owner) if f["opponent"].lower() == opp["label"].lower() and f.get("goals_for") is None]
        next_fixture = upcoming[0] if upcoming else None
    opp_extra = {}
    if opp.get("source") == "scouted":
        opp_extra = {"league_table_row": opp.get("table") or None, "scouting_notes": opp.get("scouting") or None,
                     "what_we_know_comes_from": opp["data_quality"]["sources"] or ["nothing yet — treated as an average team"]}
    gap = engine.level_gap(us, opp)
    level_note = ("The opponent plays at a FAR higher level (professional/international) than our team. Be honest: "
                  "winning is close to impossible; focus on staying compact, limiting damage and learning."
                  if gap <= -0.8 else
                  "Our team plays at a far higher level than the opponent." if gap >= 0.8 else "Both teams play at a similar level.")
    return {"level_comparison": level_note,
            "real_past_meetings_between_these_teams": engine.h2h(us, opp) or "none in our data",
            "our_club_profile": club_info, "next_fixture_against_them": next_fixture,
            "our_team": team_facts(us), "opponent": {**team_facts(opp), **opp_extra}, "game_plan": {
        "how_hard": plan["difficulty"], "opponent_style": plan["opponent"]["style"], "dangers": plan["dangers"],
        "plan": {k: plan["plan"][k] for k in ("summary", "change_title", "instructions", "roles", "subs")},
        "options_considered": [{"name": o["name"], "summary": o["summary"], "effects": [v["text"] for v in o["verdicts"]]} for o in plan["options"]],
        "training_focus": plan["focus"],
        "this_weeks_training": [{"day": x["day"], "session": x["title"], "minutes": x["minutes"], "intensity": x["intensity"],
                                 "days_before_match": x.get("days_before_match"),
                                 "blocks": [b["name"] for b in x["blocks"]]} for x in plan["week"]["sessions"]],
        "match_day": plan["week"].get("match_day"),
    }}


class Assistant:
    def __init__(self, conn, drills=None):
        self.conn = conn
        self.drills = drills or []

    @property
    def enabled(self):
        return self.conn.enabled

    def ask(self, engine, team_id, opponent_id, venue, question: str, history: list[dict], plan: dict, viewer_id: str | None = None) -> dict:
        if not self.conn.enabled:
            return {"answer": offline_answer(question, plan), "source": "offline"}
        a = self.conn.sdk
        client = self.conn.client
        ctx = context_for(plan, engine, team_id, opponent_id, viewer_id)
        system = SYSTEM + "\n\nMATCH CONTEXT (JSON):\n" + json.dumps(ctx, default=str)
        messages = [{"role": m["role"], "content": m["content"]} for m in history[-10:]
                    if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip()]
        messages.append({"role": "user", "content": question})
        used_tool = False
        try:
            for _ in range(5):
                resp = client.beta.messages.create(
                    model=self.conn.model, max_tokens=4000, system=system, messages=messages, tools=TOOLS,
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                    output_config={"effort": "medium"},
                )
                usage.record(resp, "ask")
                if resp.stop_reason == "refusal":
                    return {"answer": "I can't help with that one — let's keep it to tactics, training and the match.", "source": "assistant"}
                if resp.stop_reason != "tool_use":
                    text = "\n".join(b.text for b in resp.content if b.type == "text").strip()
                    return {"answer": text or "Sorry, I couldn't put an answer together — try asking another way.",
                            "source": "assistant", "used_model": used_tool}
                messages.append({"role": "assistant", "content": resp.content})
                results = []
                for b in resp.content:
                    if b.type != "tool_use":
                        continue
                    try:
                        args = dict(b.input)
                        if b.name == "try_tactics":
                            out = try_tactics(engine, team_id, opponent_id, venue, args)
                            used_tool = True
                        elif b.name == "game_situation":
                            out = game_situation(engine, team_id, opponent_id, venue, args)
                            used_tool = True
                        elif b.name == "find_drills":
                            out = find_drills(self.drills, args)
                        else:
                            raise ValueError(f"unknown tool {b.name}")
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out)})
                    except Exception as e:  # bad input from the model
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": f"Error: {e}", "is_error": True})
                messages.append({"role": "user", "content": results})
            return {"answer": "That took too many steps — try a more specific question.", "source": "assistant"}
        except a.AuthenticationError:
            return {"answer": offline_answer(question, plan), "source": "offline", "note": "Anthropic key rejected."}
        except (a.RateLimitError, a.APIConnectionError, a.APIStatusError) as e:
            log.warning("assistant API problem: %s", e)
            return {"answer": offline_answer(question, plan), "source": "offline",
                    "note": "Coach Twelve is offline right now, so this answer comes from the game plan."}


def offline_answer(question: str, plan: dict) -> str:
    """Keyword answers straight from the game plan (used when no API key is set)."""
    q = question.lower()
    p = plan["plan"]
    lines = []
    if any(w in q for w in ("how do they", "their style", "opponent", "how they play", "who are")):
        lines.append(f"{plan['opponent']['name']}: {plan['opponent']['style']} They usually play {plan['opponent']['formation']}.")
    if any(w in q for w in ("danger", "watch", "threat", "worry", "careful")):
        lines += [f"{d['title']}: {d['text']}" for d in plan["dangers"]]
    if any(w in q for w in ("sub", "change", "tired", "fitness", "fresh")):
        lines.append(p["subs"])
    if any(w in q for w in ("formation", "plan", "how should we", "tactic", "set up", "line up", "lineup")):
        lines.append(f"Plan: {p['summary']}.")
        lines += [f"{i['title']}: {i['text']}" for i in p["instructions"]]
    if any(w in q for w in ("press", "defend", "defence", "defense")):
        lines += [f"{i['title']}: {i['text']}" for i in p["instructions"] if "press" in i["title"].lower() or "defend" in i["title"].lower() or "compact" in i["title"].lower()]
    if any(w in q for w in ("attack", "score", "chance", "goal")):
        lines += [f"{i['title']}: {i['text']}" for i in p["instructions"] if "attack" in i["title"].lower() or "forward" in i["title"].lower()]
    if any(w in q for w in ("set piece", "corner", "free kick")):
        lines += [f"{d['title']}: {d['text']}" for d in plan["dangers"] if "set piece" in d["title"].lower()] or \
                 ["Rehearse two corner routines and your set-piece marking this week."]
    if any(w in q for w in ("train", "drill", "session", "practice", "work on")):
        lines += [f"{f['title']}: {f['text']}" for f in plan["focus"]] + [f"Drill: {d['name']} ({d['minutes']} min) — {d['why']}" for d in plan["drills"]]
    groups = {"Goalkeeper": ("keeper", "goalkeeper", "gk"), "Defenders": ("defender", "centre-back", "center back", "full-back", "fullback", "back four"),
              "Wing-backs": ("wing-back", "wingback"), "Midfielders": ("midfield", "winger"), "Forwards": ("striker", "forward", "attacker", "number 9")}
    asked = [g for g, words in groups.items() if any(w in q for w in words)]
    if asked:
        lines += [f"{r['group']}: " + " ".join(r["jobs"]) for r in p["roles"] if r["group"] in asked]
    elif any(w in q for w in ("player", "job", "role", "position")):
        lines += [f"{r['group']}: " + " ".join(r["jobs"]) for r in p["roles"]]
    lines = list(dict.fromkeys(lines))
    if not lines:
        return ("I can answer questions about the opponent, our plan, dangers, substitutions, player roles and training "
                "from the game plan. For free-form questions and 'what if' scenarios, Coach Twelve's full AI needs the "
                "AI connection (see README).")
    return "\n".join(f"• {l}" for l in lines[:8]) + \
        "\n\n(Answer from the game plan — Coach Twelve's full AI answers and 'what if' testing need the AI connection.)"


# ---------------------------------------------------------------- extra tools

def game_situation(engine, team_id, opponent_id, venue, args: dict) -> dict:
    """From a given minute and score, compare 'carry on', 'go for it' and 'protect it' for the rest of the game."""
    import numpy as np
    from scipy.stats import poisson
    us, opp = engine.team(team_id), engine.team(opponent_id)
    usual = engine.default_tactics(us)
    minute = int(max(0, min(89, args.get("minute", 45))))
    gf, ga = int(args.get("our_goals", 0)), int(args.get("their_goals", 0))
    prof = np.repeat(np.array(engine.eff["minute_profile"]), 15)
    share_left = float(prof[minute:].sum() / prof.sum())
    approaches = {
        "carry on with the plan": dict(usual),
        "go for it (press higher, play more direct)": {**usual, "press": min(95, usual["press"] + 25), "tempo": min(95, usual["tempo"] + 25)},
        "protect it (drop deeper, stay compact)": {**usual, "press": max(5, usual["press"] - 30), "width": max(5, usual["width"] - 20)},
    }
    out = []
    for name, t in approaches.items():
        r = engine.rates(us, opp, t, venue, "normal")
        lf, la = r["lam_for"] * share_left, r["lam_against"] * share_left
        # tiredness: big pressing changes late on cost a little extra at the back
        if t["press"] > usual["press"]:
            la *= 1.05
        pf = poisson.pmf(np.arange(10), lf)
        pa = poisson.pmf(np.arange(10), la)
        m = np.outer(pf, pa)
        diff = gf - ga + np.subtract.outer(np.arange(10), np.arange(10))
        win, draw = float(m[diff > 0].sum()), float(m[diff == 0].sum())
        out.append({"approach": name, "chance_to_win": round(win, 3), "chance_to_draw": round(draw, 3),
                    "chance_to_lose": round(1 - win - draw, 3), "expected_points": round(3 * win + draw, 3),
                    "goals_we_score_rest_of_game": round(lf, 2), "goals_we_concede_rest_of_game": round(la, 2)})
    best = max(out, key=lambda x: x["expected_points"])
    return {"situation": f"{gf}-{ga} after {minute} minutes", "minutes_left_share_of_danger": round(share_left, 2),
            "options": out, "best_by_model": best["approach"],
            "note": "Model estimates for the rest of the game; differences under ~0.05 expected points are too small to matter."}


def find_drills(drills: list, args: dict) -> dict:
    stop = {"the", "and", "for", "with", "our", "how", "drill", "drills", "session", "training", "against"}
    topic = str(args.get("topic", "")).lower().replace("-", " ")
    synonyms = {"from the back": "build up", "play out": "build up", "playing out": "build up", "keep the ball": "possession",
                "1v1": "wide defensive", "winger": "wide defensive", "full back": "wide defensive", "fullback": "wide defensive",
                "counter attack": "transition", "counter": "transition", "finishing": "final third", "shooting": "final third",
                "crosses": "crosses final third", "corner": "set pieces corner", "free kick": "set pieces", "stamina": "fitness",
                "tired": "fitness", "late goals": "fitness game management", "high press": "pressing", "press": "pressing"}
    for k, v in synonyms.items():
        if k in topic:
            topic += " " + v
    stems = [w[:5] for w in topic.split() if len(w) > 2 and w not in stop]
    scored = []
    for d in drills:
        tags = " ".join(d["tags"]).replace("-", " ").lower()
        text = " ".join([d["name"], d["objective"], " ".join(d["coaching_points"])]).lower()
        score = sum(3 * tags.count(st) + 2 * d["name"].lower().count(st) + text.count(st) for st in stems)
        if score:
            scored.append((score, d))
    scored.sort(key=lambda x: -x[0])
    return {"drills": [{"name": d["name"], "minutes": d["minutes"], "players": d["players"], "area": d["area"],
                        "purpose": d["objective"], "setup": d["setup"], "coaching_points": d["coaching_points"],
                        "progression": d["progression"]} for _, d in scored[:3]],
            "note": "These are the app's drill library entries. If none fit, give general advice and say so."}
