// SVG chart helpers. No dependencies — everything is drawn by hand so the app works offline.
const NS = "http://www.w3.org/2000/svg";

export function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

export function h(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v; // only used with static, trusted markup
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

export const C = {
  us: "#3987e5", them: "#d95926", neutral: "#6b6a64", s3: "#199e70", s4: "#c98500", s5: "#d55181",
  good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b",
  grid: "#2c2c2a", axis: "#383835", muted: "#898781", line: "rgba(255,255,255,0.22)", pitch: "#16201a",
};
export const ARCH_COLORS = [C.us, C.them, C.s3, C.s4, C.s5];
export const ARCH_SHAPES = ["circle", "square", "triangle", "diamond", "cross"];

export const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
export const signed = (v, d = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
export const signedPct = (v, d = 0) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(d)}%`;

// ---------------------------------------------------------------- tooltip
const tip = () => document.getElementById("tooltip");
export function showTip(evt, rows) {
  const t = tip();
  t.replaceChildren(...rows.map((r) => {
    if (typeof r === "string") return h("div", {}, r);
    const row = h("div", { class: "tt-row" });
    if (r.color) row.append(h("span", { class: "key-line", style: { background: r.color } }));
    if (r.value !== undefined) row.append(h("strong", {}, r.value));
    if (r.label) row.append(h("span", {}, r.label));
    return row;
  }));
  t.hidden = false;
  const x = evt.clientX + 14, y = evt.clientY + 14;
  const w = t.offsetWidth, hgt = t.offsetHeight;
  t.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
  t.style.top = `${Math.min(y, window.innerHeight - hgt - 8)}px`;
}
export function hideTip() { tip().hidden = true; }
export function bindTip(node, rowsFn) {
  node.addEventListener("pointermove", (e) => showTip(e, rowsFn()));
  node.addEventListener("pointerleave", hideTip);
  node.setAttribute("tabindex", "0");
  node.addEventListener("focus", (e) => {
    const r = node.getBoundingClientRect();
    showTip({ clientX: r.right, clientY: r.top }, rowsFn());
  });
  node.addEventListener("blur", hideTip);
  return node;
}

// ---------------------------------------------------------------- pitch
export function pitch({ width = 560, pad = 3, light = false } = {}) {
  const W = 120 + pad * 2, H = 80 + pad * 2;
  const svg = s("svg", { viewBox: `${-pad} ${-pad} ${W} ${H}`, width, role: "img", style: `width:100%;max-width:${width}px;height:auto` });
  const line = light ? "rgba(0,0,0,0.25)" : C.line;
  const bg = light ? "#eef2ec" : C.pitch;
  const st = { fill: "none", stroke: line, "stroke-width": 0.35 };
  svg.append(s("rect", { x: -pad, y: -pad, width: W, height: H, fill: bg, rx: 2 }));
  const lines = s("g", {}, [
    s("rect", { x: 0, y: 0, width: 120, height: 80, ...st }),
    s("line", { x1: 60, y1: 0, x2: 60, y2: 80, ...st }),
    s("circle", { cx: 60, cy: 40, r: 10, ...st }),
    s("rect", { x: 0, y: 18, width: 18, height: 44, ...st }),
    s("rect", { x: 102, y: 18, width: 18, height: 44, ...st }),
    s("rect", { x: 0, y: 30, width: 6, height: 20, ...st }),
    s("rect", { x: 114, y: 30, width: 6, height: 20, ...st }),
    s("circle", { cx: 12, cy: 40, r: 0.5, fill: line }),
    s("circle", { cx: 108, cy: 40, r: 0.5, fill: line }),
    s("circle", { cx: 60, cy: 40, r: 0.5, fill: line }),
    s("path", { d: "M18 32 A10 10 0 0 1 18 48", ...st }),
    s("path", { d: "M102 32 A10 10 0 0 0 102 48", ...st }),
  ]);
  const layer = s("g");
  svg.append(layer, lines);
  return { svg, layer };
}

export function attackArrow(svg, label = "Attacking direction") {
  svg.append(s("g", { opacity: 0.8 }, [
    s("line", { x1: 48, y1: 84.5, x2: 72, y2: 84.5, stroke: C.muted, "stroke-width": 0.4, "marker-end": "" }),
    s("path", { d: "M72 83.3 L74.5 84.5 L72 85.7 Z", fill: C.muted }),
  ]));
  return label;
}

export function heatmap(grid, color = C.us, { title = "Touches", light = false } = {}) {
  const { svg, layer } = pitch({ light });
  if (!grid) return emptyPitch(svg, "No event data for this team");
  const gx = grid.length, gy = grid[0].length, cw = 120 / gx, ch = 80 / gy;
  grid.forEach((col, i) => col.forEach((v, j) => {
    const r = s("rect", { x: i * cw + 0.3, y: j * ch + 0.3, width: cw - 0.6, height: ch - 0.6, rx: 0.8, fill: color, "fill-opacity": (0.04 + 0.86 * v).toFixed(3) });
    bindTip(r, () => [{ value: pct(v), label: `${title} relative to busiest zone` }, `${zoneName(i, j, gx, gy)}`]);
    layer.append(r);
  }));
  return svg;
}

export function zoneName(i, j, gx = 12, gy = 8) {
  const third = i < gx / 3 ? "defensive third" : i < (2 * gx) / 3 ? "middle third" : "final third";
  const lanes = ["left wing", "left wing", "left half-space", "centre", "centre", "right half-space", "right wing", "right wing"];
  return `${lanes[Math.floor((j / gy) * 8)]}, ${third}`;
}

function emptyPitch(svg, msg) {
  svg.append(s("text", { x: 60, y: 41, "text-anchor": "middle", "font-size": 4, class: "t-secondary" }, msg));
  return svg;
}

export function passNetwork(pn, color = C.us, { light = false } = {}) {
  const { svg, layer } = pitch({ light });
  if (!pn || !pn.nodes || !pn.nodes.length) return emptyPitch(svg, "No pass network available");
  const pos = Object.fromEntries(pn.nodes.map((n) => [n.pos, n]));
  const maxE = Math.max(...pn.edges.map((e) => e.n), 1);
  const maxN = Math.max(...pn.nodes.map((n) => n.passes), 1);
  pn.edges.filter((e) => e.n >= maxE * 0.18).forEach((e) => {
    const a = pos[e.a], b = pos[e.b];
    const l = s("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, "stroke-opacity": 0.25 + 0.6 * (e.n / maxE), "stroke-width": 0.3 + 1.6 * (e.n / maxE), "stroke-linecap": "round" });
    bindTip(l, () => [{ value: e.n, label: "completed passes (starting XI)" }, `${e.a} ↔ ${e.b}`]);
    layer.append(l);
  });
  pn.nodes.forEach((n) => {
    const r = 1.6 + 2.4 * Math.sqrt(n.passes / maxN);
    const g = s("g", {}, [
      s("circle", { cx: n.x, cy: n.y, r: r + 0.5, fill: light ? "#eef2ec" : C.pitch }),
      s("circle", { cx: n.x, cy: n.y, r, fill: color }),
      s("text", { x: n.x, y: n.y + r + 3, "text-anchor": "middle", "font-size": 2.6, class: "t-secondary" }, abbreviate(n.pos)),
    ]);
    bindTip(g, () => [{ value: n.passes, label: "passes attempted" }, n.pos]);
    layer.append(g);
  });
  return svg;
}

function abbreviate(p) {
  const map = { Goalkeeper: "GK", "Right Back": "RB", "Left Back": "LB", "Right Center Back": "RCB", "Left Center Back": "LCB", "Center Back": "CB",
    "Right Wing Back": "RWB", "Left Wing Back": "LWB", "Right Defensive Midfield": "RDM", "Left Defensive Midfield": "LDM", "Center Defensive Midfield": "CDM",
    "Right Center Midfield": "RCM", "Left Center Midfield": "LCM", "Center Midfield": "CM", "Right Midfield": "RM", "Left Midfield": "LM",
    "Right Wing": "RW", "Left Wing": "LW", "Right Attacking Midfield": "RAM", "Left Attacking Midfield": "LAM", "Center Attacking Midfield": "CAM",
    "Right Center Forward": "RCF", "Left Center Forward": "LCF", "Center Forward": "ST", "Secondary Striker": "SS" };
  return map[p] || p.split(" ").map((w) => w[0]).join("");
}

export function shotMap(shots, color = C.us, { light = false, label = "shot" } = {}) {
  const { svg, layer } = pitch({ light });
  if (!shots || !shots.length) return emptyPitch(svg, "No shots to show");
  shots.forEach((sh) => {
    const [x, y, xg, goal] = sh;
    const r = 0.9 + 4.5 * Math.sqrt(xg);
    const c = s("circle", { cx: x, cy: y, r, fill: goal ? color : "none", "fill-opacity": goal ? 0.9 : 0, stroke: color, "stroke-width": 0.45, "stroke-opacity": 0.9 });
    const halo = s("circle", { cx: x, cy: y, r: Math.max(r, 2.5), fill: "transparent" });
    const g = s("g", {}, [c, halo]);
    bindTip(g, () => [{ value: xg.toFixed(2), label: "xG" }, goal ? "Goal" : label]);
    layer.append(g);
  });
  return svg;
}

export function zonesPitch(zones, { light = false } = {}) {
  const { svg, layer } = pitch({ light });
  const lane = { "left wing": [0, 20], "left half-space": [20, 30], centre: [30, 50], "right half-space": [50, 60], "right wing": [60, 80] };
  zones.attack.forEach((z) => {
    const [y0, y1] = lane[z.zone];
    const r = s("rect", { x: 80, y: y0 + 0.4, width: 39.6, height: y1 - y0 - 0.8, fill: C.us, "fill-opacity": 0.35, rx: 1 });
    bindTip(r, () => [{ value: z.zone, label: "attack here" }, `Only ${pct(z.opp_def_share)} of their defensive actions happen in this lane`]);
    layer.append(r);
    layer.append(s("text", { x: 100, y: (y0 + y1) / 2 + 1.2, "text-anchor": "middle", "font-size": 3, class: "t-primary" }, "ATTACK"));
  });
  zones.protect.forEach((z) => {
    const [y0, y1] = lane[z.zone];
    const r = s("rect", { x: 0.4, y: y0 + 0.4, width: 39.6, height: y1 - y0 - 0.8, fill: C.them, "fill-opacity": 0.35, rx: 1 });
    bindTip(r, () => [{ value: z.zone, label: "protect" }, `${pct(z.opp_attack_share)} of their final-third play comes down this side`]);
    layer.append(r);
    layer.append(s("text", { x: 20, y: (y0 + y1) / 2 + 1.2, "text-anchor": "middle", "font-size": 3, class: "t-primary" }, "PROTECT"));
  });
  return svg;
}

// ---------------------------------------------------------------- generic charts
function frame(w, hgt, m) {
  const svg = s("svg", { viewBox: `0 0 ${w} ${hgt}`, style: "width:100%;height:auto" });
  return { svg, iw: w - m.l - m.r, ih: hgt - m.t - m.b, g: s("g", { transform: `translate(${m.l},${m.t})` }) };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function yAxis(g, iw, ih, max, fmt, ticks = 4) {
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i, y = ih - (v / max) * ih;
    g.append(s("line", { x1: 0, x2: iw, y1: y, y2: y, stroke: i === 0 ? C.axis : C.grid, "stroke-width": 1 }));
    g.append(s("text", { x: -6, y: y + 3.5, "text-anchor": "end", class: "num" }, fmt(v)));
  }
}

function roundTopBar(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return "";
  const rr = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + hgt} Z`;
}

/** Grouped columns: cats = labels, series = [{name, color, values}] */
export function columns(cats, series, { height = 220, fmt = (v) => pct(v), yfmt, valueLabel = "" } = {}) {
  const m = { t: 10, r: 8, b: 26, l: 40 };
  const { svg, iw, ih, g } = frame(520, height, m);
  const max = niceMax(Math.max(...series.flatMap((x) => x.values)) * 1.05);
  yAxis(g, iw, ih, max, yfmt || fmt);
  const band = iw / cats.length;
  const bw = Math.min(24, (band * 0.7) / series.length);
  cats.forEach((c, i) => {
    const x0 = i * band + (band - bw * series.length - 2 * (series.length - 1)) / 2;
    series.forEach((ser, k) => {
      const v = ser.values[i], bh = (v / max) * ih;
      const p = s("path", { d: roundTopBar(x0 + k * (bw + 2), ih - bh, bw, bh), fill: ser.color });
      g.append(p);
      const hit = s("rect", { x: i * band, y: 0, width: band, height: ih, fill: "transparent" });
      if (k === 0) {
        bindTip(hit, () => [String(c), ...series.map((sr) => ({ color: sr.color, value: fmt(sr.values[i]), label: sr.name + (valueLabel ? ` ${valueLabel}` : "") }))]);
        g.append(hit);
      }
    });
    g.append(s("text", { x: i * band + band / 2, y: ih + 16, "text-anchor": "middle" }, c));
  });
  svg.append(g);
  return svg;
}

/** Line chart with crosshair. series = [{name,color,values}] ; labels = x labels */
export function lineChart(labels, series, { height = 220, fmt = (v) => v.toFixed(2), yMax, area = false } = {}) {
  const m = { t: 12, r: 14, b: 26, l: 40 };
  const { svg, iw, ih, g } = frame(560, height, m);
  const vals = series.flatMap((x) => x.values.filter((v) => v != null));
  const max = yMax || niceMax(Math.max(...vals, 0.01) * 1.08);
  yAxis(g, iw, ih, max, fmt);
  const n = labels.length;
  const X = (i) => (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v) => ih - (v / max) * ih;
  const step = Math.ceil(n / 8);
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) g.append(s("text", { x: X(i), y: ih + 16, "text-anchor": "middle" }, l)); });
  series.forEach((ser) => {
    const pts = ser.values.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
    if (!pts.length) return;
    if (area) g.append(s("path", { d: `M${pts[0][0]},${ih} L${pts.map((p) => p.join(",")).join(" L")} L${pts[pts.length - 1][0]},${ih} Z`, fill: ser.color, "fill-opacity": 0.1 }));
    g.append(s("path", { d: `M${pts.map((p) => p.join(",")).join(" L")}`, fill: "none", stroke: ser.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": ser.dash || null }));
    const last = pts[pts.length - 1];
    g.append(s("circle", { cx: last[0], cy: last[1], r: 4, fill: ser.color, stroke: "#1a1a19", "stroke-width": 2 }));
  });
  const cross = s("line", { y1: 0, y2: ih, stroke: C.muted, "stroke-width": 1, opacity: 0 });
  g.append(cross);
  const hit = s("rect", { x: 0, y: 0, width: iw, height: ih, fill: "transparent" });
  hit.addEventListener("pointermove", (e) => {
    const r = hit.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("opacity", 0.6);
    showTip(e, [String(labels[i]), ...series.map((sr) => ({ color: sr.color, value: sr.values[i] == null ? "—" : fmt(sr.values[i]), label: sr.name }))]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  g.append(hit);
  svg.append(g);
  return svg;
}

/** Driver bars: rows = [{label, value}] diverging around 0, good direction colours handled by caller */
export function divergingBars(rows, { height, fmt = (v) => signedPct(v), max } = {}) {
  const rowH = 26;
  const H = height || rows.length * rowH + 24;
  const m = { t: 6, r: 50, b: 18, l: 150 };
  const { svg, iw, ih, g } = frame(520, H, m);
  const mx = max || Math.max(0.05, ...rows.map((r) => Math.abs(r.value))) * 1.1;
  const X = (v) => iw / 2 + (v / mx) * (iw / 2);
  g.append(s("line", { x1: iw / 2, x2: iw / 2, y1: 0, y2: ih, stroke: C.axis }));
  rows.forEach((r, i) => {
    const y = i * rowH + 4, bh = 14;
    const x0 = Math.min(X(0), X(r.value)), w = Math.abs(X(r.value) - X(0));
    const bar = s("rect", { x: x0, y, width: Math.max(w, 1), height: bh, rx: 3, fill: r.color });
    g.append(s("text", { x: -8, y: y + 11, "text-anchor": "end", class: "t-secondary" }, r.label));
    g.append(bar);
    g.append(s("text", { x: r.value >= 0 ? X(r.value) + 5 : X(r.value) - 5, y: y + 11, "text-anchor": r.value >= 0 ? "start" : "end", class: "t-primary num" }, fmt(r.value)));
    bindTip(bar, () => [{ color: r.color, value: fmt(r.value), label: r.label }, r.note || ""]);
  });
  g.append(s("text", { x: 0, y: ih + 14 }, `−${pct(mx)}`));
  g.append(s("text", { x: iw, y: ih + 14, "text-anchor": "end" }, `+${pct(mx)}`));
  svg.append(g);
  return svg;
}

/** Style dumbbell: features with z-scores for us and them */
export function styleDumbbell(features, za, zb, { nameA = "You", nameB = "Opponent", labels = {} } = {}) {
  const rowH = 30;
  const m = { t: 8, r: 16, b: 22, l: 120 };
  const { svg, iw, ih, g } = frame(520, features.length * rowH + 30, m);
  const X = (z) => ((Math.max(-2.5, Math.min(2.5, z)) + 2.5) / 5) * iw;
  [-2, -1, 0, 1, 2].forEach((z) => {
    g.append(s("line", { x1: X(z), x2: X(z), y1: 0, y2: ih, stroke: z === 0 ? C.axis : C.grid }));
    g.append(s("text", { x: X(z), y: ih + 14, "text-anchor": "middle" }, z === 0 ? "pro avg" : `${z > 0 ? "+" : ""}${z}σ`));
  });
  features.forEach((f, i) => {
    const y = i * rowH + 15;
    g.append(s("text", { x: -10, y: y + 4, "text-anchor": "end", class: "t-secondary" }, labels[f] || f));
    g.append(s("line", { x1: X(za[f]), x2: X(zb[f]), y1: y, y2: y, stroke: C.muted, "stroke-width": 2, "stroke-opacity": 0.5 }));
    const a = s("circle", { cx: X(zb[f]), cy: y, r: 6, fill: C.them, stroke: "#1a1a19", "stroke-width": 2 });
    const b = s("circle", { cx: X(za[f]), cy: y, r: 6, fill: C.us, stroke: "#1a1a19", "stroke-width": 2 });
    bindTip(a, () => [{ color: C.them, value: `${zb[f] >= 0 ? "+" : ""}${zb[f].toFixed(2)}σ`, label: nameB }, labels[f] || f]);
    bindTip(b, () => [{ color: C.us, value: `${za[f] >= 0 ? "+" : ""}${za[f].toFixed(2)}σ`, label: nameA }, labels[f] || f]);
    g.append(a, b);
  });
  svg.append(g);
  return svg;
}

/** Scatter with shapes per category (secondary encoding) */
export function scatter(points, { height = 460, colorOf, shapeOf, tipOf, highlight = new Set(), xLabel = "", yLabel = "", onClick } = {}) {
  const m = { t: 16, r: 16, b: 34, l: 40 };
  const { svg, iw, ih, g } = frame(760, height, m);
  const xs = points.map((p) => p.xy[0]), ys = points.map((p) => p.xy[1]);
  const pad = 0.4;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const X = (v) => ((v - x0) / (x1 - x0)) * iw, Y = (v) => ih - ((v - y0) / (y1 - y0)) * ih;
  g.append(s("line", { x1: X(0), x2: X(0), y1: 0, y2: ih, stroke: C.grid }));
  g.append(s("line", { x1: 0, x2: iw, y1: Y(0), y2: Y(0), stroke: C.grid }));
  g.append(s("text", { x: iw, y: ih + 26, "text-anchor": "end" }, xLabel));
  g.append(s("text", { x: 0, y: -4 }, yLabel));
  const sorted = [...points].sort((a, b) => (highlight.has(a.id) ? 1 : 0) - (highlight.has(b.id) ? 1 : 0));
  sorted.forEach((p) => {
    const cx = X(p.xy[0]), cy = Y(p.xy[1]);
    const big = highlight.has(p.id) || p.source === "local";
    const r = big ? 7 : 5;
    const grp = s("g", { style: "cursor:pointer" });
    grp.append(shape(shapeOf(p), cx, cy, r, colorOf(p), big));
    grp.append(s("circle", { cx, cy, r: 12, fill: "transparent" }));
    if (big) grp.append(s("text", { x: cx + 10, y: cy + 4, class: "t-primary", "font-weight": 600 }, p.label.split(" · ")[0]));
    bindTip(grp, () => tipOf(p));
    if (onClick) grp.addEventListener("click", () => onClick(p));
    g.append(grp);
  });
  svg.append(g);
  return svg;
}

function shape(kind, x, y, r, fill, ring) {
  const st = { fill, stroke: ring ? "#ffffff" : "#1a1a19", "stroke-width": ring ? 2 : 1.5 };
  switch (kind) {
    case "square": return s("rect", { x: x - r * 0.85, y: y - r * 0.85, width: r * 1.7, height: r * 1.7, rx: 1.5, ...st });
    case "triangle": return s("path", { d: `M${x},${y - r} L${x + r},${y + r * 0.8} L${x - r},${y + r * 0.8} Z`, ...st });
    case "diamond": return s("path", { d: `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`, ...st });
    case "cross": return s("path", { d: `M${x - r},${y - r * 0.35} H${x - r * 0.35} V${y - r} H${x + r * 0.35} V${y - r * 0.35} H${x + r} V${y + r * 0.35} H${x + r * 0.35} V${y + r} H${x - r * 0.35} V${y + r * 0.35} H${x - r} Z`, ...st });
    default: return s("circle", { cx: x, cy: y, r, ...st });
  }
}
export function shapeIcon(kind, color) {
  const svg = s("svg", { viewBox: "0 0 16 16", width: 12, height: 12, style: "display:inline-block" });
  svg.append(shape(kind, 8, 8, 6, color, false));
  return svg;
}

/** Calibration: predicted vs observed with diagonal */
export function calibration(points) {
  const m = { t: 10, r: 14, b: 32, l: 40 };
  const { svg, iw, ih, g } = frame(420, 320, m);
  const X = (v) => v * iw, Y = (v) => ih - v * ih;
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
    g.append(s("line", { x1: 0, x2: iw, y1: Y(v), y2: Y(v), stroke: v === 0 ? C.axis : C.grid }));
    g.append(s("text", { x: -6, y: Y(v) + 3.5, "text-anchor": "end" }, pct(v)));
    g.append(s("text", { x: X(v), y: ih + 15, "text-anchor": "middle" }, pct(v)));
  });
  g.append(s("text", { x: iw / 2, y: ih + 29, "text-anchor": "middle" }, "Predicted probability"));
  g.append(s("line", { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), stroke: C.muted, "stroke-dasharray": "4 4" }));
  const pts = points.map((p) => [X(p.predicted), Y(p.observed)]);
  g.append(s("path", { d: `M${pts.map((p) => p.join(",")).join(" L")}`, fill: "none", stroke: C.us, "stroke-width": 2 }));
  points.forEach((p) => {
    const r = 3 + Math.sqrt(p.n) / 2.5;
    const c = s("circle", { cx: X(p.predicted), cy: Y(p.observed), r, fill: C.us, stroke: "#1a1a19", "stroke-width": 2 });
    bindTip(c, () => [{ color: C.us, value: pct(p.observed, 1), label: "observed" }, `predicted ${pct(p.predicted, 1)} · ${p.n} outcomes`]);
    g.append(c);
  });
  svg.append(g);
  return svg;
}

/** Forest plot: rows [{label, est, lo, hi}] in log-multiplier units */
export function forest(rows, { fmt = (v) => signedPct(Math.exp(v) - 1, 1) } = {}) {
  const rowH = 28;
  const m = { t: 10, r: 70, b: 24, l: 190 };
  const { svg, iw, ih, g } = frame(620, rows.length * rowH + 34, m);
  const mx = Math.max(0.05, ...rows.flatMap((r) => [Math.abs(r.lo), Math.abs(r.hi)])) * 1.1;
  const X = (v) => iw / 2 + (v / mx) * (iw / 2);
  g.append(s("line", { x1: X(0), x2: X(0), y1: 0, y2: ih, stroke: C.axis }));
  rows.forEach((r, i) => {
    const y = i * rowH + 14;
    const sig = r.lo > 0 || r.hi < 0;
    g.append(s("text", { x: -10, y: y + 4, "text-anchor": "end", class: "t-secondary" }, r.label));
    g.append(s("line", { x1: X(r.lo), x2: X(r.hi), y1: y, y2: y, stroke: sig ? C.us : C.muted, "stroke-width": 2, "stroke-linecap": "round" }));
    const c = s("circle", { cx: X(r.est), cy: y, r: 5, fill: sig ? C.us : C.muted, stroke: "#1a1a19", "stroke-width": 2 });
    bindTip(c, () => [{ value: fmt(r.est), label: "estimate" }, `90% interval ${fmt(r.lo)} to ${fmt(r.hi)}`, sig ? "Interval excludes zero" : "Interval includes zero — treat as uncertain"]);
    g.append(c);
    g.append(s("text", { x: iw + 8, y: y + 4, class: "t-primary num" }, fmt(r.est)));
  });
  g.append(s("text", { x: X(0), y: ih + 16, "text-anchor": "middle" }, "no effect"));
  svg.append(g);
  return svg;
}

// ---------------------------------------------------------------- drill diagram
export function drillDiagram(d, { light = false } = {}) {
  const svg = s("svg", { viewBox: "0 0 104 64", style: "width:100%;height:auto;border-radius:8px" });
  svg.append(s("rect", { x: 0, y: 0, width: 104, height: 64, fill: light ? "#e9efe8" : C.pitch }));
  svg.append(s("rect", { x: 2, y: 2, width: 100, height: 60, fill: "none", stroke: light ? "rgba(0,0,0,.25)" : C.line, "stroke-width": 0.4 }));
  const g = s("g", { transform: "translate(2,2)" });
  const dg = d.diagram || {};
  (dg.zones || []).forEach(([x, y, w, hh, lab]) => {
    g.append(s("rect", { x, y, width: w, height: hh, fill: light ? "rgba(0,0,0,.05)" : "rgba(255,255,255,.05)", stroke: light ? "rgba(0,0,0,.3)" : "rgba(255,255,255,.3)", "stroke-width": 0.3, "stroke-dasharray": "1.5 1", rx: 0.8 }));
    if (lab) g.append(s("text", { x: x + w / 2, y: y + 3, "text-anchor": "middle", "font-size": 2.4 }, lab));
  });
  (dg.cones || []).forEach(([x, y]) => g.append(s("path", { d: `M${x},${y - 1.4} L${x + 1.2},${y + 1} L${x - 1.2},${y + 1} Z`, fill: C.warning })));
  const markers = { pass: "", run: "3 1.5", dribble: "0.8 0.8" };
  (dg.arrows || []).forEach(([x1, y1, x2, y2, k]) => {
    const ang = Math.atan2(y2 - y1, x2 - x1), hl = 1.8;
    const col = light ? "#33332f" : "#e8e7e1";
    g.append(s("line", { x1, y1, x2: x2 - Math.cos(ang) * 1.2, y2: y2 - Math.sin(ang) * 1.2, stroke: col, "stroke-width": 0.45, "stroke-dasharray": markers[k] || "" }));
    g.append(s("path", { d: `M${x2},${y2} L${x2 - hl * Math.cos(ang - 0.45)},${y2 - hl * Math.sin(ang - 0.45)} L${x2 - hl * Math.cos(ang + 0.45)},${y2 - hl * Math.sin(ang + 0.45)} Z`, fill: col }));
  });
  const fill = { a: C.us, b: C.them, n: C.s4, gk: C.s3 };
  (dg.players || []).forEach(([x, y, t]) => g.append(s("circle", { cx: x, cy: y, r: 1.8, fill: fill[t] || C.neutral, stroke: light ? "#fff" : "#16201a", "stroke-width": 0.5 })));
  svg.append(g);
  return svg;
}

export function drillLegend() {
  return h("div", { class: "legend", style: { fontSize: "11px" } }, [
    h("span", {}, [h("span", { class: "dot", style: { background: C.us } }), "Team A"]),
    h("span", {}, [h("span", { class: "dot", style: { background: C.them } }), "Team B"]),
    h("span", {}, [h("span", { class: "dot", style: { background: C.s4 } }), "Neutral"]),
    h("span", {}, [h("span", { class: "dot", style: { background: C.s3 } }), "GK"]),
    h("span", {}, "— pass  ‑ ‑ run  ··· dribble"),
  ]);
}

// ---------------------------------------------------------------- W/D/L bar
export function wdlBar(w, d, l, { band } = {}) {
  const seg = (v, color, label) => h("div", { style: { width: `${v * 100}%`, background: color }, title: `${label} ${pct(v)}` }, v > 0.09 ? pct(v) : "");
  const bar = h("div", { class: "wdl", role: "img", "aria-label": `Win ${pct(w)}, draw ${pct(d)}, loss ${pct(l)}` }, [seg(w, C.us, "Win"), seg(d, C.neutral, "Draw"), seg(l, C.them, "Loss")]);
  const legend = h("div", { class: "wdl-legend" }, [
    h("span", {}, [h("span", { class: "key-rect", style: { background: C.us, marginRight: "6px" } }), `Win ${pct(w)}`, band ? h("span", { class: "muted" }, ` (${pct(band[0])}–${pct(band[1])})`) : null]),
    h("span", {}, [h("span", { class: "key-rect", style: { background: C.neutral, marginRight: "6px" } }), `Draw ${pct(d)}`]),
    h("span", {}, [h("span", { class: "key-rect", style: { background: C.them, marginRight: "6px" } }), `Loss ${pct(l)}`]),
  ]);
  return h("div", {}, [bar, legend]);
}

/** Histogram of two sample sets on shared bins */
export function dualHistogram(a, b, { names = ["xG for", "xG against"], bins = 12 } = {}) {
  const all = a.concat(b);
  const lo = Math.max(0, Math.min(...all) - 0.05), hi = Math.max(...all) + 0.05;
  const w = (hi - lo) / bins;
  const count = (arr) => { const c = Array(bins).fill(0); arr.forEach((v) => c[Math.min(bins - 1, Math.floor((v - lo) / w))]++); return c.map((x) => x / arr.length); };
  const cats = Array.from({ length: bins }, (_, i) => (lo + w * (i + 0.5)).toFixed(1));
  return columns(cats, [{ name: names[0], color: C.us, values: count(a) }, { name: names[1], color: C.them, values: count(b) }], { height: 200, valueLabel: "of scenarios" });
}

/** Collapsible "show more" section — keeps pages focused on the essentials. */
export function more(summary, children, { open = false, hint = "" } = {}) {
  const d = h("details", { class: "more" }, [
    h("summary", {}, [h("span", { class: "more-title" }, summary), hint ? h("span", { class: "more-hint" }, hint) : null]),
    h("div", { class: "more-body" }, children),
  ]);
  if (open) d.open = true;
  return d;
}
