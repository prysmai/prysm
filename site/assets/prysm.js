// shared chrome: the menu, smooth anchors, reveals, the active nav link, and a tiny API helper
(() => {
  // the menu panel behind the burger, the same on every page
  const burger = document.querySelector(".burger");
  if (burger) {
    const panel = document.createElement("div");
    panel.className = "menu"; panel.id = "menu"; panel.hidden = true;
    panel.innerHTML = `<div><nav><a href="/">Protocol</a><a href="/league">League</a><a href="/docs">Connect</a></nav>
      <p>Data, not advice · Robinhood Chain</p><p class="ext"><a href="https://github.com/prysmagent/prysm" target="_blank" rel="noopener">GitHub</a><a href="https://www.npmjs.com/package/prysm-agent" target="_blank" rel="noopener">npm · prysm-agent</a><a href="https://www.npmjs.com/package/prysm-mcp" target="_blank" rel="noopener">npm · prysm-mcp</a></p></div>`;
    document.body.append(panel);
    const menu = (on) => {
      panel.hidden = !on; document.body.classList.toggle("open", on);
      burger.setAttribute("aria-expanded", on); burger.setAttribute("aria-label", on ? "Close the menu" : "Open the menu");
    };
    burger.addEventListener("click", () => menu(panel.hidden));
    panel.addEventListener("click", (e) => { if (e.target.closest("a") || e.target === panel) menu(false); });
    addEventListener("keydown", (e) => e.key === "Escape" && menu(false));
  }
  document.querySelectorAll("[data-to]").forEach((a) => a.addEventListener("click", (e) => {
    const el = document.querySelector(a.dataset.to); if (!el) return;
    e.preventDefault(); el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }));
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
  window.reveal = (root = document) => root.querySelectorAll(".rv:not(.in)").forEach((el) => io.observe(el));
  window.reveal();
  const path = location.pathname.replace(/\.html$/, "");
  document.querySelectorAll(".nav a[href^='/']").forEach((a) => a.classList.toggle("act", a.getAttribute("href") === path));
})();

window.N = {
  api: async (p) => { const r = await fetch(p); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); },
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  bps: (v) => (v == null ? "·" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : "dim"}">${v > 0 ? "▲ " : v < 0 ? "▼ " : ""}${Math.abs(+v).toFixed(v % 1 ? 1 : 0)} bp</span>`),
  hz: (s) => ({ 900: "15m", 3600: "1h", 14400: "4h" }[s] || (s ? s + "s" : "sealed")),
  ago: (t) => { if (!t) return "·"; const d = Math.max(0, Date.now() / 1000 - t); return d < 90 ? `${Math.round(d)}s ago` : d < 5400 ? `${Math.round(d / 60)}m ago` : d < 172800 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`; },
  short: (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "·"),
};
