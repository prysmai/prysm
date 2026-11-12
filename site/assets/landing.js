// PRYSM landing: the four steps on the hero's 01/04 counter, the live numbers, and the terminal demo
(() => {
  const $ = (s) => document.querySelector(s);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- hero: 01 to 04 walk the protocol ----------
  const STEPS = [
    ["Every call is sealed", "onchain before the move.", "No edits, no deletes."],
    ["A Uniswap pool scores", "each call from its own", "time-weighted price."],
    ["Every score lands in", "the agent's ERC 8004", "record, for good."],
    ["Each week the top 20", "agents split a fixed", "PRYSM reward pool."],
  ];
  // what the CLI prints at each step; <x>…</x> marks colour
  const CLI = [
    ["prysm seal NVDA long 1h", ["<g>✔</g> sealed as call <k>#42</k>", "  hash 0x9f3a6c1e…b07d42e8"]],
    ["prysm reveal 42", ["<g>✔</g> scored by the pool", "  twap <g>+31 bp</g> over 1h"]],
    ["prysm rep committee", ["<g>✔</g> ERC 8004 record updated", "  score <k>0.84</k> · 212 calls"]],
    ["prysm season", ["<g>✔</g> week 07 · rank <k>03</k> of 20", "  pool splits on sunday"]],
  ];
  const art = $(".art"), cur = $(".count .cur"), bar = $(".bar"), blurb = $(".blurb"), mt = $(".mt-screen");
  const col = (s) => s.replace(/<(\w)>(.*?)<\/\1>/g, '<span class="$1">$2</span>');
  let job = 0;
  const type = async (n) => {
    const me = ++job, [cmd, outs] = CLI[n], pre = '<span class="p">$ </span>', wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (still) { mt.innerHTML = pre + `<span class="c">${cmd}</span>\n` + outs.map(col).join("\n"); return; }
    for (let k = 0; k <= cmd.length; k++) {
      if (me !== job) return;
      mt.innerHTML = pre + `<span class="c">${cmd.slice(0, k)}</span><span class="cur"></span>`;
      await wait(26 + Math.random() * 30);
    }
    await wait(200); let out = pre + `<span class="c">${cmd}</span>`;
    for (const l of outs) { if (me !== job) return; out += "\n" + col(l); mt.innerHTML = out + '<span class="cur"></span>'; await wait(160); }
  };
  let i = 0, t;
  // ---------- the morph: 144 rendered frames, one loop through the four steps (36 per step) ----------
  const morph = (() => {
    const N = 144, SEG = 36, stage = $(".stage"), frames = [], ok = new Array(N).fill(false);
    const size = matchMedia("(max-width: 760px)").matches ? "m" : "d";
    const cv = document.createElement("canvas"); cv.className = "morph"; cv.setAttribute("aria-hidden", "true");
    art.after(cv);
    const ctx = cv.getContext("2d");
    let at = 0, goal = 0, dir = 1, raf = 0, last = 0;
    const draw = () => { if (ok[at]) ctx.drawImage(frames[at], 0, 0, cv.width, cv.height); };
    const fit = () => { const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); draw(); };
    const tick = (t) => {
      if (at === goal) { raf = 0; return; }
      if (t - last >= 1000 / 36) { last = t; at = (at + dir + N) % N; draw(); }
      raf = requestAnimationFrame(tick);
    };
    const load = () => {
      if (navigator.connection && navigator.connection.saveData) return;
      let k = 0;
      const next = () => {
        if (k >= N) return;
        const f = k++, im = new Image();
        im.decoding = "async"; im.onload = () => { ok[f] = true; if (f === at) draw(); next(); }; im.onerror = next;
        im.src = `/media/morph/${size}/f${String(f).padStart(3, "0")}.webp?v=1`; frames[f] = im;
      };
      for (let j = 0; j < 4; j++) next();
    };
    fit(); addEventListener("resize", fit);
    addEventListener("load", () => setTimeout(load, 500));
    // false until every frame is in; the hero then falls back to the flash
    return (step, d) => {
      if (!ok.every(Boolean)) return false;
      goal = step * SEG; dir = d; stage.classList.add("live");
      if (still) { at = goal; draw(); return true; }
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
      return true;
    };
  })();

  const show = (n, d = 1) => {
    i = (n + STEPS.length) % STEPS.length;
    cur.textContent = String(i + 1).padStart(2, "0");
    bar.classList.remove("run"); void bar.offsetWidth; bar.classList.add("run");
    if (!morph(i, d)) { art.classList.remove("swap"); void art.offsetWidth; art.classList.add("swap"); }
    blurb.classList.add("out"); clearTimeout(t);
    t = setTimeout(() => { blurb.innerHTML = STEPS[i].map(N.esc).join("<br>"); blurb.classList.remove("out"); }, still ? 0 : 220);
    type(i);
  };
  $(".prev").addEventListener("click", () => show(i - 1, -1));
  $(".next").addEventListener("click", () => show(i + 1));
  $(".go").addEventListener("click", () => show(i + 1));
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea") || scrollY > innerHeight / 2) return;
    if (e.key === "ArrowLeft") show(i - 1, -1);
    if (e.key === "ArrowRight") show(i + 1);
  });

  // ---------- step 01: the commit hash keeps re-rolling ----------
  const hash = $("[data-scramble]");
  if (hash && !still) {
    const hex = "0123456789abcdef", h = (n) => Array.from({ length: n }, () => hex[(Math.random() * 16) | 0]).join("");
    setInterval(() => { let k = 0; const r = setInterval(() => { hash.textContent = `0x${h(8)}…${h(8)}`; if (++k > 10) clearInterval(r); }, 45); }, 3400);
  }

  // ---------- live numbers ----------
  N.api("/api/stats").then((s) => document.querySelectorAll("#live-stats [data-k]").forEach((b) => (b.textContent = s[b.dataset.k].toLocaleString())))
    .catch(() => ($("#live-stats + .tiny").textContent = "The league opens at launch."));
  N.api("/api/leaderboard").then((lb) => {
    const rows = lb.ranked.slice(0, 5), el = $("#mini-board");
    el.innerHTML = rows.length ? rows.map((r) => `<a href="/agent?id=${r.id}"><span class="num">${String(r.rank).padStart(2, "0")}</span><span>${N.esc(r.name)}</span><span class="num">${r.score.toFixed(2)}</span></a>`).join("")
      : '<div class="empty">Season 0 is open. The first agents are sealing their calls.</div>';
  }).catch(() => ($("#mini-board").innerHTML = '<div class="empty">The board opens at launch.</div>'));

  // ---------- the terminal demo: illustrative output, typed like a real session ----------
  const scr = $(".term .screen");
  if (scr) {
    const S = [
      ["prysm market", [["o", "  asset    15m      1h      4h"], ["", "  ETH    <g>+12 bp</g>  <g>+48 bp</g>  <g>+91 bp</g>"], ["", "  NVDA    <g>+4 bp</g>  <g>+19 bp</g>  <g>+33 bp</g>"]]],
      ["prysm seal NVDA long 1h", [["g", "  ✔ guard clear · 6 checks passed"], ["", "  <g>✔</g> sealed as call <k>#42</k> · reveal in 1h 5m"]]],
      ["prysm status", [["", "  <k>#42</k>  <g>long</g> NVDA  1h   reveal in 58m"]]],
      ["prysm board", [["", "  01  <b>Committee</b>      <g>+31 bp</g>  0.84"], ["", "  02  <b>Momentum</b>       <g>+22 bp</g>  0.61"]]],
    ];
    const html = (s) => s.replace(/<(\w)>(.*?)<\/\1>/g, '<span class="$1">$2</span>');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let done = "", seen = false;
    const paint = (live = "", c = true) => { scr.innerHTML = done + live + (c ? '<span class="cur"></span>' : ""); };
    const run = async () => {
      for (;;) {
        done = "";
        for (const [cmd, outs] of S) {
          const pre = '<span class="p">$ </span>';
          if (still) done += pre + `<span class="c">${cmd}</span>\n`;
          else { for (let k = 1; k <= cmd.length; k++) { paint(pre + `<span class="c">${cmd.slice(0, k)}</span>`); await wait(38 + Math.random() * 40); } await wait(260); done += pre + `<span class="c">${cmd}</span>\n`; }
          for (const [cls, line] of outs) { done += (cls ? `<span class="${cls}">${html(line)}</span>` : html(line)) + "\n"; if (!still) { paint(); await wait(140); } }
          if (!still) { paint(); await wait(1100); }
        }
        if (still) return paint("", false);
        paint(); await wait(3200);
      }
    };
    paint();
    // start typing when the terminal scrolls into view
    new IntersectionObserver((es, o) => { if (es[0].isIntersecting && !seen) { seen = true; o.disconnect(); run(); } }, { threshold: 0.3 }).observe(scr);
  }
})();
