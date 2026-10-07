import { state, api, save } from "../state.js";
import { h, C, ARCH_COLORS, pct, wdlBar, styleDumbbell, zonesPitch, heatmap, passNetwork, shotMap, more } from "../charts.js";
import { go, renderPickers, render } from "../app.js";

export const FEATURE_LABELS = { possession: "Possession", pass_comp: "Pass completion", press_height: "Press height", directness: "Directness", width: "Width" };

export function archBlock(a) {
  return h("div", { class: "arch" }, [
    h("span", { class: "arch-swatch", style: { background: ARCH_COLORS[a.id % ARCH_COLORS.length] } }),
    h("div", { class: "stack", style: { gap: "4px" } }, [
      h("span", { class: "sub" }, "Team archetype"),
      h("h4", {}, a.name),
      h("p", { class: "secondary", style: { fontSize: "13px" } }, a.description),
      h("span", { class: "sub" }, `Fit ${pct(a.fit)} · ${Object.entries(a.mix).slice(1).map(([k, v]) => `${pct(v)} ${k}`).join(" · ")}`),
    ]),
  ]);
}

function teamCard(t, color, role, detail = false) {
  const r = t.record || {};
  const ratingTile = (labelTxt, v, goodHigh) => {
    const good = goodHigh ? v >= 1 : v <= 1;
    return h("div", { class: "tile" }, [
      h("span", { class: "label" }, labelTxt),
      h("span", { class: "value num" }, `${v.toFixed(2)}×`),
      h("span", { class: `delta ${good ? "up-good" : "down-bad"}` }, `${good ? "▲" : "▼"} ${goodHigh ? (v >= 1 ? "above" : "below") : (v <= 1 ? "better than" : "worse than")} league avg`),
    ]);
  };
  const similar = (t.similar || []).slice(0, 3);
  return h("div", { class: "card stack", style: { gap: "14px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("div", { class: "team-title" }, [h("span", { class: "dot", style: { background: color } }), h("h2", {}, t.label)]),
      h("span", { class: "tag" }, role),
    ]),
    h("div", { class: "row secondary", style: { fontSize: "13px" } }, [
      h("span", {}, t.source === "local" ? "Your club data" : t.competition),
      h("span", { class: "muted" }, "·"),
      h("span", {}, `${t.matches} matches`),
      h("span", { class: "muted" }, "·"),
      h("span", { class: "num" }, `W${r.W} D${r.D} L${r.L}`),
      h("span", { class: "muted" }, "·"),
      h("span", {}, `Usually ${t.formation}`),
    ]),
    archBlock(t.archetype),
    detail ? h("div", { class: "tiles" }, [
      ratingTile("Attack index (chances created)", t.rating.attack, true),
      ratingTile("Defence index (chances conceded)", t.rating.defence, false),
    ]) : null,
    detail && similar.length ? h("div", { class: "stack", style: { gap: "6px" } }, [
      h("span", { class: "sub" }, "Closest pro styles"),
      h("div", { class: "row" }, similar.map((sm) => h("button", {
        class: "chip", title: "Use as opponent",
        onclick: () => { if (sm.id !== state.teamId) { state.oppId = sm.id; save(); renderPickers(); render(); } },
      }, sm.label))),
    ]) : null,
  ]);
}

function scouting(t, color) {
  const box = h("div", { class: "card" });
  const tabs = [
    ["Touches", () => heatmap(t.heat, color, { title: "Touches" })],
    ["Defensive actions", () => heatmap(t.def_heat, color, { title: "Defensive actions" })],
    ["Pass network", () => passNetwork(t.pass_network, color)],
  ];
  const body = h("div");
  const tabBar = h("div", { class: "tabs", role: "tablist" });
  const select = (i) => {
    [...tabBar.children].forEach((b, k) => b.classList.toggle("on", k === i));
    body.replaceChildren(tabs[i][1](), h("p", { class: "chart-note" }, i === 2
      ? `Average positions and completed passes of the starting XI in their usual ${t.formation}, before the first substitution. Attacking left → right.`
      : "Share of actions per zone relative to the busiest zone, all matches. Attacking left → right."));
  };
  tabs.forEach(([name], i) => tabBar.append(h("button", { onclick: () => select(i) }, name)));
  box.append(h("div", { class: "card-head" }, [h("h3", {}, `Scouting · ${t.label}`), tabBar]), body);
  if (!t.has_event_data) {
    body.append(h("div", { class: "empty" }, "Local team — heatmaps and pass networks need event data. Style, ratings and archetype come from your match inputs."));
    tabBar.remove();
  } else select(0);
  return box;
}

export async function renderMatchup() {
  const mu = await api("/matchup", { method: "POST", body: { team_id: state.teamId, opponent_id: state.oppId } });
  const us = mu.team, them = mu.opponent;
  const q = mu.quick;

  const head = h("div", { class: "page-head" }, [
    h("div", {}, [
      h("h1", {}, `${us.label.split(" · ")[0]} vs ${them.label.split(" · ")[0]}`),
      h("p", {}, "Who you're facing, how they play, and what to watch out for."),
    ]),
    h("div", { class: "row" }, [
      h("button", { class: "btn", onclick: () => go("lab") }, "Open Tactics Lab"),
      h("button", { class: "btn primary", onclick: () => go("recommend") }, "Get recommendations →"),
    ]),
  ]);

  const outlook = h("div", { class: "card stack" }, [
    h("h3", {}, "If you play your usual way"),
    wdlBar(q.win, q.draw, q.loss),
    h("p", { class: "secondary" }, `About ${q.xg_for.toFixed(1)} expected goals for you and ${q.xg_against.toFixed(1)} against. Try changes in the Tactics Lab.`),
  ]);

  const risks = h("div", { class: "card" }, [
    h("h3", {}, "3 things to plan for"),
    ...mu.risks.slice(0, 3).map((r) => h("div", { class: "risk" }, [h("span", { class: "ico", "aria-hidden": "true" }, "▲"), h("div", {}, [h("strong", {}, r.title), h("p", { class: "secondary", style: { fontSize: "13px", marginTop: "2px" } }, r.detail)])])),
  ]);

  const zones = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Where to attack, what to protect"), h("span", { class: "sub" }, "you attack left → right")]),
    zonesPitch(mu.zones),
  ]);

  const style = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Style comparison"), h("span", { class: "sub" }, "vs all pro team-matches")]),
    h("div", { class: "legend" }, [
      h("span", {}, [h("span", { class: "dot", style: { background: C.us } }), us.label]),
      h("span", {}, [h("span", { class: "dot", style: { background: C.them } }), them.label]),
    ]),
    styleDumbbell(Object.keys(FEATURE_LABELS), us.archetype.z, them.archetype.z, { nameA: us.label, nameB: them.label, labels: FEATURE_LABELS }),
  ]);

  return h("div", { class: "stack", style: { gap: "20px" } }, [
    head,
    h("div", { class: "grid g2" }, [teamCard(us, C.us, "Your team"), teamCard(them, C.them, "Opponent")]),
    h("div", { class: "grid g2" }, [outlook, risks]),
    zones,
    more("Scouting details", [
      h("div", { class: "grid g2" }, [teamCard(us, C.us, "Ratings", true), teamCard(them, C.them, "Ratings", true)]),
      style,
      h("div", { class: "grid g2" }, [scouting(them, C.them), scouting(us, C.us)]),
    ], { hint: "ratings, style comparison, heatmaps, pass networks" }),
  ]);
}
