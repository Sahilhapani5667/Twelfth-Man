"""Offline analytics: team features, archetypes, tactic-effect model, backtest.

Everything here runs once in `scripts/build_models.py` and writes JSON to
data/processed/, so the API starts instantly and the demo works offline.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.cluster import KMeans
from sklearn.linear_model import Ridge

from .formations import FORMATION_FAMILY, family_of

SEED = 12
STYLE_FEATURES = ["possession", "pass_comp", "press_height", "directness", "width"]
TACTIC_LEVERS = ["press_height", "directness", "width"]  # what a coach can dial
COMP_SHORT = {"Premier League 2015/16": "PL 15/16", "Euro 2024": "Euro 24", "World Cup 2022": "WC 22"}
NEUTRAL_COMPS = {"Euro 2024", "World Cup 2022"}
SHRINK_MATCHES = 4  # pseudo-matches of league-average performance added to ratings


def slug(s: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in s).strip("-").replace("--", "-")


# ---------------------------------------------------------------- loading

def load_rows(cache_dir: Path) -> tuple[pd.DataFrame, dict]:
    """Team-match rows + raw per-team spatial payloads keyed by team id."""
    rows, spatial = [], defaultdict(list)
    for f in sorted(cache_dir.glob("*.json")):
        m = json.loads(f.read_text())
        comp = m["competition"]
        for t, v in m["teams"].items():
            is_home = t == m["home"]
            opp = m["away"] if is_home else m["home"]
            tid = slug(f"{t} {COMP_SHORT[comp]}")
            rows.append({
                "match_id": m["match_id"], "date": m["date"], "competition": comp,
                "team_id": tid, "team": t, "opp_id": slug(f"{opp} {COMP_SHORT[comp]}"), "opp": opp,
                "venue": 0.0 if comp in NEUTRAL_COMPS else (1.0 if is_home else -1.0),
                "gf": m["home_score"] if is_home else m["away_score"],
                "ga": m["away_score"] if is_home else m["home_score"],
                "formation": family_of(v["formation"]),
                **{k: v[k] for k in ["possession", "pass_comp", "field_tilt", "directness", "width",
                                     "press_height", "ppda", "high_recoveries", "shots", "xg",
                                     "shots_against", "xga", "sp_xg", "counter_xga"]},
                "xg_late": sum(v["xg_by_15"][4:]), "xga_late": sum(v["xga_by_15"][4:]),
                "xg_by_15": v["xg_by_15"],
            })
            spatial[tid].append(v)
    df = pd.DataFrame(rows).sort_values(["date", "match_id"]).reset_index(drop=True)
    return df, spatial


# ---------------------------------------------------------------- archetypes

# Named prototypes (z-score signatures over STYLE_FEATURES). Fitted clusters are
# matched one-to-one to the closest prototype so every archetype gets a readable name.
PROTOTYPES = {
    "Possession & High Press": ([1, 1, 1, -1, 0],
        "Dominates the ball with short, secure passing and wins it back high up the pitch."),
    "Controlled Possession": ([0.6, 0.6, 0, -0.5, -0.6],
        "Patient, narrow build-up; keeps the ball but defends in a mid-block rather than pressing high."),
    "Wide Balanced Block": ([0, 0, 0.2, 0, 1],
        "Even share of the ball, stretches the pitch with wide play and engages around halfway."),
    "Counter-Attacking Low Block": ([-0.8, -0.3, -1, 0.5, -0.5],
        "Concedes the ball, defends deep and compact, then breaks quickly into space."),
    "Direct & Physical": ([-1, -1.5, -0.5, 1.5, 0.4],
        "Plays long and early, competes for second balls and accepts low pass completion."),
    "Compact Mid Block": ([-0.3, 0, -0.3, 0, -1],
        "Narrow and organised without the ball, mixes short and direct play."),
}


def _name_clusters(centroids: np.ndarray) -> list[tuple[str, str]]:
    from scipy.optimize import linear_sum_assignment
    names = list(PROTOTYPES)
    P = np.array([PROTOTYPES[n][0] for n in names], dtype=float)
    cost = np.array([[np.linalg.norm(c - p) for p in P] for c in centroids])
    rows, cols = linear_sum_assignment(cost)
    out = [None] * len(centroids)
    for r, c in zip(rows, cols):
        out[r] = (names[c], PROTOTYPES[names[c]][1])
    return out


def fit_archetypes(df: pd.DataFrame, k: int = 5) -> dict:
    X = df[STYLE_FEATURES].values
    mu, sd = X.mean(0), X.std(0)
    Z = (X - mu) / sd
    km = KMeans(n_clusters=k, n_init=20, random_state=SEED).fit(Z)
    clusters = []
    for i, (c, (name, desc)) in enumerate(zip(km.cluster_centers_, _name_clusters(km.cluster_centers_))):
        clusters.append({"id": i, "name": name, "description": desc,
                         "centroid_z": {k_: round(float(v), 3) for k_, v in zip(STYLE_FEATURES, c)},
                         "share": round(float((km.labels_ == i).mean()), 3)})
    df["cluster"] = km.labels_
    return {"features": STYLE_FEATURES, "mean": mu.tolist(), "std": sd.tolist(), "clusters": clusters}


def assign_archetype(style: dict, arch: dict) -> dict:
    z = np.array([(style[f] - m) / s for f, m, s in zip(arch["features"], arch["mean"], arch["std"])])
    cents = np.array([[c["centroid_z"][f] for f in arch["features"]] for c in arch["clusters"]])
    dist = np.linalg.norm(cents - z, axis=1)
    w = np.exp(-dist ** 2)
    w = w / w.sum()
    best = int(dist.argmin())
    return {"id": best, "name": arch["clusters"][best]["name"],
            "description": arch["clusters"][best]["description"],
            "fit": round(float(w[best]), 3),
            "mix": {arch["clusters"][i]["name"]: round(float(w[i]), 3) for i in np.argsort(-w)[:3]},
            "z": {f: round(float(v), 3) for f, v in zip(arch["features"], z)}}


# ---------------------------------------------------------------- tactic effects

def _effect_design(d: pd.DataFrame, lever_sd: dict, opp_side: str):
    """Within-team (fixed-effects) design: deviations from each team's own average."""
    cols = {}
    for f in TACTIC_LEVERS:
        cols[f] = (d[f] - d.groupby("team_id")[f].transform("mean")) / lever_sd[f]
    # matchup interactions: pressing vs good passers, direct play vs high pressers
    cols["press_x_opp_passing"] = cols["press_height"] * d["opp_pass_comp_z"]
    cols["direct_x_opp_press"] = cols["directness"] * d["opp_press_z"]
    cols["opp_strength"] = d[opp_side] - d.groupby("team_id")[opp_side].transform("mean")
    cols["venue"] = d["venue"]
    return pd.DataFrame(cols)


def fit_effects(df: pd.DataFrame, n_boot: int = 300) -> dict:
    d = df.copy()
    d["lxg"] = np.log(d.xg + 0.1)
    d["lxga"] = np.log(d.xga + 0.1)
    tm = d.groupby("team_id").agg(lxg=("lxg", "mean"), lxga=("lxga", "mean"),
                                  pc=("pass_comp", "mean"), ph=("press_height", "mean"))
    d["opp_att"] = d.opp_id.map(tm.lxg)
    d["opp_def"] = d.opp_id.map(tm.lxga)
    d["opp_pass_comp_z"] = (d.opp_id.map(tm.pc) - tm.pc.mean()) / tm.pc.std()
    d["opp_press_z"] = (d.opp_id.map(tm.ph) - tm.ph.mean()) / tm.ph.std()
    lever_sd = {f: float((d[f] - d.groupby("team_id")[f].transform("mean")).std()) for f in TACTIC_LEVERS}

    out = {"lever_sd": lever_sd, "targets": {},
           "opp_norm": {"pass_comp_mean": float(tm.pc.mean()), "pass_comp_std": float(tm.pc.std()),
                        "press_mean": float(tm.ph.mean()), "press_std": float(tm.ph.std())}}
    rng = np.random.default_rng(SEED)
    teams = d.team_id.unique()
    for target, opp_side in [("xg", "opp_def"), ("xga", "opp_att")]:
        y = d["l" + target] - d.groupby("team_id")["l" + target].transform("mean")
        X = _effect_design(d, lever_sd, opp_side)
        model = Ridge(alpha=5.0).fit(X.values, y.values)
        coefs = dict(zip(X.columns, model.coef_))
        # cluster bootstrap over teams -> honest uncertainty
        boots = []
        for _ in range(n_boot):
            pick = rng.choice(teams, size=len(teams), replace=True)
            idx = np.concatenate([np.flatnonzero(d.team_id.values == t) for t in pick])
            boots.append(Ridge(alpha=5.0).fit(X.values[idx], y.values[idx]).coef_)
        boots = np.array(boots)
        out["targets"][target] = {
            "coef": {k: round(float(v), 4) for k, v in coefs.items()},
            "ci90": {k: [round(float(np.percentile(boots[:, i], 5)), 4), round(float(np.percentile(boots[:, i], 95)), 4)]
                     for i, k in enumerate(X.columns)},
            "boot": boots[:, :5].round(4).tolist(),  # lever + interaction draws for recommendation confidence
            "boot_cols": list(X.columns[:5]),
            "r2_within": round(float(model.score(X.values, y.values)), 3),
        }

    # Formation effects: within-team residual xG / xGA by formation family, shrunk toward 0,
    # with a cluster bootstrap over teams for uncertainty.
    def _form_effects(frame):
        res = {}
        for target in ["lxg", "lxga"]:
            resid = frame[target] - frame.groupby("team_key")[target].transform("mean")
            g = pd.DataFrame({"f": frame.formation, "r": resid}).groupby("f")["r"].agg(["mean", "count"])
            res[target[1:]] = {k: float(m * c / (c + 40)) for k, (m, c) in g.iterrows()}
        return res
    d["team_key"] = d.team_id
    fe_point = _form_effects(d)
    fe = {t: {k: round(v, 4) for k, v in e.items()} for t, e in fe_point.items()}
    fe_boot = {"xg": [], "xga": []}
    for _ in range(n_boot):
        pick = rng.choice(teams, size=len(teams), replace=True)
        parts = []
        for j, t in enumerate(pick):
            part = d[d.team_id == t].copy()
            part["team_key"] = f"{t}#{j}"
            parts.append(part)
        b = _form_effects(pd.concat(parts))
        for t in ("xg", "xga"):
            fe_boot[t].append({k: round(b[t].get(k, 0.0), 4) for k in fe[t]})
    out["formation_effect_boot"] = fe_boot
    # Formation style offsets (how a formation shifts width / press / directness within team)
    style_off = {}
    for f in TACTIC_LEVERS:
        dev = d[f] - d.groupby("team_id")[f].transform("mean")
        g = pd.DataFrame({"f": d.formation, "r": dev}).groupby("f")["r"].agg(["mean", "count"])
        style_off[f] = {k: round(float(m * c / (c + 20)), 3) for k, (m, c) in g.iterrows()}
    out["formation_effect"] = fe
    out["formation_style_offset"] = style_off
    out["formation_counts"] = d.formation.value_counts().to_dict()

    # Fatigue: does a higher press shift xG-against into the last 30 minutes?
    late = d.xga_late / d.xga.clip(lower=0.05)
    press_z = (d.press_height - d.press_height.mean()) / d.press_height.std()
    slope = float(np.polyfit(press_z, late.clip(0, 1), 1)[0])
    out["fatigue"] = {"late_xga_share_mean": round(float(late.clip(0, 1).mean()), 3),
                      "late_xga_share_per_press_sd": round(slope, 4)}

    # When goals happen: xG share per 15-minute window (mean = 1.0)
    prof = np.sum(np.array(d.xg_by_15.tolist()), axis=0)
    out["minute_profile"] = (prof / prof.mean()).round(4).tolist()

    # Counter exposure vs pressing height (within team)
    cdev = np.log(d.counter_xga + 0.05) - np.log(d.counter_xga + 0.05).groupby(d.team_id).transform("mean")
    pdev = (d.press_height - d.groupby("team_id").press_height.transform("mean")) / lever_sd["press_height"]
    out["counter_press_slope"] = round(float(np.polyfit(pdev, cdev, 1)[0]), 4)

    # Venue & game state
    pl = d[d.venue != 0]
    out["home_log_effect"] = round(float(np.log(pl[pl.venue == 1].xg.mean() / pl[pl.venue == -1].xg.mean()) / 2), 4)
    return out


# ---------------------------------------------------------------- outcome model + backtest

def score_matrix(lam_a: float, lam_b: float, max_goals: int = 10) -> np.ndarray:
    ga = poisson.pmf(np.arange(max_goals + 1), lam_a)
    gb = poisson.pmf(np.arange(max_goals + 1), lam_b)
    return np.outer(ga, gb)


def wdl(m: np.ndarray) -> tuple[float, float, float]:
    return float(np.tril(m, -1).sum()), float(np.trace(m)), float(np.triu(m, 1).sum())


def draw_adjust(p: tuple, k: float) -> tuple:
    w, dr, l = p
    dr2 = min(dr * k, 0.6)
    s = (1 - dr2) / (w + l)
    return (w * s, dr2, l * s)


def backtest(df: pd.DataFrame, warmup_days: int = 45) -> dict:
    """Rolling-origin backtest on the Premier League: ratings use only earlier matches."""
    pl = df[df.competition == "Premier League 2015/16"].copy()
    home = pl[pl.venue == 1].sort_values("date")
    start = pd.to_datetime(home.date.min()) + pd.Timedelta(days=warmup_days)
    preds, train_rows = [], []
    for date, day in home.groupby("date"):
        if pd.to_datetime(date) < start:
            continue
        hist = pl[pl.date < date]
        base = hist.xg.mean()
        h_adv = math.sqrt(hist[hist.venue == 1].xg.mean() / hist[hist.venue == -1].xg.mean())
        g = hist.groupby("team_id").agg(xg=("xg", "sum"), xga=("xga", "sum"), n=("xg", "size"))
        att = (g.xg + SHRINK_MATCHES * base) / (g.n + SHRINK_MATCHES) / base
        dfn = (g.xga + SHRINK_MATCHES * base) / (g.n + SHRINK_MATCHES) / base
        for _, r in day.iterrows():
            la = base * att.get(r.team_id, 1) * dfn.get(r.opp_id, 1) * h_adv
            lb = base * att.get(r.opp_id, 1) * dfn.get(r.team_id, 1) / h_adv
            p = wdl(score_matrix(la, lb))
            res = 0 if r.gf > r.ga else (1 if r.gf == r.ga else 2)
            preds.append({"date": date, "p": p, "res": res})
    # fit draw inflation on the first half of predictions, evaluate on the second half
    half = len(preds) // 2
    best_k, best_ll = 1.0, 1e9
    for k in np.arange(0.9, 1.5, 0.02):
        ll = -np.mean([math.log(draw_adjust(x["p"], k)[x["res"]]) for x in preds[:half]])
        if ll < best_ll:
            best_k, best_ll = float(k), ll
    test = preds[half:]

    def metrics(probs, outcomes):
        P = np.array(probs)
        Y = np.eye(3)[outcomes]
        ll = float(-np.mean(np.log(P[np.arange(len(P)), outcomes])))
        brier = float(np.mean(np.sum((P - Y) ** 2, axis=1)))
        rps = float(np.mean(np.sum((np.cumsum(P, 1) - np.cumsum(Y, 1))[:, :2] ** 2, axis=1) / 2))
        acc = float(np.mean(P.argmax(1) == np.array(outcomes)))
        return {"log_loss": round(ll, 4), "brier": round(brier, 4), "rps": round(rps, 4), "accuracy": round(acc, 3)}

    outcomes = [x["res"] for x in test]
    model_p = [draw_adjust(x["p"], best_k) for x in test]
    train_out = [x["res"] for x in preds[:half]]
    freq = np.bincount(train_out, minlength=3) / len(train_out)
    base_p = [tuple(freq)] * len(test)

    # calibration: pool all three outcome probabilities
    P = np.array(model_p).ravel()
    Y = np.eye(3)[outcomes].ravel()
    bins = np.linspace(0, 1, 11)
    calib = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (P >= lo) & (P < hi)
        if m.sum() >= 8:
            calib.append({"bin": f"{lo:.1f}-{hi:.1f}", "predicted": round(float(P[m].mean()), 3),
                          "observed": round(float(Y[m].mean()), 3), "n": int(m.sum())})
    return {
        "description": "Rolling-origin backtest, Premier League 2015/16. Ratings for each matchday use only "
                       "earlier matches (xG-based, shrunk toward league average). First half of the "
                       "predictions tunes the draw adjustment; metrics are on the second half.",
        "n_test": len(test), "draw_factor": round(best_k, 3),
        "model": metrics(model_p, outcomes),
        "baseline_frequencies": metrics(base_p, outcomes),
        "calibration": calib,
    }


# ---------------------------------------------------------------- team profiles

def _norm_grid(grids: list[list[list[int]]]) -> list[list[float]]:
    g = np.sum(np.array(grids, dtype=float), axis=0)
    return (g / g.max()).round(3).tolist() if g.max() else g.tolist()


def _pass_network(spatial: list[dict], formation_raw: list[str], fam: str) -> dict:
    """Positional pass network aggregated over matches played in the team's main formation."""
    loc = defaultdict(lambda: [0.0, 0.0, 0])
    edges = Counter()
    for v, f in zip(spatial, formation_raw):
        if f != fam:
            continue
        for pos, (x, y, n) in v["pos_loc"].items():
            l = loc[pos]
            l[0] += x * n; l[1] += y * n; l[2] += n
        edges.update(v["edges"])
    nodes = [{"pos": p, "x": round(x / n, 1), "y": round(y / n, 1), "passes": n}
             for p, (x, y, n) in loc.items() if n]
    nodes.sort(key=lambda n: -n["passes"])
    nodes = nodes[:11]
    keep = {n["pos"] for n in nodes}
    e = [{"a": k.split("|")[0], "b": k.split("|")[1], "n": n} for k, n in edges.most_common()
         if k.split("|")[0] in keep and k.split("|")[1] in keep]
    return {"nodes": nodes, "edges": e[:30]}


def build_team_profiles(df: pd.DataFrame, spatial: dict, arch: dict) -> list[dict]:
    comp_base = df.groupby("competition").xg.mean().to_dict()
    style_mu = df.groupby("team_id")[STYLE_FEATURES].mean()
    profiles = []
    for tid, g in df.groupby("team_id"):
        n = len(g)
        comp = g.competition.iloc[0]
        base = comp_base[comp]
        fam = Counter(g.formation).most_common(1)[0][0]
        style = {f: float(g[f].mean()) for f in STYLE_FEATURES}
        res = Counter("W" if a > b else ("D" if a == b else "L") for a, b in zip(g.gf, g.ga))
        shots = [s for v in spatial[tid] for s in v["shot_list"]]
        shots_against_pm = float(g.shots_against.mean())
        profiles.append({
            "id": tid, "name": g.team.iloc[0], "competition": comp, "source": "statsbomb",
            "label": f"{g.team.iloc[0]} · {COMP_SHORT[comp]}",
            "matches": n, "formation": fam,
            "formations_used": dict(Counter(g.formation)),
            "record": {"W": res["W"], "D": res["D"], "L": res["L"],
                       "gf": int(g.gf.sum()), "ga": int(g.ga.sum())},
            "style": {k: round(v, 4) for k, v in style.items()},
            "extra": {
                "field_tilt": round(float(g.field_tilt.mean()), 3),
                "ppda": round(float(g.ppda.median()), 2),
                "high_recoveries_pm": round(float(g.high_recoveries.mean()), 2),
                "sp_xg_pm": round(float(g.sp_xg.mean()), 3),
                "counter_xga_pm": round(float(g.counter_xga.mean()), 3),
                "late_xga_share": round(float(g.xga_late.sum() / max(g.xga.sum(), 1e-6)), 3),
            },
            "per_match": {
                "xg": round(float(g.xg.mean()), 3), "xga": round(float(g.xga.mean()), 3),
                "shots": round(float(g.shots.mean()), 2), "shots_against": round(shots_against_pm, 2),
                "goals": round(float(g.gf.mean()), 3), "goals_against": round(float(g.ga.mean()), 3),
            },
            "rating": {
                "attack": round(float((g.xg.sum() + SHRINK_MATCHES * base) / (n + SHRINK_MATCHES) / base), 4),
                "defence": round(float((g.xga.sum() + SHRINK_MATCHES * base) / (n + SHRINK_MATCHES) / base), 4),
                "n_effective": n,
            },
            "xg_per_shot": round(float(g.xg.sum() / max(g.shots.sum(), 1)), 4),
            "archetype": assign_archetype(style, arch),
            "heat": _norm_grid([v["heat"] for v in spatial[tid]]),
            "def_heat": _norm_grid([v["def_heat"] for v in spatial[tid]]),
            "shots": shots[-250:],
            "pass_network": _pass_network(spatial[tid], [family_of(v["formation"]) for v in spatial[tid]], fam),
            "trend": [{"date": r.date, "opp": r.opp, "gf": int(r.gf), "ga": int(r.ga),
                       "xg": round(r.xg, 2), "xga": round(r.xga, 2), "possession": round(r.possession, 3),
                       "press_height": round(r.press_height, 1), "formation": r.formation}
                      for r in g.itertuples()],
        })
    # nearest stylistic neighbours
    Z = (style_mu - style_mu.mean()) / style_mu.std()
    for p in profiles:
        dist = np.linalg.norm(Z.values - Z.loc[p["id"]].values, axis=1)
        order = np.argsort(dist)[1:6]
        p["similar"] = [{"id": Z.index[i], "distance": round(float(dist[i]), 3)} for i in order]
    return profiles


def style_distribution(df: pd.DataFrame) -> dict:
    """Quantiles used to map coach 1-5 ratings and UI sliders onto pro feature scales."""
    out = {}
    for f in STYLE_FEATURES + ["field_tilt"]:
        out[f] = {f"q{int(q * 100)}": round(float(df[f].quantile(q)), 4) for q in
                  [0.05, 0.1, 0.25, 0.3, 0.5, 0.7, 0.75, 0.9, 0.95]}
        out[f]["mean"] = round(float(df[f].mean()), 4)
        out[f]["std"] = round(float(df[f].std()), 4)
    out["xg_per_shot"] = round(float(df.xg.sum() / df.shots.sum()), 4)
    out["xg_pm"] = round(float(df.xg.mean()), 4)
    return out


def formation_family_counts() -> dict:
    return {k: v for k, v in FORMATION_FAMILY.items()}
