// Shared app state + API client.
export const state = {
  meta: null,
  teams: [],
  teamId: null,
  oppId: null,
  venue: "home",
  conditions: "normal",
  tactics: {},      // per team id
  subs: [],
  lineups: {},      // `${teamId}|${formation}` -> [names per slot]
  plans: {},        // `${teamId}|${oppId}` -> chosen tactics in coach mode
  nSims: 10000,
  teamCache: {},
  lastSim: null,
};

// Saved per user, so each coach (and each new account) starts from their own next fixture.
const key = () => `twelfth-man:v2:${state.user ? state.user.id : "anon"}`;

export function load() {
  try {
    const raw = localStorage.getItem(key());
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const k of ["teamId", "oppId", "venue", "conditions", "tactics", "subs", "lineups", "nSims", "plans"]) if (s[k] !== undefined) state[k] = s[k];
  } catch { /* storage unavailable — fine */ }
}

export function save() {
  try {
    const { teamId, oppId, venue, conditions, tactics, subs, lineups, nSims, plans } = state;
    localStorage.setItem(key(), JSON.stringify({ teamId, oppId, venue, conditions, tactics, subs, lineups, nSims, plans }));
  } catch { /* ignore */ }
}

export async function api(path, { method = "GET", body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401 && !path.startsWith("/auth/")) { location.reload(); throw new Error("Please sign in."); }
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = data && data.detail;
    const err = new Error(typeof detail === "string" ? detail : (detail && detail.errors ? detail.errors.join("; ") : `Request failed (${res.status})`));
    err.errors = detail && detail.errors;
    throw err;
  }
  return data;
}

export async function team(id, { fresh = false } = {}) {
  if (!fresh && state.teamCache[id]) return state.teamCache[id];
  const t = await api(`/teams/${encodeURIComponent(id)}`);
  state.teamCache[id] = t;
  return t;
}

export async function refreshTeams() {
  state.teams = await api("/teams");
  state.teamCache = {};
  return state.teams;
}

export async function tacticsFor(teamId) {
  if (!state.tactics[teamId]) {
    const t = await team(teamId);
    state.tactics[teamId] = { ...t.default_tactics };
  }
  return state.tactics[teamId];
}

export function label(id) {
  const t = state.teams.find((x) => x.id === id);
  return t ? t.label : id;
}

export function toast(msg, ms = 3200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), ms);
}

export function simBody(extra = {}) {
  return {
    team_id: state.teamId, opponent_id: state.oppId, tactics: state.tactics[state.teamId] || {},
    venue: state.venue, conditions: state.conditions, subs: state.subs, n_sims: state.nSims, ...extra,
  };
}
