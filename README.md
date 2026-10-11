# The Twelfth Man

**AI-powered football strategy, simulation and development platform for grassroots coaches.**

The Twelfth Man turns professional-level match analytics into a plain-language game plan that a volunteer coach can
use on a Tuesday night. Pick your next opponent and the platform tells you how hard the game is, how they play, what
to watch out for, how to set up, what each player's job is, when to make substitutions and what to train this week —
all built from a match engine trained on 495 professional matches.

It is educational and coaching-oriented. **No betting, odds or gambling outputs.**

---

## What's inside

**For coaches (plain football language, no statistics)**
- **Season** — fixtures, the league table and scouting notes for every opponent; the app always opens on your next game.
- **Game Plan** — difficulty of the game, how the opponent plays, what to watch out for, numbered team instructions,
  where to attack and protect, substitution timing for your match length, and three ways to play it compared in words.
- **Team Sheet** — a printable page for players: names on the pitch, how we play, each position's job, subs.
- **Training** — a full week built backwards from match day: recovery, fixing weaknesses, technique, the game plan and a
  light session the day before. Adapts to age group (shorter "skills & fun" sessions for young players), match format
  (4v4 / 6v6 / 8v8 games) and formation, using a library of 37 drills with diagrams.
- **Ask Coach Twelve** — the in-house AI coach: ask anything about the next game ("what if we play 3-5-2?",
  "we're 1-0 down at half-time", "what are we doing on Thursday?") and get an answer grounded in your data.
- **Results & Squad / My Club** — enter results after each game, manage the squad and set the club profile
  (location, league, match rules, training days).

**For analysts**
- Opponent analysis (heatmaps, pass networks, style comparison), the Tactics Lab (10,000-match simulations with
  uncertainty bands), recommendations, a full match report, season trends, a style map of 76 professional
  team-seasons and a *How it works* page with the backtest and every assumption.

**Professional teams** — every Premier League 2015/16, Euro 2024 and World Cup 2022 team is available. Play your
team against them, or simulate two professional teams against each other and see their real past meetings.

Visitors land straight in a private demo club — no sign-up needed. Coaches can create a free account to save their own team.

---

## Quick start

Requires Python 3.11+ (tested on 3.13). No Node needed, and no internet once the data is built.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_data.py      # one-off: downloads StatsBomb open data (~1 min, needs internet)
.venv/bin/python scripts/build_models.py    # builds features, archetypes, effect models and the backtest (~10 s)
.venv/bin/python run.py                     # opens http://127.0.0.1:8012
```

The processed model files are included in the repository, so the first two steps are only needed to rebuild them.

### Optional: Coach Twelve

Ask Coach Twelve uses the Anthropic API. Create a `.env` file in the project folder:

```
ANTHROPIC_API_KEY=your-api-key
TWELFTH_MAN_MODEL=model-id-from-your-anthropic-console
```

Without these, everything still works: Coach Twelve runs in offline mode and answers common questions straight from
the game plan. It is the only feature that uses the API; game plans, recommendations and reports are always free.

### Deploy online

The repository includes a `render.yaml` for [Render](https://render.com): create a free account, choose
**New → Blueprint**, pick this repository and enter `ANTHROPIC_API_KEY` and `TWELFTH_MAN_MODEL` when asked.
Coach Twelve is protected on a public site by a per-visitor daily limit (`TWELFTH_MAN_ASK_PER_DAY`, default 8) and a
daily budget for the whole site (`TWELFTH_MAN_DAILY_BUDGET`, default $1.00); after that it answers from the game plan.
On the free plan the site sleeps when idle (the first visit then takes about a minute) and club data is reset when
the service restarts; the demo club is recreated for every visitor.

---

## Demo script (3–5 minutes)

1. **Game Plan** — the demo club (Riverside FC U18) vs its next opponent. Read the verdict, how they play, what to
   watch out for and the numbered instructions with the attack/protect pitch.
2. **Other ways to play it** — compare the three options in plain words and click **Use this plan**.
3. **Team Sheet** and **Training** — the printable sheet for players and the week of sessions leading to Saturday.
4. **Try it against the pros** — Riverside vs Spain: *"Very, very difficult"*. Then Arsenal vs Leicester with their
   two real 2015/16 meetings.
5. **Ask Coach Twelve** — "What if we switch to 3-5-2?" (it tests the idea with the match engine before answering).
6. **Analyst tools** — the Tactics Lab simulation and *How it works* (backtest log-loss 1.00 vs 1.08 baseline).

---

## How it works

```
StatsBomb open events (495 matches: PL 2015/16, Euro 2024, WC 2022)
   └─ per-match team features: possession, pass completion, press height, directness, width, PPDA, field tilt,
      xG / xGA, set-piece and counter xG, heatmaps, positional pass networks        (backend/app/etl/statsbomb.py)
   └─ K-means style archetypes, xG-based attack/defence ratings shrunk toward the league average
   └─ Poisson outcome model with a fitted draw adjustment and a rolling-origin backtest
   └─ within-team ridge regressions: tactic levers → xG / xGA, with matchup interactions and
      cluster-bootstrap intervals; formation effects shrunk and bootstrapped        (backend/app/analytics.py)
Club data (results, league table, scouting) → the same feature space, rated relative to the club's own league
   └─ match engine: minute-by-minute Monte Carlo (fatigue for both teams, subs, game state, weather, uncertainty),
      a playing-level gap between grassroots and professional football, head-to-heads,
      recommendations ranked by a cautious (10th-percentile) expected-points gain     (backend/app/engine.py)
   └─ coach mode: plain-language plans, team sheets and weekly training             (backend/app/coach.py)
   └─ Coach Twelve: answers from the plan and records, tests ideas with the engine   (backend/app/assistant.py)
```

**Honesty measures** (see *How it works* in the app):
- Observational tactic effects are confounded by game state, so the engine halves them and adds an adaptation cost for
  big changes from a team's usual style or an unfamiliar formation.
- Recommendations must stay positive at the 10th percentile of the bootstrap distribution.
- Fatigue, substitution, game-state, weather and playing-level effects are coaching assumptions, not fitted from data;
  they are listed on the *How it works* page.
- Coach Twelve is told to use only the numbers the models produce and never to invent statistics.

## Project layout

```
backend/app/
  etl/statsbomb.py     download and summarise StatsBomb matches
  analytics.py         features, archetypes, effect models, backtest, team profiles
  engine.py            simulation, recommendations, matchup analysis, club and opponent profiles
  coach.py             plain-language game plans, team sheets and weekly training
  assistant.py         Coach Twelve question answering and tools
  accounts.py          accounts, demo sessions, club profiles, fixtures, opponents, league tables
  store.py             SQLite storage and CSV validation for club match data
  client.py, usage.py  Anthropic API connection and cost logging
  main.py              FastAPI app (API under /api, web app at /)
  content/drills.json  drill library (37 drills with diagrams)
frontend/              no-build web app (vanilla JavaScript ES modules, hand-drawn SVG charts)
scripts/               fetch_data.py, build_models.py, jscheck.sh (JavaScript syntax check without Node)
sample_data/           demo club results and league table (also a template for coaches)
data/                  processed/ (model and team files); local.db holds club data and stays on your machine
```

## Club data format

Download the template from **Results & Squad → Template CSV**. Required columns:
`date, opponent, formation, goals_for, goals_against, shots_for, shots_against`.
Optional columns that improve the estimates: `venue, sot_for, sot_against, possession, passes_attempted,
passes_completed, press_rating, directness_rating, width_rating (1–5), corners_for, late_goals_against, notes`.

League tables can be pasted straight from a league website: one team per line with position, name, played, won,
drawn, lost, goals for and goals against.

## Roadmap

- **Player development:** similarity to professional players, role-fit scores and workload guidance.
- **Data import:** pull fixtures and league tables directly from league websites (with their permission).
- **Stretch:** an in-game coach that adapts to the score, and team shape from training video.

Data: [StatsBomb Open Data](https://github.com/statsbomb/open-data), used under its open-data licence terms.
