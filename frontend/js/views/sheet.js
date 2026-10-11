// Printable team sheet for players: lineup, team instructions, each player's job.
import { state } from "../state.js";
import { h, s, pitch } from "../charts.js";
import { loadPlan } from "./gameplan.js";
import { go } from "../app.js";

const GROUP = (r) => r === "GK" ? "GK" : /CB/.test(r) ? "CB" : /^(LB|RB|LWB|RWB)$/.test(r) ? "FB" : /^(LW|RW|LM|RM|LAM|RAM)$/.test(r) ? "W" : /^(ST|LS|RS)$/.test(r) ? "ST" : "CM";
const POS = (p) => ({ GK: "GK", CB: "CB", LB: "FB", RB: "FB", LWB: "FB", RWB: "FB", LM: "W", RM: "W", LW: "W", RW: "W", ST: "ST", CF: "ST" }[p] || "CM");

function lineup(slots, roster, key) {
  if (state.lineups[key]) return state.lineups[key];
  const left = [...roster];
  const out = slots.map(() => null);
  for (const strict of [true, false]) slots.forEach((sl, i) => {
    if (out[i]) return;
    const k = left.findIndex((p) => !strict || POS(p.position) === GROUP(sl.role));
    if (k >= 0) out[i] = left.splice(k, 1)[0].name;
  });
  return out;
}

export async function renderSheet() {
  const g = await loadPlan();
  const plan = g.plan;
  const formation = plan.tactics.formation;
  const slots = state.meta.formations[formation].slots;
  const names = lineup(slots, g.team.roster, `${g.team.id}|${formation}`);

  const { svg, layer } = pitch({ light: true, width: 640 });
  slots.forEach((sl, i) => {
    layer.append(s("circle", { cx: sl.x, cy: sl.y, r: 4.2, fill: "#3987e5", stroke: "#fff", "stroke-width": 0.8 }));
    layer.append(s("text", { x: sl.x, y: sl.y + 1.1, "text-anchor": "middle", "font-size": 2.6, "font-weight": 700, style: "fill:#fff" }, sl.role));
    if (names[i]) layer.append(s("text", { x: sl.x, y: sl.y + 8, "text-anchor": "middle", "font-size": 3, "font-weight": 600, style: "fill:#0b0b0b" }, names[i]));
  });

  const sheet = h("div", { class: "report sheet" }, [
    h("p", { class: "eyebrow" }, "Team sheet"),
    h("h1", {}, `${g.team.name} vs ${g.opponent.name}`),
    h("p", { class: "muted" }, plan.summary.charAt(0).toUpperCase() + plan.summary.slice(1)),
    h("div", { style: { margin: "14px 0" } }, svg),
    h("h2", {}, "How we play"),
    h("ol", { class: "plain-list numbered" }, plan.instructions.map((i) => h("li", {}, [h("strong", {}, i.title), h("span", {}, i.text)]))),
    h("h2", {}, "Your job"),
    h("div", { class: "roles" }, plan.roles.map((r) => h("div", { class: "role" }, [h("strong", {}, r.group), h("ul", {}, r.jobs.map((j) => h("li", {}, j)))]))),
    h("h2", {}, "Watch out for"),
    h("ul", { class: "plain-list" }, g.dangers.map((d) => h("li", {}, [h("strong", {}, d.title), h("span", {}, d.text)]))),
    h("h2", {}, "Substitutions"),
    h("p", {}, plan.subs),
  ]);

  return h("div", { class: "stack", style: { gap: "16px" } }, [
    h("div", { class: "row no-print" }, [
      h("button", { class: "btn primary", onclick: () => window.print() }, "Print / save as PDF"),
      h("button", { class: "btn", onclick: () => go("plan") }, "← Back to game plan"),
      g.team.roster.length ? null : h("span", { class: "sub" }, "Tip: add your squad in Results & Squad to put names on the pitch."),
    ]),
    sheet,
  ]);
}
