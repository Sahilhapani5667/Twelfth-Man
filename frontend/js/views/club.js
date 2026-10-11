// My Club: the coach's club profile (also the onboarding page right after sign-up).
import { state, api, toast } from "../state.js";
import { h } from "../charts.js";

const COUNTRIES = ["United Kingdom", "Ireland", "United States", "Canada", "Australia", "New Zealand", "India", "Pakistan",
  "Bangladesh", "Nigeria", "Ghana", "Kenya", "South Africa", "Egypt", "Morocco", "Spain", "Portugal", "France", "Germany",
  "Italy", "Netherlands", "Belgium", "Sweden", "Norway", "Denmark", "Poland", "Turkey", "Greece", "Brazil", "Argentina",
  "Mexico", "Colombia", "Chile", "Japan", "South Korea", "China", "Saudi Arabia", "United Arab Emirates", "Qatar",
  "Indonesia", "Malaysia", "Singapore", "Philippines", "Other"];

const SECTIONS = [
  ["Club & team", "Who you are", [
    ["club_name", "Club name", "text", { required: true, placeholder: "e.g. Riverside FC" }],
    ["team_name", "Team name", "text", { placeholder: "e.g. U18s, First Team, Reserves" }],
    ["age_group", "Age group", "select", { options: ["", "U7", "U8", "U9", "U10", "U11", "U12", "U13", "U14", "U15", "U16", "U17", "U18", "U19", "U21", "U23", "Senior", "Veterans (35+)"] }],
    ["category", "Team", "select", { options: ["", "Boys", "Girls", "Men", "Women", "Mixed"] }],
    ["level", "Level", "select", { options: ["", "Grassroots", "School", "College / University", "Sunday league", "Semi-pro", "Academy"] }],
    ["colours", "Kit colours", "text", { placeholder: "e.g. Sky blue & white" }],
    ["coach_role", "Your role", "select", { options: ["", "Head coach", "Assistant coach", "Manager", "Analyst", "Player-coach"] }],
  ]],
  ["Where you play", "Location and home ground", [
    ["country", "Country", "select", { options: ["", ...COUNTRIES] }],
    ["region", "Region / state / county", "text", { placeholder: "e.g. Greater Manchester" }],
    ["city", "City / town", "text", { placeholder: "e.g. Salford" }],
    ["area", "Area / neighbourhood", "text", { placeholder: "e.g. Riverside Park" }],
    ["postcode", "Postcode / ZIP", "text", { placeholder: "Optional" }],
    ["ground_name", "Home ground", "text", { placeholder: "e.g. Riverside Park, pitch 2" }],
    ["ground_address", "Ground address", "text", { placeholder: "Optional", wide: true }],
  ]],
  ["Your competition", "League and season", [
    ["league", "League", "text", { placeholder: "e.g. Salford & District Youth League" }],
    ["division", "Division / tier", "text", { placeholder: "e.g. U18 Division 1" }],
    ["season", "Season", "text", { placeholder: "e.g. 2026-27" }],
  ]],
  ["Match rules", "The AI coach uses these for substitutions and timings", [
    ["match_format", "Format", "select", { options: ["", "11-a-side", "9-a-side", "7-a-side", "5-a-side"] }],
    ["half_length", "Minutes per half", "select", { options: ["", "20", "25", "30", "35", "40", "45"] }],
    ["subs_rule", "Substitutions", "select", { options: ["", "rolling", "fixed"], labels: { rolling: "Rolling (players can come back on)", fixed: "Fixed (once off, stays off)" } }],
    ["max_subs", "Max subs per game", "select", { options: ["", "1", "2", "3", "4", "5", "6", "7", "Unlimited"] }],
  ]],
  ["Facilities & training", "Helps tailor plans and sessions", [
    ["pitch_surface", "Home pitch surface", "select", { options: ["", "Grass", "3G / artificial", "Astro (sand-based)", "Indoor"] }],
    ["pitch_size", "Pitch size", "select", { options: ["", "Small", "Standard", "Large"] }],
    ["training_days", "Training days", "days", { wide: true }],
    ["squad_size", "Squad size", "number", { placeholder: "e.g. 18" }],
  ]],
];

export async function renderClub({ onboarding = false } = {}) {
  const club = (await api("/club")) || {};
  const inputs = {};
  const field = ([key, label, type, opt]) => {
    let input;
    if (type === "days") {
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      const picked = new Set(DAYS.filter((d) => String(club[key] || "").toLowerCase().includes(d.slice(0, 3).toLowerCase())));
      input = h("input", { type: "hidden", name: key, value: DAYS.filter((d) => picked.has(d)).join(", ") });
      const chips = h("div", { class: "row day-chips", role: "group", "aria-label": label }, DAYS.map((d) => {
        const b = h("button", { type: "button", class: `chip ${picked.has(d) ? "on" : ""}`, "aria-pressed": picked.has(d) ? "true" : "false" }, d.slice(0, 3));
        b.addEventListener("click", () => {
          picked.has(d) ? picked.delete(d) : picked.add(d);
          b.classList.toggle("on", picked.has(d));
          b.setAttribute("aria-pressed", picked.has(d) ? "true" : "false");
          input.value = DAYS.filter((x) => picked.has(x)).join(", ");
        });
        return b;
      }));
      inputs[key] = input;
      return h("div", { class: "field", style: { gridColumn: "1 / -1" } }, [h("span", {}, label + " — tap the days you train"), chips, input]);
    }
    if (type === "select") {
      input = h("select", { name: key }, opt.options.map((o) => h("option", { value: o, selected: (club[key] || "") === o }, o ? (opt.labels?.[o] || o) : "Choose…")));
    } else {
      input = h("input", { type, name: key, value: club[key] || "", placeholder: opt.placeholder || "", required: opt.required, maxlength: 200, min: type === "number" ? 1 : null });
    }
    inputs[key] = input;
    return h("label", { class: "field", style: opt.wide ? { gridColumn: "1 / -1" } : null }, [h("span", {}, label + (opt.required ? " *" : "")), input]);
  };

  const status = h("div");
  const save = h("button", { class: "btn primary", type: "submit" }, onboarding ? "Save and continue →" : "Save changes");
  const form = h("form", { class: "stack", style: { gap: "20px" } }, [
    ...SECTIONS.map(([title, sub, fields]) => h("section", { class: "coach-card" }, [
      h("div", {}, [h("h2", {}, title), h("p", { class: "sub" }, sub)]),
      h("div", { class: "form-grid" }, fields.map(field)),
    ])),
    status,
    h("div", { class: "coach-actions" }, [save]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    if (!data.club_name) { status.replaceChildren(h("div", { class: "errors" }, "Please enter your club name.")); return; }
    save.disabled = true;
    try {
      const saved = await api("/club", { method: "PUT", body: data });
      state.club = saved;
      state.teamId = saved.team_id;
      toast("Club saved.");
      if (onboarding) location.hash = "#/season";
      location.reload();
    } catch (err) {
      status.replaceChildren(h("div", { class: "errors" }, err.message));
      save.disabled = false;
    }
  });

  const demo = onboarding ? h("section", { class: "coach-card demo-card" }, [
    h("h2", {}, "Just exploring?"),
    h("p", { class: "secondary" }, "Load a complete example season — a youth club with 10 results, a squad, a league table, upcoming fixtures and scouting notes — and see everything working straight away."),
    h("button", { class: "btn", type: "button", onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Setting up the demo club…";
      try { await api("/demo", { method: "POST" }); location.hash = "#/plan"; location.reload(); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    } }, "Try with a demo club"),
  ]) : null;

  return h("div", { class: "coach" }, [
    h("div", { class: "coach-head" }, [
      h("p", { class: "eyebrow" }, onboarding ? "Step 1 of 2" : "Club profile"),
      h("h1", {}, onboarding ? `Welcome${state.user ? ", " + state.user.name.split(" ")[0] : ""}! Tell us about your team` : "My Club"),
      h("p", { class: "lead" }, onboarding
        ? "This takes about two minutes. Only the club name is required — everything else makes the game plans and AI advice fit your team better."
        : "Your club details. The game plans and the AI coach use these — especially the match rules."),
    ]),
    demo,
    form,
  ]);
}
