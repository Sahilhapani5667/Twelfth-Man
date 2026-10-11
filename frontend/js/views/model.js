import { state, api } from "../state.js";
import { h, C, ARCH_COLORS, ARCH_SHAPES, shapeIcon, pct, signedPct, calibration, forest, columns , more } from "../charts.js";

// ---------------------------------------------------------------- constants
const LEVER_ROWS = [
  ["press_height", "Press height (+1 SD)"],
  ["directness", "Directness (+1 SD)"],
  ["width", "Width (+1 SD)"],
  ["press_x_opp_passing", "Pressing × opponent passing quality"],
  ["direct_x_opp_press", "Directness × opponent press height"],
];
const STYLE_LABELS = { possession: "Possession", pass_comp: "Pass completion", press_height: "Press height", directness: "Directness", width: "Width" };
const MINUTE_BINS = ["0–15", "15–30", "30–45", "45–60", "60–75", "75–90+"];
const METRICS = [
  { key: "log_loss", label: "Log-loss", lower: true, hint: "Punishes confident wrong calls" },
  { key: "brier", label: "Brier score", lower: true, hint: "Squared error across win / draw / loss" },
  { key: "rps", label: "Ranked probability score", lower: true, hint: "Respects the win > draw > loss order" },
  { key: "accuracy", label: "Accuracy", lower: false, hint: "Most likely outcome matched the result" },
];

const logPct = (v, d = 1) => signedPct(Math.exp(v) - 1, d);
const absPct = (v) => `${Math.round(Math.abs(v) * 100)}%`;

// Plain-language reading of each coaching prior. Functions take the live value so the text
// stays in step with backend/app/engine.py PRIORS.
const PRIOR_TEXT = {
  fatigue_xga_per_press_sd: ["Pressing fatigue · chances conceded", (v) =>
    `Extra xG conceded per unit of pressing load (press height above the pro average, in SD, growing faster at extreme intensity). It builds from 60' to 90': about +${absPct(v)} on average over the last half hour per unit. Zero for an average or deeper press.`],
  fatigue_xg_per_press_sd: ["Pressing fatigue · chances created", (v) =>
    `Own xG lost the same way: about −${absPct(v)} on average over the last half hour per unit of pressing load.`],
  sub_relief: ["Substitution relief", (v) => `Each substitution made by 80' removes ${absPct(v)} of the fatigue penalty from that minute on.`],
  sub_relief_max: ["Relief cap", (v) => `Substitutions can remove at most ${absPct(v)} of the fatigue penalty.`],
  attacking_sub: ["Attacking substitution", (v) => `After an attacking change: about ${signedPct(v[0])} chances created and ${signedPct(v[1])} chances conceded (xG, xGA).`],
  defensive_sub: ["Defensive substitution", (v) => `After a defensive change: about ${signedPct(v[0])} chances created and ${signedPct(v[1])} chances conceded (xG, xGA).`],
  leading_mult: ["Game state · leading", (v) => `A team that is ahead creates chances at ${v}× its normal rate (it sits deeper).`],
  trailing_mult: ["Game state · trailing", (v) => `A team that is behind creates chances at ${v}× its normal rate (it pushes on).`],
  rain: ["Heavy rain", (v) => `Each team's xG about ${signedPct(v.both)}; teams with above-average pass completion lose a further ${absPct(v.pass_comp_z)} per SD.`],
  wind: ["Strong wind", (v) => `Each team's xG about ${signedPct(v.both)}. ${v.directness_z ? `Directness adjustment ${v.directness_z} per SD.` : "No style-specific effect yet (the directness term is 0)."}`],
  heat_fatigue_mult: ["Hot day", (v) => `Pressing load, and so fatigue, is multiplied by ${v}.`],
  back_three_vs_two_strikers_xga: ["Back three vs two strikers", (v) => `About ${signedPct(v)} chances conceded: a spare centre-back covers the two strikers.`],
  back_three_vs_lone_striker_xg: ["Back three vs a lone striker", (v) => `About ${signedPct(v)} chances created: the spare centre-back is one fewer player further forward.`],
  three_mids_vs_442_xg: ["Three central midfielders vs 4-4-2", (v) => `About ${signedPct(v)} chances created from the central overload.`],
  max_tactic_mult: ["Cap on tactic effects", (v) => `The combined tactic multiplier on either side's xG is held between ×${v[0]} and ×${v[1]}, so extreme settings cannot extrapolate.`],
  causal_discount: ["Causal discount", (v) => `Fitted press, directness and width effects (and their interactions) are multiplied by ${v} before use, because score-driven changes in style inflate observational estimates.`],
  adaptation_per_sd: ["Adaptation cost", (v) => `For each lever moved more than 1 within-team SD from the team's usual style, every extra SD costs about ${absPct(v)} of chances created and adds ${absPct(v)} to chances conceded.`],
  unfamiliar_formation: ["Unfamiliar formation", (v) => `A formation the team has not used in its data adds a further ${absPct(v)} cost on both sides.`],
};

function priorValue(v) {
  if (Array.isArray(v)) return v.map(String).join(" / ");
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(" · ");
  return String(v);
}

function priorText(key, v) {
  const entry = PRIOR_TEXT[key];
  if (!entry) return [key, "Coaching assumption used by the simulator (see engine.py)."];
  try { return [entry[0], entry[1](v)]; } catch { return [entry[0], "Coaching assumption used by the simulator."]; }
}

// forest() reserves a fixed left margin for labels; widen the viewBox so the longer
// interaction labels are never clipped.
function widenLeft(svg, extra = 32) {
  const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    vb[0] -= extra; vb[2] += extra;
    svg.setAttribute("viewBox", vb.join(" "));
  }
  return svg;
}

// ---------------------------------------------------------------- small builders
const tileKV = (label, value, delta) => h("div", { class: "tile" }, [
  h("span", { class: "label" }, label),
  h("span", { class: "value num", style: { fontSize: "18px" } }, value),
  delta ? h("span", { class: "delta" }, delta) : null,
]);

const table = (head, rows) => h("div", { class: "table-wrap" }, h("table", {}, [
  h("thead", {}, h("tr", {}, head.map((c) => h("th", { scope: "col" }, c)))),
  h("tbody", {}, rows),
]));

const statusPill = (status) => h("span", { class: "pill" }, [
  h("span", { class: "dot", style: { background: status.enabled ? C.good : C.muted } }),
  status.enabled ? "Coach Twelve (AI coach) is on" : "Built-in explanations",
]);

function step(i, title, tag, body, extra) {
  return h("li", {
    style: { display: "flex", gap: "12px", alignItems: "flex-start", padding: "10px 0", borderTop: i ? "1px solid var(--hairline)" : "0" },
  }, [
    h("span", { class: "rec-num", "aria-hidden": "true" }, String(i + 1)),
    h("div", { class: "stack", style: { gap: "4px", flex: "1 1 0", minWidth: "0" } }, [
      h("div", { class: "row", style: { gap: "8px" } }, [h("strong", {}, title), h("span", { class: "tag" }, tag)]),
      h("p", { class: "secondary", style: { fontSize: "13px" } }, body),
      extra || null,
    ]),
  ]);
}

// ---------------------------------------------------------------- sections
function howItWorks(card, status) {
  const d = card.data || {};
  const comps = d.competitions || [];
  const nArch = (card.archetypes || []).length || 5;
  const home = card.home_log_effect || 0;
  const drawK = card.draw_factor ?? card.backtest?.draw_factor;
  const steps = [
    ["Open match data", "Open data",
      `StatsBomb open event data: ${d.matches} matches from ${comps.join(", ")} — every pass, pressure, tackle and shot with pitch coordinates.`],
    ["Per-match team features", "Computed",
      "For each team in each match: possession (share of passes), pass completion, press height (average height of defensive actions), directness (forward progress ÷ total pass distance), width (average distance from the centre line of passes in the attacking half), xG and xG against (StatsBomb shot model), PPDA and field tilt. The first five are the style features; PPDA and field tilt are profile stats."],
    ["Style archetypes", "Fitted",
      `K-means with ${nArch} clusters on the five standardised style features across all ${d.matches ? d.matches * 2 : ""} pro team-matches. Each cluster is named after the closest hand-written style prototype, and every team gets a soft fit to each archetype from its average style.`],
    ["Attack and defence ratings", "Fitted",
      "Attack = xG created per match and defence = xG conceded per match, both relative to the competition average and shrunk toward average by adding 4 matches of average performance. Grassroots teams are rated the same way against the average of the local data entered."],
    ["Outcome model", "Fitted · backtested",
      `Each side's goals follow a Poisson distribution whose mean is league base × own attack × opponent defence × home advantage (about ${logPct(home, 0)} xG at home, ${logPct(-home, 0)} away) × tactic effects. The draw probability is scaled by ×${drawK != null ? Number(drawK).toFixed(2) : "—"} — a factor fitted in the backtest — and win/loss are rescaled to match.`],
    ["Tactic effects", "Fitted · bootstrapped",
      "Within-team (fixed-effects) ridge regressions of log xG and log xG against on each match's deviation from the team's own average press height, directness and width, plus two matchup interactions, opponent strength and venue. 300 cluster-bootstrap resamples of whole teams give the 90% intervals."],
    ["Minute-by-minute Monte Carlo", "Simulation + priors",
      "Each run is split into 40 groups. Every group draws its own team ratings (more spread for teams with fewer matches) and one bootstrap set of effect coefficients, then plays 90 one-minute steps using the pro goal-timing profile, game state, pressing fatigue, substitutions and weather. The last four are coaching priors, listed below."],
    ["Recommendations", "Search + uncertainty",
      "Single and paired changes to press, tempo, width and formation are scored on expected points. The 40 most promising are re-scored under 120 bootstrap draws of the effect model and ranked by their pessimistic (10th-percentile) gain. A change is shown only if that cautious gain is above zero, and each option is led by a different lever."],
    ["Plain-language plans", "Built-in",
      "Game plans, recommendations and match reports turn the numbers above into coaching language with built-in wording rules. Ask Coach Twelve, our in-house AI coach, answers free-form questions from the same numbers and tests “what if” ideas with the match engine.",
      h("div", { class: "row", style: { gap: "8px" } }, [statusPill(status), h("span", { class: "sub" }, status.reason || "")])],
  ];
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "How it works"), h("span", { class: "sub" }, "from open data to a coaching note")]),
    h("div", { class: "tiles" }, [
      tileKV("Pro matches", String(d.matches ?? "—")),
      tileKV("Pro team-seasons", String(d.team_seasons ?? "—")),
      tileKV("Competitions", String(comps.length), comps.join(" · ")),
      tileKV("Style archetypes", String(nArch)),
    ]),
    d.source ? h("p", { class: "sub", style: { marginTop: "8px" } }, `Source: ${d.source}`) : null,
    h("ol", { style: { listStyle: "none", padding: "0", margin: "12px 0 0" } }, steps.map((s, i) => step(i, s[0], s[1], s[2], s[3]))),
  ]);
}

function backtestCards(bt) {
  if (!bt || !bt.model) return [h("div", { class: "card empty" }, "No backtest results in this build.")];
  const m = bt.model, b = bt.baseline_frequencies || {};
  const fmt = (met, v) => (v == null ? "—" : met.lower ? v.toFixed(3) : pct(v, 1));
  const rows = METRICS.map((met) => {
    const mv = m[met.key], bv = b[met.key];
    let cell = h("td", {}, "—");
    if (mv != null && bv) {
      const rel = met.lower ? (bv - mv) / bv : (mv - bv) / bv;
      cell = h("td", { class: rel > 0 ? "up-good" : rel < 0 ? "down-bad" : "" }, `${Math.abs(rel * 100).toFixed(1)}% ${rel >= 0 ? "better" : "worse"}`);
    }
    return h("tr", {}, [
      h("td", {}, [h("div", {}, met.label), h("div", { class: "sub" }, `${met.hint} · ${met.lower ? "lower" : "higher"} is better`)]),
      h("td", { class: "num" }, fmt(met, mv)),
      h("td", { class: "num" }, fmt(met, bv)),
      cell,
    ]);
  });

  const tableCard = h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Backtest"), h("span", { class: "sub" }, "outcome model vs a no-skill baseline")]),
    h("div", { class: "tiles" }, [
      tileKV("Test matches", String(bt.n_test ?? "—")),
      tileKV("Draw adjustment", bt.draw_factor != null ? `×${Number(bt.draw_factor).toFixed(2)}` : "—", "fitted on the earlier half"),
    ]),
    table(["Metric", "Model", "Baseline", "Relative improvement"], rows),
    h("p", { class: "chart-note" }, bt.description || ""),
    h("p", { class: "chart-note" }, "Baseline = always predict the home-win / draw / away-win frequencies seen in the earlier half of the season. Only one season is tested, so treat the size of the gain as approximate."),
  ]);

  const pts = bt.calibration || [];
  const calCard = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Calibration"), h("span", { class: "sub" }, "do 30% calls happen about 30% of the time?")]),
    h("div", { class: "legend" }, [
      h("span", {}, [h("span", { class: "key-line", style: { background: C.us } }), "Model (dot size = outcomes in bin)"]),
      h("span", {}, [h("span", { class: "key-line", style: { background: "none", borderTop: `2px dashed ${C.muted}`, height: "0" } }), "Perfect calibration"]),
    ]),
    pts.length
      ? h("div", { style: { maxWidth: "480px", margin: "0 auto" } }, calibration(pts))
      : h("div", { class: "empty" }, "Not enough test outcomes to draw a calibration curve."),
    h("p", { class: "chart-note" }, "Every win, draw and loss probability from the test matches is pooled into 10-point bins (bins with fewer than 8 outcomes are dropped). The y-axis is how often those outcomes actually happened. The dashed diagonal is perfect calibration; points above it mean the model was too cautious, points below it too confident. Small bins are noisy."),
  ]);
  return [tableCard, calCard];
}

function effectsCard(card) {
  const eff = card.effects || {};
  const sd = card.lever_sd || {};
  const k = card.priors?.causal_discount ?? 0.5;
  const rowsFor = (t) => LEVER_ROWS.filter(([key]) => eff[t]?.coef?.[key] != null).map(([key, label]) => {
    const ci = eff[t].ci90?.[key] || [eff[t].coef[key], eff[t].coef[key]];
    return { label, est: eff[t].coef[key], lo: ci[0], hi: ci[1] };
  });
  const xgRows = rowsFor("xg"), xgaRows = rowsFor("xga");

  const forestBlock = (title, rows, note) => h("div", { class: "stack", style: { gap: "6px", minWidth: "0", maxWidth: "760px" } }, [
    h("h4", {}, title),
    rows.length ? widenLeft(forest(rows)) : h("div", { class: "empty" }, "No estimates available."),
    h("p", { class: "chart-note" }, note),
  ]);

  const ivl = (t, key) => {
    const c = eff[t]?.coef?.[key];
    if (c == null) return h("td", {}, "—");
    const ci = eff[t].ci90?.[key];
    return h("td", { class: "num" }, [h("div", {}, logPct(c)), ci ? h("div", { class: "sub" }, `${logPct(ci[0])} to ${logPct(ci[1])}`) : null]);
  };
  const used = (key) => {
    const a = eff.xg?.coef?.[key], b = eff.xga?.coef?.[key];
    return h("td", { class: "num" }, [
      h("div", {}, `xG ${a == null ? "—" : logPct(k * a)}`),
      h("div", {}, `xGA ${b == null ? "—" : logPct(k * b)}`),
    ]);
  };
  const tableRows = LEVER_ROWS.map(([key, label]) => h("tr", {}, [h("td", {}, label), ivl("xg", key), ivl("xga", key), used(key)]));

  const r2 = (t) => (eff[t]?.r2_within != null ? pct(eff[t].r2_within) : "—");

  return h("div", { class: "card stack", style: { gap: "14px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Tactic effects"), h("span", { class: "sub" }, "within-team estimates from pro data · 90% intervals")]),
    h("p", { class: "secondary", style: { fontSize: "13px", maxWidth: "860px" } },
      "Each effect is the change in a team's xG (or xG against) when it plays one within-team standard deviation (SD) of a lever away from its own average. “Within-team” means every match is compared with the same team's average in that season or tournament, so differences in squad quality between clubs cannot pose as tactic effects. Opponent strength and venue are controlled for."),
    h("div", { class: "tiles" }, [
      tileKV("Press height · 1 SD", sd.press_height != null ? `≈${sd.press_height.toFixed(1)} m` : "—", "higher average position of defensive actions"),
      tileKV("Directness · 1 SD", sd.directness != null ? `+${sd.directness.toFixed(3)}` : "—",
        `in forward progress ÷ pass distance${sd.directness != null ? ` (e.g. 0.50 → ${(0.5 + sd.directness).toFixed(2)})` : ""}`),
      tileKV("Width · 1 SD", sd.width != null ? `≈${sd.width.toFixed(1)} m` : "—", "further from the centre line, passes in the attacking half"),
    ]),
    h("p", { class: "chart-note", style: { marginTop: "0" } }, "Pitch positions use StatsBomb's 120 × 80 grid, so one unit is about a metre on a 120 m pitch (about 0.9 m on a typical 105 m pitch)."),
    h("div", { class: "legend", style: { marginBottom: "0" } }, [
      h("span", {}, [h("span", { class: "dot", style: { background: C.us } }), "90% interval excludes zero"]),
      h("span", {}, [h("span", { class: "dot", style: { background: C.muted } }), "Interval includes zero (uncertain)"]),
    ]),
    h("div", { class: "stack", style: { gap: "18px" } }, [
      forestBlock("Effect on xG for", xgRows, "Positive = more chances created. Interactions: the extra effect of +1 SD of the lever for every 1 SD the opponent's season pass completion (or press height) is above the pro average."),
      forestBlock("Effect on xG against", xgaRows, "Negative = fewer chances conceded. Estimates shown before the causal discount; hover a dot for its interval."),
    ]),
    h("div", {}, [
      table(["Lever (per +1 SD)", "xG for", "xG against", `Used in simulations (×${k})`], tableRows),
      h("p", { class: "chart-note" }, "Each cell shows the estimate with its 90% interval beneath. The last column is the halved effect the simulator actually applies."),
    ]),
    h("div", { class: "stack", style: { gap: "4px" } }, [
      h("p", { class: "chart-note" }, `The engine multiplies every lever effect by ${k} (causal_discount in the priors) before using it: teams change style with the score — leaders drop deeper, chasers push up — and that game-state confounding inflates estimates from observational data. Slider moves are converted to within-team SDs and saturate beyond about ±2 SD; the total tactic multiplier is capped (see priors).`),
      h("p", { class: "chart-note" }, `These levers explain only part of the match-to-match variation: within-team R² is ${r2("xg")} for xG and ${r2("xga")} for xG against. Most of a single match is still down to quality, chance and things this model does not see.`),
    ]),
  ]);
}

function formationCard(card) {
  const fe = card.formation_effect || {};
  const counts = card.formation_counts || {};
  const names = [...new Set([...Object.keys(counts), ...Object.keys(fe.xg || {}), ...Object.keys(fe.xga || {})])]
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  const vals = names.flatMap((f) => [fe.xg?.[f], fe.xga?.[f]]).filter((v) => v != null);
  const largest = vals.length ? Math.max(...vals.map((v) => Math.abs(Math.exp(v) - 1))) : 0;
  const cell = (v) => h("td", { class: "num" }, v == null ? "—" : logPct(v));
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Formation effects"), h("span", { class: "sub" }, "within-team, shrunk toward zero")]),
    names.length
      ? table(["Formation", "Team-matches", "xG for", "xG against"], names.map((f) => h("tr", {}, [
        h("td", {}, f), h("td", { class: "num" }, String(counts[f] ?? "—")), cell(fe.xg?.[f]), cell(fe.xga?.[f]),
      ])))
      : h("div", { class: "empty" }, "No formation estimates in this build."),
    h("p", { class: "chart-note" }, `Average difference in a team's xG and xG against when it lined up in that formation family, compared with its own average. Each estimate is shrunk toward zero by weight matches ÷ (matches + 40), so rare shapes say little. All are small (largest ${pct(largest, 1)}): how a shape is played matters more than the shape itself. The engine adds a few matchup priors on top (e.g. back three vs two strikers) and an adaptation cost for formations a team has not used.`),
  ]);
}

function minuteCard(card) {
  const prof = card.minute_profile || [];
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "When goals happen"), h("span", { class: "sub" }, "chance (xG) rate by 15-minute window")]),
    prof.length === MINUTE_BINS.length
      ? columns(MINUTE_BINS, [{ name: "Chance rate", color: C.us, values: prof }], {
        fmt: (v) => `${v.toFixed(2)}×`, yfmt: (v) => `${v.toFixed(1)}×`, valueLabel: "vs an average window",
      })
      : h("div", { class: "empty" }, "No timing profile in this build."),
    h("p", { class: "chart-note" }, `Share of all xG created in each window across the ${card.data?.matches ?? ""} pro matches, scaled so the average window = 1.0×. Added time counts in the following window (first-half stoppage in 45–60, second-half stoppage in 75–90+), which partly explains the late peak. The simulator uses this shape to time goals.`),
  ]);
}

function priorsCard(priors) {
  const rows = Object.entries(priors || {}).map(([key, v]) => {
    const [name, text] = priorText(key, v);
    return h("tr", {}, [
      h("td", {}, [h("div", {}, name), h("code", { class: "sub" }, key)]),
      h("td", { class: "num", style: { whiteSpace: "nowrap" } }, priorValue(v)),
      h("td", { class: "secondary", style: { minWidth: "260px" } }, text),
    ]);
  });
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("h3", {}, "Coaching priors"),
      h("span", { class: "pill" }, [h("span", { class: "dot", style: { background: C.warning } }), "Not fitted from data"]),
    ]),
    h("p", { class: "secondary", style: { fontSize: "13px" } }, "Not fitted from data — expert assumptions, editable in backend/app/engine.py PRIORS. They cover what open event data cannot measure well: fatigue, substitutions, game state, weather and a few formation matchups. Values are multipliers or log-scale shifts (0.05 ≈ +5%)."),
    rows.length ? table(["Assumption", "Value", "What it means"], rows) : h("div", { class: "empty" }, "No priors reported."),
  ]);
}

function archetypesCard(card) {
  const arch = card.archetypes || [];
  const nRows = card.data?.matches ? card.data.matches * 2 : null;
  const signature = (z) => Object.entries(z || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2)
    .map(([f, v]) => h("div", { style: { whiteSpace: "nowrap" } }, `${STYLE_LABELS[f] || f} ${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} SD`));
  const icon = (a, color) => {
    const svg = shapeIcon(ARCH_SHAPES[a.id % ARCH_SHAPES.length], color);
    svg.style.flex = "none";
    return svg;
  };
  const rows = arch.map((a) => {
    const color = ARCH_COLORS[a.id % ARCH_COLORS.length];
    return h("tr", {}, [
      h("td", { style: { minWidth: "170px" } }, h("span", { class: "row", style: { gap: "8px", flexWrap: "nowrap" } }, [icon(a, color), h("strong", {}, a.name)])),
      h("td", { class: "num" }, a.share != null ? pct(a.share) : "—"),
      h("td", { class: "num" }, signature(a.centroid_z)),
      h("td", { class: "secondary", style: { minWidth: "240px" } }, a.description),
    ]);
  });
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Style archetypes"), h("span", { class: "sub" }, "K-means clusters of pro team-matches")]),
    rows.length ? table(["Archetype", "Share", "Strongest traits", "Description"], rows) : h("div", { class: "empty" }, "No archetypes in this build."),
    h("p", { class: "chart-note" }, `Share = fraction of the ${nRows ?? ""} pro team-matches in each cluster. Strongest traits = the cluster centre's two largest standardised style features (SD from the pro average). Names come from matching each cluster to the closest hand-written prototype, so they describe tendencies, not rules.`),
  ]);
}

function limitationsCard(card, status) {
  const items = [
    ["Not for betting.", "This is educational planning software for coaches. It compares tactical options; it does not offer odds and should not be used for gambling."],
    ["Scenarios, not predictions.", "Every output is a what-if under stated assumptions. Read the ranges — win bands, expected-points ranges and 90% intervals carry the model's uncertainty. The model is team-level: it does not know about injuries, individual players or motivation."],
    ["Observational data means confounding.", "Tactics in the pro data were not randomly assigned. Teams drop deeper when leading and push up when chasing a game. Within-team comparison removes squad-quality differences but not these score effects, which is why lever effects are halved and big moves away from a team's identity pay an adaptation cost."],
    ["Pro-to-grassroots transfer is approximate.", `Effects were estimated on elite men's football (${(card.data?.competitions || []).join(", ")}). Local teams are rated relative to their own league — the average of all local match data entered here, or a default of 1.6 xG per team per match until at least 3 matches exist. Local xG is estimated from shots and shots on target, blended with goals, not from event data; local press, directness and width come from coach 1–5 ratings mapped onto pro ranges.`],
    ["Small samples for local teams.", "Local ratings are shrunk toward the league average by 4 pseudo-matches, and the simulator widens rating uncertainty for teams with few matches. With fewer than 8 matches, treat a local profile as rough."],
    ["Your data stays local.", "Club data and rosters live in a database on the machine running the app and are not uploaded anywhere. When you ask Coach Twelve, our AI coach, a question, the game plan, team summaries, recent results and squad names for that match are sent to the AI service to write the answer — nothing is sent otherwise."],
    ["Coach Twelve does not invent numbers.", "It is instructed to use only the numbers the models produced and to speak in estimates, not guarantees. When it is offline, answers come straight from the game plan."],
  ];
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Limitations & ethics"), statusPill(status)]),
    h("ul", { class: "cues", style: { margin: "0" } }, items.map(([t, d]) => h("li", { style: { margin: "6px 0" } }, [h("strong", { style: { color: "var(--text-primary)" } }, t), " ", d]))),
    h("p", { class: "chart-note" }, `Explanation status: ${status.reason || "unknown"}`),
  ]);
}

// ---------------------------------------------------------------- view
export async function renderModel() {
  const card = await api("/model-card");
  const meta = state.meta || {};
  const status = meta.assistant || { enabled: false, reason: "Explanation status unavailable." };

  return h("div", { class: "stack", style: { gap: "16px" } }, [
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("h1", {}, "How it works"),
        h("p", {}, "How The Twelfth Man builds your game plan, how well it holds up, and where it can mislead. Educational planning — not a betting or prediction service."),
      ]),
      meta.built_at ? h("span", { class: "pill" }, `Models built ${meta.built_at}`) : null,
    ]),
    h("section", { class: "coach-card" }, [
      h("h2", {}, "In plain words"),
      h("ol", { class: "plain-list numbered" }, [
        ["We learned from real football", "The match engine studied 495 professional matches (Premier League 2015/16, Euro 2024, World Cup 2022): how teams press, pass and attack, and what that does to the chances they create and concede."],
        ["We rate your team from your results", "Your results, shots and style ratings place your team on the same scale, compared with the other teams in your own league."],
        ["We play the game thousands of times", "For any set-up, the engine simulates the match minute by minute — including tiredness, substitutions and the score — to see how often each way of playing works."],
        ["We turn it into a plan", "The best options become plain instructions, a team sheet and a training week. Coach Twelve, our in-house AI coach, answers questions using the same numbers."],
      ].map(([t, d]) => h("li", {}, [h("strong", {}, t), h("span", {}, d)]))),
      h("p", { class: "sub" }, "Below: how accurate it is, its limits, and the full technical detail for anyone who wants it."),
    ]),
    h("div", { class: "grid g2" }, backtestCards(card.backtest)),
    limitationsCard(card, status),
    more("How it works", [howItWorks(card, status)], { hint: "the pipeline, step by step" }),
    more("Tactic effects", [effectsCard(card)], { hint: "what the data says about press, tempo and width" }),
    more("Formations & goal timing", [h("div", { class: "grid g2" }, [formationCard(card), minuteCard(card)])]),
    more("Assumptions (not fitted from data)", [priorsCard(card.priors)]),
    more("Archetypes", [archetypesCard(card)]),
  ]);
}
