import { state, api, save, tacticsFor, toast } from "../state.js";
import { h, C, pct, signed, signedPct, divergingBars, drillDiagram, drillLegend, more } from "../charts.js";
import { go } from "../app.js";

export function drillCard(d, { light = false } = {}) {
  return h("div", { class: "drill" }, [
    drillDiagram(d, { light }),
    h("div", { class: "row", style: { justifyContent: "space-between" } }, [h("h4", {}, d.name), h("span", { class: "tag" }, `${d.minutes} min`)]),
    h("p", {}, d.objective),
    h("p", { class: "muted", style: { fontSize: "11px" } }, `${d.players} players · ${d.area}`),
    h("ul", {}, d.coaching_points.map((c) => h("li", {}, c))),
  ]);
}

const confColor = (c) => (c >= 0.8 ? C.good : c >= 0.6 ? C.warning : C.serious);

function recCard(r, i, onApply) {
  const imp = r.impact;
  const rows = [];
  for (const d of r.drivers) {
    rows.push({ label: `${d.label} · xG for`, value: d.xg_pct, color: d.xg_pct >= 0 ? C.us : C.them });
    rows.push({ label: `${d.label} · xG against`, value: d.xga_pct, color: d.xga_pct <= 0 ? C.us : C.them });
  }
  const why = h("p", { class: "why", "data-why": i }, r.why);
  const cues = h("ul", { class: "cues", "data-cues": i }, (r.coaching_cues || []).map((c) => h("li", {}, c)));
  const statTile = (l, v, cls = "") => h("div", { class: "tile" }, [h("span", { class: "label" }, l), h("span", { class: `value num ${cls}`, style: { fontSize: "18px" } }, v)]);
  const big = (labelTxt, v, good) => h("div", { class: "big-stat" }, [h("span", { class: `value num ${good ? "up-good" : ""}` }, v), h("span", { class: "label" }, labelTxt)]);
  return h("div", { class: "card stack", style: { gap: "16px" } }, [
    h("div", { class: "row", style: { alignItems: "flex-start" } }, [
      h("span", { class: "rec-num" }, String(i + 1)),
      h("div", { class: "stack", style: { gap: "4px", flex: 1 } }, [
        h("h2", {}, r.title),
        h("span", { class: "conf" }, [h("span", { class: "dot", style: { background: confColor(r.confidence) } }), `${r.confidence_label} confidence`]),
      ]),
      h("button", { class: "btn small", onclick: () => onApply(r) }, "Try it →"),
    ]),
    h("div", { class: "row", style: { gap: "36px" } }, [
      big("win chance", signedPct(imp.win, 1), imp.win > 0),
      big("chances created (xG)", signed(imp.xg_for), imp.xg_for > 0),
      big("chances conceded (xG)", signed(imp.xg_against), imp.xg_against < 0),
    ]),
    h("div", {}, [why, cues]),
    more("Drills & details", [
      r.drills && r.drills.length ? h("div", { class: "stack" }, [h("span", { class: "sub" }, "Drill pack"), h("div", { class: "drills" }, r.drills.map((d) => drillCard(d))), drillLegend()]) : null,
      h("div", {}, [h("span", { class: "sub" }, "Key drivers"), divergingBars(rows)]),
      h("p", { class: "sub" }, `Expected points ${signed(imp.xpts)} (80% range ${signed(imp.xpts_range[0])} to ${signed(imp.xpts_range[1])}) · helps in ${pct(r.confidence)} of uncertainty scenarios · counter-attack risk ${signedPct(imp.counter_risk_pct)}`),
    ], { hint: `${(r.drills || []).length} drills` }),
  ]);
}

export async function renderRecommend() {
  const tactics = await tacticsFor(state.teamId);
  const body = { team_id: state.teamId, opponent_id: state.oppId, tactics, venue: state.venue, conditions: state.conditions };
  const rec = await api("/recommend", { method: "POST", body });
  const cur = rec.current;

  const apply = (r) => {
    Object.assign(state.tactics[state.teamId], r.tactics);
    save();
    toast(`Applied: ${r.title}`);
    go("lab");
  };

  const sourceNote = h("span", { class: "source-note" }, [h("span", { class: "dot", style: { background: C.muted } }), "Built-in coaching notes"]);
  const headline = h("p", { class: "secondary", style: { fontSize: "15px" } });

  const page = h("div", { class: "stack", style: { gap: "16px" } }, [
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("h1", {}, "Recommendations"),
        h("p", {}, `The best changes to try against ${rec.opponent.label.split(" · ")[0]}. We only show changes that still help when the model is unsure.`),
      ]),
      sourceNote,
    ]),
    headline,
    h("p", { class: "secondary" }, [`Current plan: ${cur.tactics.formation}, press ${cur.tactics.press}, tempo ${cur.tactics.tempo}, width ${cur.tactics.width} — about ${pct(cur.win)} win chance. `, h("a", { href: "#/lab" }, "Edit")]),
    ...(rec.recommendations.length
      ? rec.recommendations.map((r, i) => recCard(r, i, apply))
      : [h("div", { class: "card empty" }, "No change clears the confidence bar — your current plan is already a good fit for this opponent. Focus training on the areas below.")]),
    more("Training focus from your team profile", [
      rec.weaknesses.length ? null : h("p", { class: "muted" }, "No clear weaknesses flagged in the data."),
      ...rec.weaknesses.map((w) => h("div", { class: "stack", style: { gap: "8px" } }, [
        h("div", {}, [h("strong", {}, w.title), h("p", { class: "secondary", style: { fontSize: "13px" } }, w.detail)]),
        h("div", { class: "drills" }, (w.drills || []).map((d) => drillCard(d))),
        h("div", { class: "divider" }),
      ])),
    ], { hint: `${rec.weaknesses.length} areas to work on` }),
    h("p", { class: "chart-note" }, "Educational scenario planning, not a prediction service. Effects are estimated within teams from pro data, halved to allow for game-state bias, and include an adaptation cost for unfamiliar set-ups. See Model Card."),
  ]);

  return page;
}

const tileKV = (k, v) => h("div", { class: "tile" }, [h("span", { class: "label" }, k), h("span", { class: "value num", style: { fontSize: "17px" } }, String(v))]);
