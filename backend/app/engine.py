"""Simulation + recommendation engine.

Expected goals for each side come from relative attack/defence ratings, then get
multiplied by tactic effects that were estimated *within teams* (fixed effects) on
StatsBomb data, plus a few clearly-labelled coaching priors (fatigue, subs, game
state, weather). A minute-by-minute Monte Carlo turns those rates into outcome
distributions; parameter uncertainty is propagated by drawing ratings and effect
coefficients (cluster bootstrap) per simulation group.
"""
from __future__ import annotations

import json
import math
from itertools import combinations
from pathlib import Path

import numpy as np

from .analytics import STYLE_FEATURES, assign_archetype, draw_adjust, score_matrix, wdl
from .formations import FAMILIES, LAYOUTS, NOTES

LEVERS = {"press": "press_height", "tempo": "directness", "width": "width"}
LEVER_LABEL = {"press": "Press height", "tempo": "Tempo / directness", "width": "Width", "formation": "Formation",
               "adaptation": "Adaptation cost"}

# ---- coaching priors (not estimated from data; shown as such in the model card)
PRIORS = {
    "fatigue_xga_per_press_sd": 0.12,   # extra late (60'+) xGA per SD of press height above average
    "fatigue_xg_per_press_sd": 0.05,    # lost late attacking output per SD
    "sub_relief": 0.2,                  # each sub (before 80') removes 20% of fatigue penalty
    "sub_relief_max": 0.6,
    "attacking_sub": (0.06, 0.04),      # (xg, xga) log-uplift after an attacking change
    "defensive_sub": (-0.05, -0.06),
    "leading_mult": 0.92,               # score effects: leaders sit deeper,
    "trailing_mult": 1.10,              # chasers push on
    "rain": {"both": -0.04, "pass_comp_z": -0.03},
    "wind": {"both": -0.03, "directness_z": 0.0},
    "heat_fatigue_mult": 1.6,
    "back_three_vs_two_strikers_xga": -0.03,
    "back_three_vs_lone_striker_xg": -0.02,
    "three_mids_vs_442_xg": 0.03,
    "max_tactic_mult": (0.7, 1.35),
    # Observational within-team effects are inflated by game state (teams that are on top
    # defend higher, for example), so lever effects are halved before use.
    "causal_discount": 0.5,
    # Execution cost of moving away from a team's identity: per within-team SD beyond the
    # first, and for a formation the team has not used.
    "adaptation_per_sd": 0.025,
    "unfamiliar_formation": 0.03,
}
TWO_STRIKERS = {"4-4-2", "3-5-2"}
BACK_THREE = {"3-5-2", "3-4-3"}
THREE_CENTRAL = {"4-3-3", "4-1-4-1", "4-2-3-1", "3-5-2"}

# Playing level, in log goal-rate units relative to professional / international football.
# Ratings are relative to each team's own league, so without this a grassroots side and a
# professional side would look equally strong. Coaching priors, listed on the Model Card.
LEVEL_TIER = {"Academy": -0.9, "Semi-pro": -1.0, "College / University": -1.5, "Sunday league": -1.9,
              "Grassroots": -1.8, "School": -2.0, "": -1.8}
AGE_TIER = {"U7": -1.8, "U8": -1.8, "U9": -1.8, "U10": -1.6, "U11": -1.5, "U12": -1.3, "U13": -1.0, "U14": -0.9,
            "U15": -0.8, "U16": -0.5, "U17": -0.4, "U18": -0.3, "U19": -0.3, "U21": -0.1, "U23": -0.1,
            "Senior": 0.0, "Veterans (35+)": -0.4, "": 0.0}
LEVEL_GAP_SCALE = 0.6

ZONE_Y = ["left wing", "left wing", "left half-space", "centre", "centre", "right half-space", "right wing", "right wing"]


class Engine:
    def __init__(self, processed: Path, store):
        self.model = json.loads((processed / "model.json").read_text())
        self.pro = {t["id"]: t for t in json.loads((processed / "teams.json").read_text())}
        self.store = store
        self.dist = self.model["distribution"]
        self.eff = self.model["effects"]
        self.arch = self.model["archetypes"]
        self.draw_k = self.model["backtest"]["draw_factor"]
        self.pro_base = float(np.mean(list(self.model["competition_base_xg"].values())))
        self._archetype_pools()

    # ------------------------------------------------------------ teams

    def _archetype_pools(self):
        """Average spatial patterns per archetype — used as stand-ins for local teams."""
        pools = {}
        for t in self.pro.values():
            a = t["archetype"]["id"]
            p = pools.setdefault(a, {"heat": [], "def_heat": [], "shots": [], "counter": [], "late": [], "sp": []})
            p["heat"].append(t["heat"]); p["def_heat"].append(t["def_heat"]); p["shots"].extend(t["shots"])
            p["counter"].append(t["extra"]["counter_xga_pm"] / max(t["per_match"]["xga"], 0.1))
            p["late"].append(t["extra"]["late_xga_share"]); p["sp"].append(t["extra"]["sp_xg_pm"] / max(t["per_match"]["xg"], .1))
        self.pools = {a: {"heat": np.mean(p["heat"], 0).round(3).tolist(),
                          "def_heat": np.mean(p["def_heat"], 0).round(3).tolist(),
                          "shots": p["shots"][::3],
                          "counter_share": float(np.mean(p["counter"])),
                          "late_share": float(np.mean(p["late"])),
                          "sp_share": float(np.mean(p["sp"]))} for a, p in pools.items()}

    accounts = None  # set by main: scouted opponents live in the accounts store

    def team(self, team_id: str) -> dict:
        if team_id in self.pro:
            return self.pro[team_id]
        if team_id.startswith("opp-") and self.accounts is not None:
            opp = self.accounts.opponent(team_id)
            if opp is None:
                raise KeyError(team_id)
            return scouted_profile(opp, self)
        t = self.store.profile(team_id, self)
        if t is None:
            raise KeyError(team_id)
        return t

    def list_teams(self, user: dict | None = None) -> list[dict]:
        rows = [{"id": t["id"], "label": t["label"], "source": "statsbomb", "competition": t["competition"],
                 "formation": t["formation"], "archetype": t["archetype"]["name"]} for t in self.pro.values()]
        rows.sort(key=lambda r: (r["competition"], r["label"]))
        mine, opps = [], []
        owned = self.accounts.team_ids(user["id"]) if (user and self.accounts) else set()
        for lt in self.store.list_teams():
            if lt["id"] not in owned:
                continue
            try:
                p = self.team(lt["id"])
                mine.append({"id": p["id"], "label": p["label"], "source": "local", "competition": "My club",
                             "formation": p["formation"], "archetype": p["archetype"]["name"], "matches": p["matches"]})
            except KeyError:
                mine.append({"id": lt["id"], "label": lt["name"], "source": "local", "competition": "My club",
                             "formation": "—", "archetype": "No matches yet", "matches": 0})
        if user and self.accounts:
            for o in self.accounts.opponents(user["id"]):
                opps.append({"id": o["id"], "label": o["name"], "source": "scouted", "competition": "This season's opponents",
                             "formation": o.get("formation") or "4-4-2", "archetype": ""})
        return mine + opps + rows

    # ------------------------------------------------------------ slider mapping

    def slider_to_value(self, lever: str, s: float) -> float:
        d = self.dist[LEVERS[lever]]
        return d["q5"] + (d["q95"] - d["q5"]) * float(s) / 100

    def value_to_slider(self, lever: str, v: float) -> int:
        d = self.dist[LEVERS[lever]]
        return int(np.clip(round((v - d["q5"]) / (d["q95"] - d["q5"]) * 100), 0, 100))

    def default_tactics(self, t: dict) -> dict:
        return {"formation": t["formation"],
                **{lev: self.value_to_slider(lev, t["style"][f]) for lev, f in LEVERS.items()}}

    def rating_value_to_slider(self, rating: int) -> int:
        return {1: 10, 2: 30, 3: 50, 4: 70, 5: 90}.get(int(rating), 50)

    # ------------------------------------------------------------ effect model

    def _opp_z(self, opp: dict) -> tuple[float, float]:
        n = self.eff["opp_norm"]
        return ((opp["style"]["pass_comp"] - n["pass_comp_mean"]) / n["pass_comp_std"],
                (opp["style"]["press_height"] - n["press_mean"]) / n["press_std"])

    def _deltas(self, base: dict, new: dict) -> dict:
        """Lever change in within-team SD units, saturated so extreme sliders don't extrapolate linearly."""
        out = {}
        for lev, f in LEVERS.items():
            raw = (self.slider_to_value(lev, new[lev]) - self.slider_to_value(lev, base[lev])) / self.eff["lever_sd"][f]
            out[lev] = 2 * math.tanh(raw / 2)
        return out

    def _formation_matchup(self, form: str, opp_form: str) -> tuple[float, float]:
        xg = xga = 0.0
        if form in BACK_THREE and opp_form in TWO_STRIKERS:
            xga += PRIORS["back_three_vs_two_strikers_xga"]
        if form in BACK_THREE and opp_form not in TWO_STRIKERS:
            xg += PRIORS["back_three_vs_lone_striker_xg"]
        if form in THREE_CENTRAL and opp_form == "4-4-2":
            xg += PRIORS["three_mids_vs_442_xg"]
        return xg, xga

    def contributions(self, base: dict, new: dict, opp: dict, coefs: dict | None = None,
                      familiar: set | None = None) -> dict:
        """Per-lever log-effects on our xG and xGA. coefs overrides point estimates (bootstrap draws)."""
        d = self._deltas(base, new)
        pc_z, pr_z = self._opp_z(opp)
        k = PRIORS["causal_discount"]
        # adaptation: execution cost for big shifts from identity / unfamiliar shapes
        stretch = sum(max(abs(v) - 1, 0) for v in d.values()) * PRIORS["adaptation_per_sd"]
        if new["formation"] != base["formation"] and new["formation"] not in (familiar or set()):
            stretch += PRIORS["unfamiliar_formation"]
        out = {}
        for target in ("xg", "xga"):
            c = coefs[target] if coefs else self.eff["targets"][target]["coef"]
            fe = c.get("_formation") or self.eff["formation_effect"][target]
            m_new = self._formation_matchup(new["formation"], opp["formation"])
            m_base = self._formation_matchup(base["formation"], opp["formation"])
            idx = 0 if target == "xg" else 1
            out[target] = {
                "press": k * (c["press_height"] * d["press"] + c["press_x_opp_passing"] * d["press"] * pc_z),
                "tempo": k * (c["directness"] * d["tempo"] + c["direct_x_opp_press"] * d["tempo"] * pr_z),
                "width": k * c["width"] * d["width"],
                "formation": fe.get(new["formation"], 0) - fe.get(base["formation"], 0) + m_new[idx] - m_base[idx],
                "adaptation": -stretch if target == "xg" else stretch,
            }
        return out

    def _conditions_log(self, team: dict, conditions: str) -> float:
        if conditions == "rain":
            z = (team["style"]["pass_comp"] - self.dist["pass_comp"]["mean"]) / self.dist["pass_comp"]["std"]
            return PRIORS["rain"]["both"] + PRIORS["rain"]["pass_comp_z"] * max(z, 0)
        if conditions == "wind":
            return PRIORS["wind"]["both"]
        return 0.0

    def rates(self, us: dict, opp: dict, tactics: dict, venue: str = "home", conditions: str = "normal",
              coefs: dict | None = None) -> dict:
        base_t = self.default_tactics(us)
        contrib = self.contributions(base_t, tactics, opp, coefs, set(us.get("formations_used") or {}))
        lo, hi = PRIORS["max_tactic_mult"]
        m_for = float(np.clip(math.exp(sum(contrib["xg"].values())), lo, hi))
        m_against = float(np.clip(math.exp(sum(contrib["xga"].values())), lo, hi))
        h = self.eff["home_log_effect"] * {"home": 1, "away": -1}.get(venue, 0)
        base = math.sqrt(self._league_base(us) * self._league_base(opp))
        gap = self.level_gap(us, opp)
        lvl = math.exp(LEVEL_GAP_SCALE * gap)
        lam_for = base * us["rating"]["attack"] * opp["rating"]["defence"] * math.exp(h + self._conditions_log(us, conditions)) * m_for * lvl
        lam_against = base * opp["rating"]["attack"] * us["rating"]["defence"] * math.exp(-h + self._conditions_log(opp, conditions)) * m_against / lvl
        return {"lam_for": lam_for, "lam_against": lam_against, "contrib": contrib,
                "mult_for": m_for, "mult_against": m_against, "base": base, "level_gap": gap}

    def level_of(self, t: dict) -> float:
        """0 for professional/international teams; negative for amateur levels (from the coach's club profile).
        Cached on the profile dict: rates() runs thousands of times per request."""
        if "_level" in t:
            return t["_level"]
        t["_level"] = self._level_lookup(t)
        return t["_level"]

    def _level_lookup(self, t: dict) -> float:
        if t.get("source") == "statsbomb" or t.get("id") in self.pro:
            return 0.0
        acc = self.accounts
        owner = None
        if acc is not None:
            if str(t.get("id", "")).startswith("opp-"):
                o = acc.opponent(t["id"])
                owner = o["user_id"] if o else None
            else:
                owner = acc.owner_of(t["id"])
        club = (acc.club(owner) if (acc and owner) else None) or {}
        return LEVEL_TIER.get(club.get("level", ""), -1.8) + AGE_TIER.get(club.get("age_group", ""), 0.0)

    def level_gap(self, us: dict, opp: dict) -> float:
        return self.level_of(us) - self.level_of(opp)

    def h2h(self, a: dict, b: dict) -> list[dict]:
        """Real past meetings between two professional teams (matched by name across competitions)."""
        if a.get("id") not in self.pro or b.get("id") not in self.pro:
            return []
        na, nb = a["name"], b["name"]
        out = []
        for m in self.model.get("matches", []):
            ta, tb = self.pro.get(m["a"]), self.pro.get(m["b"])
            if not ta or not tb:
                continue
            if {ta["name"], tb["name"]} == {na, nb}:
                flip = ta["name"] != na
                out.append({"date": m["date"], "competition": m["competition"],
                            "us_goals": m["b_goals"] if flip else m["a_goals"], "them_goals": m["a_goals"] if flip else m["b_goals"],
                            "us_xg": m["b_xg"] if flip else m["a_xg"], "them_xg": m["a_xg"] if flip else m["b_xg"],
                            "venue": "neutral" if not m["home"] else ("home" if self.pro[m["home"]]["name"] == na else "away")})
        return out

    def _league_base(self, t: dict) -> float:
        return t.get("league_base") or self.model["competition_base_xg"].get(t.get("competition"), self.pro_base)

    def _fatigue_load(self, tactics: dict, conditions: str) -> float:
        """Pressing load above average; grows faster than linearly at extreme intensity."""
        pz = max(self.press_z(tactics), 0)
        load = pz + 0.5 * pz ** 2
        return load * (PRIORS["heat_fatigue_mult"] if conditions == "heat" else 1)

    def press_z(self, tactics: dict) -> float:
        v = self.slider_to_value("press", tactics["press"])
        return (v - self.dist["press_height"]["mean"]) / self.dist["press_height"]["std"]

    # ------------------------------------------------------------ Monte Carlo

    def simulate(self, team_id: str, opponent_id: str, tactics: dict, venue: str = "home",
                 conditions: str = "normal", subs: list | None = None, n_sims: int = 10000,
                 seed: int = 7, with_baseline: bool = True) -> dict:
        us, opp = self.team(team_id), self.team(opponent_id)
        tactics = {**self.default_tactics(us), **(tactics or {})}
        subs = subs or []
        res = self._run_mc(us, opp, tactics, venue, conditions, subs, n_sims, seed)
        res["tactics"] = tactics
        res["team"] = {"id": us["id"], "label": us["label"]}
        res["opponent"] = {"id": opp["id"], "label": opp["label"]}
        res["shot_map"] = self._shot_map(us, res["xg_for"], seed)
        res["shot_map_against"] = self._shot_map(opp, res["xg_against"], seed + 1)
        res["notes"] = self._notes(us, opp, tactics, res, conditions, subs)
        if with_baseline:
            base_t = self.default_tactics(us)
            b = self._run_mc(us, opp, base_t, venue, conditions, [], n_sims, seed)
            res["baseline"] = {"tactics": base_t, "win": b["win"], "draw": b["draw"], "loss": b["loss"],
                               "xg_for": b["xg_for"], "xg_against": b["xg_against"], "xpts": b["xpts"]}
            res["delta"] = {k: round(res[k] - b[k], 4) for k in ["win", "draw", "loss", "xg_for", "xg_against", "xpts"]}
        return res

    def _boot_coefs(self, rng, n: int) -> list[dict]:
        out = []
        fb = self.eff["formation_effect_boot"]
        for target in ("xg", "xga"):
            t = self.eff["targets"][target]
            boot = np.array(t["boot"])
            idx = rng.integers(0, len(boot), n)
            out.append([{**t["coef"], **dict(zip(t["boot_cols"], boot[i])), "_formation": fb[target][i % len(fb[target])]}
                        for i in idx])
        return [{"xg": a, "xga": b} for a, b in zip(*out)]

    def _run_mc(self, us, opp, tactics, venue, conditions, subs, n_sims, seed) -> dict:
        rng = np.random.default_rng(seed)
        G = 40
        per = max(n_sims // G, 50)
        prof = np.repeat(np.array(self.eff["minute_profile"]), 15)  # 90 minutes
        prof = prof / prof.mean()
        pz = self._fatigue_load(tactics, conditions)
        minutes = np.arange(90)
        relief = np.zeros(90)
        att_shift = np.zeros(90)
        def_shift = np.zeros(90)
        for s in subs:
            m = int(s.get("minute", 60))
            after = minutes >= m
            if m <= 80:
                relief[after] += PRIORS["sub_relief"]
            kind = s.get("type", "like-for-like")
            if kind in ("attacking", "defensive"):
                dx, dy = PRIORS[f"{kind}_sub"]
                att_shift[after] += dx
                def_shift[after] += dy
        relief = np.minimum(relief, PRIORS["sub_relief_max"])
        late = minutes >= 60
        ramp = np.clip((minutes - 60) / 30, 0, 1)  # fatigue builds through the last half hour
        fat_against = 1 + PRIORS["fatigue_xga_per_press_sd"] * pz * ramp * 2 * (1 - relief) * late
        fat_for = 1 - PRIORS["fatigue_xg_per_press_sd"] * pz * ramp * 2 * (1 - relief) * late
        shape_for = prof * fat_for * np.exp(att_shift) / 90
        shape_against = prof * fat_against * np.exp(def_shift) / 90

        # parameter uncertainty: ratings + effect coefficients, one draw per group
        sd_us = 0.6 / math.sqrt(us["rating"].get("n_effective", 10) + 4)
        sd_opp = 0.6 / math.sqrt(opp["rating"].get("n_effective", 10) + 4)
        coefs = self._boot_coefs(rng, G)
        gf_all, ga_all, lam_f_g, lam_a_g, timing_f, timing_a = [], [], [], [], np.zeros(6), np.zeros(6)
        first = np.zeros(3)
        late_concede = 0
        group_wdl = []
        for g in range(G):
            r = self.rates(us, opp, tactics, venue, conditions, coefs[g])
            lf = r["lam_for"] * math.exp(rng.normal(0, sd_us) + rng.normal(0, sd_opp) - (sd_us ** 2 + sd_opp ** 2) / 2)
            la = r["lam_against"] * math.exp(rng.normal(0, sd_us) + rng.normal(0, sd_opp) - (sd_us ** 2 + sd_opp ** 2) / 2)
            lam_f_g.append(float(lf * shape_for.sum()))
            lam_a_g.append(float(la * shape_against.sum()))
            gf = np.zeros(per, dtype=int)
            ga = np.zeros(per, dtype=int)
            first_goal = np.zeros(per, dtype=int)  # 0 none, 1 us, 2 them
            late_c = np.zeros(per, dtype=bool)
            for t in range(90):
                diff = gf - ga
                mf = np.where(diff > 0, PRIORS["leading_mult"], np.where(diff < 0, PRIORS["trailing_mult"], 1.0))
                ma = np.where(diff < 0, PRIORS["leading_mult"], np.where(diff > 0, PRIORS["trailing_mult"], 1.0))
                sf = rng.poisson(lf * shape_for[t] * mf)
                sa = rng.poisson(la * shape_against[t] * ma)
                first_goal = np.where((first_goal == 0) & (sf > 0) & (sa == 0), 1, first_goal)
                first_goal = np.where((first_goal == 0) & (sa > 0), 2, first_goal)
                if t >= 75:
                    late_c |= sa > 0
                timing_f[t // 15] += sf.sum()
                timing_a[t // 15] += sa.sum()
                gf += sf
                ga += sa
            gf_all.append(gf); ga_all.append(ga)
            first += np.bincount(first_goal, minlength=3)
            late_concede += late_c.sum()
            group_wdl.append(draw_adjust(((gf > ga).mean(), (gf == ga).mean(), (gf < ga).mean()), self.draw_k))
        gf = np.concatenate(gf_all)
        ga = np.concatenate(ga_all)
        n = len(gf)
        w, d, l = draw_adjust(((gf > ga).mean(), (gf == ga).mean(), (gf < ga).mean()), self.draw_k)
        gw = np.array(group_wdl)
        scores = {}
        for a, b in zip(gf.tolist(), ga.tolist()):
            scores[(a, b)] = scores.get((a, b), 0) + 1
        top = sorted(scores.items(), key=lambda kv: -kv[1])[:8]
        r_point = self.rates(us, opp, tactics, venue, conditions)
        counter_share = self._counter_share(us)
        xga = float(np.mean(lam_a_g))
        return {
            "n_sims": n,
            "win": round(float(w), 4), "draw": round(float(d), 4), "loss": round(float(l), 4),
            "win_band": [round(float(np.percentile(gw[:, 0], 5)), 3), round(float(np.percentile(gw[:, 0], 95)), 3)],
            "loss_band": [round(float(np.percentile(gw[:, 2], 5)), 3), round(float(np.percentile(gw[:, 2], 95)), 3)],
            "xg_for": round(float(np.mean(lam_f_g)), 3), "xg_against": round(xga, 3),
            "xg_for_band": [round(float(np.percentile(lam_f_g, 5)), 3), round(float(np.percentile(lam_f_g, 95)), 3)],
            "xg_against_band": [round(float(np.percentile(lam_a_g, 5)), 3), round(float(np.percentile(lam_a_g, 95)), 3)],
            "xg_for_samples": [round(x, 3) for x in lam_f_g],
            "xg_against_samples": [round(x, 3) for x in lam_a_g],
            "xpts": round(float(3 * w + d), 3),
            "goals_for_dist": [round(float((gf == k).mean()), 4) for k in range(6)] + [round(float((gf >= 6).mean()), 4)],
            "goals_against_dist": [round(float((ga == k).mean()), 4) for k in range(6)] + [round(float((ga >= 6).mean()), 4)],
            "scorelines": [{"score": f"{a}-{b}", "p": round(c / n, 4)} for (a, b), c in top],
            "clean_sheet": round(float((ga == 0).mean()), 4),
            "concede_2plus": round(float((ga >= 2).mean()), 4),
            "score_first": round(float(first[1] / n), 4), "concede_first": round(float(first[2] / n), 4),
            "late_concede": round(float(late_concede / n), 4),
            "timing_for": (timing_f / n).round(3).tolist(), "timing_against": (timing_a / n).round(3).tolist(),
            "risk": {
                "counter_xga": round(xga * counter_share, 3),
                "counter_share": round(counter_share, 3),
                "fatigue_index": round(float(pz * (1 - relief[-1])), 3),
                "late_xga_share": round(float(timing_a[4:].sum() / max(timing_a.sum(), 1e-9)), 3),
            },
            "drivers": {k: {lv: round(math.exp(v) - 1, 4) for lv, v in r_point["contrib"][k].items()} for k in ("xg", "xga")},
        }

    def _counter_share(self, t: dict) -> float:
        if "counter_xga_pm" in t.get("extra", {}) and t["extra"]["counter_xga_pm"] is not None:
            return float(np.clip(t["extra"]["counter_xga_pm"] / max(t["per_match"]["xga"], 0.1), 0, 0.5))
        return self.pools[t["archetype"]["id"]]["counter_share"]

    def _shot_map(self, t: dict, xg_total: float, seed: int) -> list:
        pool = t.get("shots") or self.pools[t["archetype"]["id"]]["shots"]
        if not pool:
            return []
        rng = np.random.default_rng(seed)
        xps = np.mean([s[2] for s in pool]) or 0.1
        n = int(np.clip(round(xg_total / xps), 3, 30))
        pick = [pool[i] for i in rng.choice(len(pool), n, replace=False if n <= len(pool) else True)]
        scale = xg_total / max(sum(p[2] for p in pick), 1e-6)
        return [[p[0], p[1], round(min(p[2] * scale, 0.95), 3)] for p in pick]

    # ------------------------------------------------------------ narrative helpers

    def _notes(self, us, opp, tactics, res, conditions, subs) -> list[str]:
        notes = []
        dr = res["drivers"]
        for lev in ("press", "tempo", "width", "formation", "adaptation"):
            a, b = dr["xg"][lev], dr["xga"][lev]
            if abs(a) >= 0.02 or abs(b) >= 0.02:
                notes.append(f"{LEVER_LABEL[lev]}: {a:+.0%} xG for, {b:+.0%} xG against vs your usual set-up.")
        if res["risk"]["fatigue_index"] > 0.6 and not subs:
            notes.append("High press without planned substitutions — expect legs to go after 60'. Plan 2–3 changes.")
        if res["late_concede"] > 0.3:
            notes.append(f"{res['late_concede']:.0%} chance of conceding after 75' — rehearse late-game game management.")
        if conditions != "normal":
            notes.append(f"Conditions ({conditions}) applied as a coaching prior, not a fitted effect.")
        if not notes:
            notes.append("This set-up is close to your usual identity; differences come mainly from the opponent.")
        return notes

    def key_zones(self, us: dict, opp: dict) -> dict:
        """Where the opponent defends least (attack there) and where they attack most (protect there)."""
        od = np.array(opp.get("def_heat") or self.pools[opp["archetype"]["id"]]["def_heat"])
        oa = np.array(opp.get("heat") or self.pools[opp["archetype"]["id"]]["heat"])
        # opponent's defensive actions in their own defensive third = our attacking third (mirror both axes)
        their_def_third = od[0:4, :]                     # x 0-40 in their frame
        ours = their_def_third[::-1, ::-1].sum(axis=0)   # by our y lanes
        lanes = {}
        for i, z in enumerate(ZONE_Y):
            lanes[z] = lanes.get(z, 0) + ours[i]
        attack = sorted(lanes, key=lanes.get)[:2]
        threat = oa[8:12, :][::-1, ::-1].sum(axis=0)     # their final third = our defensive third, mirrored
        tl = {}
        for i, z in enumerate(ZONE_Y):
            tl[z] = tl.get(z, 0) + threat[i]
        protect = sorted(tl, key=tl.get, reverse=True)[:2]
        tot = sum(lanes.values()) or 1
        ttot = sum(tl.values()) or 1
        return {"attack": [{"zone": z, "opp_def_share": round(lanes[z] / tot, 3)} for z in attack],
                "protect": [{"zone": z, "opp_attack_share": round(tl[z] / ttot, 3)} for z in protect]}

    def matchup(self, team_id: str, opponent_id: str) -> dict:
        us, opp = self.team(team_id), self.team(opponent_id)
        zu = us["archetype"]["z"]
        zo = opp["archetype"]["z"]
        pc_z, pr_z = self._opp_z(opp)
        risks = []
        if zo["press_height"] > 0.5 and zu["pass_comp"] < 0:
            risks.append({"title": "Their press vs your build-up",
                          "detail": "They press high and your pass completion is below average — expect turnovers in your half. Direct play into the channels historically does better against high-pressing sides."})
        if zo["directness"] > 0.5 and zu["press_height"] > 0.3:
            risks.append({"title": "Space behind your high line",
                          "detail": "They go direct quickly; a high defensive line leaves space for balls in behind."})
        if zo["possession"] > 0.5 and zu["press_height"] < -0.3:
            risks.append({"title": "Long spells without the ball",
                          "detail": "They dominate possession and you defend deep — stay compact and make each turnover count."})
        if zo["width"] > 0.5:
            risks.append({"title": "Wide overloads",
                          "detail": "They stretch the pitch; full-backs/wing-backs will face 2v1s without wide-midfield support."})
        if pc_z > 0.8 and zu["press_height"] > 0.5:
            risks.append({"title": "Press could be bypassed",
                          "detail": "They are excellent passers; in the data, pressing high against good passing sides raises xG against."})
        if opp["extra"].get("sp_xg_pm", 0) and opp["extra"]["sp_xg_pm"] > 0.6:
            risks.append({"title": "Set-piece threat",
                          "detail": f"{opp['extra']['sp_xg_pm']:.2f} xG per match from set-piece phases."})
        if not risks:
            risks.append({"title": "No major style mismatch",
                          "detail": "Styles are compatible — the game will be decided by execution and quality."})
        r = self.rates(us, opp, self.default_tactics(us))
        p = draw_adjust(wdl(score_matrix(r["lam_for"], r["lam_against"])), self.draw_k)
        gap = self.level_gap(us, opp)
        if gap <= -0.8:
            risks.insert(0, {"title": "Huge difference in level",
                             "detail": "They play at a far higher level (professional/international). Expect long spells without the ball; aim to stay compact and keep it respectable."})
        elif gap >= 0.8:
            risks.insert(0, {"title": "You're the much stronger side",
                             "detail": "You play at a far higher level. The danger is complacency — keep the tempo high and stay professional."})
        return {"team": self._summary(us), "opponent": self._summary(opp), "risks": risks[:4], "h2h": self.h2h(us, opp),
                "level_gap": round(gap, 2),
                "zones": self.key_zones(us, opp),
                "quick": {"win": round(p[0], 3), "draw": round(p[1], 3), "loss": round(p[2], 3),
                          "xg_for": round(r["lam_for"], 2), "xg_against": round(r["lam_against"], 2)}}

    def _summary(self, t: dict) -> dict:
        keys = ["id", "label", "name", "source", "competition", "matches", "formation", "record", "style", "extra",
                "per_match", "rating", "archetype", "heat", "def_heat", "pass_network", "similar", "level"]
        out = {k: t.get(k) for k in keys}
        out["similar"] = [{"id": s["id"], "label": self.pro[s["id"]]["label"], "distance": s["distance"]}
                          for s in (t.get("similar") or []) if s["id"] in self.pro]
        out["default_tactics"] = self.default_tactics(t)
        out["has_event_data"] = t.get("source") == "statsbomb"
        return out

    # ------------------------------------------------------------ recommendations

    def _xpts(self, lam_f, lam_a) -> tuple[float, tuple]:
        p = draw_adjust(wdl(score_matrix(lam_f, lam_a)), self.draw_k)
        return 3 * p[0] + p[1], p

    def _avg_fatigue(self, tactics, conditions) -> tuple[float, float]:
        pz = self._fatigue_load(tactics, conditions)
        prof = np.repeat(np.array(self.eff["minute_profile"]), 15)
        ramp = np.clip((np.arange(90) - 60) / 30, 0, 1) * 2 * (1 - 0.4)  # assumes 2 subs
        fa = (prof * (1 + PRIORS["fatigue_xga_per_press_sd"] * pz * ramp)).sum() / prof.sum()
        ff = (prof * (1 - PRIORS["fatigue_xg_per_press_sd"] * pz * ramp)).sum() / prof.sum()
        return ff, fa

    def evaluate(self, us, opp, tactics, venue, conditions) -> dict:
        r = self.rates(us, opp, tactics, venue, conditions)
        ff, fa = self._avg_fatigue(tactics, conditions)
        xp, p = self._xpts(r["lam_for"] * ff, r["lam_against"] * fa)
        return {"xpts": xp, "p": p, "xg_for": r["lam_for"] * ff, "xg_against": r["lam_against"] * fa,
                "contrib": r["contrib"]}

    def recommend(self, team_id: str, opponent_id: str, tactics: dict | None = None, venue: str = "home",
                  conditions: str = "normal", top_k: int = 3) -> dict:
        us, opp = self.team(team_id), self.team(opponent_id)
        cur = {**self.default_tactics(us), **(tactics or {})}
        cur_eval = self.evaluate(us, opp, cur, venue, conditions)

        singles = []
        for lev in ("press", "tempo", "width"):
            for step in (-30, -15, 15, 30):
                v = int(np.clip(cur[lev] + step, 5, 95))
                if v != cur[lev]:
                    singles.append({lev: v})
        for f in FAMILIES:
            if f != cur["formation"]:
                singles.append({"formation": f})
        cands = singles + [{**a, **b} for a, b in combinations(singles, 2) if not set(a) & set(b)]

        scored = []
        for ch in cands:
            new = {**cur, **ch}
            e = self.evaluate(us, opp, new, venue, conditions)
            gain = e["xpts"] - cur_eval["xpts"]
            if gain > 0.01:
                scored.append((gain, ch, new, e))
        scored.sort(key=lambda x: -x[0])

        # Re-rank the strongest candidates by a pessimistic (10th percentile) gain across
        # bootstrap draws of the effect model, so recommendations stay conservative.
        boots = self._boot_coefs(np.random.default_rng(3), 120)
        ff_c, fa_c = self._avg_fatigue(cur, conditions)
        cur_boot = []
        for c in boots:
            rc = self.rates(us, opp, cur, venue, conditions, c)
            cur_boot.append(self._xpts(rc["lam_for"] * ff_c, rc["lam_against"] * fa_c)[0])
        ranked = []
        for gain, ch, new, e in scored[:40]:
            ff_n, fa_n = self._avg_fatigue(new, conditions)
            g = []
            for c, base_x in zip(boots, cur_boot):
                rn = self.rates(us, opp, new, venue, conditions, c)
                g.append(self._xpts(rn["lam_for"] * ff_n, rn["lam_against"] * fa_n)[0] - base_x)
            g = np.array(g)
            ranked.append((float(np.percentile(g, 10)), gain, ch, new, e, g))
        ranked.sort(key=lambda x: -x[0])

        # Offer distinct options: each recommendation must be led by a different lever.
        recs, used_primary = [], set()
        for p10, gain, ch, new, e, g in ranked:
            if p10 <= 0:
                continue
            payload = self._rec_payload(us, opp, cur, new, ch, cur_eval, e, float((g > 0).mean()))
            core = [d for d in payload["drivers"] if d["lever"] != "adaptation"]
            primary = max(core, key=lambda d: abs(d["xg_pct"]) + abs(d["xga_pct"]))["lever"] if core else None
            if primary in used_primary:
                continue
            payload["primary_lever"] = primary
            payload["impact"]["xpts_range"] = [round(float(np.percentile(g, 10)), 3), round(float(np.percentile(g, 90)), 3)]
            recs.append(payload)
            used_primary.add(primary)
            if len(recs) == top_k:
                break
        return {"current": {"tactics": cur, "xpts": round(cur_eval["xpts"], 3),
                            "win": round(cur_eval["p"][0], 3), "draw": round(cur_eval["p"][1], 3),
                            "loss": round(cur_eval["p"][2], 3),
                            "xg_for": round(cur_eval["xg_for"], 3), "xg_against": round(cur_eval["xg_against"], 3)},
                "recommendations": recs,
                "weaknesses": self.weaknesses(us, opp),
                "team": {"id": us["id"], "label": us["label"]}, "opponent": {"id": opp["id"], "label": opp["label"]}}

    def _describe_change(self, cur, new) -> list[str]:
        out = []
        words = {"press": ("drop the press", "press higher"), "tempo": ("slow the tempo / build shorter", "play more directly"),
                 "width": ("play narrower", "play wider")}
        for lev in ("press", "tempo", "width"):
            if new[lev] != cur[lev]:
                out.append(f"{words[lev][new[lev] > cur[lev]].capitalize()} ({cur[lev]} → {new[lev]})")
        if new["formation"] != cur["formation"]:
            out.append(f"Switch to {new['formation']} (from {cur['formation']})")
        return out

    def _rec_payload(self, us, opp, cur, new, ch, ce, ne, conf) -> dict:
        drivers = []
        for lev in ("press", "tempo", "width", "formation", "adaptation"):
            a = ne["contrib"]["xg"][lev] - ce["contrib"]["xg"][lev]
            b = ne["contrib"]["xga"][lev] - ce["contrib"]["xga"][lev]
            if abs(a) > 1e-4 or abs(b) > 1e-4:
                drivers.append({"lever": lev, "label": LEVER_LABEL[lev], "xg_pct": round(math.exp(a) - 1, 4),
                                "xga_pct": round(math.exp(b) - 1, 4)})
        ff_c, fa_c = self._avg_fatigue(cur, "normal")
        ff_n, fa_n = self._avg_fatigue(new, "normal")
        title = " + ".join(self._describe_change(cur, new))
        tags = self._drill_tags(cur, new)
        return {
            "title": title, "changes": ch, "tactics": new,
            "impact": {"xpts": round(ne["xpts"] - ce["xpts"], 3),
                       "win": round(ne["p"][0] - ce["p"][0], 4), "loss": round(ne["p"][2] - ce["p"][2], 4),
                       "xg_for": round(ne["xg_for"] - ce["xg_for"], 3),
                       "xg_against": round(ne["xg_against"] - ce["xg_against"], 3),
                       "counter_risk_pct": round(((ne["xg_against"] * self._counter_share(us)) /
                                                  max(ce["xg_against"] * self._counter_share(us), 1e-6)) - 1, 4),
                       "fatigue_change": round(fa_n - fa_c, 4)},
            "confidence": round(conf, 3),
            "confidence_label": "high" if conf >= 0.8 else ("moderate" if conf >= 0.6 else "low"),
            "drivers": drivers,
            "drill_tags": tags,
            "why": self._template_why(us, opp, cur, new, drivers, conf),
        }

    def _template_why(self, us, opp, cur, new, drivers, conf) -> str:
        oa = opp["archetype"]["name"]
        parts = []
        for d in drivers:
            lev = d["lever"]
            if lev == "press" and new["press"] > cur["press"]:
                parts.append(f"winning the ball higher against a {oa} side shortens your route to goal and keeps them from settling")
            elif lev == "press":
                parts.append(f"a deeper block denies a {oa} side the space they like to attack")
            elif lev == "tempo" and new["tempo"] > cur["tempo"]:
                parts.append("moving the ball forward sooner bypasses their press before it can set")
            elif lev == "tempo":
                parts.append("keeping the ball longer reduces how often you're exposed in transition")
            elif lev == "width" and new["width"] > cur["width"]:
                parts.append("stretching the pitch opens gaps between their full-backs and centre-backs")
            elif lev == "width":
                parts.append("a narrower shape protects the central lanes where they create most")
            elif lev == "formation":
                parts.append(f"the {new['formation']} shape matches up better against their {opp['formation']}")
        parts = [p for p in parts if p]
        main = "; ".join(parts[:2]) or "the change matches up better with the opponent's style"
        core = [d for d in drivers if d["lever"] != "adaptation"]
        best = max(core, key=lambda d: abs(d["xg_pct"]) + abs(d["xga_pct"])) if core else None
        num = (f" Model estimate: {best['label'].lower()} moves your xG by {best['xg_pct']:+.0%} "
               f"and xG against by {best['xga_pct']:+.0%}.") if best else ""
        return (f"Against {opp['label']}, {main}.{num} "
                f"It holds up in {conf:.0%} of the model's uncertainty scenarios.")

    def _drill_tags(self, cur, new) -> list[str]:
        tags = []
        if new["press"] > cur["press"]:
            tags += ["pressing", "counter-press"]
        elif new["press"] < cur["press"]:
            tags += ["compact-block", "defensive-shape"]
        if new["tempo"] > cur["tempo"]:
            tags += ["vertical-passing", "transition"]
        elif new["tempo"] < cur["tempo"]:
            tags += ["build-up", "possession"]
        if new["width"] > cur["width"]:
            tags += ["wide-play", "switching"]
        elif new["width"] < cur["width"]:
            tags += ["central-combinations", "compact-block"]
        if new["formation"] != cur["formation"]:
            tags += {"3-5-2": ["back-three", "wing-backs"], "3-4-3": ["back-three", "wing-backs", "front-three"],
                     "4-3-3": ["front-three", "midfield-triangle"], "4-2-3-1": ["double-pivot", "number-10"],
                     "4-4-2": ["two-strikers", "banks-of-four"], "4-1-4-1": ["single-pivot", "compact-block"]}[new["formation"]]
        return list(dict.fromkeys(tags))

    def weaknesses(self, us: dict, opp: dict) -> list[dict]:
        z = us["archetype"]["z"]
        out = []
        cs = self._counter_share(us)
        if cs > 0.12:
            out.append({"title": "Counter-attacks against", "tags": ["rest-defence", "transition"],
                        "detail": f"{cs:.0%} of the chances you concede come from counters."})
        late = us.get("extra", {}).get("late_xga_share")
        if late and late > 0.45:
            out.append({"title": "Late-game concessions", "tags": ["fitness", "game-management"],
                        "detail": f"{late:.0%} of the danger you concede comes after the hour."})
        if z["pass_comp"] < -0.5:
            out.append({"title": "Ball security", "tags": ["possession", "build-up"],
                        "detail": "Pass completion is well below the pro average — retaining the ball under pressure is a priority."})
        if us["rating"]["defence"] > 1.15:
            out.append({"title": "Chances conceded", "tags": ["defensive-shape", "compact-block"],
                        "detail": f"You concede {us['rating']['defence']:.0%} of a league-average side's chance volume."})
        if us["rating"]["attack"] < 0.85:
            out.append({"title": "Chance creation", "tags": ["final-third", "central-combinations"],
                        "detail": f"You create {us['rating']['attack']:.0%} of a league-average side's chance volume."})
        sp = us.get("extra", {}).get("sp_xg_pm")
        if (opp.get("extra", {}).get("sp_xg_pm") or 0) > 0.6:
            out.append({"title": "Defending set pieces", "tags": ["set-pieces"],
                        "detail": "This opponent generates a lot from set-piece phases."})
        elif sp is not None and sp < 0.3:
            out.append({"title": "Set-piece threat", "tags": ["set-pieces"],
                        "detail": "Little threat from set pieces — an easy area to gain."})
        return out[:4]

    # ------------------------------------------------------------ archetype map

    def archetype_map(self) -> dict:
        arch = self.arch
        mu, sd = np.array(arch["mean"]), np.array(arch["std"])
        teams = list(self.pro.values())
        local = []
        for lt in self.store.list_teams():
            try:
                local.append(self.team(lt["id"]))
            except KeyError:
                pass
        X = np.array([[t["style"][f] for f in STYLE_FEATURES] for t in teams])
        Z = (X - mu) / sd
        Zc = Z - Z.mean(0)
        _, _, vt = np.linalg.svd(Zc, full_matrices=False)
        comps = vt[:2]
        # orient axes so that +x = more possession, +y = higher press (for readability)
        if comps[0][0] < 0:
            comps[0] *= -1
        if comps[1][2] < 0:
            comps[1] *= -1

        def proj(t):
            z = (np.array([t["style"][f] for f in STYLE_FEATURES]) - mu) / sd - Z.mean(0)
            return (z @ comps.T).round(3).tolist()

        pts = [{"id": t["id"], "label": t["label"], "archetype": t["archetype"]["id"], "source": t.get("source", "statsbomb"),
                "xy": proj(t)} for t in teams + local]
        return {"points": pts, "archetypes": arch["clusters"],
                "axes": {"x": dict(zip(STYLE_FEATURES, comps[0].round(3).tolist())),
                         "y": dict(zip(STYLE_FEATURES, comps[1].round(3).tolist()))}}

    def meta(self) -> dict:
        return {"formations": {f: {"slots": [{"role": r, "x": x, "y": y} for r, x, y in LAYOUTS[f]], "note": NOTES[f]}
                               for f in FAMILIES},
                "archetypes": self.arch["clusters"], "data": self.model["data"], "built_at": self.model["built_at"],
                "levers": {lev: {"feature": f, "q5": self.dist[f]["q5"], "q95": self.dist[f]["q95"]} for lev, f in LEVERS.items()}}

    def model_card(self) -> dict:
        e = self.eff
        return {"data": self.model["data"], "backtest": self.model["backtest"],
                "effects": {t: {"coef": e["targets"][t]["coef"], "ci90": e["targets"][t]["ci90"],
                                "r2_within": e["targets"][t]["r2_within"]} for t in ("xg", "xga")},
                "lever_sd": e["lever_sd"], "formation_effect": e["formation_effect"],
                "formation_counts": e["formation_counts"], "home_log_effect": e["home_log_effect"],
                "minute_profile": e["minute_profile"],
                "priors": {**{k: v for k, v in PRIORS.items()},
                           "level_gap_scale": LEVEL_GAP_SCALE,
                           "level_tier_by_level": LEVEL_TIER, "level_tier_by_age_group": AGE_TIER},
                "archetypes": self.arch["clusters"], "draw_factor": self.draw_k}


def local_profile_from_matches(team: dict, matches: list[dict], engine: "Engine", league_base: float) -> dict:
    """Turn coach-entered match rows into the same profile shape as a pro team."""
    from collections import Counter
    from .formations import family_of
    n = len(matches)
    dist = engine.dist

    def rating_to_value(feature, rating):
        q = {1: "q10", 2: "q30", 3: "q50", 4: "q70", 5: "q90"}[int(np.clip(round(rating), 1, 5))]
        return dist[feature][q]

    def xg_est(m, side):
        shots = m.get(f"shots_{side}") or 0
        sot = m.get(f"sot_{side}")
        goals = m.get("goals_for" if side == "for" else "goals_against") or 0
        est = (0.30 * sot + 0.05 * max(shots - sot, 0)) if sot not in (None, "") else 0.11 * shots
        return 0.7 * est + 0.3 * goals  # blend: no event data, so lean partly on goals

    poss = [m["possession"] / 100 if m.get("possession") not in (None, "") else None for m in matches]
    poss = [p for p in poss if p is not None] or [0.5]
    pcs = [m["passes_completed"] / m["passes_attempted"] for m in matches
           if m.get("passes_attempted") and m.get("passes_completed") is not None]
    pass_comp = float(np.mean(pcs)) if pcs else dist["pass_comp"]["q30"]
    style = {
        "possession": float(np.mean(poss)),
        "pass_comp": float(np.clip(pass_comp, dist["pass_comp"]["q5"] - 0.1, dist["pass_comp"]["q95"])),
        "press_height": float(np.mean([rating_to_value("press_height", m.get("press_rating") or 3) for m in matches])),
        "directness": float(np.mean([rating_to_value("directness", m.get("directness_rating") or 3) for m in matches])),
        "width": float(np.mean([rating_to_value("width", m.get("width_rating") or 3) for m in matches])),
    }
    xg = [xg_est(m, "for") for m in matches]
    xga = [xg_est(m, "against") for m in matches]
    k = 4
    arche = assign_archetype(style, engine.arch)
    res = Counter("W" if m["goals_for"] > m["goals_against"] else ("D" if m["goals_for"] == m["goals_against"] else "L")
                  for m in matches)
    late = [m for m in matches if m.get("late_goals_against") not in (None, "")]
    corners = [m["corners_for"] for m in matches if m.get("corners_for") not in (None, "")]
    pool = engine.pools[arche["id"]]
    formation = Counter(family_of(m.get("formation")) for m in matches).most_common(1)[0][0]
    total_ga = sum(m["goals_against"] for m in matches)
    return {
        "id": team["id"], "name": team["name"], "label": f"{team['name']} · {team.get('level') or 'Local'}",
        "source": "local", "competition": "Your club data", "level": team.get("level"),
        "matches": n, "formation": formation, "league_base": league_base,
        "formations_used": dict(Counter(family_of(m.get("formation")) for m in matches)),
        "record": {"W": res["W"], "D": res["D"], "L": res["L"],
                   "gf": sum(m["goals_for"] for m in matches), "ga": total_ga},
        "style": {k_: round(v, 4) for k_, v in style.items()},
        "extra": {
            "counter_xga_pm": None, "ppda": None, "field_tilt": None,
            "sp_xg_pm": round(0.03 * float(np.mean(corners)), 3) if corners else None,
            "late_xga_share": round(sum(m["late_goals_against"] for m in late) / max(sum(m["goals_against"] for m in late), 1), 3)
            if late and sum(m["goals_against"] for m in late) >= 3 else pool["late_share"],
        },
        "per_match": {"xg": round(float(np.mean(xg)), 3), "xga": round(float(np.mean(xga)), 3),
                      "shots": round(float(np.mean([m.get("shots_for") or 0 for m in matches])), 2),
                      "shots_against": round(float(np.mean([m.get("shots_against") or 0 for m in matches])), 2),
                      "goals": round(float(np.mean([m["goals_for"] for m in matches])), 3),
                      "goals_against": round(float(np.mean([m["goals_against"] for m in matches])), 3)},
        "rating": {"attack": round((sum(xg) + k * league_base) / (n + k) / league_base, 4),
                   "defence": round((sum(xga) + k * league_base) / (n + k) / league_base, 4),
                   "n_effective": n},
        "archetype": arche,
        "heat": None, "def_heat": None, "shots": None, "pass_network": None,
        "trend": [{"date": m["date"], "opp": m.get("opponent"), "gf": m["goals_for"], "ga": m["goals_against"],
                   "xg": round(xg_est(m, "for"), 2), "xga": round(xg_est(m, "against"), 2),
                   "possession": (m["possession"] / 100) if m.get("possession") not in (None, "") else None,
                   "shots": m.get("shots_for"), "shots_against": m.get("shots_against"),
                   "pass_comp": (m["passes_completed"] / m["passes_attempted"]) if m.get("passes_attempted") else None,
                   "press_rating": m.get("press_rating"), "formation": family_of(m.get("formation"))}
                  for m in sorted(matches, key=lambda r: r["date"])],
        "roster": team.get("roster") or [],
        "similar": _similar_pro(style, engine),
        "data_quality": {"matches": n, "has_passing": bool(pcs), "has_sot": any(m.get("sot_for") not in (None, "") for m in matches),
                         "note": "Ratings are shrunk toward your league average; with fewer than 8 matches treat them as rough."},
    }


def _similar_pro(style: dict, engine: Engine) -> list[dict]:
    feats = STYLE_FEATURES
    X = np.array([[t["style"][f] for f in feats] for t in engine.pro.values()])
    mu, sd = X.mean(0), X.std(0)
    z = (np.array([style[f] for f in feats]) - mu) / sd
    Z = (X - mu) / sd
    dist = np.linalg.norm(Z - z, axis=1)
    ids = list(engine.pro)
    return [{"id": ids[i], "distance": round(float(dist[i]), 3)} for i in np.argsort(dist)[:5]]


def scouted_profile(opp: dict, engine: "Engine") -> dict:
    """Profile for a grassroots opponent built from the league table, our results against them and scouting notes."""
    from .formations import family_of
    acc = engine.accounts
    user_id = opp["user_id"]
    table = opp.get("table") or {}
    dist = engine.dist
    # league scoring level from the user's pasted table (goals per team per game), else the local base
    rows = [o.get("table") for o in acc.opponents(user_id) if o.get("table")]
    league_gpg = (sum(r["gf"] for r in rows) / sum(r["played"] for r in rows)) if rows and sum(r["played"] for r in rows) else None
    base = league_gpg or engine.store.league_base(owner_id=user_id)
    # observations: league table rows + head-to-head results from our own match records
    gf = table.get("gf", 0)
    ga = table.get("ga", 0)
    n = table.get("played", 0)
    h2h = []
    for tid in acc.team_ids(user_id):
        for m in engine.store.matches(tid):
            if (m.get("opponent") or "").strip().lower() == opp["name"].strip().lower():
                h2h.append(m)
                gf += m["goals_against"]
                ga += m["goals_for"]
                n += 1
    k = 4
    attack = (gf + k * base) / (n + k) / base if base else 1.0
    defence = (ga + k * base) / (n + k) / base if base else 1.0

    def rating_value(feature, rating):
        if rating in (None, ""):
            return dist[feature]["q50"]
        return dist[feature][{1: "q10", 2: "q30", 3: "q50", 4: "q70", 5: "q90"}[int(np.clip(round(float(rating)), 1, 5))]]

    sc = opp.get("scouting") or {}
    style = {
        "possession": float(sc["possession"]) / 100 if sc.get("possession") not in (None, "") else 0.5,
        "pass_comp": dist["pass_comp"]["q30"],
        "press_height": rating_value("press_height", sc.get("press_rating")),
        "directness": rating_value("directness", sc.get("directness_rating")),
        "width": rating_value("width", sc.get("width_rating")),
    }
    arche = assign_archetype(style, engine.arch)
    scouted = any(sc.get(k) not in (None, "") for k in ("press_rating", "directness_rating", "width_rating"))
    if not scouted:
        arche = {**arche, "name": "Not scouted yet", "description": "Add scouting notes to learn their style."}
    pool = engine.pools[assign_archetype(style, engine.arch)["id"]]
    w = table.get("won", 0) + sum(1 for m in h2h if m["goals_against"] > m["goals_for"])
    d = table.get("drawn", 0) + sum(1 for m in h2h if m["goals_against"] == m["goals_for"])
    l_ = table.get("lost", 0) + sum(1 for m in h2h if m["goals_against"] < m["goals_for"])
    sources = (["league table"] if table else []) + (["your results against them"] if h2h else []) + (["your scouting"] if scouted else [])
    return {
        "id": opp["id"], "name": opp["name"], "label": opp["name"], "source": "scouted", "competition": "This season",
        "matches": n, "formation": family_of(sc.get("formation") or "4-4-2"), "league_base": base,
        "formations_used": {family_of(sc.get("formation") or "4-4-2"): max(n, 1)},
        "record": {"W": w, "D": d, "L": l_, "gf": gf, "ga": ga},
        "style": {k_: round(v, 4) for k_, v in style.items()},
        "extra": {"counter_xga_pm": None, "sp_xg_pm": 0.7 if sc.get("set_piece_threat") else None,
                  "late_xga_share": pool["late_share"]},
        "per_match": {"xg": round(gf / n, 3) if n else None, "xga": round(ga / n, 3) if n else None,
                      "goals": round(gf / n, 3) if n else None, "goals_against": round(ga / n, 3) if n else None},
        "rating": {"attack": round(attack, 4), "defence": round(defence, 4), "n_effective": n},
        "archetype": arche, "heat": None, "def_heat": None, "shots": None, "pass_network": None,
        "trend": [{"date": m["date"], "opp": "you", "gf": m["goals_against"], "ga": m["goals_for"]} for m in h2h],
        "table": table, "scouting": sc, "similar": [],
        "data_quality": {"sources": sources, "note": ("Based on " + ", ".join(sources) + ".") if sources
                         else "No information yet: treated as an average team in your league. Add the league table or scouting notes."},
    }


def blank_local_profile(team: dict, engine: "Engine", league_base: float) -> dict:
    """A brand-new team with no results yet: league-average ratings and a balanced style."""
    style = {f: engine.dist[f]["q50"] for f in STYLE_FEATURES}
    style["possession"] = 0.5
    style["pass_comp"] = engine.dist["pass_comp"]["q30"]
    arche = assign_archetype(style, engine.arch)
    return {
        "id": team["id"], "name": team["name"], "label": team["name"], "source": "local", "competition": "My club",
        "level": team.get("level"), "matches": 0, "formation": "4-4-2", "league_base": league_base,
        "formations_used": {}, "record": {"W": 0, "D": 0, "L": 0, "gf": 0, "ga": 0}, "style": style,
        "extra": {"counter_xga_pm": None, "sp_xg_pm": None, "late_xga_share": engine.pools[arche["id"]]["late_share"]},
        "per_match": {"xg": None, "xga": None, "shots": None, "shots_against": None, "goals": None, "goals_against": None},
        "rating": {"attack": 1.0, "defence": 1.0, "n_effective": 0},
        "archetype": {**arche, "name": "New team", "description": "Add your results to learn your style."},
        "heat": None, "def_heat": None, "shots": None, "pass_network": None, "trend": [], "roster": team.get("roster") or [],
        "similar": [], "data_quality": {"matches": 0, "has_passing": False, "has_sot": False,
                                        "note": "No results yet — treated as an average team. Add matches in My Team."},
    }
