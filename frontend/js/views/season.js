// Season: fixtures, league table and opponent scouting — where the coach's opponents and their stats come from.
import { state, api, save, toast } from "../state.js";
import { h } from "../charts.js";
import { go, reloadTeams } from "../app.js";

const fmtDate = (d) => {
  try { return new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  catch { return d; }
};
const today = () => new Date().toISOString().slice(0, 10);

function strengthWords(p) {
  if (!p || !p.rating) return [];
  const out = [];
  const a = p.rating.attack, d = p.rating.defence;
  if (a >= 1.15) out.push("Scores a lot"); else if (a <= 0.85) out.push("Doesn't score much");
  if (d <= 0.85) out.push("Hard to score against"); else if (d >= 1.15) out.push("Concedes a lot");
  if (!out.length) out.push("Average team in your league");
  return out;
}

function planFor(f) {
  if (!f.opponent_id) return;
  state.oppId = f.opponent_id;
  state.venue = f.venue || "home";
  save();
  go("plan");
  setTimeout(() => location.reload(), 50);
}

function scoutForm(o, onSaved) {
  const sc = o.scouting || {};
  const sel = (name, opts, labels) => h("select", { name }, [h("option", { value: "" }, "Not sure"), ...opts.map((v, i) => h("option", { value: v, selected: String(sc[name] ?? "") === String(v) }, labels ? labels[i] : v))]);
  const formation = sel("formation", Object.keys(state.meta.formations));
  const press = sel("press_rating", [1, 2, 3, 4, 5], ["1 · sit deep", "2", "3 · middle", "4", "5 · press very high"]);
  const direct = sel("directness_rating", [1, 2, 3, 4, 5], ["1 · short passing", "2", "3 · mixed", "4", "5 · long balls"]);
  const width = sel("width_rating", [1, 2, 3, 4, 5], ["1 · very narrow", "2", "3 · balanced", "4", "5 · very wide"]);
  const sp = h("input", { type: "checkbox", checked: !!sc.set_piece_threat });
  const players = h("textarea", { rows: 2, maxlength: 400, placeholder: "e.g. Quick #7 on the right wing; tall #5 strong in the air" }, sc.key_players || "");
  const notes = h("textarea", { rows: 2, maxlength: 400, placeholder: "Anything else you noticed" }, sc.notes || "");
  const btn = h("button", { class: "btn primary small", type: "submit" }, "Save scouting");
  const form = h("form", { class: "stack scout-form" }, [
    h("div", { class: "form-grid" }, [
      h("label", { class: "field" }, ["Formation", formation]),
      h("label", { class: "field" }, ["How high do they press?", press]),
      h("label", { class: "field" }, ["How direct are they?", direct]),
      h("label", { class: "field" }, ["How wide do they play?", width]),
    ]),
    h("label", { class: "row", style: { gap: "8px" } }, [sp, "Dangerous at set pieces"]),
    h("label", { class: "field" }, ["Key players", players]),
    h("label", { class: "field" }, ["Notes", notes]),
    btn,
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api("/opponents", { method: "POST", body: { id: o.id, name: o.name, scouting: {
        formation: formation.value || null, press_rating: press.value ? +press.value : null,
        directness_rating: direct.value ? +direct.value : null, width_rating: width.value ? +width.value : null,
        set_piece_threat: sp.checked, key_players: players.value.trim(), notes: notes.value.trim(), possession: null } } });
      toast(`Scouting saved for ${o.name}.`);
      onSaved();
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  return form;
}

export async function renderSeason() {
  const root = h("div", { class: "coach" });
  async function draw() {
    const [club, fixtures, opponents] = await Promise.all([api("/club"), api("/fixtures"), api("/opponents")]);
    const upcoming = fixtures.filter((f) => f.goals_for == null && f.date >= today());
    const next = upcoming[0];
    const oppByName = Object.fromEntries(opponents.map((o) => [o.name.toLowerCase(), o]));

    // next game
    const nextCard = h("section", { class: "coach-card next-game" }, next ? [
      h("p", { class: "eyebrow" }, "Next game"),
      h("h2", { class: "next-title" }, `${next.venue === "away" ? "Away at" : "Home vs"} ${next.opponent}`),
      h("p", { class: "secondary" }, `${fmtDate(next.date)}${next.time ? " · " + next.time : ""} · ${next.competition || "League"}`),
      h("p", {}, strengthWords(oppByName[next.opponent.toLowerCase()]?.profile).join(" · ")),
      h("div", { class: "coach-actions" }, [h("button", { class: "btn primary", onclick: () => planFor(next) }, "Get the game plan →")]),
    ] : [h("h2", {}, "No upcoming games yet"), h("p", { class: "secondary" }, "Add your fixtures below and the app will prepare a plan for each opponent.")]);

    // fixtures list + add form
    const known = h("datalist", { id: "opp-names" }, opponents.map((o) => h("option", { value: o.name })));
    const fOpp = h("input", { type: "text", list: "opp-names", placeholder: "Opponent name", required: true, maxlength: 120 });
    const fDate = h("input", { type: "date", required: true, value: today() });
    const fTime = h("input", { type: "time" });
    const fVenue = h("select", {}, [["home", "Home"], ["away", "Away"], ["neutral", "Neutral"]].map(([v, l]) => h("option", { value: v }, l)));
    const fComp = h("input", { type: "text", value: "League", maxlength: 80 });
    const addForm = h("form", { class: "form-grid add-fixture" }, [
      h("label", { class: "field" }, ["Opponent", fOpp]), h("label", { class: "field" }, ["Date", fDate]),
      h("label", { class: "field" }, ["Kick-off", fTime]), h("label", { class: "field" }, ["Home / away", fVenue]),
      h("label", { class: "field" }, ["Competition", fComp]),
      h("div", { class: "field", style: { justifyContent: "flex-end" } }, [h("button", { class: "btn primary", type: "submit" }, "Add fixture")]),
    ]);
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!fOpp.value.trim()) return toast("Enter the opponent's name.");
      try {
        await api("/fixtures", { method: "POST", body: { opponent: fOpp.value.trim(), date: fDate.value, time: fTime.value, venue: fVenue.value, competition: fComp.value.trim() || "League" } });
        await reloadTeams();
        toast("Fixture added.");
        draw();
      } catch (err) { toast(err.message); }
    });

    const rows = fixtures.map((f) => {
      const played = f.goals_for != null;
      const due = f.date <= today();  // results can be entered from match day onwards
      const gf = h("input", { type: "number", min: 0, max: 50, class: "score-in", value: f.goals_for ?? "", "aria-label": "Our goals" });
      const ga = h("input", { type: "number", min: 0, max: 50, class: "score-in", value: f.goals_against ?? "", "aria-label": "Their goals" });
      const saveScore = h("button", { class: "btn small ghost", onclick: async () => {
        try {
          await api(`/fixtures/${f.id}`, { method: "PUT", body: { ...f, goals_for: gf.value === "" ? null : +gf.value, goals_against: ga.value === "" ? null : +ga.value } });
          toast("Result saved. Add the full match stats in Results & Squad to improve your profile.");
          draw();
        } catch (err) { toast(err.message); }
      } }, "Save");
      return h("tr", { class: played ? "played" : "" }, [
        h("td", {}, fmtDate(f.date)),
        h("td", {}, h("strong", {}, f.opponent)),
        h("td", {}, f.venue === "away" ? "Away" : f.venue === "neutral" ? "Neutral" : "Home"),
        h("td", { class: "score-cell" }, due || played ? [gf, "–", ga, saveScore] : h("span", { class: "muted" }, f.time ? `Kick-off ${f.time}` : "Upcoming")),
        h("td", {}, h("div", { class: "row", style: { gap: "6px", flexWrap: "nowrap" } }, [
          !played && f.opponent_id ? h("button", { class: "btn small", onclick: () => planFor(f) }, "Plan") : null,
          h("button", { class: "btn small ghost", "aria-label": `Delete fixture vs ${f.opponent}`, onclick: async () => {
            if (!confirm(`Delete the fixture against ${f.opponent}?`)) return;
            await api(`/fixtures/${f.id}`, { method: "DELETE" }); draw();
          } }, "✕"),
        ])),
      ]);
    });
    const fixturesCard = h("section", { class: "coach-card" }, [
      h("h2", {}, "Fixtures"),
      fixtures.length ? h("div", { class: "table-wrap" }, h("table", {}, [
        h("thead", {}, h("tr", {}, ["Date", "Opponent", "Venue", "Score (us – them)", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, rows),
      ])) : h("p", { class: "muted" }, "No fixtures yet — add your first game below."),
      known,
      h("details", { class: "more", open: !fixtures.length }, [
        h("summary", {}, [h("span", { class: "more-title" }, "Add a fixture"), h("span", { class: "more-hint" }, "opponents are created automatically")]),
        h("div", { class: "more-body" }, [addForm]),
      ]),
    ]);

    // league table
    const table = opponents.filter((o) => o.table).map((o) => ({ name: o.name, ...o.table }));
    if (club && club.table) table.push({ name: `${club.club_name}${club.team_name ? " " + club.team_name : ""}`, ...club.table, me: true });
    table.sort((a, b) => (a.position || 99) - (b.position || 99));
    const paste = h("textarea", { rows: 6, maxlength: 20000, placeholder: "Paste your league table here — one team per line, e.g.\n1 Northgate Athletic 8 5 2 1 18 8 10 17\n2 Riverside FC 10 4 3 3 17 14 3 15\n(position, team, played, won, drawn, lost, goals for, goals against…)" });
    const importBtn = h("button", { class: "btn primary small", type: "button", onclick: async () => {
      try {
        const r = await api("/league-table", { method: "POST", body: { text: paste.value } });
        await reloadTeams();
        toast(`Imported ${r.count} teams${r.own_row ? " (including yours)" : ""}.`);
        draw();
      } catch (err) { toast(err.message); }
    } }, "Import table");
    const tableCard = h("section", { class: "coach-card" }, [
      h("h2", {}, "League table"),
      h("p", { class: "sub" }, "Most leagues publish their table online. Pasting it here gives every team in your division a strength rating."),
      table.length ? h("div", { class: "table-wrap" }, h("table", { class: "league" }, [
        h("thead", {}, h("tr", {}, ["#", "Team", "P", "W", "D", "L", "GF", "GA", "GD", "Pts"].map((t) => h("th", {}, t)))),
        h("tbody", {}, table.map((r) => h("tr", { class: r.me ? "me" : "" }, [
          r.position, r.name, r.played, r.won, r.drawn, r.lost, r.gf, r.ga, r.gf - r.ga, 3 * r.won + r.drawn,
        ].map((v, i) => h("td", {}, i === 1 ? h("strong", {}, String(v)) : String(v)))))),
      ])) : null,
      h("details", { class: "more" }, [h("summary", {}, [h("span", { class: "more-title" }, table.length ? "Update the table" : "Paste your league table")]),
        h("div", { class: "more-body" }, [paste, importBtn])]),
    ]);

    // opponents
    const byTable = [...opponents].sort((a, b) => ((a.table && a.table.position) || 99) - ((b.table && b.table.position) || 99) || a.name.localeCompare(b.name));
    const oppCards = byTable.map((o) => {
      const p = o.profile;
      const scoutBox = h("div", { hidden: true });
      const t = o.table;
      return h("div", { class: "opp-card" }, [
        h("div", { class: "row", style: { justifyContent: "space-between" } }, [
          h("strong", { class: "opp-name" }, o.name),
          t ? h("span", { class: "tag" }, `${t.position ? "#" + t.position + " · " : ""}W${t.won} D${t.drawn} L${t.lost}`) : null,
        ]),
        h("p", {}, strengthWords(p).join(" · ")),
        p && p.style_in_words ? h("p", { class: "secondary" }, p.style_in_words) : h("p", { class: "secondary" }, "Style not scouted yet."),
        o.scouting && o.scouting.key_players ? h("p", { class: "sub" }, `Key players: ${o.scouting.key_players}`) : null,
        h("p", { class: "sub" }, p ? p.note : ""),
        h("div", { class: "row", style: { gap: "6px" } }, [
          h("button", { class: "btn small", onclick: () => {
            scoutBox.hidden = !scoutBox.hidden;
            if (!scoutBox.firstChild) scoutBox.append(scoutForm(o, draw));
          } }, o.scouting ? "Edit scouting" : "Scout this team"),
          h("button", { class: "btn small ghost", onclick: () => { state.oppId = o.id; save(); go("plan"); setTimeout(() => location.reload(), 50); } }, "Game plan"),
        ]),
        scoutBox,
      ]);
    });
    const oppSection = h("section", { class: "coach-card" }, [
      h("h2", {}, "Opponents"),
      h("p", { class: "sub" }, "What we know about each team comes from the league table, your results against them and your own scouting. The more you add, the better the plans."),
      opponents.length ? h("div", { class: "opp-grid" }, oppCards) : h("p", { class: "muted" }, "Add fixtures or paste your league table to see your opponents here."),
    ]);

    root.replaceChildren(
      h("div", { class: "coach-head" }, [
        h("p", { class: "eyebrow" }, [club?.season, club?.league, club?.division].filter(Boolean).join(" · ") || "Your season"),
        h("h1", {}, "Season"),
        h("p", { class: "lead" }, "Your fixtures, your league and the teams you'll face."),
      ]),
      nextCard, fixturesCard, tableCard, oppSection,
    );
  }
  await draw();
  return root;
}
