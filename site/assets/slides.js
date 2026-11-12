// drawn visuals for the landing slides (seal, twap, season); all illustrative, the live numbers come from /api
(() => {
  const NS = "http://www.w3.org/2000/svg", el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // 01: particles converge on the pyramid's apex
  const dots = document.querySelector(".seal .dots");
  if (dots) for (let i = 0; i < 34; i++) {
    const a = Math.PI * (1.05 + rnd() * 0.9), r = 120 + rnd() * 110;
    const c = el("circle", { cx: 220, cy: 196, r: (0.8 + rnd() * 1.6).toFixed(2) });
    c.style.setProperty("--x", (Math.cos(a) * r).toFixed(1) + "px"); c.style.setProperty("--y", (Math.sin(a) * r * 0.75).toFixed(1) + "px");
    c.style.setProperty("--d", (-rnd() * 3.4).toFixed(2) + "s"); dots.append(c);
  }
  const hash = document.querySelector("[data-scramble]");
  if (hash && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const hex = "0123456789abcdef", h = (n) => Array.from({ length: n }, () => hex[(Math.random() * 16) | 0]).join("");
    setInterval(() => { let k = 0; const t = setInterval(() => { hash.textContent = `0x${h(8)}…${h(8)}`; if (++k > 10) clearInterval(t); }, 45); }, 3400);
  }

  // 02: a price walk that averages 150 in the commit window and 92 in the reveal window (y grows down)
  const tw = document.querySelector(".twap svg");
  if (tw) {
    const pts = []; let y = 0; for (let x = 0; x <= 440; x += 6) { y += (rnd() - 0.5) * 16; pts.push([x, y]); }
    const at = (x0, x1) => { const s = pts.filter(([x]) => x >= x0 && x <= x1); return s.reduce((a, p) => a + p[1], 0) / s.length; };
    const m0 = at(78, 132), m1 = at(330, 384), k = (92 - 150 - (m1 - m0)) / (357 - 105);
    const P = pts.map(([x, v]) => [x, Math.max(14, Math.min(226, v - m0 + 150 + k * (x - 105)))]);
    const d = "M" + P.map(([x, v]) => `${x} ${v.toFixed(1)}`).join("L");
    tw.querySelector(".price").setAttribute("d", d); tw.querySelector(".area").setAttribute("d", d + "L440 240L0 240Z");
    tw.prepend(el("defs", {})); tw.firstChild.innerHTML = '<linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b4a6ff" stop-opacity=".22"/><stop offset="1" stop-color="#b4a6ff" stop-opacity="0"/></linearGradient>';
  }

  // 04: seven days on the orbit, twenty spokes shrinking with rank
  const ss = document.querySelector(".season svg");
  if (ss) {
    const days = ss.querySelector(".days"), split = ss.querySelector(".split"), D = "MTWTFSS";
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i / 7) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      days.append(el("line", { x1: 150 + c * 122, y1: 150 + s * 122, x2: 150 + c * 134, y2: 150 + s * 134 }));
      const t = el("text", { x: 150 + c * 146, y: 150 + s * 146 }); t.textContent = D[i]; days.append(t);
    }
    for (let i = 0; i < 20; i++) {
      const a = -Math.PI / 2 + (i / 20) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), len = 52 * Math.pow(0.88, i) + 6;
      split.append(el("line", { x1: 150 + c * 54, y1: 150 + s * 54, x2: 150 + c * (54 + len), y2: 150 + s * (54 + len), opacity: (1 - i * 0.038).toFixed(2) }));
    }
  }

  // hero: a looping CLI session (illustrative output, typed like a real terminal)
  const scr = document.querySelector(".cli .screen");
  if (scr) {
    const S = [
      ["prysm market", [["o", "  asset    15m      1h      4h"], ["", "  ETH    <g>+12 bp</g>  <g>+48 bp</g>  <g>+91 bp</g>"], ["", "  NVDA    <g>+4 bp</g>  <g>+19 bp</g>  <g>+33 bp</g>"]]],
      ["prysm seal NVDA long 1h", [["g", "  ✔ guard clear · 6 checks passed"], ["", "  <g>✔</g> sealed as call <k>#42</k> · reveal in 1h 5m"]]],
      ["prysm status", [["", "  <k>#42</k>  <g>long</g> NVDA  1h   reveal in 58m"]]],
      ["prysm board", [["", "  01  <b>Committee</b>      <g>+31 bp</g>  0.84"], ["", "  02  <b>Momentum</b>       <g>+22 bp</g>  0.61"]]],
    ];
    const html = (t) => t.replace(/<(\w)>(.*?)<\/\1>/g, '<span class="$1">$2</span>');
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let done = "";
    const paint = (live = "", cur = true) => { scr.innerHTML = done + live + (cur ? '<span class="cur"></span>' : ""); };
    const run = async () => {
      for (;;) {
        done = "";
        for (const [cmd, outs] of S) {
          const pre = '<span class="p">$ </span>';
          if (still) done += pre + `<span class="c">${cmd}</span>\n`;
          else { for (let i = 1; i <= cmd.length; i++) { paint(pre + `<span class="c">${cmd.slice(0, i)}</span>`); await wait(38 + Math.random() * 40); } await wait(260); done += pre + `<span class="c">${cmd}</span>\n`; }
          for (const [cls, line] of outs) { done += (cls ? `<span class="${cls}">${html(line)}</span>` : html(line)) + "\n"; if (!still) { paint(); await wait(140); } }
          if (!still) { paint(); await wait(1100); }
        }
        if (still) return paint("", false);
        paint(); await wait(3200);
      }
    };
    run();
  }
})();
