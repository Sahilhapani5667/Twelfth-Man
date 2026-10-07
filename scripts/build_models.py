"""Step 2: build features, archetypes, effect models and the backtest.

    .venv/bin/python scripts/build_models.py
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import analytics as A  # noqa: E402

if __name__ == "__main__":
    t0 = time.time()
    out = ROOT / "data" / "processed"
    out.mkdir(parents=True, exist_ok=True)

    df, spatial = A.load_rows(ROOT / "data" / "cache")
    print(f"Loaded {len(df)} team-match rows from {df.match_id.nunique()} matches")

    arch = A.fit_archetypes(df)
    for c in arch["clusters"]:
        print(f"  archetype {c['id']}: {c['name']:<45} share={c['share']:.2f}")

    effects = A.fit_effects(df)
    for t, e in effects["targets"].items():
        print(f"  effects on {t}: {e['coef']}")
    print(f"  formation effects: {effects['formation_effect']}")
    print(f"  fatigue: {effects['fatigue']}  home: {effects['home_log_effect']}")

    bt = A.backtest(df)
    print(f"  backtest n={bt['n_test']} model={bt['model']} baseline={bt['baseline_frequencies']} draw_k={bt['draw_factor']}")

    profiles = A.build_team_profiles(df, spatial, arch)
    model = {
        "built_at": time.strftime("%Y-%m-%d %H:%M"),
        "data": {"source": "StatsBomb Open Data (https://github.com/statsbomb/open-data)",
                 "competitions": sorted(df.competition.unique().tolist()),
                 "matches": int(df.match_id.nunique()), "team_seasons": len(profiles)},
        "competition_base_xg": df.groupby("competition").xg.mean().round(4).to_dict(),
        "archetypes": arch,
        "effects": effects,
        "distribution": A.style_distribution(df),
        "backtest": bt,
    }
    # every match, for head-to-head lookups between pro teams
    matches = []
    for mid, g in df.groupby("match_id"):
        a, b = g.iloc[0], g.iloc[1]
        matches.append({"date": a.date, "competition": a.competition, "a": a.team_id, "b": b.team_id,
                        "a_goals": int(a.gf), "b_goals": int(b.gf), "a_xg": round(float(a.xg), 2), "b_xg": round(float(b.xg), 2),
                        "home": a.team_id if a.venue == 1 else (b.team_id if b.venue == 1 else None)})
    model["matches"] = sorted(matches, key=lambda m: m["date"])
    (out / "model.json").write_text(json.dumps(model, indent=1))
    (out / "teams.json").write_text(json.dumps(profiles))
    print(f"Wrote {len(profiles)} team profiles in {time.time() - t0:.1f}s")
