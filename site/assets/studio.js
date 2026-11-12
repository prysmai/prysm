// PRYSM studio: key login (sessionStorage), CA, burn wallet, buyback & burn, supply burn, record preview, history.
// Every call carries x-studio-key; a 401 drops the key and shows the login again. Keys typed here are never kept in
// the page after they are sent.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "prysm_studio_key", X = "https://robinhoodchain.blockscout.com";
  const esc = window.N.esc, short = window.N.short;
  const store = { get: () => { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } }, set: (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} } };
  let key = store.get(), state = null;

  const say = (id, text, kind = "") => { const el = $(id); el.className = "st-msg" + (kind ? " " + kind : ""); el.innerHTML = text; };
  const usd = (v) => (v == null ? "·" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
  const tok = (v) => (v == null ? "·" : Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) >= 100 ? 0 : 4 }));
  const when = (t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
  const txLink = (h) => `<a href="${X}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))} ↗</a>`;

  async function call(path, body) {
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-studio-key": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { lock("The key was refused. Enter it again."); throw new Error("Studio key required."); }
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
    return j;
  }
  function lock(text = "") { key = ""; store.set(""); state = null; $("desk").hidden = true; $("login").hidden = false; say("loginmsg", esc(text), text ? "err" : ""); $("skey").focus(); }
  const busy = (btn, on) => { btn.disabled = on; };

  function render(s) {
    state = s; const b = s.burn || {};
    $("upd").textContent = `updated ${new Date().toLocaleTimeString("en-US", { hour12: false })}${b.rpc === false ? " · chain not reachable from this server" : ""}`;
    $("kpis").innerHTML = [
      [s.token ? short(s.token) : "not set", "$PRYSM contract"],
      [b.burned != null ? tok(b.burned) : "·", "$PRYSM at the dead address"],
      [b.eth != null ? Number(b.eth).toFixed(5) : "·", "burn wallet ETH"],
      [`${usd(b.today)} / ${usd(b.dayUsd)}`, "bought back in 24 h / cap"],
    ].map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
    $("tokstate").textContent = s.token ? "published" : "not set";
    if (document.activeElement !== $("tok")) $("tok").value = s.token || "";
    $("wkv").innerHTML = [
      ["Address", b.address ? `<a class="addr" href="${X}/address/${esc(b.address)}" target="_blank" rel="noopener">${esc(b.address)}</a>` : "No key saved", !!b.address],
      ["ETH", b.eth != null ? Number(b.eth).toFixed(6) : "·"],
      ["$PRYSM held", b.tokenBal != null ? tok(b.tokenBal) : "·"],
      ["Encryption", b.secretOk ? "PRYSM_SECRET set" : "PRYSM_SECRET missing"],
    ].map(([k, v, a]) => `<div><span>${k}</span><b${a ? ' class="addr"' : ""}>${v}</b></div>`).join("");
    $("caps").textContent = `max ${usd(b.maxUsd)} a run · ${usd(b.dayUsd)} a day`;
    $("skv").innerHTML = [
      ["Burn wallet holds", b.tokenBal != null ? tok(b.tokenBal) + " $PRYSM" : "·"],
      ["Worth at the curve", b.tokenBalUsd != null ? usd(b.tokenBalUsd) : "·"],
      ["Curve price", b.priceUsd ? "$" + Number(b.priceUsd).toPrecision(3) : "·"],
      ["Supply burned here", tok(b.supplyBurned || 0)],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
    const log = b.log || [];
    $("hist").innerHTML = log.length ? log.map((x) => `<tr>
      <td class="num dim">${esc(when(x.at))}</td><td>${x.kind === "supply" ? '<span class="pill">Supply burn</span>' : '<span class="pill open">Buyback</span>'}</td>
      <td class="r num">${x.usd == null ? "·" : usd(x.usd)}</td><td class="r num dim">${x.kind === "supply" ? "·" : Number(x.eth).toFixed(5)}</td>
      <td class="r num">${tok(x.tokens)}</td>
      <td>${x.status === "failed" ? '<span class="pill forfeited">failed</span>' : x.status === "pending" ? '<span class="pill open">pending</span>' : '<span class="pill settled">done</span>'}</td>
      <td class="num">${x.tx ? txLink(x.tx) : "·"}</td></tr>`).join("")
      : '<tr><td colspan="7" class="empty">No burns yet.</td></tr>';
  }
  async function refresh() { try { render(await call("/api/studio/state")); } catch {} }
  async function unlock() {
    $("login").hidden = true; $("desk").hidden = false;
    say("loginmsg", "");
    await refresh();
    if (state) window.mountBurns($("burnpanel"), { live: false });
  }

  $("loginf").addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("skey").value.trim(); if (!v) return;
    busy($("logingo"), true); say("loginmsg", "Checking…");
    key = v;
    try { const s = await call("/api/studio/state"); store.set(v); $("skey").value = ""; render(s); $("login").hidden = true; $("desk").hidden = false; say("loginmsg", ""); window.mountBurns($("burnpanel"), { live: false }); }
    catch (err) { if (key) say("loginmsg", esc(err.message), "err"); }
    finally { busy($("logingo"), false); }
  });
  $("lock").addEventListener("click", () => lock());

  // CA
  async function setToken(t, btn) {
    busy(btn, true); say("tokmsg", t ? "Checking the Pons factory…" : "Clearing…");
    try { render(await call("/api/studio/token", { token: t })); say("tokmsg", t ? "Saved. The landing now shows the burn record." : "Cleared. The burn section on the landing is hidden again.", "ok"); window.mountBurns($("burnpanel"), { live: false }); }
    catch (err) { say("tokmsg", esc(err.message), "err"); }
    finally { busy(btn, false); }
  }
  $("tokf").addEventListener("submit", (e) => { e.preventDefault(); const t = $("tok").value.trim(); if (!t) return say("tokmsg", "Paste the contract address, or press Clear.", "err"); setToken(t, $("tokgo")); });
  $("tokclear").addEventListener("click", () => { if (confirm("Clear the published $PRYSM contract address?")) setToken("", $("tokclear")); });

  // burn wallet key: sent once, then wiped from the field
  $("wkf").addEventListener("submit", async (e) => {
    e.preventDefault(); const k = $("wk").value.trim(); if (!k) return say("wkmsg", "Paste the burn wallet's private key.", "err");
    busy($("wkgo"), true); say("wkmsg", "Saving…");
    try { const s = await call("/api/studio/burn", { privateKey: k }); render(s); say("wkmsg", "Saved and encrypted on the server.", "ok"); }
    catch (err) { say("wkmsg", esc(err.message), "err"); }
    finally { $("wk").value = ""; busy($("wkgo"), false); }
  });
  $("wkrm").addEventListener("click", async () => {
    if (!confirm("Remove the saved burn wallet key from the server?")) return;
    try { render(await call("/api/studio/burn", { privateKey: "" })); say("wkmsg", "Removed.", "ok"); } catch (err) { say("wkmsg", esc(err.message), "err"); }
  });

  // buyback & burn
  $("amts").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $("busd").value = b.dataset.v; [...$("amts").children].forEach((x) => x.classList.toggle("on", x === b)); });
  $("busd").addEventListener("input", () => [...$("amts").children].forEach((x) => x.classList.toggle("on", x.dataset.v === $("busd").value.trim())));
  $("bbf").addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("busd").value.trim().replace(/^\$/, "");
    if (!(Number(v) > 0)) return say("bbmsg", "Enter an amount in dollars.", "err");
    if (!confirm(`Buy $${v} of $PRYSM on the curve and burn it? This sends a real transaction from the burn wallet.`)) return;
    busy($("bbgo"), true); say("bbmsg", "Sending the buy and waiting for the receipt…");
    try { const s = await call("/api/studio/burn", { usd: v }); render(s); say("bbmsg", `Burned ${tok(s.done.tokens)} $PRYSM for ${usd(s.done.usd)}. ${txLink(s.done.tx)}`, "ok"); window.mountBurns($("burnpanel"), { live: false }); }
    catch (err) { say("bbmsg", esc(err.message), "err"); refresh(); }
    finally { busy($("bbgo"), false); }
  });

  // supply burn
  async function supply(v, btn) {
    if (!confirm(v === "max" ? "Burn ALL the $PRYSM the burn wallet holds?" : `Burn $${v} worth of the $PRYSM the burn wallet holds?`)) return;
    busy(btn, true); say("sbmsg", "Sending the transfer to the dead address…");
    try { const s = await call("/api/studio/burn", { supplyUsd: v }); render(s); say("sbmsg", `Burned ${tok(s.done.tokens)} $PRYSM${s.done.usd != null ? ` (about ${usd(s.done.usd)})` : ""}. ${txLink(s.done.tx)}`, "ok"); window.mountBurns($("burnpanel"), { live: false }); }
    catch (err) { say("sbmsg", esc(err.message), "err"); refresh(); }
    finally { busy(btn, false); }
  }
  $("sbf").addEventListener("submit", (e) => { e.preventDefault(); const v = $("susd").value.trim().replace(/^\$/, ""); if (!(Number(v) > 0)) return say("sbmsg", "Enter an amount in dollars, or press Max.", "err"); supply(v, $("sbgo")); });
  $("smax").addEventListener("click", () => supply("max", $("smax")));

  // record preview
  $("prf").addEventListener("submit", (e) => { e.preventDefault(); const t = $("prt").value.trim(); $("burnpanel").innerHTML = ""; window.mountBurns($("burnpanel"), { token: t || undefined, live: false }); });

  if (key) unlock(); else lock();
})();
