// PRYSM morph. Every section has two clips: an intro (the shape forming, played once each time you arrive) and a
// cycle (the formed shape moving, rendered in Blender as a closed loop that starts on the intro's next frame, so it
// repeats forever with no seam and never jumps back to the forming). Scrolling between sections does not scrub the
// film: a WebGL shader dissolves one scene into the next along a drifting noise field. Everything plays at normal
// speed; nothing is seeked frame by frame.
//   PrysmMorph(video, { intro: (index, suffix) => url, cycle: (index, suffix) => url, count, sections: [el, ...] })
// count 1 and no sections = one scene (the app pages): intro once, then its cycle.
(() => {
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const HOLD = 0.22;     // share of the scroll between two sections where the current scene holds before turning
  const START = 0.35;    // an arriving scene starts forming once it covers this much of the turn

  const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
  const FS = `precision highp float;
uniform sampler2D A, B; uniform vec2 sa, sb, fo; uniform float m, t, z;
varying vec2 v;
float h(vec2 q){ return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 q){ vec2 i = floor(q), f = fract(q); f = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 q){ float s = 0., a = .5; for (int k = 0; k < 5; k++){ s += a * n2(q); q = q * 2.03 + 11.7; a *= .5; } return s; }
vec2 cover(vec2 u, vec2 s){ return (u - fo) * s + fo; }
void main(){
  vec2 u = (v - fo) / z + fo;                                    // the push-in while turning
  float w = .16, k = sin(3.14159 * m);
  vec2 q = u * vec2(2.4, 1.5) + vec2(t * .035, -t * .02);
  float n = fbm(q + .6 * fbm(q * 1.7 - t * .05));               // domain-warped: the turn spreads like ink
  float th = m * (1. + 2. * w) - w;
  float x = 1. - smoothstep(th - w, th + w, n);                  // 0 = scene A, 1 = scene B
  float band = 1. - abs(x * 2. - 1.);
  vec2 off = (vec2(fbm(q * 2.3 + 3.1), fbm(q * 2.3 + 7.9)) - .5) * (.05 * band + .012 * k);
  vec3 a = texture2D(A, cover(u + off, sa)).rgb, b = texture2D(B, cover(u - off, sb)).rgb;
  vec3 c = mix(a, b, x) + vec3(.70, .64, 1.) * pow(band, 4.) * .14 * k;
  gl_FragColor = vec4(c, 1.);
}`;

  window.PrysmMorph = function (film, { intro, cycle, count, sections = [] }) {
    const stage = film.parentElement, still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = Math.min(screen.width, screen.height) * (devicePixelRatio || 1) < 900 || innerWidth < 820, sfx = small ? "-720" : "";
    const focusY = () => (innerWidth <= 860 ? 0.4 : 0.46);
    const mk = (url, loop, el) => {
      const v = el || document.createElement("video");
      v.muted = true; v.loop = loop; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "metadata";
      v.crossOrigin = "anonymous"; v.src = url;
      if (!el) stage.insertBefore(v, film.nextSibling);          // in the DOM (Safari), hidden by the stage CSS until .on
      return v;
    };
    // a scene: idle (not on screen) -> intro (forming, once) -> cycle (formed, forever)
    const scenes = Array.from({ length: count }, (_, i) => {
      const s = { intro: mk(intro(i, sfx), false, i === 0 ? film : null), cycle: mk(cycle(i, sfx), true), state: "idle" };
      s.intro.addEventListener("ended", () => { if (s.state === "intro") toCycle(s); });
      return s;
    });
    const toCycle = (s) => { s.state = "cycle"; s.cycle.currentTime = 0; if (!still) s.cycle.play().catch(() => {}); };
    const arrive = (s) => {
      if (still) { s.state = "cycle"; return; }                  // reduced motion: the formed shape, held
      s.state = "intro"; s.intro.currentTime = 0; s.intro.play().catch(() => {});
    };
    const leave = (s) => { if (s.state === "idle") return; s.state = "idle"; s.intro.pause(); s.cycle.pause(); };
    const el = (s) => (s.state === "cycle" ? s.cycle : s.intro);   // the clip on screen for this scene
    // buffer ahead; load() restarts a media element (and drops a pending play), so only an untouched one is kicked
    const want = (k) => { for (const v of [scenes[k]?.intro, scenes[k]?.cycle]) if (v && v.preload !== "auto") { v.preload = "auto"; if (v.readyState === 0 && v.paused) v.load(); } };

    // one scene: intro, then its cycle, as plain video
    if (count === 1 || sections.length < 2) {
      const s = scenes[0]; want(0);
      const show = () => { film.classList.add("on"); arrive(s); };
      film.addEventListener("loadeddata", show, { once: true });
      if (film.readyState >= 2) show();
      s.cycle.addEventListener("playing", () => { s.cycle.classList.add("on"); film.classList.remove("on"); });
      s.cycle.style.transition = "none";
      document.addEventListener("visibilitychange", () => { const v = el(s); document.hidden ? v.pause() : !still && v.play().catch(() => {}); });
      return;
    }

    let anchors = [];
    const measure = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      anchors = sections.map((e, i) => {
        if (i === 0) return 0;
        if (i === sections.length - 1) return max;
        const r = e.getBoundingClientRect();
        return Math.min(max, Math.max(0, r.top + scrollY + r.height / 2 - innerHeight / 2));
      });
    };
    const place = (y) => {
      let i = 0;
      while (i < anchors.length - 2 && y > anchors[i + 1]) i++;
      const y0 = anchors[i], y1 = anchors[i + 1], p = y1 > y0 ? Math.min(1, Math.max(0, (y - y0) / (y1 - y0))) : 0;
      return [i, ease((p - HOLD) / (1 - 2 * HOLD))];
    };

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;transform:scale(var(--zoom,1));transform-origin:50% 46%;opacity:0;transition:opacity .8s ease";
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });

    // scene bookkeeping shared by both renderers: who is on screen, who forms, who rests
    const drive = (i, m) => {
      const j = i + 1, w = (k) => (k === i ? 1 - m : k === j ? m : 0);
      want(i); want(j); want(j + 1); want(i - 1);
      for (let k = 0; k < count; k++) {
        const s = scenes[k], wk = w(k);
        if (wk <= 0.001) { leave(s); continue; }
        if (s.state === "idle" && (wk >= START || (k === i && m <= 0.001))) arrive(s);
      }
    };

    // no WebGL: the two scenes cross-fade as plain videos
    if (!gl) {
      const all = scenes.flatMap((s) => [s.intro, s.cycle]);
      all.forEach((v) => { v.classList.add("on"); v.style.transition = "none"; v.style.opacity = 0; });
      const step = () => {
        requestAnimationFrame(step);
        const [i, m] = place(scrollY); drive(i, m);
        all.forEach((v) => (v.style.opacity = 0));
        if (scenes[i]) el(scenes[i]).style.opacity = 1 - m;
        if (scenes[i + 1] && m > 0) el(scenes[i + 1]).style.opacity = m;
      };
      measure(); addEventListener("resize", measure); new ResizeObserver(measure).observe(document.body);
      step();
      return;
    }

    stage.insertBefore(canvas, film.nextSibling);
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = Object.fromEntries(["A", "B", "sa", "sb", "fo", "m", "t", "z"].map((k) => [k, gl.getUniformLocation(prog, k)]));
    gl.uniform1i(U.A, 0); gl.uniform1i(U.B, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);                 // video rows run top-down, GL textures bottom-up
    // one texture per scene; it keeps the last frame it got, so a clip that is still loading never flashes black
    const tex = scenes.map(() => {
      const o = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, o);
      for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
      return o;
    });
    const fresh = scenes.map(() => false), dims = scenes.map(() => [16, 9]);
    const upload = (k, unit) => {
      gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, tex[k]);
      const v = el(scenes[k]);
      if (v.readyState >= 2) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v); fresh[k] = true; dims[k] = [v.videoWidth, v.videoHeight]; }
    };
    const coverScale = (k) => {
      const ca = canvas.width / canvas.height, va = dims[k][0] / dims[k][1];
      return ca > va ? [1, va / ca] : [ca / va, 1];
    };
    const resize = () => {
      const d = Math.min(devicePixelRatio || 1, 2), w = Math.round(innerWidth * d), h = Math.round(innerHeight * d);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      measure();
    };

    const t0 = performance.now(); let raf = 0, shown = false;
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      const [i, m] = place(scrollY), j = i + 1;
      drive(i, m);
      if (m < 0.999) upload(i, gl.TEXTURE0); else { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[i]); }
      if (m > 0.001) upload(j, gl.TEXTURE1); else { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[i]); }
      if (!fresh[i] && !(m >= 0.999 && fresh[j])) return;
      const mm = fresh[j] ? m : 0;                                // a scene not loaded yet holds the current one
      gl.uniform2fv(U.sa, coverScale(i)); gl.uniform2fv(U.sb, coverScale(fresh[j] ? j : i));
      gl.uniform2f(U.fo, 0.5, 1 - focusY());
      gl.uniform1f(U.m, mm); gl.uniform1f(U.t, still ? 0 : (now - t0) / 1000);
      gl.uniform1f(U.z, 1 + 0.035 * Math.sin(Math.PI * mm));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!shown) { shown = true; canvas.style.opacity = 1; }
    };
    resize(); addEventListener("resize", resize); addEventListener("load", measure); new ResizeObserver(measure).observe(document.body);
    document.addEventListener("visibilitychange", () => {
      cancelAnimationFrame(raf);
      if (document.hidden) scenes.forEach((s) => { s.intro.pause(); s.cycle.pause(); });
      else { scenes.forEach((s) => { if (s.state !== "idle" && !still) el(s).play().catch(() => {}); }); raf = requestAnimationFrame(draw); }
    });
    raf = requestAnimationFrame(draw);
  };
})();
