// PRYSM burn record: total burned, its share of the supply, what the buybacks cost, and every burn transaction with
// a link to the explorer. Read from the chain by /api/burns (ported from XENON). Styles live in burns.css.
// mountBurns(el, { token, live }) renders into el; the studio passes a token to preview one before it is published.
// On the landing, a <section class="burns" id="burns" hidden> unhides itself once /api/token returns a CA.
(() => {
  const X = "https://robinhoodchain.blockscout.com";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => { v = Number(v) || 0; return v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 4 }); };
  const pct = (v) => (v == null ? "·" : v.toFixed(v < 1 ? 3 : 2) + "%");
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC" : "·");
  const KIND = { buyback: "Buyback", supply: "Supply burn", transfer: "Sent to dead" };
  const timers = new WeakMap();

  window.mountBurns = async (el, opts = {}) => {
    el.classList.add("bp"); clearTimeout(timers.get(el));
    const msg = (t) => { el.innerHTML = `<div class="bmsg">${t}</div>`; };
    const again = (ms) => { if (opts.live !== false) timers.set(el, setTimeout(() => window.mountBurns(el, opts), ms)); };
    if (!el.innerHTML.trim()) msg("Reading burns from Robinhood Chain…");
    try {
      const r = await fetch(`/api/burns${opts.token ? "?token=" + encodeURIComponent(opts.token) : ""}`), b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || "Could not read the burns.");
      if (!b.token) { msg("The burn record fills in once the $PRYSM contract address is published."); return b; }
      if (b.scanning) { msg(esc(b.note)); timers.set(el, setTimeout(() => window.mountBurns(el, opts), 20000)); return b; }
      const sym = esc(b.symbol), cells = [[num(b.burned), `$${sym} burned`], [pct(b.burnedPct), "of the total supply"], [String(b.count), `burn transaction${b.count === 1 ? "" : "s"}`]];
      if (b.buybacks) cells.push([`$${Number(b.buybackUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`, `spent on ${b.buybacks} buyback${b.buybacks === 1 ? "" : "s"}`]);
      const rows = b.items.map((x) => `<tr><td class="num dim">${esc(when(x.at))}</td>
        <td><span class="pill k-${esc(x.kind)}">${KIND[x.kind] || "Burn"}</span>${x.kind === "buyback" && x.usd != null ? `<span class="cost">$${Number(x.usd).toFixed(2)}${x.eth ? ` · ${x.eth.toFixed(5)} ETH` : ""}</span>` : ""}</td>
        <td class="r num"><b>${num(x.amount)}</b></td><td class="r num dim">${pct(x.pct)}</td>
        <td class="num"><a href="${X}/address/${esc(x.from)}" target="_blank" rel="noopener">${esc(short(x.from))}</a></td>
        <td class="num"><a href="${X}/tx/${esc(x.tx)}" target="_blank" rel="noopener">${esc(short(x.tx))} ↗</a></td></tr>`).join("");
      el.innerHTML = `<div class="bstats">${cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}</div>
        ${rows ? `<div class="bcard tbl"><table><thead><tr><th>Time</th><th>Type</th><th class="r">Amount</th><th class="r">Supply</th><th>From</th><th>Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : `<div class="bmsg" style="margin-top:14px">No burn yet. Every transfer of $${sym} to the dead address will show here with its transaction.</div>`}
        <p class="bnote">Read from the chain: every transfer of $${sym} to 0x…dEaD or the zero address since launch, up to block ${Number(b.scannedTo).toLocaleString("en-US")}.${b.refreshing ? " Checking newer blocks now." : ""}</p>`;
      again(b.refreshing ? 30000 : 120000);
      return b;
    } catch (e) { msg(esc(e.message || "Could not read the burns.")); again(60000); }
  };

  // landing: show the section only once the CA is published
  const sec = document.querySelector("section.burns#burns");
  if (sec) (async () => {
    try {
      const r = await fetch("/api/token"); if (!r.ok) return;
      const t = await r.json(); if (!t || !t.token) return;
      const ca = sec.querySelector("[data-ca]");
      if (ca) { ca.textContent = t.token; ca.href = `${t.explorer || X}/token/${t.token}`; }
      sec.hidden = false; if (window.reveal) window.reveal(sec);
      window.mountBurns(sec.querySelector(".burns-panel"));
    } catch {}
  })();
})();
