// Ask Coach Twelve: questions about the next match, answered from the game plan and the match engine.
import { state, api, label } from "../state.js";
import { h } from "../charts.js";

const SUGGESTIONS = [
  "How do they play, and how do we hurt them?",
  "What if we switch to 3-5-2?",
  "What if we press really high for the whole game?",
  "How do we stop their wingers?",
  "What should I tell my strikers?",
  "When should I make my substitutions?",
];

// Minimal, safe Markdown → DOM (bold, bullets, numbered lists, headings). Text is always inserted as text.
function inline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.filter(Boolean).map((p) => (p.startsWith("**") && p.endsWith("**") ? h("strong", {}, p.slice(2, -2)) : p.replace(/\*([^*]+)\*/g, "$1")));
}
function renderMd(text) {
  const out = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || num) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag, { class: "md-list" }); out.push(list); }
      list.append(h("li", {}, inline(bullet ? bullet[1] : num[2])));
      continue;
    }
    list = null;
    if (!line.trim() || /^-{3,}$/.test(line.trim())) continue;
    const head = line.match(/^#{1,4}\s+(.*)$/);
    out.push(head ? h("p", { class: "md-head" }, inline(head[1])) : h("p", {}, inline(line)));
  }
  return out;
}

// One conversation per matchup, kept for this browser session.
const threads = {};

export async function renderAsk() {
  const key = `${state.teamId}|${state.oppId}`;
  const thread = (threads[key] ||= []);
  const online = state.meta && state.meta.assistant && state.meta.assistant.enabled;
  const opp = label(state.oppId).split(" · ")[0];

  const log = h("div", { class: "chat-log", "aria-live": "polite" });
  const input = h("textarea", { class: "chat-input", rows: 2, maxlength: 1000, placeholder: `Ask anything about the game against ${opp}…`, "aria-label": "Your question" });
  const send = h("button", { class: "btn primary", type: "submit" }, "Ask");
  const chips = h("div", { class: "row", style: { gap: "8px" } });

  const bubble = (m) => h("div", { class: `msg ${m.role}` }, [
    h("div", { class: "msg-who" }, m.role === "user" ? "You" : "Coach Twelve"),
    h("div", { class: `msg-text ${m.role === "assistant" ? "md" : ""}` }, m.role === "assistant" ? renderMd(m.content) : m.content),
    m.used_model ? h("div", { class: "msg-note" }, "✓ Checked with the match model") : null,
    m.note ? h("div", { class: "msg-note" }, m.note) : null,
  ]);

  const draw = () => {
    log.replaceChildren(...(thread.length ? thread.map(bubble) : [h("div", { class: "chat-empty" }, [
      h("p", { class: "big-line" }, `Ask me anything about tactics, training or the game against ${opp}.`),
      h("p", { class: "secondary" }, "I answer from your game plan and both teams' records, and I test \"what if\" ideas with the match model before answering."),
    ])]));
    chips.replaceChildren(...SUGGESTIONS.map((q) => h("button", { class: "chip", type: "button", onclick: () => ask(q) }, q)));
    log.scrollTop = log.scrollHeight;
  };

  async function ask(q) {
    q = (q || "").trim();
    if (!q || send.disabled) return;
    const history = thread.map(({ role, content }) => ({ role, content }));
    thread.push({ role: "user", content: q });
    input.value = "";
    send.disabled = true;
    draw();
    const typing = h("div", { class: "msg assistant typing" }, [h("div", { class: "msg-who" }, "Coach Twelve"), h("div", { class: "msg-text" }, "Thinking…")]);
    log.append(typing);
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api("/ask", {
        method: "POST",
        body: { team_id: state.teamId, opponent_id: state.oppId, venue: state.venue, question: q, history,
          tactics: (state.plans || {})[`${state.teamId}|${state.oppId}`] || null },
      });
      thread.push({ role: "assistant", content: r.answer, used_model: r.used_model, note: r.note });
    } catch (e) {
      thread.push({ role: "assistant", content: `Sorry — something went wrong (${e.message}). Try again.` });
    } finally {
      send.disabled = false;
      draw();
      input.focus();
    }
  }

  const form = h("form", { class: "chat-form" }, [input, send]);
  form.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });

  draw();
  return h("div", { class: "coach" }, [
    h("div", { class: "coach-head" }, [
      h("p", { class: "eyebrow" }, `Preparing for ${opp}`),
      h("h1", {}, "Ask Coach Twelve"),
      online ? null : h("p", { class: "secondary" }, "Coach Twelve is in offline mode: common questions are answered from the game plan. Full answers and \"what if\" testing need the AI connection (see README)."),
    ]),
    h("section", { class: "coach-card chat" }, [log, form]),
    h("div", { class: "stack", style: { gap: "8px" } }, [h("span", { class: "sub" }, "Try asking"), chips]),
    thread.length ? h("button", { class: "btn ghost small", style: { alignSelf: "flex-start" }, onclick: () => { thread.length = 0; draw(); } }, "Clear conversation") : null,
  ]);
}
