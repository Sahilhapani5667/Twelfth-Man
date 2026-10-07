// Coach mode home: the whole game plan in plain football language — no statistics.
import { state, api, save, label } from "../state.js";
import { h, C, zonesPitch } from "../charts.js";
import { go } from "../app.js";

const TONE = { good: C.good, neutral: C.warning, bad: C.serious };

export function planKey() { return `${state.teamId}|${state.oppId}`; }

// Game Plan, Team Sheet and Training all show the same plan: fetch it once per matchup and reuse it.
const planCache = new Map();
export function clearPlanCache() { planCache.clear(); }
export async function loadPlan() {
  const chosen = (state.plans || {})[planKey()];
  const body = { team_id: state.teamId, opponent_id: state.oppId, venue: state.venue, tactics: chosen || null };
  const k = JSON.stringify(body);
  if (!planCache.has(k)) {
    planCache.set(k, api("/gameplan", { method: "POST", body }).catch((e) => { planCache.delete(k); throw e; }));
  }
  return planCache.get(k);
}

const same = (a, b) => a && b && ["formation", "press", "tempo", "width"].every((k) => a[k] === b[k]);

export async function renderGameplan() {
  const g = await loadPlan();
  const plan = g.plan;

  const choose = (tactics) => {
    state.plans = state.plans || {};
    state.plans[planKey()] = tactics;
    save();
    go("plan");
  };

  const options = h("div", { class: "options" }, g.options.map((o) => {
    const selected = same(o.tactics, plan.tactics);
    return h("div", { class: `option ${selected ? "selected" : ""}` }, [
      h("div", { class: "row", style: { justifyContent: "space-between" } }, [
        h("strong", {}, o.name),
        o.recommended ? h("span", { class: "badge" }, "Our pick") : null,
      ]),
      h("p", { class: "secondary" }, o.summary),
      h("ul", { class: "verdicts" }, o.verdicts.map((v) => h("li", { class: v.good ? "good" : "bad" }, [h("span", { "aria-hidden": "true" }, v.good ? "✓ " : "! "), v.text]))),
      o.confidence ? h("p", { class: "sub" }, o.confidence) : null,
      selected ? h("span", { class: "chosen" }, "✓ Current plan") : h("button", { class: "btn small", onclick: () => choose(o.tactics) }, "Use this plan"),
    ]);
  }));

  const setOpp = (id) => { state.oppId = id; save(); go("plan"); setTimeout(() => location.reload(), 30); };
  const setMatch = (a, b, venue) => { state.teamId = a; state.oppId = b; state.venue = venue; save(); go("plan"); setTimeout(() => location.reload(), 30); };
  const myTeam = state.club && state.club.team_id;
  const isPro = (id) => !!state.teams.find((t) => t.id === id && t.source === "statsbomb");
  const proHint = h("section", { class: "coach-card pro-hint" }, [
    h("div", {}, [h("strong", {}, "⚽ Try it against the pros"),
      h("p", { class: "secondary" }, "Every Euro 2024, World Cup 2022 and Premier League 2015/16 team is in the app. Play your team against them — or choose two pro teams in the top bar to simulate any match, with their real past meetings.")]),
    h("div", { class: "row", style: { gap: "8px" } }, [
      ["spain-euro-24", "Spain · Euro 24"], ["argentina-wc-22", "Argentina · WC 22"], ["leicester-city-pl-15-16", "Leicester · PL 15/16"], ["england-euro-24", "England · Euro 24"],
    ].filter(([id]) => id !== state.oppId).map(([id, l]) => h("button", { class: "chip", onclick: () => setOpp(id) }, `vs ${l}`))),
  ]);
  const inspo = h("section", { class: "coach-card pro-hint inspo" }, [
    h("div", {}, [h("strong", {}, "🏆 Watch two professional teams"),
      h("p", { class: "secondary" }, "Simulate a match between two pro sides to see how the plan changes — and take inspiration for your own team.")]),
    h("div", { class: "row", style: { gap: "8px" } }, [
      ["spain-euro-24", "england-euro-24", "neutral", "Spain vs England (Euro 24 final)"],
      ["argentina-wc-22", "france-wc-22", "neutral", "Argentina vs France (WC 22 final)"],
      ["arsenal-pl-15-16", "leicester-city-pl-15-16", "home", "Arsenal vs Leicester (PL 15/16)"],
    ].map(([a, b, v, l]) => h("button", { class: "chip", onclick: () => setMatch(a, b, v) }, l))),
  ]);
  const viewingPros = isPro(state.teamId);
  const backBar = viewingPros && myTeam ? h("div", { class: "row back-bar" }, [
    h("span", { class: "secondary" }, "You're watching two professional teams."),
    h("button", { class: "btn small", onclick: () => setMatch(myTeam, state.oppId && !isPro(state.oppId) ? state.oppId : (state.teams.find((t) => t.source === "scouted") || {}).id || "spain-euro-24", "home") }, "← Back to my club"),
  ]) : null;
  const deeper = h("section", { class: "coach-card deeper" }, [
    h("div", {}, [h("h2", {}, "Analyst tools"),
      h("p", { class: "secondary" }, "For detailed analysis: adjust tactics, review the statistics behind this plan and run match simulations. Also available in the menu.")]),
    h("div", { class: "row", style: { gap: "8px" } }, [
      h("button", { class: "btn", onclick: () => go("lab") }, "Tactics Lab — run simulations"),
      h("button", { class: "btn", onclick: () => go("matchup") }, "Opponent analysis — stats"),
      h("button", { class: "btn", onclick: () => go("recommend") }, "Recommendations"),
    ]),
  ]);

  const past = g.past_meetings || [];
  const pastCard = past.length ? h("section", { class: "coach-card" }, [
    h("h2", {}, "Past meetings"),
    h("p", { class: "sub" }, "Real results between these two teams, with the chances each side created."),
    h("ul", { class: "plain-list" }, past.map((m) => {
      const res = m.us_goals > m.them_goals ? "Won" : m.us_goals === m.them_goals ? "Drew" : "Lost";
      return h("li", {}, [
        h("strong", {}, `${res} ${m.us_goals}–${m.them_goals} · ${m.competition}`),
        h("span", {}, `${new Date(m.date + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · chances created ${m.us_xg.toFixed(1)} vs ${m.them_xg.toFixed(1)}${m.venue !== "neutral" ? ` · ${m.venue}` : ""}`),
      ]);
    })),
  ]) : (isPro(state.teamId) && isPro(state.oppId) ? h("section", { class: "coach-card" }, [
    h("h2", {}, "Past meetings"), h("p", { class: "secondary" }, "These two teams never met in the matches we have (Premier League 2015/16, Euro 2024, World Cup 2022), so this is a pure simulation."),
  ]) : null);

  return h("div", { class: "coach" }, [
    backBar,
    viewingPros ? null : (isPro(state.oppId) ? null : proHint),
    viewingPros ? null : inspo,
    h("div", { class: "coach-head" }, [
      h("p", { class: "eyebrow" }, `Next game · ${state.venue === "away" ? "Away" : state.venue === "neutral" ? "Neutral ground" : "Home"}`),
      h("h1", {}, `${g.team.name} vs ${g.opponent.name}`),
      h("div", { class: "verdict-pill", style: { borderColor: TONE[g.difficulty.tone] } }, [
        h("span", { class: "dot", style: { background: TONE[g.difficulty.tone] } }), g.difficulty.label,
      ]),
      h("p", { class: "lead" }, g.difficulty.text),
    ]),

    pastCard,
    h("section", { class: "coach-card" }, [
      h("h2", {}, "How they play"),
      h("p", { class: "big-line" }, g.opponent.style),
      h("p", { class: "secondary" }, `They usually line up in a ${g.opponent.formation}.`),
      h("h3", { style: { marginTop: "18px" } }, "Watch out for"),
      h("ul", { class: "plain-list" }, g.dangers.map((d) => h("li", {}, [h("strong", {}, d.title), h("span", {}, d.text)]))),
    ]),

    h("section", { class: "coach-card" }, [
      h("h2", {}, "Our plan"),
      h("p", { class: "big-line" }, plan.summary.charAt(0).toUpperCase() + plan.summary.slice(1) + "."),
      plan.change_title ? h("p", { class: "secondary" }, `Change from usual: ${plan.change_title.toLowerCase()}.`) : null,
      h("ol", { class: "plain-list numbered" }, plan.instructions.map((i) => h("li", {}, [h("strong", {}, i.title), h("span", {}, i.text)]))),
      h("div", { class: "pitch-wrap" }, [zonesPitch(g.zones), h("p", { class: "sub" }, "We attack left → right. Blue = attack here, orange = be careful here.")]),
    ]),

    h("section", { class: "coach-card" }, [
      h("h2", {}, "Substitutions"),
      h("p", {}, plan.subs),
    ]),

    h("section", { class: "coach-card" }, [
      h("h2", {}, "Other ways to play it"),
      h("p", { class: "secondary" }, "Pick the plan that suits your players. The team sheet and training update to match."),
      options,
    ]),

    h("div", { class: "coach-actions" }, [
      h("button", { class: "btn primary", onclick: () => go("sheet") }, "Print team sheet for players"),
      h("button", { class: "btn", onclick: () => go("training") }, "This week's training"),
    ]),
    deeper,
  ]);
}
