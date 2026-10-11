# The Twelfth Man

**AI-powered football strategy, simulation and development platform for grassroots coaches.**

The Twelfth Man turns pro-level analytics into explainable, practical guidance for local clubs. Load your
team's basic match stats, pick an opponent, and the platform:

- **profiles both teams**: tactical archetype, attack/defence ratings, style comparison, scouting heatmaps and pass networks;
- **simulates the match**: a minute-by-minute Monte Carlo with fatigue, substitutions, game state and parameter uncertainty, reported as distributions rather than single predictions;
- **recommends tactical changes**: formation, press height, tempo and width, ranked by a cautious estimate of their benefit, each with key drivers, a confidence level, a "why it helps" note and a drill pack;
- **exports a match plan**: a printable PDF with lineup, key messages, substitution plan and a training session;
- **tracks development**: trends over the season, plus a style map placing your club among 76 pro team-seasons.

Coaches see plain football language only. The statistics stay under the hood, in the optional *Analyst tools*.
It is educational and coaching-oriented. **No betting, odds or gambling outputs.**

---

## Quick start

Requires Python 3.11+ (tested on 3.13). No Node or internet needed once the data is built.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_data.py      # one-off: downloads StatsBomb open data (~1 min, needs internet)
.venv/bin/python scripts/build_models.py    # builds features, archetypes, effect models, backtest (~10 s)
.venv/bin/python run.py                     # opens http://127.0.0.1:8012
```

On first launch, two demo grassroots clubs (Riverside FC and Northgate Athletic, both U18) are loaded from `sample_data/`.

### Optional: AI-written coaching notes

Set an Anthropic API key and the recommendations and match plans gain plain-language coaching notes written by
a large language model. The AI receives only the model's numbers and is told never to invent statistics.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
.venv/bin/python run.py
```

Without a key, everything still works and the notes come from built-in templates. The sidebar shows which mode is active.

---

## Fair demo script (3–5 minutes)

**Coach mode (what a grassroots coach uses every week, no statistics):**
1. **Game Plan**: pick *Riverside FC* (local data) vs *Leicester City 2015/16*. Read out the verdict ("Even game"),
   how they play, what to watch out for, and *our plan* as numbered instructions with the attack/protect pitch.
2. **Other ways to play it**: compare the options in plain words ("✓ Creates more chances", "! More tiring")
   and click **Use this plan**.
3. **Team Sheet**: print the one-page sheet for players (names on the pitch, team instructions, each position's job, subs).
4. **Training**: this week's focus areas and three drills with diagrams.
5. **My Team**: add last weekend's result in under a minute; the plan updates.

**Analyst tools (for judges who want the maths):** the Tactics Lab Monte Carlo with distributions, opponent heatmaps and
pass networks, the style map, and *How it works* (backtest log-loss 1.00 vs 1.08 baseline, calibration, effect sizes).

---

## How it works

```
StatsBomb open events (495 matches: PL 2015/16, Euro 2024, WC 2022)
   └─ per-match team features: possession, pass completion, press height, directness, width, PPDA, field tilt,
      xG/xGA, set-piece & counter xG, heatmaps, positional pass networks          (backend/app/etl/statsbomb.py)
   └─ K-means archetypes (5) on standardised style features, named by prototype matching
   └─ xG-based attack/defence ratings, shrunk toward league average
   └─ Poisson outcome model + fitted draw adjustment, rolling-origin backtest
   └─ within-team (fixed-effects) ridge regressions: tactic levers → xG / xGA, with matchup interactions,
      cluster-bootstrap 90% intervals; formation effects shrunk + bootstrapped     (backend/app/analytics.py)
Your club's CSV / form input → same feature space (ratings relative to your own league, xG estimated from shots)
   └─ engine: minute-by-minute Monte Carlo (fatigue, subs, game state, weather priors, parameter uncertainty);
      recommendation search over formation × press × tempo × width, ranked by 10th-percentile xPts gain   (backend/app/engine.py)
   └─ the AI (optional) writes coaching notes from the numbers only                 (backend/app/explain.py)
```

**Honesty measures** (see the Model Card page):
- Observational tactic effects are confounded by game state (teams that are on top defend higher, for example), so the engine **halves** them and adds an **adaptation cost** for big changes from a team's identity or an unfamiliar formation.
- Recommendations must stay positive at the **10th percentile** of the bootstrap distribution, and each one is driven by a different lever.
- Fatigue, substitution, game-state and weather effects are **coaching priors**, not fitted from data; they are listed in `engine.PRIORS`.

## Project layout

```
backend/app/
  etl/statsbomb.py   download + summarise StatsBomb matches
  analytics.py       features, archetypes, effect models, backtest, team profiles
  formations.py      formation families and slot layouts
  engine.py          simulation, recommendations, matchup analysis, local-team profiles
  store.py           SQLite storage + CSV validation for local club data
  explain.py         AI explanations (with template fallback)
  main.py            FastAPI app (API under /api, web app at /)
  content/drills.json  drill library (23 drills with diagrams)
frontend/            no-build ES-module web app (vanilla JS + hand-drawn SVG charts)
scripts/             fetch_data.py, build_models.py, jscheck.sh (JS syntax check without Node)
sample_data/         demo club CSVs (also a template for coaches)
data/                cache/ (match summaries), processed/ (model + team JSON), local.db (your club data)
```

## Club data format

Download the template from **Club Data → Template CSV**. Required columns: `date, opponent, formation, goals_for, goals_against, shots_for, shots_against`.
Optional columns that improve the estimates: `venue, sot_for, sot_against, possession, passes_attempted, passes_completed,
press_rating, directness_rating, width_rating (1–5), corners_for, late_goals_against, notes`.
Local data is stored only on this computer, in `data/local.db`.

## Roadmap

- **Phase 4:** team development: longer-term progression dashboards and session planning.
- **Phase 5:** player development: similarity to pro players, role-fit scores, workload guidance.
- **Stretch:** reinforcement-learning in-game coach; computer vision for team shape from training video.

Data: [StatsBomb Open Data](https://github.com/statsbomb/open-data), used under its open-data licence terms.
