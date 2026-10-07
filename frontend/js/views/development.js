import { state, team } from "../state.js";
import { h, C, pct, signed, lineChart, bindTip, showTip , more } from "../charts.js";
import { go } from "../app.js";

// ---------------------------------------------------------------- helpers
const RES = {
  W: { word: "Win", color: C.us, pts: 3 },
  D: { word: "Draw", color: C.neutral, pts: 1 },
  L: { word: "Loss", color: C.them, pts: 0 },
};
const resultOf = (m) => (m.gf > m.ga ? "W" : m.gf === m.ga ? "D" : "L");
const score = (m) => `${m.gf}–${m.ga}`;
const oppName = (m) => m.opp || "Unknown opponent";
const shortDate = (m, i) => (m.date && String(m.date).length >= 10 ? String(m.date).slice(5, 10) : `M${i + 1}`);
const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);

function mean(vals) {
  const v = vals.filter(has);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Trailing k-match average; null until k matches are available. */
function rolling(vals, k = 3) {
  return vals.map((_, i) => (i < k - 1 ? null : mean(vals.slice(i - k + 1, i + 1))));
}

const f2 = (v) => v.toFixed(2);
const intFmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function keyLine(color, dashed) {
  return h("span", {
    class: "key-line",
    style: { background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color },
  });
}

function legend(series) {
  return h("div", { class: "legend" }, series.map((sr) => h("span", {}, [keyLine(sr.color, !!sr.dash), sr.name])));
}

/** lineChart's built-in tooltip only knows the x label; add the opponent and score on top of it. */
function withMatchTips(svg, trend, series, fmt) {
  const hit = svg.querySelector('rect[fill="transparent"]');
  const n = trend.length;
  if (!hit || !n) return svg;
  hit.addEventListener("pointermove", (e) => {
    const r = hit.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    const m = trend[i];
    const res = resultOf(m);
    showTip(e, [
      `${m.date || `Match ${i + 1}`} · vs ${oppName(m)}`,
      `${RES[res].word} ${score(m)}`,
      ...series.map((sr) => ({ color: sr.color, value: sr.values[i] == null ? "—" : fmt(sr.values[i]), label: sr.name })),
    ]);
  });
  return svg;
}

function chartCard(title, sub, trend, labels, series, opts, note, ariaLabel) {
  const live = series.filter((sr) => sr.values.some(has));
  if (!live.length) {
    return h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", {}, title), sub ? h("span", { class: "sub" }, sub) : null]),
      h("div", { class: "empty" }, "No values recorded for this yet."),
    ]);
  }
  const svg = lineChart(labels, live, opts);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel);
  withMatchTips(svg, trend, live, opts.fmt || f2);
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, title), sub ? h("span", { class: "sub" }, sub) : null]),
    legend(live),
    svg,
    h("p", { class: "chart-note" }, note),
  ]);
}

// ---------------------------------------------------------------- form strip
function formCard(t, trend) {
  const last = trend.slice(-10);
  const counts = { W: 0, D: 0, L: 0 };
  last.forEach((m) => counts[resultOf(m)]++);
  const pts = last.reduce((a, m) => a + RES[resultOf(m)].pts, 0);
  const rec = t.record || {};

  const chips = last.map((m) => {
    const r = resultOf(m);
    const chip = h("span", {
      class: "chip",
      "aria-label": `${RES[r].word} ${score(m)} vs ${oppName(m)} on ${m.date || "unknown date"}`,
    }, [h("span", { class: "dot", style: { background: RES[r].color } }), h("strong", { class: "num" }, r)]);
    return bindTip(chip, () => [{ color: RES[r].color, value: `${RES[r].word} ${score(m)}`, label: `vs ${oppName(m)}` }, m.date || ""]);
  });

  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("h3", {}, `Form · last ${last.length}`),
      h("span", { class: "sub" }, "oldest → latest"),
    ]),
    h("div", { class: "row", style: { gap: "6px" } }, chips),
    h("div", { class: "legend", style: { marginBottom: 0 } }, Object.entries(RES).map(([k, v]) =>
      h("span", {}, [h("span", { class: "dot", style: { background: v.color } }), `${k} = ${v.word.toLowerCase()}`]))),
    h("div", { class: "stack secondary num", style: { gap: "2px", fontSize: "13px" } }, [
      h("span", {}, `Last ${last.length}: ${counts.W}W ${counts.D}D ${counts.L}L · ${pts} pts`),
      h("span", {}, `All ${t.matches} matches: W${rec.W ?? "–"} D${rec.D ?? "–"} L${rec.L ?? "–"} · goals ${rec.gf ?? "–"}–${rec.ga ?? "–"}`),
    ]),
  ]);
}

// ---------------------------------------------------------------- data card
function dataCard(t, trend) {
  const dq = t.data_quality || {};
  if (t.source === "local") {
    return h("div", { class: "card stack" }, [
      h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "About this data"), h("span", { class: "tag" }, "Your club data")]),
      h("p", { class: "secondary num", style: { fontSize: "13px" } },
        [`${dq.matches ?? t.matches} matches entered`, dq.has_passing ? "passing data recorded" : "no passing data yet",
          dq.has_sot ? "shots on target recorded" : "no shots-on-target data"].join(" · ")),
      dq.note ? h("p", { class: "secondary", style: { fontSize: "13px" } }, dq.note) : null,
      h("p", { class: "chart-note" }, dq.has_sot
        ? "xG for local matches is estimated from shots, shots on target and goals — there is no shot-by-shot data, so read it as a guide rather than an exact figure."
        : "xG for local matches is estimated from total shots and goals. Adding shots on target makes the estimate noticeably better."),
      h("div", { class: "row" }, [h("button", { class: "btn small", onclick: () => go("data") }, "Add or edit matches")]),
    ]);
  }
  const first = trend[0], last = trend[trend.length - 1];
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "About this data"), h("span", { class: "tag" }, "Open data")]),
    h("p", { class: "secondary num", style: { fontSize: "13px" } },
      [t.competition || "Pro data", `${t.matches} matches`, first.date && last.date ? `${first.date} to ${last.date}` : null].filter(Boolean).join(" · ")),
    h("p", { class: "secondary", style: { fontSize: "13px" } },
      "StatsBomb open event data. xG comes from shot-by-shot chance quality; press height is the average position of defensive actions up the pitch."),
    h("p", { class: "chart-note" }, "Pro seasons are useful as a reference for how a style develops. Pick your own club in the team selector to track your players' progress."),
  ]);
}

// ---------------------------------------------------------------- recent vs earlier tiles
function compareCard(t, trend) {
  const n = trend.length;
  const local = t.source === "local";
  let recent, base, baseName, headSub;
  if (n >= 8) {
    recent = trend.slice(-5); base = trend.slice(0, -5);
    baseName = `Previous ${base.length}`; headSub = `last 5 vs previous ${base.length} matches`;
  } else if (n > 5) {
    recent = trend.slice(-5); base = trend;
    baseName = "Season avg"; headSub = `last 5 vs season average (${n} matches)`;
  } else {
    recent = trend; base = null;
    baseName = ""; headSub = `average of all ${n} match${n === 1 ? "" : "es"}`;
  }

  const defs = [
    { label: "Points per match", get: (m) => RES[resultOf(m)].pts, fmt: f2, dfmt: (v) => signed(v, 2), good: 1, eps: 0.05 },
    { label: "Goals for / match", get: (m) => m.gf, fmt: f2, dfmt: (v) => signed(v, 2), good: 1, eps: 0.05 },
    { label: "Goals against / match", get: (m) => m.ga, fmt: f2, dfmt: (v) => signed(v, 2), good: -1, eps: 0.05 },
    { label: local ? "xG for (est.)" : "xG for", get: (m) => m.xg, fmt: f2, dfmt: (v) => signed(v, 2), good: 1, eps: 0.05 },
    { label: local ? "xG against (est.)" : "xG against", get: (m) => m.xga, fmt: f2, dfmt: (v) => signed(v, 2), good: -1, eps: 0.05 },
    { label: "Possession", get: (m) => m.possession, fmt: (v) => pct(v), dfmt: (v) => `${signed(v * 100, 1)}%`, good: 0, eps: 0.01, words: ["more of the ball", "less of the ball"] },
  ];
  if (local) {
    defs.push(
      { label: "Pass completion", get: (m) => m.pass_comp, fmt: (v) => pct(v), dfmt: (v) => `${signed(v * 100, 1)}%`, good: 1, eps: 0.01 },
      { label: "Shots / match", get: (m) => m.shots, fmt: (v) => v.toFixed(1), dfmt: (v) => signed(v, 1), good: 1, eps: 0.5 },
      { label: "Shots against / match", get: (m) => m.shots_against, fmt: (v) => v.toFixed(1), dfmt: (v) => signed(v, 1), good: -1, eps: 0.5 },
    );
  }

  const tiles = [];
  for (const d of defs) {
    const r = mean(recent.map(d.get));
    if (r == null) continue;
    const b = base ? mean(base.map(d.get)) : null;
    let deltaNode = null;
    if (b != null) {
      const delta = r - b;
      const eps = d.eps ?? 0.05;
      const flat = Math.abs(delta) < eps;
      const up = delta > 0;
      const better = d.good === 0 ? null : (d.good > 0) === up;
      const cls = flat || better === null ? "" : better ? "up-good" : "down-bad";
      const word = flat ? "about the same" : better === null ? (up ? d.words[0] : d.words[1]) : better ? "better" : "worse";
      deltaNode = h("span", { class: `delta num ${cls}` }, flat ? `• ${word}` : `${up ? "▲" : "▼"} ${d.dfmt(delta)} · ${word}`);
    }
    tiles.push(h("div", { class: "tile" }, [
      h("span", { class: "label" }, d.label),
      h("span", { class: "value num" }, d.fmt(r)),
      deltaNode,
      b != null ? h("span", { class: "delta muted num" }, `${baseName}: ${d.fmt(b)}`) : null,
    ]));
  }

  let summary = null;
  if (base) {
    const rd = mean(recent.map((m) => (has(m.xg) && has(m.xga) ? m.xg - m.xga : null)));
    const bd = mean(base.map((m) => (has(m.xg) && has(m.xga) ? m.xg - m.xga : null)));
    if (rd != null && bd != null) {
      const diff = rd - bd;
      const trendWord = Math.abs(diff) < 0.1 ? "holding steady" : diff > 0 ? "improving" : "slipping";
      summary = h("p", { class: "secondary", style: { fontSize: "13px" } },
        `Chance balance (xG for minus xG against) over the last 5 is ${signed(rd, 2)} per match, compared with ${signed(bd, 2)} ${n >= 8 ? "before" : "across the season"} — ${trendWord}.`);
    }
  }

  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, base ? "Recent form vs earlier" : "Season averages"), h("span", { class: "sub" }, headSub)]),
    h("div", { class: "tiles" }, tiles),
    summary,
    h("p", { class: "chart-note" }, base
      ? "▲/▼ show the change in the per-match average; green = moving the right way for your team, orange = the wrong way. Possession is a style choice, so it is not marked good or bad. Five matches is a small sample — look for changes that persist."
      : "A recent-vs-earlier comparison appears once there are at least 6 matches."),
  ]);
}

// ---------------------------------------------------------------- charts
function charts(t, trend) {
  const local = t.source === "local";
  const labels = trend.map(shortDate);
  const roll = trend.length >= 4;
  const col = (get) => trend.map((m) => (has(get(m)) ? get(m) : null));
  const withRolling = (base, name) => (roll ? [base, { name, color: base.color, dash: "4 3", values: rolling(base.values) }] : [base]);

  const xg = col((m) => m.xg), xga = col((m) => m.xga);
  const xgSeries = [
    { name: local ? "xG for (est.)" : "xG for", color: C.us, values: xg },
    { name: local ? "xG against (est.)" : "xG against", color: C.them, values: xga },
  ];
  if (roll) {
    xgSeries.push(
      { name: "xG for · 3-match avg", color: C.us, dash: "4 3", values: rolling(xg) },
      { name: "xG against · 3-match avg", color: C.them, dash: "4 3", values: rolling(xga) },
    );
  }
  const xgCard = chartCard("Chances created vs conceded", "xG per match", trend, labels, xgSeries, { fmt: f2 },
    `Expected goals for and against in each match${roll ? "; dashed lines are 3-match rolling averages, which smooth out one-off games" : ""}. A widening gap with blue on top means you are creating more than you allow.${local ? " Local xG is estimated from shots." : ""}`,
    `Line chart of xG for and against across ${trend.length} matches`);

  const gf = col((m) => m.gf), ga = col((m) => m.ga);
  const maxG = Math.max(1, ...gf.filter(has), ...ga.filter(has));
  const goalsCard = chartCard("Goals scored vs conceded", "per match", trend, labels, [
    { name: "Goals scored", color: C.us, values: gf },
    { name: "Goals conceded", color: C.them, values: ga },
  ], { fmt: intFmt, yMax: 4 * Math.ceil((maxG + 0.5) / 4) },
  "Actual goals each match. Goals swing more than xG, so compare this with the xG chart: scoring well below your xG for a spell usually points to finishing, not chance creation.",
  `Line chart of goals scored and conceded across ${trend.length} matches`);

  const poss = col((m) => m.possession);
  const possCard = chartCard("Possession", "share of the ball", trend, labels,
    withRolling({ name: "Possession", color: C.us, values: poss }, "3-match avg"), { fmt: (v) => pct(v), yMax: 1 },
    `Your share of possession in each match; the 50% gridline is an even share.${local ? " Possession for local matches is the estimate you entered." : ""} Neither high nor low is better — check it matches the style you are coaching.`,
    `Line chart of possession across ${trend.length} matches`);

  let fourth;
  if (local) {
    const pc = col((m) => m.pass_comp);
    if (pc.some(has)) {
      fourth = chartCard("Pass completion", "completed ÷ attempted", trend, labels,
        withRolling({ name: "Pass completion", color: C.us, values: pc }, "3-match avg"), { fmt: (v) => pct(v), yMax: 1 },
        "Share of passes that reached a teammate, from your tallies. A rising line usually means calmer build-up; it can dip when you deliberately play more forward passes.",
        `Line chart of pass completion across ${trend.length} matches`);
    } else {
      fourth = chartCard("Shots for vs against", "per match", trend, labels, [
        { name: "Shots", color: C.us, values: col((m) => m.shots) },
        { name: "Shots against", color: C.them, values: col((m) => m.shots_against) },
      ], { fmt: intFmt },
      "No passing data entered yet, so this shows shot volume instead. Add passes attempted and completed in Club Data to track pass completion.",
      `Line chart of shots for and against across ${trend.length} matches`);
    }
  } else {
    fourth = chartCard("Press height", "avg defensive action position, 0–120", trend, labels,
      withRolling({ name: "Press height", color: C.us, values: col((m) => m.press_height) }, "3-match avg"), { fmt: (v) => v.toFixed(0), yMax: 120 },
      "How far up the pitch (0 = own goal line, 120 = opponent's) the team made its defensive actions on average. Higher means pressing further forward.",
      `Line chart of press height across ${trend.length} matches`);
  }

  return [h("div", { class: "grid g2" }, [xgCard, goalsCard]), h("div", { class: "grid g2" }, [possCard, fourth])];
}

// ---------------------------------------------------------------- match table
function matchTable(t, trend) {
  const local = t.source === "local";
  const rows = [...trend].reverse();
  const cell = (v, fmt) => h("td", { class: "num" }, has(v) ? fmt(v) : "—");
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Match log"), h("span", { class: "sub" }, `${trend.length} matches · newest first`)]),
    h("div", { class: "table-wrap" }, h("table", {}, [
      h("thead", {}, h("tr", {}, [
        h("th", { scope: "col" }, "Date"), h("th", { scope: "col" }, "Opponent"), h("th", { scope: "col" }, "Score"),
        h("th", { scope: "col" }, local ? "xG (est.)" : "xG"), h("th", { scope: "col" }, local ? "xGA (est.)" : "xGA"),
        h("th", { scope: "col" }, "Possession"),
        local ? h("th", { scope: "col" }, "Shots") : null,
        local ? h("th", { scope: "col" }, "Pass %") : null,
        h("th", { scope: "col" }, "Formation"),
      ])),
      h("tbody", {}, rows.map((m) => {
        const r = resultOf(m);
        return h("tr", {}, [
          h("td", { class: "num", style: { whiteSpace: "nowrap" } }, m.date || "—"),
          h("td", {}, oppName(m)),
          h("td", { class: "num", style: { whiteSpace: "nowrap" } }, [
            h("span", { class: "dot", style: { background: RES[r].color, marginRight: "6px" } }),
            `${r} ${score(m)}`,
          ]),
          cell(m.xg, f2),
          cell(m.xga, f2),
          cell(m.possession, (v) => pct(v)),
          local ? h("td", { class: "num", style: { whiteSpace: "nowrap" } }, has(m.shots) ? `${m.shots}${has(m.shots_against) ? ` / ${m.shots_against}` : ""}` : "—") : null,
          local ? cell(m.pass_comp, (v) => pct(v)) : null,
          h("td", {}, m.formation || "—"),
        ]);
      })),
    ])),
    local ? h("p", { class: "chart-note" }, "Shots shown as yours / theirs.") : null,
  ]);
}

// ---------------------------------------------------------------- coming next
function playerCard(t) {
  const local = t.source === "local";
  const roster = Array.isArray(t.roster) ? [...t.roster].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)) : [];
  const feature = (title, text) => h("div", { class: "stack", style: { gap: "2px" } }, [h("strong", {}, title), h("p", { class: "secondary", style: { fontSize: "13px" } }, text)]);
  let squad = null;
  if (local && roster.length) {
    squad = h("div", { class: "stack", style: { gap: "6px" } }, [
      h("span", { class: "sub" }, `Your squad · ${roster.length} players ready for player tracking`),
      h("div", { class: "row", style: { gap: "6px" } }, roster.map((p) => h("span", { class: "chip" }, [
        has(p.number) ? h("span", { class: "num muted" }, `#${p.number}`) : null,
        p.name || "Unnamed",
        p.position ? h("span", { class: "muted" }, p.position) : null,
      ]))),
    ]);
  } else if (local) {
    squad = h("div", { class: "row" }, [
      h("span", { class: "secondary", style: { fontSize: "13px" } }, "Add your squad in Club Data so it's ready when player tracking arrives."),
      h("button", { class: "btn small", onclick: () => go("data") }, "Add squad"),
    ]);
  } else {
    squad = h("p", { class: "chart-note" }, "Player development works from your own squad data — choose your club in the team selector to see your roster here.");
  }
  return h("div", { class: "card stack", style: { gap: "12px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Coming next: player development"), h("span", { class: "tag" }, "Planned · Phase 5")]),
    h("div", { class: "grid g3" }, [
      feature("Player similarity to pros", "See which pro players in the same role each of your players most resembles, giving them a clear model to watch and learn from."),
      feature("Role fit", "How well each player's strengths suit each position in your formation, to support lineup choices and positional development."),
      feature("Workload guidance", "Track minutes and match intensity to plan rotation and keep young players' load sensible across a season."),
    ]),
    squad,
  ]);
}

// ---------------------------------------------------------------- view
export async function renderDevelopment() {
  const t = await team(state.teamId);
  const local = t.source === "local";
  const name = t.name || (t.label || "").split(" · ")[0];
  const trend = [...(t.trend || [])].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

  const head = h("div", { class: "page-head" }, [
    h("div", {}, [
      h("h1", {}, `Development · ${name}`),
      h("p", {}, `How ${name} is developing over time: recent form, chances created and conceded, and style across ${trend.length} match${trend.length === 1 ? "" : "es"}. ${trend.length >= 6
        ? "Single games are noisy — the dashed rolling averages and the recent-vs-earlier comparison show the direction of travel."
        : "Single games are noisy, so look for patterns across several matches rather than one result."}`),
    ]),
    local ? h("div", { class: "row" }, [h("button", { class: "btn primary", onclick: () => go("data") }, "Add a match")]) : null,
  ]);

  if (!trend.length) {
    return h("div", { class: "stack", style: { gap: "16px" } }, [
      head,
      h("div", { class: "card empty" }, [
        h("p", {}, "No matches recorded yet. Add a few results to start tracking development."),
        local ? h("button", { class: "btn small", style: { marginTop: "10px" }, onclick: () => go("data") }, "Add matches") : null,
      ]),
      playerCard(t),
    ]);
  }

  const fewNote = local && t.matches < 5
    ? h("div", { class: "card row", style: { justifyContent: "space-between" } }, [
      h("p", { class: "secondary", style: { flex: "1 1 260px" } },
        `Trends need a few more matches to mean much — with ${t.matches} so far, one unusual game can move every line. Five or more gives a steadier picture, and six or more unlocks a recent-vs-earlier comparison.`),
      h("button", { class: "btn small", onclick: () => go("data") }, "Add matches"),
    ])
    : null;

  const [mainChart, ...otherCharts] = charts(t, trend);
  return h("div", { class: "stack", style: { gap: "20px" } }, [
    head,
    fewNote,
    formCard(t, trend),
    compareCard(t, trend),
    mainChart,
    more("More trends & all matches", [...otherCharts, dataCard(t, trend), matchTable(t, trend)], { hint: "goals, possession, style, full match table" }),
    more("Player development (coming next)", [playerCard(t)]),
  ]);
}
