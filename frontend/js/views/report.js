import { state, api, tacticsFor, simBody } from "../state.js";
import { h, s, C, ARCH_COLORS, pct, signed, signedPct, bindTip, pitch, zonesPitch, wdlBar, drillLegend } from "../charts.js";
import { go , render } from "../app.js";
import { drillCard } from "./recommend.js";

// Printable one-page-ish "Match Plan". Everything inside .report uses the light theme in app.css.

const VENUE_TEXT = { home: "Home", away: "Away", neutral: "Neutral venue" };
const COND_TEXT = { normal: "Normal conditions", rain: "Heavy rain", wind: "Strong wind", heat: "Hot day" };
const INK = "#22221f"; // primary text colour on the light report

const short = (lbl) => String(lbl || "").split(" · ")[0];
const arr = (v) => (Array.isArray(v) ? v : []);
const fatigueWord = (f) => (f > 0.8 ? "high — plan your changes" : f > 0.3 ? "moderate" : "low");
const lastName = (n) => String(n).trim().split(/\s+/).slice(-1)[0];
const cap = (t) => (t ? String(t).charAt(0).toUpperCase() + String(t).slice(1) : "");
const NOWRAP = { whiteSpace: "nowrap" };
const INK_2 = "#52514e"; // secondary text colour on the light report (>= 7:1 on white)

// The dark theme's pale secondary/muted text colours (.legend, .tile .delta, .wdl-legend,
// .source-note, .chart-note) are unreadable on the light report. Recolour them inline so the
// report is self-contained and prints legibly.
const PALE = ".legend, .tile .delta, .wdl-legend, .source-note, .chart-note";
function inkPale(root) {
  root.querySelectorAll(PALE).forEach((el) => { el.style.color = INK_2; });
  return root;
}

function section(title, children) {
  return h("section", {}, [h("h2", {}, title), h("div", { class: "stack" }, children)]);
}

function tile(labelTxt, value, note, small = false) {
  return h("div", { class: "tile" }, [
    h("span", { class: "label" }, labelTxt),
    h("span", { class: "value num", style: small ? { fontSize: "17px" } : null }, value),
    note ? h("span", { class: "delta num", style: { color: INK_2 } }, note) : null,
  ]);
}

function bullets(items, ordered = false) {
  const list = arr(items);
  if (!list.length) return h("p", { class: "muted" }, "Nothing flagged for this phase.");
  return h(ordered ? "ol" : "ul", { class: "cues", style: { marginTop: 0 } }, list.map((x) => h("li", {}, String(x))));
}

// ---------------------------------------------------------------- toolbar (screen only)
function toolbar(onExport) {
  return h("div", { class: "row no-print", style: { justifyContent: "space-between", alignItems: "flex-start" } }, [
    h("p", { class: "sub", style: { maxWidth: "560px" } },
      "Export PDF opens your browser's print dialog — choose “Save as PDF” as the destination. If colours are missing, tick “Background graphics”."),
    h("div", { class: "row" }, [
      h("button", { class: "btn ghost", onclick: () => go("lab") }, "← Back to Tactics Lab"),
      onExport ? h("button", { class: "btn primary", onclick: onExport }, "Export PDF") : null,
    ]),
  ]);
}

// ---------------------------------------------------------------- lineup
function lineupPitch(formation) {
  const slots = state.meta?.formations?.[formation]?.slots || [];
  const names = state.lineups[`${state.teamId}|${formation}`] || [];
  const { svg, layer } = pitch({ width: 460, light: true });
  slots.forEach((sl, i) => {
    const name = names[i];
    const ny = sl.y > 68 ? sl.y - 5.8 : sl.y + 8.6; // keep names inside the pitch on the touchline side
    const g = s("g", {}, [
      s("circle", { cx: sl.x, cy: sl.y, r: 4.2, fill: C.us, stroke: "#ffffff", "stroke-width": 0.8 }),
      // inline font-size: the global `svg text { font-size: 11px }` rule would beat the attribute
      s("text", { x: sl.x, y: sl.y + 1.1, "text-anchor": "middle", "font-weight": 700, style: "fill:#ffffff;font-size:2.8px" }, sl.role),
      name ? s("text", { x: sl.x, y: ny, "text-anchor": "middle", "font-weight": 600, style: `fill:${INK};font-size:3.6px` }, lastName(name)) : null,
    ]);
    bindTip(g, () => [{ value: name || "Unassigned", label: sl.role }]);
    layer.append(g);
  });
  return { svg, named: names.some(Boolean) };
}

// ---------------------------------------------------------------- zones
function zonesCard(zones, oppHasEvents) {
  const attack = arr(zones && zones.attack), protect = arr(zones && zones.protect);
  const notes = [
    ...attack.map((z) => h("li", {}, [h("strong", {}, `Attack the ${z.zone}`), ` — only ${pct(z.opp_def_share)} of their defensive actions in their own third happen in this lane.`])),
    ...protect.map((z) => h("li", {}, [h("strong", {}, `Protect our ${z.zone}`), ` — ${pct(z.opp_attack_share)} of their final-third play comes down this side.`])),
  ];
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Where to attack, what to protect"), h("span", { class: "sub" }, "you attack left → right")]),
    h("div", { class: "legend", style: { color: INK_2 } }, [
      h("span", {}, [h("span", { class: "key-rect", style: { background: C.us } }), "Attack lanes"]),
      h("span", {}, [h("span", { class: "key-rect", style: { background: C.them } }), "Protect lanes"]),
    ]),
    h("div", { class: "grid g2", style: { alignItems: "center" } }, [
      zonesPitch({ attack, protect }, { light: true }),
      notes.length ? h("ul", { class: "cues", style: { marginTop: 0 } }, notes) : h("p", { class: "muted" }, "No clear lanes stand out for this opponent."),
    ]),
    h("p", { class: "chart-note" }, oppHasEvents
      ? "Attack lanes = where they make the fewest defensive actions in their own third. Protect lanes = where most of their final-third play happens."
      : "Local opponent: lanes are estimated from the typical pattern of their archetype."),
  ]);
}

// ---------------------------------------------------------------- opponent
function opponentCards(mu) {
  const opp = mu.opponent || {};
  const arch = opp.archetype || {};
  const rec = opp.record;
  const facts = [
    opp.formation ? `Usually ${opp.formation}` : null,
    opp.matches != null ? `${opp.matches} matches` : null,
    rec ? `W${rec.W} D${rec.D} L${rec.L}` : null,
    opp.rating ? `Attack index ${opp.rating.attack.toFixed(2)}×` : null,
    opp.rating ? `Defence index ${opp.rating.defence.toFixed(2)}×` : null,
  ].filter(Boolean);
  const archCard = h("div", { class: "card stack", style: { gap: "12px" } }, [
    h("div", { class: "arch" }, [
      h("span", { class: "arch-swatch", style: { background: ARCH_COLORS[(arch.id || 0) % ARCH_COLORS.length] } }),
      h("div", { class: "stack", style: { gap: "4px" } }, [
        h("span", { class: "sub" }, `${short(opp.label)} · team archetype`),
        h("h3", { style: { fontSize: "15px" } }, arch.name || "Unclassified"),
        arch.description ? h("p", { style: { fontSize: "13px" } }, arch.description) : null,
        arch.fit != null ? h("span", { class: "sub" }, `Fit to this archetype ${pct(arch.fit)}`) : null,
      ]),
    ]),
    facts.length ? h("div", { class: "row", style: { gap: "6px" } }, facts.map((f) => h("span", { class: "tag num" }, f))) : null,
    h("p", { class: "chart-note" }, "Attack index above 1× = creates more chances than league average; defence index below 1× = concedes fewer."),
  ]);
  const risks = arr(mu.risks);
  const riskCard = h("div", { class: "card" }, [
    h("h3", {}, "Top risks"),
    ...(risks.length
      ? risks.map((r) => h("div", { class: "risk" }, [
        h("span", { class: "ico", "aria-hidden": "true" }, "▲"),
        h("div", {}, [h("strong", {}, r.title), h("p", { style: { fontSize: "13px", marginTop: "2px" } }, r.detail)]),
      ]))
      : [h("p", { class: "muted" }, "No major style mismatches flagged for this opponent.")]),
  ]);
  return h("div", { class: "grid g2" }, [archCard, riskCard]);
}

// ---------------------------------------------------------------- adjustments
function adjustments(recs) {
  if (!recs.length) {
    return h("p", {}, "No change clears the confidence bar — the current plan is already a good fit for this opponent. Focus on executing it well.");
  }
  return h("div", { class: "card" }, [
    h("div", { class: "table-wrap" }, h("table", {}, [
      h("thead", {}, h("tr", {}, ["#", "Adjustment", "Δ expected points", "80% range", "Δ win probability", "Confidence"].map((t) => h("th", {}, t)))),
      h("tbody", {}, recs.map((r, i) => {
        const imp = r.impact || {};
        const range = arr(imp.xpts_range);
        return h("tr", {}, [
          h("td", { class: "num" }, String(i + 1)),
          h("td", {}, h("strong", {}, r.title)),
          h("td", { class: "num", style: NOWRAP }, signed(imp.xpts)),
          h("td", { class: "num", style: NOWRAP }, range.length === 2 ? `${signed(range[0])} to ${signed(range[1])}` : "—"),
          h("td", { class: "num", style: NOWRAP }, signedPct(imp.win, 1)),
          h("td", { style: NOWRAP }, r.confidence != null ? `${cap(r.confidence_label)} (${pct(r.confidence)})` : cap(r.confidence_label) || "—"),
        ]);
      })),
    ])),
    h("p", { class: "chart-note" }, "Changes versus the plan above, ranked by a cautious estimate of the expected-points gain. The 80% range shows how much the gain could vary under model uncertainty. Try them in the Tactics Lab before matchday."),
  ]);
}

// ---------------------------------------------------------------- substitutions
function subsBlock(plan, sim) {
  const subs = [...arr(state.subs)].sort((a, b) => (a.minute || 0) - (b.minute || 0));
  const fat = sim.risk && typeof sim.risk.fatigue_index === "number" ? sim.risk.fatigue_index : null;
  return [
    plan.substitution_plan ? h("p", {}, plan.substitution_plan) : null,
    fat != null ? h("p", { class: "sub num" }, `Fatigue load ${fat.toFixed(2)} — ${fatigueWord(fat)}. Concede after 75': ${pct(sim.late_concede)} of simulated matches.`) : null,
    subs.length
      ? h("div", { class: "card", style: { padding: "8px 12px" } }, h("div", { class: "table-wrap" }, h("table", {}, [
        h("thead", {}, h("tr", {}, ["Minute", "Type", "Off", "On"].map((t) => h("th", {}, t)))),
        h("tbody", {}, subs.map((sb) => h("tr", {}, [
          h("td", { class: "num" }, `${sb.minute}'`),
          h("td", {}, sb.type || "like-for-like"),
          h("td", {}, sb.off || "—"),
          h("td", {}, sb.on || "—"),
        ]))),
      ])))
      : h("p", { class: "muted" }, "No substitutions planned yet — add them in the Tactics Lab to print them here."),
  ];
}

// ---------------------------------------------------------------- view
export async function renderReport() {
  let res;
  try {
    await tacticsFor(state.teamId);
    res = await api("/report", { method: "POST", body: simBody() });
  } catch (e) {
    return h("div", { class: "stack", style: { gap: "16px" } }, [
      toolbar(null),
      h("div", { class: "card errors" }, [h("strong", {}, "Could not build the match plan. "), e.message]),
    ]);
  }

  const sim = res.simulation || {};
  const mu = res.matchup || {};
  const plan = res.plan || {};
  const recs = arr(res.recommendations && res.recommendations.recommendations);
  const session = arr(res.session);
  const us = short(sim.team && sim.team.label);
  const them = short(sim.opponent && sim.opponent.label);
  const tactics = sim.tactics || state.tactics[state.teamId] || {};
  const formation = tactics.formation;

  const exportPdf = () => {
    const prev = document.title;
    document.title = `Match Plan - ${us} vs ${them}`; // default PDF file name in most browsers
    const restore = () => { document.title = prev; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    window.print();
  };

  // 1. header
  const meta = [
    VENUE_TEXT[state.venue] || state.venue,
    COND_TEXT[state.conditions] || state.conditions,
    formation ? `Formation ${formation}` : null,
    ["press", "tempo", "width"].every((k) => typeof tactics[k] === "number") ? `Press ${tactics.press} · Tempo ${tactics.tempo} · Width ${tactics.width}` : null,
    `Generated ${new Date().toLocaleDateString()}`,
  ].filter(Boolean);
  const header = h("section", {}, [
    h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } }, [
      h("div", { class: "stack", style: { gap: "4px" } }, [
        h("span", { class: "sub", style: { textTransform: "uppercase", letterSpacing: "0.08em" } }, "The Twelfth Man"),
        h("h1", {}, "Match Plan"),
        h("p", { style: { fontSize: "18px", fontWeight: 600, color: "#0b0b0b" } }, `${us} vs ${them}`),
      ]),
    ]),
    h("div", { class: "row", style: { gap: "6px", marginTop: "10px" } }, meta.map((m) => h("span", { class: "tag" }, m))),
  ]);

  // 2. game plan + outcome
  const xgBand = (b) => (arr(b).length === 2 ? `90% range ${b[0].toFixed(2)}–${b[1].toFixed(2)}` : null);
  const gamePlan = section("Game plan", [
    plan.summary ? h("p", { style: { fontSize: "15px", lineHeight: 1.55 } }, plan.summary) : null,
    h("div", { class: "card stack" }, [
      h("div", { class: "card-head", style: { marginBottom: 0 } }, [
        h("h3", {}, "Simulated outcome"),
        h("span", { class: "sub" }, `${(sim.n_sims || 0).toLocaleString()} simulated matches`),
      ]),
      wdlBar(sim.win, sim.draw, sim.loss, { band: sim.win_band }),
      h("div", { class: "tiles" }, [
        tile("Win / draw / loss", `${pct(sim.win)} / ${pct(sim.draw)} / ${pct(sim.loss)}`, null, true),
        typeof sim.xpts === "number" ? tile("Expected points", sim.xpts.toFixed(2)) : null,
        tile("xG for", sim.xg_for.toFixed(2), xgBand(sim.xg_for_band)),
        tile("xG against", sim.xg_against.toFixed(2), xgBand(sim.xg_against_band)),
        tile("Clean sheet", pct(sim.clean_sheet)),
        tile("Concede after 75'", pct(sim.late_concede)),
      ]),
      h("p", { class: "chart-note" }, "Bar = share of simulated matches won, drawn and lost with this plan; the bracket after Win is its 90% range across model uncertainty. Scenarios, not certainties."),
    ]),
  ]);

  // 3. lineup + key messages
  const { svg: lineupSvg, named } = lineupPitch(formation);
  const lineupMessages = h("div", { class: "grid g2" }, [
    h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", {}, "Starting lineup"), formation ? h("span", { class: "tag" }, formation) : null]),
      lineupSvg,
      h("p", { class: "chart-note" }, named
        ? "Your XI from the Tactics Lab lineup editor. Attacking left → right."
        : `Positions for the ${formation || "chosen formation"}. Pick names in the Tactics Lab lineup editor to print them here. Attacking left → right.`),
    ]),
    h("div", { class: "card" }, [h("h3", {}, "Key messages"), bullets(plan.key_messages, true)]),
  ]);

  // 4. phases + zones
  const phases = section("In and out of possession", [
    h("div", { class: "grid g2" }, [
      h("div", { class: "card" }, [h("h3", {}, "In possession"), bullets(plan.in_possession)]),
      h("div", { class: "card" }, [h("h3", {}, "Out of possession"), bullets(plan.out_of_possession)]),
    ]),
    zonesCard(mu.zones, mu.opponent && mu.opponent.has_event_data),
  ]);

  // 8. training session
  const totalMin = session.reduce((t, d) => t + (+d.minutes || 0), 0);
  const training = section("Training session", session.length
    ? [
      h("p", { class: "sub" }, `${session.length} drills · about ${totalMin} minutes of work. Matched to this plan's top adjustment and your team's weak spots.`),
      drillLegend(),
      h("div", { class: "drills" }, session.map((d) => drillCard(d, { light: true }))),
    ]
    : [h("p", { class: "muted" }, "No drills matched this plan.")]);

  // 9. footer
  const pro = state.meta && state.meta.data && state.meta.data.matches;
  const footer = h("footer", { style: { marginTop: "24px", paddingTop: "10px", borderTop: "1px solid #e1e0d9" } }, [
    h("p", { class: "sub" }, `Data: StatsBomb open data${pro ? ` (${pro} pro matches)` : ""} plus your club's own match inputs. The Twelfth Man is educational scenario planning: every figure comes from simulations that carry real uncertainty. Use it to guide coaching decisions — it is not a prediction service.`),
  ]);

  const report = h("div", { class: "report" }, [
    header,
    gamePlan,
    section("Lineup and key messages", [lineupMessages]),
    phases,
    section("Substitution plan", subsBlock(plan, sim)),
    section("Opponent snapshot", [opponentCards(mu)]),
    section("Recommended adjustments", [adjustments(recs)]),
    training,
    footer,
  ]);

  inkPale(report); // catch every remaining pale legend / chart-note inside the light report
  return h("div", { class: "stack", style: { gap: "16px" } }, [toolbar(exportPdf), report]);
}
