import { state, api, save, toast, label } from "../state.js";
import { h, ARCH_COLORS, ARCH_SHAPES, shapeIcon, pct, signed, scatter, divergingBars , more } from "../charts.js";
import { go, render, renderPickers } from "../app.js";

const FEATURES = ["possession", "pass_comp", "press_height", "directness", "width"];
const FEATURE_LABELS = { possession: "Possession", pass_comp: "Pass completion", press_height: "Press height", directness: "Directness", width: "Width" };
// How to describe moving along an axis, for a positive / negative feature weight.
const AXIS_PHRASE = {
  possession: ["more possession", "less possession"],
  pass_comp: ["higher pass completion", "lower pass completion"],
  press_height: ["higher press", "deeper block"],
  directness: ["more direct", "less direct"],
  width: ["wider", "narrower"],
};

const FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "pl", label: "Premier League 15/16", test: (p) => p.id.endsWith("-pl-15-16") },
  { key: "euro", label: "Euro 2024", test: (p) => p.id.endsWith("-euro-24") },
  { key: "wc", label: "World Cup 2022", test: (p) => p.id.endsWith("-wc-22") },
  { key: "local", label: "Your club data", test: (p) => p.source === "local" },
];

// Kept at module level so the choice survives the full re-render after picking an opponent.
let filterKey = "all";
let mode = "map";

const colorOf = (p) => ARCH_COLORS[p.archetype % ARCH_COLORS.length];
const shapeOf = (p) => ARCH_SHAPES[p.archetype % ARCH_SHAPES.length];
const archColor = (a) => ARCH_COLORS[a.id % ARCH_COLORS.length];
const archShape = (a) => ARCH_SHAPES[a.id % ARCH_SHAPES.length];
const zfmt = (v) => (Math.abs(v) < 0.05 ? "0.0σ" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}σ`);

function axisPhrase(weights = {}) {
  const top = Object.entries(weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2);
  if (!top.length) return "";
  return top.map(([f, w]) => (AXIS_PHRASE[f] || [`more ${f}`, `less ${f}`])[w >= 0 ? 0 : 1]).join(" & ");
}

function roleOf(p) {
  if (p.id === state.teamId) return "Your team";
  if (p.id === state.oppId) return "Current opponent";
  return null;
}

function competitionOf(p) {
  if (p.source === "local") return "Your club data";
  const t = state.teams.find((x) => x.id === p.id);
  if (t && t.competition) return t.competition;
  const f = FILTERS.find((x) => x.key !== "all" && x.key !== "local" && x.test(p));
  return f ? f.label : "";
}

function pickOpponent(p) {
  if (p.id === state.teamId) { toast(`${p.label} is your team — pick a different side to scout.`); return; }
  if (p.id === state.oppId) { toast(`${p.label} is already your opponent.`); return; }
  state.oppId = p.id;
  save();
  renderPickers();
  toast(`Opponent set to ${p.label}. Open Matchup to scout them.`);
  render();
}

// divergingBars() labels its axis ends as percentages; these bars are in SD units.
function relabelEnds(svg, max) {
  const texts = svg.querySelectorAll("text");
  const m = +max.toFixed(1);
  if (texts.length >= 2) {
    texts[texts.length - 2].textContent = `−${m}σ`;
    texts[texts.length - 1].textContent = `+${m}σ`;
  }
  return svg;
}

// Share of pro-vs-pro pairs that sit further apart on the map than distance d.
function furtherShare(points, d) {
  const pro = points.filter((p) => p.source !== "local");
  let further = 0, n = 0;
  for (let i = 0; i < pro.length; i++) {
    for (let j = i + 1; j < pro.length; j++) {
      const dd = Math.hypot(pro[i].xy[0] - pro[j].xy[0], pro[i].xy[1] - pro[j].xy[1]);
      n++;
      if (dd > d) further++;
    }
  }
  return n ? further / n : null;
}

export async function renderExplore() {
  const map = await api("/archetype-map");
  const points = map.points || [];
  const archs = [...(map.archetypes || [])].sort((a, b) => a.id - b.id);
  const archById = Object.fromEntries(archs.map((a) => [a.id, a]));
  const archName = (id) => (archById[id] ? archById[id].name : `Archetype ${id + 1}`);
  const axes = map.axes || {};
  const xPhrase = axisPhrase(axes.x), yPhrase = axisPhrase(axes.y);
  const xLabel = xPhrase ? `${xPhrase} →` : "";
  const yLabel = yPhrase ? `↑ ${yPhrase}` : "";

  if (filterKey === "local" && !points.some((p) => p.source === "local")) filterKey = "all";

  const archTag = (id) => h("span", { class: "row", style: { gap: "6px", display: "inline-flex", flexWrap: "nowrap" } }, [
    shapeIcon(ARCH_SHAPES[id % ARCH_SHAPES.length], ARCH_COLORS[id % ARCH_COLORS.length]),
    h("span", {}, archName(id)),
  ]);

  const tipOf = (p) => {
    const role = roleOf(p);
    return [
      p.label,
      { color: colorOf(p), value: archName(p.archetype) },
      competitionOf(p),
      role || "Click to set as opponent",
    ];
  };

  // ------------------------------------------------------------ summary tiles
  const usP = points.find((p) => p.id === state.teamId);
  const themP = points.find((p) => p.id === state.oppId);
  const whereTile = (p, id, role) => h("div", { class: "tile" }, [
    h("span", { class: "label" }, role),
    h("strong", { style: { fontSize: "15px" } }, p ? p.label : label(id)),
    p ? h("span", { class: "delta" }, archTag(p.archetype)) : h("span", { class: "delta muted" }, "Not on the map"),
  ]);
  const tiles = [whereTile(usP, state.teamId, "Your team"), whereTile(themP, state.oppId, "Opponent")];
  if (usP && themP) {
    const d = Math.hypot(usP.xy[0] - themP.xy[0], usP.xy[1] - themP.xy[1]);
    const q = furtherShare(points, d);
    if (q != null) {
      const verdict = q >= 0.8 ? "Very similar" : q >= 0.55 ? "Fairly similar" : q >= 0.3 ? "Different" : "Very different";
      tiles.push(h("div", { class: "tile" }, [
        h("span", { class: "label" }, "Style gap on the map"),
        h("span", { class: "value", style: { fontSize: "18px" } }, verdict),
        h("span", { class: "delta" }, usP.archetype === themP.archetype
          ? `Same archetype · closer than ${pct(q)} of pro pairings`
          : `Different archetypes · closer than ${pct(q)} of pro pairings`),
      ]));
    }
  }

  // ------------------------------------------------------------ map / table card
  const chips = h("div", { class: "row", role: "group", "aria-label": "Filter teams by competition", style: { gap: "6px" } });
  const modeTabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Map or table view" });
  const body = h("div");

  const mapView = (shown) => {
    const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
    const svg = scatter(shown, {
      height: narrow ? 640 : 460,
      colorOf, shapeOf, tipOf,
      highlight: new Set([state.teamId, state.oppId]),
      onClick: pickOpponent,
      xLabel, yLabel,
    });
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Style map of ${shown.length} teams. Use the Table view for the same data as text.`);
    return h("div", {}, [
      h("div", { class: "legend" }, [
        ...archs.map((a) => h("span", {}, [shapeIcon(archShape(a), archColor(a)), a.name])),
        h("span", { class: "muted" }, "Large ringed, labelled marks = your team, opponent and club data"),
      ]),
      svg,
    ]);
  };

  const tableView = (shown) => {
    const rows = [...shown].sort((a, b) => a.label.localeCompare(b.label));
    const numStyle = { textAlign: "right" };
    const action = (p) => {
      if (p.id === state.teamId) return h("span", { class: "tag" }, "Your team");
      if (p.id === state.oppId) return h("span", { class: "tag" }, "Opponent");
      return h("button", { class: "btn small ghost", "aria-label": `Set ${p.label} as opponent`, onclick: () => pickOpponent(p) }, "Set as opponent");
    };
    return h("div", { class: "stack", style: { gap: "6px" } }, [
      h("div", { class: "table-wrap" }, h("table", {}, [
        h("thead", {}, h("tr", {}, [
          h("th", {}, "Team"), h("th", {}, "Archetype"),
          h("th", { style: numStyle, title: xPhrase ? `Higher = ${xPhrase}` : null }, "x"),
          h("th", { style: numStyle, title: yPhrase ? `Higher = ${yPhrase}` : null }, "y"),
          h("th", { style: numStyle }, "Scout"),
        ])),
        h("tbody", {}, rows.map((p) => h("tr", {}, [
          h("td", {}, [h("div", {}, p.label), h("div", { class: "sub" }, competitionOf(p))]),
          h("td", {}, archTag(p.archetype)),
          h("td", { class: "num", style: numStyle }, signed(p.xy[0])),
          h("td", { class: "num", style: numStyle }, signed(p.xy[1])),
          h("td", { style: numStyle }, action(p)),
        ]))),
      ])),
      h("p", { class: "chart-note" }, `x: higher = ${xPhrase || "first style component"}. y: higher = ${yPhrase || "second style component"}. 0 is the average pro team-season.`),
    ]);
  };

  const draw = () => {
    const f = FILTERS.find((x) => x.key === filterKey) || FILTERS[0];
    const pinned = new Set([state.teamId, state.oppId]);
    const shown = points.filter((p) => f.test(p) || pinned.has(p.id));
    chips.replaceChildren(...FILTERS.map((x) => {
      const n = points.filter(x.test).length;
      const on = x.key === f.key;
      return h("button", {
        class: `chip${on ? " on" : ""}`, "aria-pressed": String(on), "aria-label": `${x.label}, ${n} team${n === 1 ? "" : "s"}`,
        disabled: n === 0 && x.key !== "all",
        style: n === 0 && x.key !== "all" ? { opacity: 0.5, cursor: "default" } : null,
        onclick: () => { filterKey = x.key; draw(); },
      }, [x.label, h("span", { class: "muted num" }, String(n))]);
    }));
    modeTabs.replaceChildren(...[["map", "Map"], ["table", "Table"]].map(([k, name]) => h("button", {
      class: mode === k ? "on" : "", role: "tab", "aria-selected": String(mode === k),
      onclick: () => { mode = k; draw(); },
    }, name)));
    if (!shown.length) body.replaceChildren(h("div", { class: "empty" }, "No teams in this group yet."));
    else body.replaceChildren(mode === "map" ? mapView(shown) : tableView(shown));
  };
  draw();

  const mapCard = h("div", { class: "card stack", style: { gap: "12px" } }, [
    h("div", { class: "card-head", style: { marginBottom: 0 } }, [
      h("h3", {}, "Where every team sits"),
      modeTabs,
    ]),
    chips,
    body,
    h("p", { class: "chart-note" }, "Each point is a pro team-season (or one of your club teams), placed by a 2-D projection (PCA) of five style features — possession, pass completion, press height, directness and width, each standardised against all pro team-matches. Nearby points play in a similar way; two axes can't hold everything, so treat distances as a guide. Colour and shape both show the archetype. Grid lines cross at the average pro team. Filters zoom the map to that group; your team and opponent always stay on it. Click a team to set it as your opponent."),
  ]);

  // ------------------------------------------------------------ archetype cards
  const zMax = Math.max(1, ...archs.flatMap((a) => FEATURES.map((f) => Math.abs((a.centroid_z || {})[f] || 0))));
  const barMax = Math.ceil(zMax * 1.3 * 2) / 2; // headroom for value labels, rounded to 0.5σ; one scale for every card

  const memberChip = (p) => {
    const role = roleOf(p);
    return h("button", {
      class: "chip",
      title: role || "Set as opponent",
      "aria-label": role ? `${p.label} (${role.toLowerCase()})` : `Set ${p.label} as opponent`,
      onclick: () => pickOpponent(p),
    }, [p.label, role ? h("span", { class: "muted" }, p.id === state.teamId ? "· you" : "· opponent") : null]);
  };

  const archCard = (a) => {
    const color = archColor(a);
    const cz = a.centroid_z || {};
    const members = points.filter((p) => p.archetype === a.id)
      .sort((x, y) => (x.source === "local" ? 0 : 1) - (y.source === "local" ? 0 : 1) || x.label.localeCompare(y.label));
    const rows = FEATURES.filter((f) => cz[f] != null).map((f) => ({
      label: FEATURE_LABELS[f], value: cz[f], color,
      note: Math.abs(cz[f]) < 0.05 ? "Right at the pro average" : `${Math.abs(cz[f]).toFixed(1)} SD ${cz[f] > 0 ? "above" : "below"} the pro average`,
    }));
    const bars = rows.length ? relabelEnds(divergingBars(rows, { fmt: zfmt, max: barMax }), barMax) : null;
    if (bars) {
      bars.setAttribute("role", "img");
      bars.style.maxWidth = "440px";
      bars.setAttribute("aria-label", `Typical style of ${a.name}: ${rows.map((r) => `${r.label} ${zfmt(r.value)}`).join(", ")}`);
    }
    return h("div", { class: "card stack", style: { gap: "12px" } }, [
      h("div", { class: "arch" }, [
        h("span", { class: "arch-swatch", style: { background: color } }),
        h("div", { class: "stack", style: { gap: "4px" } }, [
          h("div", { class: "row", style: { gap: "8px", flexWrap: "nowrap" } }, [shapeIcon(archShape(a), color), h("h4", {}, a.name)]),
          h("p", { class: "secondary", style: { fontSize: "13px" } }, a.description),
          h("span", { class: "sub" }, `${a.share != null ? pct(a.share) : "—"} of pro team-matches · ${members.length} team${members.length === 1 ? "" : "s"} on the map`),
        ]),
      ]),
      bars ? h("div", { class: "arch-bars" }, [h("span", { class: "sub" }, "Typical style vs the pro average (SD units)"), bars]) : null,
      h("div", { class: "stack", style: { gap: "6px" } }, [
        h("span", { class: "sub" }, "Teams in this style — click to scout one"),
        members.length
          ? h("div", { class: "row", style: { gap: "6px" } }, members.map(memberChip))
          : h("span", { class: "muted" }, "No teams on the map in this style."),
      ]),
    ]);
  };

  return h("div", { class: "stack", style: { gap: "16px" } }, [
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("h1", {}, "Style Map"),
        h("p", {}, "Where every pro team-season and your own club sit among the pro tactical archetypes learned from open match data. Use it to see who plays like your next opponent, and click any team to scout them."),
      ]),
      h("div", { class: "row" }, [h("button", { class: "btn", onclick: () => go("matchup") }, "Open Matchup →")]),
    ]),
    mapCard,
    more(`The ${archs.length === 5 ? "five" : archs.length} pro archetypes`, [
      h("div", { class: "tiles" }, tiles),
      h("p", { class: "sub" }, "Bars show each archetype's average style in standard deviations (σ) from the pro average. The same scale is used on every card."),
      h("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 1fr))" } }, archs.map(archCard)),
    ], { hint: "what each style means and who plays it" }),
  ]);
}
