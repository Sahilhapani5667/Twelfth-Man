import { state, api, save, team, tacticsFor, simBody, toast } from "../state.js";
import { h, s, C, pct, signed, signedPct, wdlBar, columns, dualHistogram, divergingBars, shotMap, pitch, bindTip, more } from "../charts.js";
import { go } from "../app.js";

const LEVER_TEXT = {
  press: ["Press height", "Deep block", "High press"],
  tempo: ["Tempo", "Patient build-up", "Direct"],
  width: ["Width", "Narrow", "Wide"],
};
const LEVER_LABEL = { press: "Press height", tempo: "Tempo / directness", width: "Width", formation: "Formation", adaptation: "Adaptation cost" };

// ---------------------------------------------------------------- lineup
const ROLE_GROUP = (r) => r === "GK" ? "GK" : /CB/.test(r) ? "CB" : /^(LB|RB|LWB|RWB)$/.test(r) ? "FB" : /^(LW|RW|LM|RM|LAM|RAM)$/.test(r) ? "W" : /^(ST|LS|RS)$/.test(r) ? "ST" : "CM";
const POS_GROUP = (p) => ({ GK: "GK", CB: "CB", LB: "FB", RB: "FB", LWB: "FB", RWB: "FB", LM: "W", RM: "W", LW: "W", RW: "W", ST: "ST", CF: "ST", CM: "CM", CDM: "CM", CAM: "CM", DM: "CM", AM: "CM" }[p] || "CM");

function autoLineup(slots, roster) {
  const left = [...roster];
  const out = slots.map(() => null);
  for (const pass of [true, false]) {
    slots.forEach((sl, i) => {
      if (out[i]) return;
      const k = left.findIndex((p) => !pass || POS_GROUP(p.position) === ROLE_GROUP(sl.role));
      if (k >= 0) out[i] = left.splice(k, 1)[0].name;
    });
  }
  return out;
}

function lineupEditor(t, formation, onChange) {
  const slots = state.meta.formations[formation].slots;
  const roster = t.roster || [];
  const key = `${t.id}|${formation}`;
  if (roster.length && !state.lineups[key]) state.lineups[key] = autoLineup(slots, roster);
  const names = state.lineups[key] || slots.map(() => null);

  const wrap = h("div", { class: "lineup-pitch" });
  const { svg, layer } = pitch({ width: 520 });
  slots.forEach((sl, i) => {
    const g = s("g", { class: "slot", "data-slot": i });
    g.append(s("circle", { cx: sl.x, cy: sl.y, r: 4.2, fill: C.us, stroke: "#16201a", "stroke-width": 0.8 }));
    g.append(s("text", { x: sl.x, y: sl.y + 1.1, "text-anchor": "middle", "font-size": 2.6, "font-weight": 700, fill: "#fff", style: "fill:#fff" }, sl.role));
    if (names[i]) g.append(s("text", { x: sl.x, y: sl.y + 8, "text-anchor": "middle", "font-size": 2.8, class: "t-primary" }, names[i].split(" ").slice(-1)[0]));
    bindTip(g, () => [{ value: names[i] || "Unassigned", label: sl.role }, roster.length ? "Drag to swap, or drag a bench player here" : "Add a roster in Club Data to name players"]);
    layer.append(g);
  });
  wrap.append(svg);

  const used = new Set(names.filter(Boolean));
  const bench = roster.filter((p) => !used.has(p.name));
  if (roster.length) {
    wrap.append(h("div", { class: "sub", style: { marginTop: "6px" } }, "Bench — drag onto a position"));
    wrap.append(h("div", { class: "bench" }, bench.map((p) => h("span", { class: "chip", "data-bench": p.name }, `${p.number ? p.number + " · " : ""}${p.name} (${p.position})`))));
  }

  // pointer-based drag & drop (works for mouse and touch)
  let drag = null;
  wrap.addEventListener("pointerdown", (e) => {
    const slot = e.target.closest("[data-slot]");
    const chip = e.target.closest("[data-bench]");
    if (!slot && !chip) return;
    e.preventDefault();
    const name = slot ? names[+slot.dataset.slot] : chip.dataset.bench;
    if (!name) return;
    const ghost = h("div", { class: "chip on", style: { position: "fixed", pointerEvents: "none", zIndex: 99, left: `${e.clientX + 8}px`, top: `${e.clientY + 8}px` } }, name);
    document.body.append(ghost);
    drag = { from: slot ? +slot.dataset.slot : null, name, ghost };
  });
  const move = (e) => { if (drag) { drag.ghost.style.left = `${e.clientX + 8}px`; drag.ghost.style.top = `${e.clientY + 8}px`; } };
  const up = (e) => {
    if (!drag) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const slot = target && target.closest && target.closest("[data-slot]");
    const toBench = target && target.closest && target.closest(".bench");
    const arr = [...names];
    if (slot && wrap.contains(slot)) {
      const to = +slot.dataset.slot;
      if (drag.from === null) arr[to] = drag.name;
      else { const tmp = arr[to]; arr[to] = arr[drag.from]; arr[drag.from] = tmp; }
    } else if (toBench && drag.from !== null) arr[drag.from] = null;
    drag.ghost.remove();
    const changed = JSON.stringify(arr) !== JSON.stringify(names);
    drag = null;
    if (changed) { state.lineups[key] = arr; save(); onChange(); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: false });
  wrap._cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  return wrap;
}

// ---------------------------------------------------------------- controls
function slider(lever, tactics, usual, onInput) {
  const [name, lo, hi] = LEVER_TEXT[lever];
  const val = h("strong", { class: "num" }, String(tactics[lever]));
  const input = h("input", { type: "range", min: 0, max: 100, step: 1, value: tactics[lever], "aria-label": name });
  input.addEventListener("input", () => { tactics[lever] = +input.value; val.textContent = input.value; onInput(); });
  return h("div", { class: "slider" }, [
    h("div", { class: "slider-top" }, [h("span", {}, name), h("span", {}, [val, h("span", { class: "usual-mark" }, `  usual ${usual[lever]}`)])]),
    input,
    h("div", { class: "slider-ends" }, [h("span", {}, lo), h("span", {}, hi)]),
  ]);
}

function subsEditor(t, onChange) {
  const box = h("div", { class: "stack", style: { gap: "8px" } });
  const roster = (t.roster || []).map((p) => p.name);
  const draw = () => {
    box.replaceChildren();
    state.subs.forEach((sb, i) => {
      const minute = h("input", { type: "number", min: 1, max: 89, value: sb.minute, "aria-label": "Minute" });
      minute.addEventListener("change", () => { sb.minute = Math.max(1, Math.min(89, +minute.value || 60)); save(); onChange(); });
      const type = h("select", { "aria-label": "Substitution type" }, ["like-for-like", "attacking", "defensive"].map((v) => h("option", { value: v, selected: sb.type === v }, v)));
      type.addEventListener("change", () => { sb.type = type.value; save(); onChange(); });
      const rm = h("button", { class: "btn small ghost", "aria-label": "Remove substitution", onclick: () => { state.subs.splice(i, 1); save(); draw(); onChange(); } }, "✕");
      box.append(h("div", { class: "sub-row" }, [minute, type, rm]));
      if (roster.length) {
        const mk = (field, lab) => {
          const sel = h("select", { "aria-label": lab }, [h("option", { value: "" }, lab), ...roster.map((n) => h("option", { value: n, selected: sb[field] === n }, n))]);
          sel.addEventListener("change", () => { sb[field] = sel.value; save(); });
          return sel;
        };
        box.append(h("div", { class: "row", style: { gap: "6px", marginTop: "-2px" } }, [mk("off", "Off…"), mk("on", "On…")]));
      }
    });
    if (state.subs.length < 5) box.append(h("button", { class: "btn small", onclick: () => { state.subs.push({ minute: [60, 70, 78, 84, 88][state.subs.length], type: "like-for-like" }); save(); draw(); onChange(); } }, "+ Add substitution"));
  };
  draw();
  return box;
}

// ---------------------------------------------------------------- results
function deltaTile(labelTxt, value, delta, { fmt = (v) => v.toFixed(2), dfmt = (v) => signed(v), goodUp = true, band } = {}) {
  const good = goodUp ? delta > 0.0005 : delta < -0.0005;
  const bad = goodUp ? delta < -0.0005 : delta > 0.0005;
  return h("div", { class: "tile" }, [
    h("span", { class: "label" }, labelTxt),
    h("span", { class: "value num" }, fmt(value)),
    band ? h("span", { class: "delta muted num" }, `90% range ${fmt(band[0])}–${fmt(band[1])}`) : null,
    delta !== undefined ? h("span", { class: `delta num ${good ? "up-good" : bad ? "down-bad" : ""}` }, `${good ? "▲" : bad ? "▼" : "•"} ${dfmt(delta)} vs usual`) : null,
  ]);
}

function results(r) {
  const d = r.delta || {};
  const wrap = h("div", { class: "stack", style: { gap: "16px" } });
  wrap.append(h("div", { class: "card stack" }, [
    h("div", { class: "card-head" }, [h("h3", {}, `Simulated outcome · ${r.n_sims.toLocaleString()} matches`), h("span", { class: "sub" }, "win band = 90% range across parameter uncertainty")]),
    wdlBar(r.win, r.draw, r.loss, { band: r.win_band }),
    h("div", { class: "tiles" }, [
      deltaTile("Win probability", r.win, d.win, { fmt: (v) => pct(v), dfmt: (v) => signedPct(v, 1) }),
      deltaTile("Chances you create (xG)", r.xg_for, d.xg_for),
      deltaTile("Chances you concede (xG)", r.xg_against, d.xg_against, { goodUp: false }),
    ]),
    r.notes.length ? h("ul", { class: "cues" }, r.notes.map((n) => h("li", {}, n))) : null,
  ]));

  const detail = [];
  const goals = columns(["0", "1", "2", "3", "4", "5", "6+"], [
    { name: "Goals scored", color: C.us, values: r.goals_for_dist },
    { name: "Goals conceded", color: C.them, values: r.goals_against_dist },
  ], { valueLabel: "of simulations" });
  detail.push(h("div", { class: "grid g2" }, [
    h("div", { class: "card" }, [h("h3", {}, "Goals distribution"), legend2("Scored", "Conceded"), goals]),
    h("div", { class: "card" }, [h("h3", {}, "Expected-goals uncertainty"), legend2("xG for", "xG against"),
      dualHistogram(r.xg_for_samples, r.xg_against_samples),
      h("p", { class: "chart-note" }, "Each scenario redraws team ratings and tactic effects from their estimated uncertainty.")]),
  ]));

  const timing = columns(["0-15", "15-30", "30-45", "45-60", "60-75", "75-90+"], [
    { name: "Goals scored", color: C.us, values: r.timing_for },
    { name: "Goals conceded", color: C.them, values: r.timing_against },
  ], { fmt: (v) => v.toFixed(2), valueLabel: "per match" });
  const risk = r.risk;
  detail.push(h("div", { class: "grid g2" }, [
    h("div", { class: "card" }, [h("h3", {}, "When goals happen"), legend2("Scored", "Conceded"), timing,
      h("p", { class: "chart-note" }, "Timing profile from 495 pro matches; pressing fatigue and substitutions reshape the last half hour.")]),
    h("div", { class: "card" }, [h("h3", {}, "Risk profile"), h("div", { class: "tiles" }, [
      tile("Clean sheet", pct(r.clean_sheet)), tile("Concede 2+", pct(r.concede_2plus)),
      tile("Score first", pct(r.score_first)), tile("Concede after 75'", pct(r.late_concede)),
      tile("Counter-attack xGA", risk.counter_xga.toFixed(2)),
      tile("Fatigue load", risk.fatigue_index.toFixed(2), risk.fatigue_index > 0.8 ? "High — plan subs" : risk.fatigue_index > 0.3 ? "Moderate" : "Low"),
    ])]),
  ]));

  const rows = [];
  for (const lev of ["press", "tempo", "width", "formation", "adaptation"]) {
    const a = r.drivers.xg[lev], b = r.drivers.xga[lev];
    if (Math.abs(a) < 0.001 && Math.abs(b) < 0.001) continue;
    rows.push({ label: `${LEVER_LABEL[lev]} · xG for`, value: a, color: a >= 0 ? C.us : C.them, note: "Positive is good" });
    rows.push({ label: `${LEVER_LABEL[lev]} · xG against`, value: b, color: b <= 0 ? C.us : C.them, note: "Negative is good" });
  }
  const drivers = h("div", { class: "card" }, [h("h3", {}, "What's driving the change"),
    rows.length ? divergingBars(rows) : h("div", { class: "empty" }, "Same as your usual set-up — move a slider or change formation to see drivers."),
    rows.length ? h("p", { class: "chart-note" }, "Blue = helps you, orange = hurts you. Effects are within-team estimates from pro data, halved for game-state bias.") : null]);

  const shotBox = h("div");
  const tabs = h("div", { class: "tabs" });
  const showShots = (i) => {
    [...tabs.children].forEach((b, k) => b.classList.toggle("on", k === i));
    shotBox.replaceChildren(i === 0 ? shotMap(r.shot_map, C.us, { label: "Expected shot" }) : shotMap(r.shot_map_against, C.them, { label: "Expected shot against" }));
  };
  ["Your chances", "Chances against"].forEach((n, i) => tabs.append(h("button", { onclick: () => showShots(i) }, n)));
  showShots(0);
  detail.push(h("div", { class: "grid g2" }, [
    drivers,
    h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", {}, "Typical shot map"), tabs]), shotBox,
      h("p", { class: "chart-note" }, "Sampled from each team's historical shot locations (or its archetype's), scaled to this scenario's xG. Circle size = xG.")]),
  ]));

  detail.push(h("div", { class: "card" }, [h("h3", {}, "Most likely scorelines"),
    h("div", { class: "table-wrap" }, h("table", {}, [
      h("thead", {}, h("tr", {}, [h("th", {}, "Score (you–them)"), h("th", {}, "Share of simulations")])),
      h("tbody", {}, r.scorelines.map((sc) => h("tr", {}, [h("td", {}, sc.score), h("td", {}, pct(sc.p, 1))]))),
    ]))]));
  wrap.append(more("Full analysis", detail, { hint: "goal timing, risks, drivers, shot maps, scorelines" }));
  return wrap;
}

const tile = (l, v, d) => h("div", { class: "tile" }, [h("span", { class: "label" }, l), h("span", { class: "value num" }, v), d ? h("span", { class: "delta" }, d) : null]);
const legend2 = (a, b) => h("div", { class: "legend" }, [
  h("span", {}, [h("span", { class: "key-rect", style: { background: C.us } }), a]),
  h("span", {}, [h("span", { class: "key-rect", style: { background: C.them } }), b]),
]);

// ---------------------------------------------------------------- view
export async function renderLab() {
  const t = await team(state.teamId);
  const tactics = await tacticsFor(state.teamId);
  const usual = t.default_tactics;
  const out = h("div", { class: "stack", id: "lab-results" });
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = "Simulating…";
    out.classList.add("loading");
    try {
      const r = await api("/simulate", { method: "POST", body: simBody() });
      state.lastSim = r;
      out.replaceChildren(results(r));
    } catch (e) {
      out.replaceChildren(h("div", { class: "card errors" }, e.message));
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = "Run simulation";
      out.classList.remove("loading");
    }
  };

  const changed = () => { save(); };
  const runBtn = h("button", { class: "btn primary", onclick: run }, "Run simulation");

  const formationRow = h("div", { class: "row", style: { gap: "6px" } });
  const lineupBox = h("div");
  const drawLineup = () => {
    if (lineupBox.firstChild && lineupBox.firstChild._cleanup) lineupBox.firstChild._cleanup();
    lineupBox.replaceChildren(lineupEditor(t, tactics.formation, drawLineup));
  };
  const drawFormations = () => {
    formationRow.replaceChildren(...Object.keys(state.meta.formations).map((f) => h("button", {
      class: `chip ${tactics.formation === f ? "on" : ""}`, title: state.meta.formations[f].note,
      onclick: () => { tactics.formation = f; changed(); drawFormations(); drawLineup(); note.textContent = state.meta.formations[f].note; },
    }, f + (usual.formation === f ? " ·usual" : ""))));
  };
  const note = h("p", { class: "chart-note" }, state.meta.formations[tactics.formation].note);
  drawFormations();
  drawLineup();

  const cond = h("select", { "aria-label": "Conditions" }, [["normal", "Normal"], ["rain", "Heavy rain"], ["wind", "Strong wind"], ["heat", "Hot day"]].map(([v, l]) => h("option", { value: v, selected: state.conditions === v }, l)));
  cond.addEventListener("change", () => { state.conditions = cond.value; save(); });
  const sims = h("select", { "aria-label": "Number of simulations" }, [2000, 10000, 25000].map((n) => h("option", { value: n, selected: state.nSims === n }, `${n.toLocaleString()} sims`)));
  sims.addEventListener("change", () => { state.nSims = +sims.value; save(); });

  const controls = h("div", { class: "card stack", style: { gap: "14px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Scenario editor"), h("button", {
      class: "btn small ghost", onclick: () => { Object.assign(tactics, usual); state.subs = []; state.conditions = "normal"; save(); location.reload(); },
    }, "Reset to usual")]),
    h("div", { class: "stack", style: { gap: "6px" } }, [h("span", { class: "sub" }, "Formation"), formationRow, note]),
    ...["press", "tempo", "width"].map((l) => slider(l, tactics, usual, changed)),
    more("Lineup", [lineupBox, h("p", { class: "chart-note" }, "The lineup feeds your match plan. The simulation is team-level.")], { hint: "drag players into positions" }),
    more("Substitutions & conditions", [
      subsEditor(t, changed),
      h("div", { class: "form-grid" }, [h("label", { class: "field" }, ["Conditions", cond]), h("label", { class: "field" }, ["Simulations", sims])]),
    ], { hint: state.subs.length ? `${state.subs.length} planned` : "optional" }),
    h("div", { class: "row" }, [runBtn, h("button", { class: "btn", onclick: () => go("recommend") }, "Recommend changes")]),
  ]);

  const page = h("div", { class: "stack", style: { gap: "16px" } }, [
    h("div", { class: "page-head" }, [h("div", {}, [
      h("h1", {}, "Tactics Lab"),
      h("p", {}, `Change ${t.label.split(" · ")[0]}'s shape and style, then run a minute-by-minute Monte Carlo against ${state.teams.find((x) => x.id === state.oppId)?.label.split(" · ")[0]}. Results are distributions, not certainties.`),
    ])]),
    h("div", { class: "grid lab-grid" }, [controls, out]),
  ]);
  out.append(h("div", { class: "card empty" }, "Running your usual set-up…"));
  setTimeout(run, 0);
  return page;
}
