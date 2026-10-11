import { state, load, save, api, refreshTeams } from "./state.js";
import { h } from "./charts.js";
import { renderMatchup } from "./views/matchup.js";
import { renderLab } from "./views/lab.js";
import { renderRecommend } from "./views/recommend.js";
import { renderReport } from "./views/report.js";
import { renderDevelopment } from "./views/development.js";
import { renderExplore } from "./views/explore.js";
import { renderData } from "./views/data.js";
import { renderModel } from "./views/model.js";
import { renderGameplan } from "./views/gameplan.js";
import { renderSheet } from "./views/sheet.js";
import { renderTraining } from "./views/training.js";
import { renderAsk } from "./views/ask.js";
import { renderAuth } from "./views/auth.js";
import { renderClub } from "./views/club.js";
import { renderSeason } from "./views/season.js";

const VIEWS = {
  plan: renderGameplan, sheet: renderSheet, training: renderTraining, ask: renderAsk,
  club: () => renderClub(), season: renderSeason,
  matchup: renderMatchup, lab: renderLab, recommend: renderRecommend, report: renderReport,
  development: renderDevelopment, explore: renderExplore, data: renderData, model: renderModel,
};

const view = document.getElementById("view");
let renderToken = 0;

function currentRoute() {
  const r = (location.hash || "#/plan").replace(/^#\//, "").split("?")[0];
  return VIEWS[r] ? r : "plan";
}

export async function render() {
  const route = currentRoute();
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === route));
  if (document.querySelector(`#nav-advanced a[data-view="${route}"]`)) document.getElementById("nav-advanced").open = true;
  const token = ++renderToken;
  view.classList.add("loading");
  try {
    const node = await VIEWS[route]();
    if (token !== renderToken) return; // a newer render started
    view.replaceChildren(node);
  } catch (e) {
    console.error(e);
    if (token === renderToken) view.replaceChildren(h("div", { class: "card errors" }, [h("strong", {}, "Something went wrong. "), e.message]));
  } finally {
    if (token === renderToken) view.classList.remove("loading");
  }
  window.scrollTo({ top: 0 });
}

function fillSelect(sel, selected, exclude) {
  sel.replaceChildren();
  const groups = {};
  for (const t of state.teams) (groups[t.competition] ||= []).push(t);
  for (const [g, list] of Object.entries(groups)) {
    const og = h("optgroup", { label: g });
    for (const t of list) {
      const o = h("option", { value: t.id }, t.label);
      if (t.id === selected) o.selected = true;
      if (t.id === exclude) o.disabled = true;
      og.append(o);
    }
    sel.append(og);
  }
}

export function renderPickers() {
  const ts = document.getElementById("team-select");
  const os = document.getElementById("opp-select");
  fillSelect(ts, state.teamId, state.oppId);
  fillSelect(os, state.oppId, state.teamId);
  document.querySelectorAll("#venue-seg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.v === state.venue);
    b.setAttribute("aria-checked", b.dataset.v === state.venue);
  });
}

function ensureValidSelection() {
  const ids = new Set(state.teams.map((t) => t.id));
  if (!ids.has(state.teamId)) state.teamId = (state.teams.find((t) => t.source === "local") || state.teams[0]).id;
  if (!ids.has(state.oppId) || state.oppId === state.teamId) {
    const pref = state.teams.find((t) => t.source === "scouted") || state.teams.find((t) => t.source === "local" && t.id !== state.teamId) || state.teams.find((t) => t.id === "leicester-city-pl-15-16");
    state.oppId = (pref || state.teams.find((t) => t.id !== state.teamId)).id;
  }
}

export async function reloadTeams() {
  await refreshTeams();
  ensureValidSelection();
  renderPickers();
}

async function boot() {
  const res = await fetch("/api/auth/me");
  const me = await res.json();
  if (!me.user) {
    // No sign-in wall: every visitor gets a private demo club instantly.
    view.replaceChildren(h("div", { class: "card empty" }, "Setting up your demo club…"));
    const g = await fetch("/api/auth/guest", { method: "POST" });
    if (g.ok) { if (!location.hash || location.hash === "#/") location.hash = "#/plan"; location.reload(); return; }
    throw new Error("Could not start a demo session.");
  }
  state.user = me.user;
  state.club = me.club;
  if (!me.club) {
    // onboarding: club profile first
    document.querySelector(".shell").classList.add("onboarding");
    const meta = await api("/meta");
    state.meta = meta;
    view.replaceChildren(await renderClub({ onboarding: true }));
    return;
  }
  return init();
}

async function init() {
  load();
  const [meta] = await Promise.all([api("/meta"), refreshTeams()]);
  state.meta = meta;
  // default to my club vs my next fixture
  if (!state.teams.some((t) => t.id === state.teamId)) state.teamId = state.club.team_id;
  if (!state.oppId || !state.teams.some((t) => t.id === state.oppId)) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const next = (await api("/fixtures")).find((f) => f.goals_for == null && f.date >= today && f.opponent_id);
      if (next) { state.oppId = next.opponent_id; state.venue = next.venue; }
    } catch { /* no fixtures yet */ }
  }
  ensureValidSelection();
  save();
  renderPickers();
  const foot = document.getElementById("sidebar-foot");
  const openAuth = () => {
    const overlay = renderAuth(() => { location.hash = "#/club"; location.reload(); }, { onClose: () => overlay.remove() });
    document.body.append(overlay);
  };
  if (state.user.guest) {
    foot.replaceChildren(
      h("div", { class: "guest-box" }, [
        h("strong", {}, "You're exploring a demo club"),
        h("span", { class: "muted" }, "Everything here is example data. Make it yours in two minutes."),
        h("button", { class: "btn primary small", onclick: openAuth }, "Create your own club"),
        h("button", { class: "btn ghost small", onclick: openAuth }, "Sign in"),
      ]),
      h("span", {}, "For coaching and learning — not for betting."),
    );
  } else foot.replaceChildren(
    h("div", { class: "user-pill" }, [
      h("span", { class: "avatar" }, (state.user.name || "?").trim().charAt(0).toUpperCase()),
      h("div", { class: "stack", style: { gap: "0" } }, [h("strong", {}, state.user.name), h("span", { class: "muted" }, state.club.club_name)]),
    ]),
    h("button", { class: "btn small ghost", onclick: async () => { await fetch("/api/auth/logout", { method: "POST" }); location.hash = ""; location.reload(); } }, "Sign out"),
    h("span", {}, "For coaching and learning — not for betting."),
  );

  document.getElementById("team-select").addEventListener("change", (e) => { state.teamId = e.target.value; state.subs = []; save(); renderPickers(); render(); });
  document.getElementById("opp-select").addEventListener("change", (e) => { state.oppId = e.target.value; save(); renderPickers(); render(); });
  document.querySelectorAll("#venue-seg button").forEach((b) => b.addEventListener("click", () => { state.venue = b.dataset.v; save(); renderPickers(); render(); }));
  window.addEventListener("hashchange", render);
  // phone menu: open/close, and close after picking a page
  const toggle = document.getElementById("menu-toggle");
  const sidebar = document.querySelector(".sidebar");
  toggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", open);
  });
  document.getElementById("nav").addEventListener("click", (e) => {
    if (e.target.closest("a")) { sidebar.classList.remove("menu-open"); toggle.setAttribute("aria-expanded", "false"); }
  });
  render();
}

export function go(route) {
  if (location.hash === `#/${route}`) render();
  else location.hash = `#/${route}`;
}

boot().catch((e) => {
  view.replaceChildren(h("div", { class: "card errors" }, [h("strong", {}, "Could not reach the Twelfth Man API. "), e.message]));
});
