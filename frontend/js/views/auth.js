// Full-screen sign in / create account page.
import { h, s } from "../charts.js";

function pitchArt() {
  const svg = s("svg", { viewBox: "0 0 120 80", class: "auth-pitch", "aria-hidden": "true", preserveAspectRatio: "xMidYMid slice" });
  const st = { fill: "none", stroke: "rgba(255,255,255,0.16)", "stroke-width": 0.4 };
  svg.append(
    s("rect", { x: 2, y: 2, width: 116, height: 76, ...st }),
    s("line", { x1: 60, y1: 2, x2: 60, y2: 78, ...st }),
    s("circle", { cx: 60, cy: 40, r: 10, ...st }),
    s("rect", { x: 2, y: 20, width: 17, height: 40, ...st }),
    s("rect", { x: 101, y: 20, width: 17, height: 40, ...st }),
    s("rect", { x: 2, y: 31, width: 6, height: 18, ...st }),
    s("rect", { x: 112, y: 31, width: 6, height: 18, ...st }),
  );
  // a few "players" and passing lines for flavour
  const pts = [[24, 40], [38, 22], [38, 58], [56, 32], [56, 50], [74, 24], [74, 56], [90, 40]];
  [[0, 1], [1, 3], [3, 5], [5, 7], [0, 2], [2, 4], [4, 6], [6, 7], [3, 4]].forEach(([a, b]) =>
    svg.append(s("line", { x1: pts[a][0], y1: pts[a][1], x2: pts[b][0], y2: pts[b][1], stroke: "rgba(255,255,255,0.22)", "stroke-width": 0.35, "stroke-dasharray": "1.2 1.2" })));
  pts.forEach(([x, y], i) => svg.append(s("circle", { cx: x, cy: y, r: i === 7 ? 2 : 1.5, fill: i === 7 ? "#fab219" : "rgba(255,255,255,0.85)" })));
  return svg;
}

export function renderAuth(onSignedIn, { onClose } = {}) {
  let mode = "signin";
  const errorBox = h("div", { class: "auth-error", role: "alert", hidden: true });
  const name = h("input", { type: "text", name: "name", autocomplete: "name", placeholder: "e.g. Alex Morgan", maxlength: 80 });
  const email = h("input", { type: "email", name: "email", autocomplete: "email", placeholder: "you@club.com", required: true, maxlength: 200 });
  const pw = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder: "At least 8 characters", required: true, maxlength: 200 });
  const toggle = h("button", { type: "button", class: "pw-toggle", "aria-label": "Show password", onclick: () => {
    pw.type = pw.type === "password" ? "text" : "password";
    toggle.textContent = pw.type === "password" ? "Show" : "Hide";
  } }, "Show");
  const nameField = h("label", { class: "auth-field" }, [h("span", {}, "Your name"), name]);
  const submit = h("button", { type: "submit", class: "btn primary auth-submit" }, "Sign in");
  const tabIn = h("button", { type: "button", class: "on", onclick: () => setMode("signin") }, "Sign in");
  const tabUp = h("button", { type: "button", onclick: () => setMode("signup") }, "Create account");
  const hint = h("p", { class: "auth-hint" });

  function setMode(m) {
    mode = m;
    tabIn.classList.toggle("on", m === "signin");
    tabUp.classList.toggle("on", m === "signup");
    nameField.hidden = m !== "signup";
    name.required = m === "signup";
    pw.autocomplete = m === "signup" ? "new-password" : "current-password";
    submit.textContent = m === "signup" ? "Create my account" : "Sign in";
    hint.textContent = m === "signup" ? "Free for grassroots coaches. Your club's data stays on this device." : "Welcome back, coach.";
    errorBox.hidden = true;
  }

  const form = h("form", { class: "auth-form", novalidate: true }, [
    h("div", { class: "auth-tabs", role: "tablist" }, [tabIn, tabUp]),
    hint, nameField,
    h("label", { class: "auth-field" }, [h("span", {}, "Email"), email]),
    h("label", { class: "auth-field" }, [h("span", {}, "Password"), h("div", { class: "pw-wrap" }, [pw, toggle])]),
    errorBox, submit,
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    if (mode === "signup" && !name.value.trim()) return showError("Please enter your name.");
    if (!email.value.trim() || !pw.value) return showError("Please enter your email and password.");
    submit.disabled = true;
    submit.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
    try {
      const res = await fetch(`/api/auth/${mode === "signup" ? "signup" : "login"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value.trim(), email: email.value.trim(), password: pw.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Something went wrong.");
      onSignedIn(data);
    } catch (err) {
      showError(err.message);
    } finally {
      submit.disabled = false;
      setMode(mode);
    }
  });
  function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
  setMode(onClose ? "signup" : "signin");

  return h("div", { class: "auth" }, [
    onClose ? h("button", { class: "auth-close", "aria-label": "Close", onclick: onClose }, "✕ Back to the demo") : null,
    h("section", { class: "auth-hero" }, [
      pitchArt(),
      h("div", { class: "auth-hero-inner" }, [
        h("div", { class: "auth-brand" }, [h("span", { class: "brand-mark" }, "12"), h("strong", {}, "The Twelfth Man")]),
        h("h1", {}, ["Your assistant coach", h("br"), "for every matchday."]),
        h("ul", { class: "auth-points" }, [
          h("li", {}, [h("span", {}, "◎"), "A clear game plan for every opponent — in plain football language"]),
          h("li", {}, [h("span", {}, "▤"), "Team sheets and training sessions ready to print"]),
          h("li", {}, [h("span", {}, "💬"), "Ask Coach Twelve, our in-house AI coach, anything about tactics and your next match"]),
        ]),
        h("p", { class: "auth-foot" }, "Built on 495 professional matches of open data · For coaching and learning, not betting."),
      ]),
    ]),
    h("section", { class: "auth-panel" }, [h("div", { class: "auth-card" }, [
      h("h2", {}, onClose ? "Make it your club" : "Get started"),
      onClose ? h("p", { class: "secondary" }, "Create a free account to add your own team, fixtures and league. The demo stays available any time.") : null,
      form,
    ])]),
  ]);
}
