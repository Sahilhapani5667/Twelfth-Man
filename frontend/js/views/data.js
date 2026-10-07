import { state, api, save, team, toast } from "../state.js";
import { h, C, ARCH_COLORS, pct, bindTip, lineChart , more } from "../charts.js";
import { renderPickers, reloadTeams } from "../app.js";

// Club Data: grassroots coaches enter and manage their own teams, matches and squads.
// Everything here is stored by the local server in data/local.db and never leaves the machine.

const POSITIONS = ["GK", "RB", "CB", "LB", "RWB", "LWB", "CDM", "CM", "CAM", "RM", "LM", "RW", "LW", "ST"];
const LEVELS = ["U8", "U10", "U12", "U14", "U16", "U18", "U21", "Senior", "Sunday League", "Veterans", "Women's", "Girls"];
const FALLBACK_FORMATIONS = ["4-4-2", "4-3-3", "4-2-3-1", "4-1-4-1", "3-5-2", "3-4-3"];

const RATINGS = {
  press_rating: { label: "Press height", opts: ["deep block", "low-mid block", "mid block", "high press", "very high press"] },
  directness_rating: { label: "Directness", opts: ["patient short build-up", "mostly short passing", "mixed", "often direct", "very direct"] },
  width_rating: { label: "Width", opts: ["very narrow", "narrow", "balanced", "wide", "very wide"] },
};

const STR_FIELDS = ["date", "opponent", "venue", "formation", "notes"];
const NUM_FIELDS = ["goals_for", "goals_against", "shots_for", "shots_against", "sot_for", "sot_against", "possession",
  "passes_attempted", "passes_completed", "press_rating", "directness_rating", "width_rating", "corners_for", "late_goals_against"];
const REQUIRED = ["date", "opponent", "formation", "goals_for", "goals_against", "shots_for", "shots_against"];
const OPTIONAL = ["venue", "sot_for", "sot_against", "possession", "passes_attempted", "passes_completed",
  "press_rating", "directness_rating", "width_rating", "corners_for", "late_goals_against", "notes"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------- small helpers
const enc = encodeURIComponent;
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
const pair = (a, b) => (a == null && b == null ? "—" : `${a == null ? "?" : a}–${b == null ? "?" : b}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const matchesTxt = (n) => plural(n, "match", "matches");

function shortDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]}` : String(iso);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formations() {
  return state.meta && state.meta.formations ? Object.keys(state.meta.formations) : FALLBACK_FORMATIONS;
}

function field(text, control, { required = false, hint, wide = false } = {}) {
  return h("label", { class: "field", style: wide ? { gridColumn: "1 / -1" } : null }, [
    h("span", {}, required ? [text, h("span", { "aria-hidden": "true" }, " *")] : text),
    control,
    hint ? h("span", { style: { fontSize: "11px" } }, hint) : null,
  ]);
}

function numInput(name, { required = false, min = 0, max, step = 1, placeholder } = {}) {
  return h("input", { type: "number", name, required, min, max, step, placeholder, inputmode: step === 1 ? "numeric" : "decimal" });
}

function errorsBox(title, e) {
  const list = e && Array.isArray(e.errors) && e.errors.length ? e.errors : [e && e.message ? e.message : String(e)];
  return h("div", { class: "errors", role: "alert" }, [h("strong", {}, title), h("ul", {}, list.map((x) => h("li", {}, String(x))))]);
}

const tile = (labelTxt, value, delta, cls = "") => h("div", { class: "tile" }, [
  h("span", { class: "label" }, labelTxt),
  h("span", { class: "value num" }, value),
  delta ? h("span", { class: `delta ${cls}` }, delta) : null,
]);

const section = (title, children) => h("div", { class: "stack", style: { gap: "8px" } }, [h("span", { class: "sub" }, title), ...children]);

// ---------------------------------------------------------------- view
export async function renderData() {
  const root = h("div", { class: "stack", style: { gap: "16px" } });
  const ctx = { root, teams: await api("/local/teams"), selId: null, token: 0, keep: null };
  const isLocal = (id) => ctx.teams.some((t) => t.id === id);
  ctx.selId = isLocal(state.teamId) ? state.teamId : (ctx.teams.length ? ctx.teams[0].id : null);
  await draw(ctx);
  return root;
}

const current = (ctx) => ctx.teams.find((t) => t.id === ctx.selId) || null;

/** Re-fetch everything after a mutation and redraw in place (forms and messages are kept). */
async function refresh(ctx) {
  const [, teams] = await Promise.all([reloadTeams(), api("/local/teams")]);
  save(); // reloadTeams may have re-pointed state.teamId / state.oppId
  ctx.teams = teams;
  if (!current(ctx)) ctx.selId = teams.length ? teams[0].id : null;
  await draw(ctx);
}

async function draw(ctx) {
  const token = ++ctx.token;
  const sel = current(ctx);
  let parts;
  if (!sel) {
    ctx.keep = null;
    parts = [h("div", { class: "card empty" }, [
      h("p", {}, "No local teams yet."),
      h("p", { class: "sub", style: { marginTop: "6px" } }, "Create your team above, then import a season from a CSV file or add matches one at a time. A profile, archetype and ratings appear after the first match."),
    ])];
  } else {
    const [matches, profile] = await Promise.all([
      api(`/local/teams/${enc(sel.id)}/matches`),
      sel.matches > 0 ? team(sel.id, { fresh: true }).catch(() => null) : Promise.resolve(null),
    ]);
    if (token !== ctx.token) return;
    if (!ctx.keep || ctx.keep.id !== sel.id) {
      ctx.keep = {
        id: sel.id,
        csv: csvCard(ctx, sel.id),
        form: matchFormCard(ctx, sel.id, profile ? profile.formation : null),
        roster: rosterCard(ctx, sel.id, sel.roster || []),
      };
    }
    parts = [
      summaryCard(ctx, sel, profile, matches),
      ctx.keep.form,
      more("Import a whole season from CSV", [ctx.keep.csv, guideCard()], { hint: "spreadsheet upload + what each column means" }),
      more(`All matches (${matches.length})`, [matchesCard(ctx, sel, matches)]),
      more(`Squad (${(sel.roster || []).length} players)`, [ctx.keep.roster], { hint: "names used in the lineup and match plan" }),
    ];
  }
  if (token !== ctx.token) return;
  ctx.root.replaceChildren(pageHead(), teamBar(ctx), ...parts);
}

// ---------------------------------------------------------------- page head
function pageHead() {
  const online = state.meta && state.meta.assistant && state.meta.assistant.enabled;
  return h("div", { class: "page-head" }, [
    h("div", {}, [
      h("h1", {}, "Results & Squad"),
      h("p", {}, "Add your matches after each game — the rest of the app updates automatically. Your data stays on this computer."
        + (online ? " When you ask Coach Twelve, our AI coach, a question, that match's plan, recent results and squad names are sent to write the answer." : "")),
    ]),
    h("span", { class: "pill" }, [h("span", { class: "dot", style: { background: C.good } }), "Stored only on this computer"]),
  ]);
}

// ---------------------------------------------------------------- team selector + new team
function teamBar(ctx) {
  const chips = ctx.teams.map((t) => {
    const on = t.id === ctx.selId;
    const mine = t.id === state.teamId;
    return h("button", {
      class: `chip${on ? " on" : ""}`, type: "button", "aria-pressed": on ? "true" : "false",
      title: mine ? "Currently selected as your team" : null,
      onclick: () => { if (!on) { ctx.selId = t.id; draw(ctx); } },
    }, [
      mine ? h("span", { class: "dot", style: { background: C.us } }) : null,
      t.name,
      h("span", { class: "muted" }, `${t.level ? ` · ${t.level}` : ""} · ${matchesTxt(t.matches)}`),
    ]);
  });

  const name = h("input", { type: "text", name: "name", required: true, maxlength: 60, placeholder: "e.g. Riverside FC", autocomplete: "off" });
  const level = h("input", { type: "text", name: "level", maxlength: 30, list: "club-level-options", placeholder: "U18, Senior, Sunday League…", autocomplete: "off" });
  const btn = h("button", { class: "btn primary", type: "submit" }, "Create team");
  const status = h("div");
  const form = h("form", { class: "form-grid", style: { alignItems: "end" } }, [
    field("Team name", name, { required: true }),
    field("Level", level),
    h("datalist", { id: "club-level-options" }, LEVELS.map((l) => h("option", { value: l }))),
    h("div", { class: "field" }, [btn]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.replaceChildren();
    btn.disabled = true;
    try {
      const t = await api("/local/teams", { method: "POST", body: { name: name.value.trim(), level: level.value.trim(), roster: [] } });
      ctx.selId = t.id;
      await refresh(ctx);
      toast(`Created ${t.name}. Add matches to build its profile.`);
    } catch (err) {
      status.replaceChildren(errorsBox("Could not create the team.", err));
      btn.disabled = false;
    }
  });

  return h("div", { class: "card stack", style: { gap: "14px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("h3", {}, "Your teams"),
      h("span", { class: "sub" }, ctx.teams.length ? "Pick a team to manage its data" : "Start by creating a team"),
    ]),
    chips.length ? h("div", { class: "row", role: "group", "aria-label": "Local teams" }, chips) : null,
    chips.length ? h("div", { class: "divider", style: { margin: "2px 0" } }) : null,
    h("span", { class: "sub" }, "New team"),
    form,
    status,
  ]);
}

// ---------------------------------------------------------------- summary
function summaryCard(ctx, t, profile, matches) {
  const mine = state.teamId === t.id;
  const useBtn = h("button", {
    class: "btn primary small", type: "button", disabled: mine || !t.matches,
    title: !t.matches ? "Add at least one match first" : null,
    onclick: async () => {
      state.teamId = t.id;
      state.subs = [];
      if (state.oppId === t.id) await reloadTeams(); // picks a different opponent
      save();
      renderPickers();
      toast(`${t.name} is now your team in every view.`);
      draw(ctx);
    },
  }, mine ? "✓ Your team" : "Use as my team");

  const delBtn = h("button", {
    class: "btn small ghost", type: "button",
    onclick: async () => {
      const msg = `Delete "${t.name}"${t.matches ? ` and its ${matchesTxt(t.matches)}` : ""} from this computer? This cannot be undone.`;
      if (!confirm(msg)) return;
      delBtn.disabled = true;
      try {
        await api(`/local/teams/${enc(t.id)}`, { method: "DELETE" });
        delete state.tactics[t.id];
        ctx.selId = null;
        await refresh(ctx);
        toast(`Deleted ${t.name}.`);
      } catch (err) {
        delBtn.disabled = false;
        toast(`Could not delete: ${err.message}`);
      }
    },
  }, "Delete team");

  const head = h("div", { class: "card-head", style: { marginBottom: 0 } }, [
    h("div", { class: "team-title" }, [
      h("span", { class: "dot", style: { background: C.us } }),
      h("h2", {}, t.name),
      t.level ? h("span", { class: "tag" }, t.level) : null,
    ]),
    h("div", { class: "row" }, [useBtn, delBtn]),
  ]);

  if (!profile) {
    return h("div", { class: "card stack", style: { gap: "14px" } }, [
      head,
      h("p", { class: "secondary" }, t.matches
        ? "The profile could not be built right now. Check the matches below."
        : "No matches yet. Import a CSV or add your first match below. The team profile, archetype and ratings appear after one match and steady from about 8."),
    ]);
  }

  const r = profile.record || {};
  const rt = profile.rating || {};
  const a = profile.archetype || {};
  const att = rt.attack, def = rt.defence;
  const used = Object.entries(profile.formations_used || {}).filter(([f]) => f !== profile.formation);
  const n = profile.matches;

  const form = (profile.trend || []).slice(-5).map((m) => (m.gf > m.ga ? "W" : m.gf === m.ga ? "D" : "L"));
  const formColor = { W: C.good, D: C.muted, L: C.serious };
  const notes = [];
  if (att != null) notes.push(att >= 1.1 ? "✓ You create plenty of chances." : att <= 0.9 ? "! You don't create many chances." : "• You create about as many chances as your opponents.");
  if (def != null) notes.push(def <= 0.9 ? "✓ You're hard to break down." : def >= 1.1 ? "! You give away too many chances." : "• Your defending is about average for your league.");
  const missing = [];
  if (!matches.some((m) => m.sot_for != null)) missing.push("shots on target");
  if (!matches.some((m) => m.press_rating != null)) missing.push("how high you pressed (1–5)");

  return h("div", { class: "card stack", style: { gap: "16px" } }, [
    head,
    h("div", { class: "row", style: { gap: "36px" } }, [
      h("div", { class: "big-stat" }, [h("span", { class: "value num" }, `${r.W}-${r.D}-${r.L}`), h("span", { class: "label" }, `won-drawn-lost · ${n} games`)]),
      h("div", { class: "big-stat" }, [h("span", { class: "value num" }, `${r.gf}–${r.ga}`), h("span", { class: "label" }, "goals for–against")]),
      form.length ? h("div", { class: "big-stat" }, [
        h("div", { class: "row", style: { gap: "4px" } }, form.map((f) => h("span", { class: "chip", style: { borderColor: formColor[f], color: "var(--text-primary)", fontWeight: 700 } }, f))),
        h("span", { class: "label" }, "last 5 games"),
      ]) : null,
    ]),
    a.name ? h("p", { class: "big-line" }, `You usually play ${profile.formation}. ${PLAIN_STYLE[a.name] || a.description || ""}`) : null,
    notes.length ? h("ul", { class: "plain-list" }, notes.map((x) => h("li", {}, x))) : null,
    n < 5 ? h("p", { class: "secondary" }, `Add a few more games — advice gets more reliable after about 5–8 matches.`) : null,
    missing.length ? h("p", { class: "sub" }, `Tip: also record ${missing.join(" and ")} — it makes the advice more accurate.`) : null,
  ]);
}

const PLAIN_STYLE = {
  "Possession & High Press": "You like to keep the ball and win it back high up the pitch.",
  "Controlled Possession": "You like to keep the ball with short, patient passing.",
  "Wide Balanced Block": "You play a balanced game and attack a lot down the wings.",
  "Counter-Attacking Low Block": "You defend deep and break forward fast.",
  "Direct & Physical": "You go forward quickly with longer passes and fight for second balls.",
  "Compact Mid Block": "You stay compact and organised and mix short and long passes.",
};

function trendCard(profile) {
  const tr = profile && profile.trend;
  if (!tr || tr.length < 2) return null;
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Chances by match"), h("span", { class: "sub" }, "estimated xG, oldest → newest")]),
    h("div", { class: "legend" }, [
      h("span", {}, [h("span", { class: "key-line", style: { background: C.us } }), "Estimated xG for"]),
      h("span", {}, [h("span", { class: "key-line", style: { background: C.them } }), "Estimated xG against"]),
    ]),
    lineChart(tr.map((m) => shortDate(m.date)), [
      { name: "Estimated xG for", color: C.us, values: tr.map((m) => m.xg) },
      { name: "Estimated xG against", color: C.them, values: tr.map((m) => m.xga) },
    ], { height: 210, fmt: (v) => v.toFixed(2) }),
    h("p", { class: "chart-note" }, "Expected goals per match, estimated from your shots, shots on target and goals (no shot locations in grassroots data). Single matches are noisy; look at the trend. Hover for values."),
  ]);
}

// ---------------------------------------------------------------- CSV import
function csvCard(ctx, id) {
  const status = h("div");
  const input = h("input", { type: "file", accept: ".csv,text/csv", hidden: true });
  const replace = h("input", { type: "checkbox", name: "replace" });
  const idle = "Drop a CSV file here, or click to choose one";
  const zoneText = h("span", {}, idle);
  const zone = h("div", { class: "dropzone", role: "button", tabindex: "0", "aria-label": "Choose a CSV file of matches to import" }, [
    h("div", { style: { fontSize: "20px", lineHeight: "1", marginBottom: "6px" }, "aria-hidden": "true" }, "⇪"),
    zoneText,
    h("div", { class: "sub", style: { marginTop: "4px" } }, "One row per match · 2 MB max"),
  ]);
  let busy = false;

  const upload = async (file) => {
    if (!file || busy) return;
    status.replaceChildren();
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      status.replaceChildren(errorsBox("That doesn't look like a CSV file.", { errors: ["In Excel, Numbers or Google Sheets use File → Save as / Download → CSV, then import that file."] }));
      return;
    }
    if (file.size > 2000000) {
      status.replaceChildren(errorsBox("File too large.", { errors: ["CSV files must be under 2 MB."] }));
      return;
    }
    const t = ctx.teams.find((x) => x.id === id);
    if (replace.checked && t && t.matches && !confirm(`Replace all ${matchesTxt(t.matches)} for "${t.name}" with the rows in ${file.name}?`)) return;
    busy = true;
    zone.classList.add("loading");
    zoneText.textContent = `Importing ${file.name}…`;
    const form = new FormData();
    form.append("file", file);
    form.append("replace", replace.checked ? "true" : "false");
    try {
      const res = await api(`/local/teams/${enc(id)}/upload`, { method: "POST", form });
      const p = res.profile || {};
      const arch = p.archetype ? p.archetype.name : null;
      const rt = p.rating || {};
      status.replaceChildren(h("div", { class: "ok-note", role: "status" }, [
        h("strong", {}, `Imported ${matchesTxt(res.imported)}.`),
        ` The team now has ${matchesTxt(p.matches)}`,
        arch ? " and plays like " : null,
        arch ? h("strong", {}, arch) : null,
        rt.attack != null ? ` (attack index ${rt.attack.toFixed(2)}×, defence index ${rt.defence.toFixed(2)}×).` : ".",
      ]));
      replace.checked = false;
      await refresh(ctx);
      toast(`Imported ${matchesTxt(res.imported)}.`);
    } catch (err) {
      status.replaceChildren(errorsBox("Import failed. Nothing was saved; fix these rows and try again.", err));
    } finally {
      busy = false;
      zone.classList.remove("loading", "drag");
      zoneText.textContent = idle;
      input.value = "";
    }
  };

  input.addEventListener("change", () => upload(input.files && input.files[0]));
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
  zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("drag"); });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    upload(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("h3", {}, "Import a CSV"),
      h("a", { class: "btn small", href: "/api/local/template.csv", download: "twelfth-man-template.csv" }, "Download template"),
    ]),
    zone,
    input,
    h("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" } }, [replace, h("span", {}, "Replace existing matches (otherwise rows are added)")]),
    status,
    h("p", { class: "sub" }, [
      h("strong", { class: "secondary" }, "Required columns: "), REQUIRED.join(", "), ".",
      h("br"),
      h("strong", { class: "secondary" }, "Optional: "), OPTIONAL.join(", "), ".",
      h("br"),
      `Dates as YYYY-MM-DD. Formation one of ${formations().join(", ")}. Ratings 1–5. The template has one example row.`,
    ]),
  ]);
}

// ---------------------------------------------------------------- explainer
function guideCard() {
  const item = (title, text) => h("div", {}, [h("strong", {}, title), h("p", { class: "secondary", style: { fontSize: "13px", marginTop: "2px" } }, text)]);
  return h("div", { class: "card stack" }, [
    h("h3", {}, "What the numbers mean"),
    item("Press height (1–5)", "Where your team starts winning the ball back. 1 = deep block (drop off and protect your box), 3 = mid block (engage around halfway), 5 = very high press (hunt the ball in their half)."),
    item("Directness (1–5)", "How quickly you move the ball forward. 1 = patient short build-up from the back, 5 = very direct (early long balls to the forwards)."),
    item("Width (1–5)", "How much you use the flanks. 1 = very narrow (play through the middle), 5 = very wide (wingers and full-backs hug the touchline)."),
    h("p", { class: "sub" }, "Each step lines up with pro teams: 1 ≈ the 10th percentile, 3 = the middle, 5 ≈ the 90th. A blank rating counts as 3."),
    h("div", { class: "divider", style: { margin: "4px 0" } }),
    item("Why shots on target help", "Grassroots data has no shot locations, so expected goals (xG) are estimated from shots, shots on target and goals. With shots on target, each on-target shot counts about 0.30 xG and each off-target shot about 0.05. With only total shots every shot counts 0.11, so a side that keeps testing the keeper looks the same as one that shoots wide. The estimate is then blended 70/30 with actual goals."),
    item("Why pass counts help", "Passes attempted and completed give your real pass completion, a key part of your style profile. Without them the model assumes a fairly low completion rate (lower third of pro teams), which can tilt your archetype."),
    item("How many matches?", "Ratings are pulled toward the average of all your local matches: with 4 matches your data and that average count equally; by 12 matches it is 75% your data."),
  ]);
}

// ---------------------------------------------------------------- add match form
function matchFormCard(ctx, id, usualFormation) {
  const fs = formations();
  const defF = fs.includes(usualFormation) ? usualFormation : (fs.includes("4-4-2") ? "4-4-2" : fs[0]);
  const status = h("div");

  const date = h("input", { type: "date", name: "date", required: true, value: today() });
  const opponent = h("input", { type: "text", name: "opponent", required: true, maxlength: 80, placeholder: "Opponent name", autocomplete: "off" });
  const venue = h("select", { name: "venue" }, ["home", "away", "neutral"].map((v) => h("option", { value: v, selected: v === "home" }, v[0].toUpperCase() + v.slice(1))));
  const formation = h("select", { name: "formation", required: true }, fs.map((f) => h("option", { value: f, selected: f === defF }, f)));
  const rating = (name) => h("select", { name }, [
    h("option", { value: "" }, "— not rated (counts as 3)"),
    ...RATINGS[name].opts.map((o, i) => h("option", { value: String(i + 1) }, `${i + 1} · ${o}`)),
  ]);
  const notes = h("input", { type: "text", name: "notes", maxlength: 300, placeholder: "Anything worth remembering (optional)", autocomplete: "off" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Add match");

  const form = h("form", { class: "stack", style: { gap: "16px" } }, [
    section("The game", [h("div", { class: "form-grid" }, [
      field("Date", date, { required: true }),
      field("Opponent", opponent, { required: true }),
      field("Home or away", venue),
      field("Formation", formation, { required: true }),
    ])]),
    section("Score & shots", [h("div", { class: "form-grid" }, [
      field("Our goals", numInput("goals_for", { required: true }), { required: true }),
      field("Their goals", numInput("goals_against", { required: true }), { required: true }),
      field("Our shots", numInput("shots_for", { required: true }), { required: true, hint: "Every shot, on target or not" }),
      field("Their shots", numInput("shots_against", { required: true }), { required: true }),
    ])]),
    section("How did we play? (1–5)", [h("div", { class: "form-grid" }, [
      field("How high did we press?", rating("press_rating"), { hint: "1 = sat deep · 5 = chased everything" }),
      field("How direct were we?", rating("directness_rating"), { hint: "1 = short passing · 5 = long balls" }),
      field("How wide did we play?", rating("width_rating"), { hint: "1 = very narrow · 5 = very wide" }),
    ])]),
    more("More details (optional)", [h("div", { class: "form-grid" }, [
      field("Our shots on target", numInput("sot_for"), { hint: "Makes the advice more accurate" }),
      field("Their shots on target", numInput("sot_against")),
      field("Possession %", numInput("possession", { min: 1, max: 99, step: "any", placeholder: "e.g. 50" }), { hint: "Rough guess is fine" }),
      field("Passes tried", numInput("passes_attempted"), { hint: "If someone counted" }),
      field("Passes completed", numInput("passes_completed")),
      field("Our corners", numInput("corners_for")),
      field("Goals we conceded after 60'", numInput("late_goals_against"), { hint: "Helps spot tiredness late on" }),
      field("Notes", notes, { wide: true }),
    ])], { hint: "shots on target, possession, passes, corners, notes" }),
    status,
    h("div", { class: "row" }, [
      submit,
      h("button", { class: "btn ghost", type: "button", onclick: () => { form.reset(); status.replaceChildren(); } }, "Clear"),
      h("span", { class: "sub" }, "* required"),
    ]),
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.replaceChildren();
    const body = {};
    for (const name of STR_FIELDS) {
      const v = (form.elements.namedItem(name).value || "").trim();
      if (v !== "") body[name] = v;
    }
    for (const name of NUM_FIELDS) {
      const raw = (form.elements.namedItem(name).value || "").trim();
      if (raw === "") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) body[name] = v;
    }
    submit.disabled = true;
    try {
      const m = await api(`/local/teams/${enc(id)}/matches`, { method: "POST", body });
      const keepF = formation.value, keepV = venue.value;
      form.reset();
      formation.value = keepF;
      venue.value = keepV;
      status.replaceChildren(h("div", { class: "ok-note", role: "status" }, `Saved: ${m.date} vs ${m.opponent} (${m.goals_for}–${m.goals_against}). The profile above has been updated.`));
      await refresh(ctx);
      toast("Match added.");
    } catch (err) {
      status.replaceChildren(errorsBox("The match was not saved:", err));
    } finally {
      submit.disabled = false;
    }
  });

  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Add a match"), h("span", { class: "sub" }, "one match at a time · blanks are fine for optional fields")]),
    form,
  ]);
}

// ---------------------------------------------------------------- matches table
function matchesCard(ctx, t, matches) {
  const sorted = [...matches].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const result = (m) => (m.goals_for > m.goals_against ? "W" : m.goals_for === m.goals_against ? "D" : "L");

  const del = (m, btn) => async () => {
    if (!confirm(`Delete the match on ${m.date} vs ${m.opponent}? This cannot be undone.`)) return;
    btn.disabled = true;
    try {
      await api(`/local/teams/${enc(t.id)}/matches/${enc(m.id)}`, { method: "DELETE" });
      await refresh(ctx);
      toast("Match deleted.");
    } catch (err) {
      btn.disabled = false;
      toast(`Could not delete: ${err.message}`);
    }
  };

  const rows = sorted.map((m) => {
    const btn = h("button", { class: "btn small ghost", type: "button", "aria-label": `Delete match on ${m.date} vs ${m.opponent}` }, "Delete");
    btn.addEventListener("click", del(m, btn));
    const passPct = m.passes_attempted && m.passes_completed != null ? pct(m.passes_completed / m.passes_attempted) : "—";
    const style = [m.press_rating, m.directness_rating, m.width_rating];
    return h("tr", {}, [
      h("td", { style: { whiteSpace: "nowrap" } }, m.date),
      h("td", {}, m.opponent),
      h("td", { class: "secondary" }, dash(m.venue)),
      h("td", {}, dash(m.formation)),
      h("td", { style: { whiteSpace: "nowrap" } }, [h("span", { class: "tag", style: { marginRight: "6px" } }, result(m)), `${m.goals_for}–${m.goals_against}`]),
      h("td", { style: { whiteSpace: "nowrap" } }, pair(m.shots_for, m.shots_against)),
      h("td", { style: { whiteSpace: "nowrap" } }, pair(m.sot_for, m.sot_against)),
      h("td", {}, m.possession != null ? `${Math.round(m.possession)}%` : "—"),
      h("td", { title: m.passes_attempted ? `${dash(m.passes_completed)} of ${m.passes_attempted} passes` : null }, passPct),
      h("td", { style: { whiteSpace: "nowrap" }, title: "Press · directness · width" }, style.every((v) => v == null) ? "—" : style.map((v) => (v == null ? "–" : v)).join(" · ")),
      h("td", { class: "secondary", title: m.notes || null, style: { maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, dash(m.notes)),
      h("td", { style: { textAlign: "right" } }, btn),
    ]);
  });

  const heads = [["Date"], ["Opponent"], ["Venue"], ["Formation"], ["Result"], ["Shots", "Shots for–against"], ["On target", "Shots on target for–against (? = not recorded)"],
    ["Poss."], ["Pass %", "Passes completed ÷ attempted"], ["Style", "Press height · directness · width ratings (1–5)"], ["Notes"], [""]];
  return h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", {}, "Matches"), h("span", { class: "sub" }, sorted.length ? `${matchesTxt(sorted.length)} · newest first · for–against` : "none yet")]),
    sorted.length
      ? h("div", { class: "table-wrap" }, h("table", {}, [
        h("thead", {}, h("tr", {}, heads.map(([x, tip]) => h("th", { scope: "col", title: tip || null, style: { whiteSpace: "nowrap" } }, x)))),
        h("tbody", {}, rows),
      ]))
      : h("div", { class: "empty" }, "No matches yet. Import a CSV or add one above."),
  ]);
}

// ---------------------------------------------------------------- roster editor
function rosterCard(ctx, id, roster) {
  let rows = roster.map((p) => ({ name: p.name || "", position: p.position || "CM", number: p.number == null ? "" : String(p.number) }));
  let saved = JSON.stringify(rows);
  const list = h("div", { class: "stack", style: { gap: "6px" } });
  const count = h("span", { class: "sub" });
  const dirtyNote = h("span", { class: "sub" });
  const status = h("div");
  const grid = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px 64px 34px", gap: "6px", alignItems: "center" };

  const markDirty = () => {
    const dirty = JSON.stringify(rows) !== saved;
    dirtyNote.textContent = dirty ? "Unsaved changes" : "";
    dirtyNote.style.color = dirty ? C.warning : "";
    const n = rows.filter((r) => r.name.trim()).length;
    count.textContent = `${n} player${n === 1 ? "" : "s"}`;
  };

  const drawRows = (focusLast = false) => {
    list.replaceChildren(h("div", { style: grid, class: "sub", "aria-hidden": "true" }, [h("span", {}, "Name"), h("span", {}, "Position"), h("span", {}, "No."), h("span")]));
    rows.forEach((r, i) => {
      const name = h("input", { type: "text", value: r.name, maxlength: 60, placeholder: "Player name", "aria-label": `Player ${i + 1} name`, autocomplete: "off", style: { width: "100%", minWidth: 0 } });
      name.addEventListener("input", () => { r.name = name.value; markDirty(); });
      const opts = POSITIONS.includes(r.position) ? POSITIONS : [r.position, ...POSITIONS];
      const pos = h("select", { "aria-label": `Player ${i + 1} position`, style: { width: "100%", minWidth: 0 } }, opts.map((p) => h("option", { value: p, selected: p === r.position }, p)));
      pos.addEventListener("change", () => { r.position = pos.value; markDirty(); });
      const num = h("input", { type: "number", min: 1, max: 99, step: 1, value: r.number, inputmode: "numeric", "aria-label": `Player ${i + 1} shirt number`, style: { width: "100%", minWidth: 0 } });
      num.addEventListener("input", () => { r.number = num.value; markDirty(); });
      const rm = h("button", { class: "btn small ghost", type: "button", "aria-label": `Remove player ${i + 1}`, title: "Remove", onclick: () => { rows.splice(i, 1); drawRows(); markDirty(); } }, "✕");
      list.append(h("div", { style: grid }, [name, pos, num, rm]));
      if (focusLast && i === rows.length - 1) setTimeout(() => name.focus(), 0);
    });
    if (!rows.length) list.append(h("p", { class: "muted", style: { fontSize: "13px" } }, "No players yet. Add your squad so line-ups and substitutions can use real names."));
    markDirty();
  };

  const addBtn = h("button", { class: "btn small", type: "button", onclick: () => {
    const nums = rows.map((r) => Number(r.number)).filter((v) => Number.isFinite(v) && v > 0);
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    rows.push({ name: "", position: "CM", number: next <= 99 ? String(next) : "" });
    drawRows(true);
  } }, "+ Add player");

  const saveBtn = h("button", { class: "btn primary small", type: "button" }, "Save roster");
  saveBtn.addEventListener("click", async () => {
    status.replaceChildren();
    const clean = rows.filter((r) => r.name.trim()).map((r) => {
      const n = r.number === "" ? null : Number(r.number);
      return { name: r.name.trim(), position: r.position, number: Number.isFinite(n) ? n : null };
    });
    const nums = clean.map((p) => p.number).filter((v) => v != null);
    const dup = nums.filter((v, i) => nums.indexOf(v) !== i);
    saveBtn.disabled = true;
    try {
      await api(`/local/teams/${enc(id)}/roster`, { method: "PUT", body: clean });
      rows = clean.map((p) => ({ name: p.name, position: p.position, number: p.number == null ? "" : String(p.number) }));
      saved = JSON.stringify(rows);
      drawRows();
      const dupSet = [...new Set(dup)];
      if (dupSet.length) status.replaceChildren(h("span", { class: "pill", role: "status" }, [h("span", { class: "dot", style: { background: C.warning } }), `Saved. Note: shirt number${dupSet.length > 1 ? "s" : ""} ${dupSet.join(", ")} ${dupSet.length > 1 ? "are" : "is"} used more than once.`]));
      await refresh(ctx);
      toast(`Roster saved (${clean.length} player${clean.length === 1 ? "" : "s"}).`);
    } catch (err) {
      status.replaceChildren(errorsBox("The roster was not saved:", err));
    } finally {
      saveBtn.disabled = false;
    }
  });

  const revertBtn = h("button", { class: "btn small ghost", type: "button", onclick: () => { rows = JSON.parse(saved); status.replaceChildren(); drawRows(); } }, "Undo changes");

  drawRows();
  return h("div", { class: "card stack" }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [h("h3", {}, "Squad roster"), h("div", { class: "row" }, [dirtyNote, count])]),
    h("p", { class: "secondary", style: { fontSize: "13px" } }, "Names, positions and shirt numbers feed the line-up pitch and substitution planner in the Tactics Lab. They stay on this computer and are never sent anywhere."),
    list,
    status,
    h("div", { class: "row" }, [addBtn, h("span", { class: "spacer" }), revertBtn, saveBtn]),
  ]);
}
