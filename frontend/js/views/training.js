// This week's training: a full schedule built around the club's training days and the next game.
import { h, drillDiagram, drillLegend } from "../charts.js";
import { loadPlan } from "./gameplan.js";
import { go } from "../app.js";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const INTENSITY = { high: "High intensity", medium: "Medium intensity", low: "Light" };

function weekStrip(week) {
  const byDay = Object.fromEntries(week.sessions.map((s, i) => [s.day, i + 1]));
  return h("div", { class: "week-strip", role: "list" }, DAYS.map((d) => {
    const isMatch = d === week.match_day;
    const n = byDay[d];
    return h("div", { class: `week-day ${isMatch ? "match" : n ? "train" : "rest"}`, role: "listitem" }, [
      h("span", { class: "wd-name" }, d.slice(0, 3)),
      h("span", { class: "wd-what" }, isMatch ? "Match" : n ? `Session ${n}` : "Rest"),
    ]);
  }));
}

function block(b) {
  if (b.type !== "drill") {
    return h("li", { class: "blk" }, [h("span", { class: "blk-min" }, `${b.minutes}'`), h("div", {}, [h("strong", {}, b.name), h("p", { class: "secondary" }, b.text)])]);
  }
  const d = b.drill;
  return h("li", { class: "blk" }, [
    h("span", { class: "blk-min" }, `${b.minutes}'`),
    h("div", { class: "stack", style: { gap: "6px", flex: 1 } }, [
      h("strong", {}, d.name),
      h("p", { class: "secondary" }, d.why),
      h("details", { class: "drill-more" }, [
        h("summary", {}, "Set-up, diagram & coaching points"),
        h("div", { class: "drill-layout", style: { marginTop: "10px" } }, [
          h("div", {}, [drillDiagram(d), drillLegend()]),
          h("div", { class: "stack" }, [
            h("p", {}, [h("strong", {}, "Set-up: "), d.how, ` (${d.area}, ${d.players} players)`]),
            h("div", {}, [h("strong", {}, "Coach it:"), h("ul", { class: "cues" }, d.tips.map((t) => h("li", {}, t)))]),
            h("p", { class: "secondary" }, [h("strong", {}, "Make it harder: "), d.next]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

export async function renderTraining() {
  const g = await loadPlan();
  const week = g.week;
  const total = week.sessions.reduce((a, s) => a + s.minutes, 0);

  return h("div", { class: "coach" }, [
    h("div", { class: "coach-head" }, [
      h("p", { class: "eyebrow" }, `Preparing for ${g.opponent.name}${week.match_day ? " · match on " + week.match_day : ""}`),
      h("h1", {}, "This week's training"),
      h("p", { class: "lead" }, `${week.sessions.length} session${week.sessions.length === 1 ? "" : "s"}, about ${total} minutes in total — each with its own focus, building up to the game.`),
      h("p", { class: "sub" }, week.note),
    ]),
    weekStrip(week),
    g.focus.length ? h("section", { class: "coach-card" }, [
      h("h2", {}, "What we're working on"),
      h("ul", { class: "plain-list" }, g.focus.map((f) => h("li", {}, [h("strong", {}, f.title), h("span", {}, f.text)]))),
    ]) : null,
    ...week.sessions.map((s, i) => h("section", { class: "coach-card session" }, [
      h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } }, [
        h("div", {}, [h("p", { class: "eyebrow" }, `Session ${i + 1} · ${s.day}${s.days_before_match ? ` · ${s.days_before_match === 1 ? "day before the match" : s.days_before_match + " days before the match"}` : ""}`), h("h2", {}, s.title), h("p", { class: "secondary" }, s.why)]),
        h("div", { class: "stack", style: { gap: "4px", alignItems: "flex-end" } }, [h("span", { class: "tag" }, `${s.minutes} min`), h("span", { class: `tag int-${s.intensity}` }, INTENSITY[s.intensity])]),
      ]),
      h("ol", { class: "blocks" }, s.blocks.map(block)),
    ])),
    h("div", { class: "coach-actions no-print" }, [
      h("button", { class: "btn primary", onclick: () => { document.querySelectorAll("details.drill-more").forEach((d) => (d.open = true)); window.print(); } }, "Print the week"),
      h("button", { class: "btn", onclick: () => go("plan") }, "← Back to game plan"),
    ]),
  ]);
}
