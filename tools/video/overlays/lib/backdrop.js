// Full-frame aurora sky: WebGL curtains (rendered at reduced resolution — it is all soft light),
// a static two-layer star field that twinkles via CSS, vignette and film grain.
// Shared by hook(), swarm() and endCard() so the film opens and closes on the same sky (seamless loop).
import { anim, css } from './anim.js';

const VERT = `attribute vec2 p; varying vec2 v; void main(){ v = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const FRAG = `
precision highp float;
varying vec2 v;
uniform vec2 uRes; uniform float uT; uniform float uT2; uniform float uMix; uniform float uAmp; uniform float uLift;
float h21(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1., 0.)), u.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), u.x), u.y); }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
vec3 pal(float h){
  vec3 a = vec3(.243, .941, .690), b = vec3(.361, .949, 1.), c = vec3(.655, .545, .980), d = vec3(1., .420, .839);
  h = clamp(h, 0., 1.) * 3.;
  return h < 1. ? mix(a, b, h) : (h < 2. ? mix(b, c, h - 1.) : mix(c, d, h - 2.));
}
vec3 sky(vec2 uv, float T){
  float ar = uRes.x / uRes.y;
  float X = (uv.x - .5) * ar;
  vec3 col = mix(vec3(.008, .011, .026), vec3(.026, .020, .060), smoothstep(.0, 1., uv.y));
  vec3 acc = vec3(0.);
  for (int i = 0; i < 3; i++){
    float fi = float(i);
    float x = X * (.72 + .34 * fi) + fi * 7.3;
    float w1 = fbm(vec2(x * .55 + T * .022, fi * 2.7));
    float w2 = vn(vec2(x * 2.3 - T * .07, fi * 9.1));
    float edge = uLift + fi * .10 + (w1 - .5) * .80 + (w2 - .5) * .05 + .075 * sin(x * 1.35 + T * .06 + fi * 2.1);
    float d = uv.y - edge;
    float xr = x + (w1 - .5) * .7;
    float rays = vn(vec2(xr * 40. + T * .11 * (1. + fi), fi * 13. + d * 1.2));
    rays = .22 + .78 * rays * rays;
    float rays2 = .45 + .55 * vn(vec2(xr * 10. - T * .05, fi * 5.));
    float fold = .15 + .85 * smoothstep(.22, .62, fbm(vec2(x * 1.2 - T * .035, 4. + fi * 2.3)));
    float h = max(d, 0.);
    float height = .22 + .20 * vn(vec2(xr * 3.3 + T * .02, fi * 3.));
    float up = smoothstep(-.005, .006, d) * exp(-h / height * 2.1);
    float rim = exp(-abs(d) * 130.) * 1.1 + exp(-max(-d, 0.) * 40.) * step(d, 0.) * .10;
    float I = fold * (up * rays * rays2 * 2.6 + rim * (.55 + .45 * rays));
    vec3 c = pal(clamp(h / height * 1.15 + fi * .16 - .03, 0., 1.));
    acc += c * I * (1. - fi * .26);
  }
  col += acc * uAmp;
  col += vec3(.015, .05, .055) * exp(-uv.y * 6.) * uAmp;
  return 1. - exp(-col * 1.35);
}
void main(){
  vec3 col = sky(v, uT);
  if (uMix > .001) col = mix(col, sky(v, uT2), uMix); // loop-back dissolve to the opening frame's sky
  col += (h21(gl_FragCoord.xy + fract(uT) * 91.) - .5) * .012; // dither against banding
  gl_FragColor = vec4(col, 1.);
}`;

export class Backdrop {
  constructor(engine, parent, { scale = .5 } = {}) {
    this.engine = engine; this.scale = scale;
    const el = this.el = document.createElement('div');
    el.className = 'ovl-layer ovl-bg';
    parent.appendChild(el);
    this.gl = null;
    const cv = this.cv = document.createElement('canvas');
    cv.width = Math.round(1920 * scale); cv.height = Math.round(1080 * scale);
    el.appendChild(cv);
    try { this._initGL(cv); } catch (e) { console.warn('[overlay] WebGL backdrop unavailable, using CSS fallback', e); this.gl = null; }
    if (!this.gl) { cv.remove(); el.classList.add('ovl-bg--fallback'); }
    this.starsA = this._stars(170, 1, 'a');
    this.starsB = this._stars(120, 2, 'b');
    for (const [c, k] of [[this.starsA, 'a'], [this.starsB, 'b']]) { c.className = 'ovl-bg__stars ovl-bg__stars--' + k; el.appendChild(c); }
    const vig = document.createElement('div'); vig.className = 'ovl-bg__vig'; el.appendChild(vig);
    const grain = document.createElement('div'); grain.className = 'ovl-bg__grain'; el.appendChild(grain);
    this.amp = 1; this.lift = .30; this.visible = false; this._stop = null;
    // sky clock: LOOP_T is the sky's state on the film's first frame; loopBack() dissolves back to it
    this.LOOP_T = 12; this.clockStart = engine.now(); this.mix = 0; this.parked = false;
    this.owner = null;
  }
  _initGL(cv) {
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = n => gl.getUniformLocation(pr, n);
    this.u = { res: U('uRes'), t: U('uT'), t2: U('uT2'), mix: U('uMix'), amp: U('uAmp'), lift: U('uLift') };
    gl.viewport(0, 0, cv.width, cv.height);
    this.gl = gl;
    try { const dbg = gl.getExtension('WEBGL_debug_renderer_info'); this.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'webgl'; } catch { this.renderer = 'webgl'; }
  }
  _stars(n, seed, kind) {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const g = c.getContext('2d');
    let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < n; i++) {
      const x = rnd() * 1920, y = Math.pow(rnd(), 1.35) * 1080 * .92;
      const r = kind === 'b' ? .7 + rnd() * 1.5 : .5 + rnd() * .9;
      const a = .25 + rnd() * .75;
      const tint = rnd();
      g.fillStyle = tint < .15 ? `rgba(180,255,235,${a})` : tint < .3 ? `rgba(215,200,255,${a})` : `rgba(235,242,255,${a})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (r > 1.6) { g.globalAlpha = .18; g.beginPath(); g.arc(x, y, r * 3.5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    }
    return c;
  }
  _draw(now) {
    const gl = this.gl; if (!gl) return;
    gl.uniform2f(this.u.res, this.cv.width, this.cv.height);
    gl.uniform1f(this.u.t, this.time(now));
    gl.uniform1f(this.u.t2, this.LOOP_T);
    gl.uniform1f(this.u.mix, this.mix);
    gl.uniform1f(this.u.amp, this.amp);
    gl.uniform1f(this.u.lift, this.lift);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** current sky time in seconds */
  time(now = this.engine.now()) { return this.parked ? this.LOOP_T : this.LOOP_T + (now - this.clockStart) / 1000; }
  /** restart the sky clock at the loop state (the film's first frame) */
  restart() { this.clockStart = this.engine.now(); this.parked = false; this.mix = 0; }
  /** dissolve the moving sky back into the opening frame's sky and hold it there (seamless X loop) */
  async loopBack(ms = 1400) {
    await this.engine.tween({ ms, easing: t => t * t * (3 - 2 * t), update: p => { this.mix = p; } });
    this.parked = true; this.mix = 0;
  }
  _run() {
    if (this._stop) return;
    this._stop = this.engine.add(now => { this._draw(now); return true; });
  }
  /** show({ms, amp, lift, iris}) — amp = curtain brightness (0..1.4), lift = curtain height (0.1..0.6). */
  async show({ ms = 500, delay = 0, amp, lift, owner } = {}) {
    if (amp != null) this.amp = amp;
    if (lift != null) this.lift = lift;
    this.owner = owner || this.owner;
    this.visible = true; this._run();
    // read the on-screen opacity BEFORE cancelling the running fade: cancelling first drops the layer to its
    // stylesheet opacity (0) for one frame — a full-frame flicker of whatever is underneath
    const from = getComputedStyle(this.el).opacity;
    this.el.style.opacity = from;
    this.el.getAnimations().forEach(a => a.cancel());
    this.el.classList.remove('ovl-iris');
    if (!(ms > 0) && !delay) { this.el.style.opacity = '1'; return; }
    await anim(this.el, [{ opacity: from }, { opacity: 1 }], { ms, delay, easing: 'ease-out' });
    if (this.visible) this.el.style.opacity = '1';
  }
  /** instant on (frame 0 of the film must already be the sky) */
  now({ amp, lift, owner, restart } = {}) { if (restart) this.restart(); if (amp != null) this.amp = amp; if (lift != null) this.lift = lift; this.owner = owner || this.owner; this.visible = true; this._run(); this.el.getAnimations().forEach(a => a.cancel()); this.el.classList.remove('ovl-iris'); this.el.style.opacity = '1'; }
  setAmp(amp, ms = 600) {
    const a0 = this.amp;
    return this.engine.tween({ ms, update: p => { this.amp = a0 + (amp - a0) * p; } });
  }
  async hide({ ms = 700, delay = 0, iris = false } = {}) {
    if (!this.visible) return;
    this.visible = false;
    const el = this.el;
    const from = getComputedStyle(el).opacity;
    el.getAnimations().forEach(a => a.cancel());
    el.style.opacity = from;
    let a;
    if (iris) {
      el.classList.add('ovl-iris');
      a = anim(el, [{ '--iris': '0px', opacity: from }, { '--iris': '1500px', opacity: 0 }], { ms, delay, easing: 'cubic-bezier(.55,0,.35,1)' });
    } else a = anim(el, [{ opacity: from }, { opacity: 0 }], { ms, delay, easing: 'ease-in-out' });
    await a;
    if (!this.visible) { el.style.opacity = '0'; el.getAnimations().forEach(x => x.cancel()); el.classList.remove('ovl-iris'); this._stop?.(); this._stop = null; this.owner = null; }
  }
}
