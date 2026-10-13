/* BUMBLEBLOOM - the garden, drawn in code.
 *
 * Same storybook style as The Last Garden: mowed lawn stripes, leafy hedges,
 * layered tree canopies, gradient petals. Everything here is pure drawing;
 * the server owns the game, this only paints what it says.
 *
 * Garden.setup(world)                      once per round
 * Garden.draw(ctx, w, h, state, t, opts)   every frame
 * Garden.fx(list)                          particle events from the server
 */
'use strict';

const PC = ["#e8504f", "#3d7ff5", "#f2b705", "#8e63d8", "#f0812a", "#e8629b", "#18a9b8", "#8a5a34"];
const PNAMES = ["Red", "Blue", "Gold", "Violet", "Orange", "Pink", "Teal", "Brown"];
const TAU = Math.PI * 2;

const Art = (() => {
  function mix(hex, amt) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const m = c => Math.round(c + (255 - c) * amt);
    return `rgb(${m(r)},${m(g)},${m(b)})`;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const pats = new WeakMap();
  function hedgePattern(ctx) {
    if (pats.has(ctx)) return pats.get(ctx);
    const c = document.createElement("canvas"); c.width = c.height = 18; const x = c.getContext("2d");
    x.fillStyle = "#47a04c"; x.fillRect(0, 0, 18, 18);
    const blob = (p, col) => { x.fillStyle = col; x.beginPath(); x.moveTo(p[0], p[1]); x.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]); x.bezierCurveTo(p[8], p[9], p[10], p[11], p[0], p[1]); x.fill(); };
    blob([2, 6, 5, 1, 11, 1, 14, 5, 11, 10, 5, 10], "#59bd58");
    blob([9, 15, 12, 11, 17, 11, 19, 14, 17, 18, 12, 18], "#3c8c43");
    blob([-3, 14, 0, 10, 4, 10, 6, 13, 4, 17, 0, 17], "#65c95f");
    x.fillStyle = "#7ad86e"; x.beginPath(); x.arc(15, 4, 1.3, 0, TAU); x.fill();
    x.fillStyle = "#2f7a3a"; x.beginPath(); x.arc(4, 12, 1.1, 0, TAU); x.fill();
    const p = ctx.createPattern(c, "repeat"); pats.set(ctx, p); return p;
  }
  function lawn(ctx, x0, y0, w, h, stripes = true, seed = 7) {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h); g.addColorStop(0, "#a8d98a"); g.addColorStop(1, "#6fae5e");
    ctx.fillStyle = g; ctx.fillRect(x0, y0, w, h);
    if (stripes) { ctx.fillStyle = "rgba(255,255,255,.12)"; for (let y = y0; y < y0 + h; y += 112) ctx.fillRect(x0, y, w, 56); }
    const R = rng(seed);
    for (let i = 0; i < (w * h) / 4200; i++) {
      const x = x0 + R() * w, y = y0 + R() * h;
      if (i % 6 === 0) { daisy(ctx, x, y, 1); }
      else if (i % 6 === 1) { ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.beginPath(); ctx.arc(x, y, 1, 0, TAU); ctx.fill(); }
      else { ctx.fillStyle = "rgba(47,122,58,.32)"; ctx.beginPath(); ctx.arc(x, y, 1.3, 0, TAU); ctx.fill(); }
    }
  }
  function daisy(ctx, x, y, s) {
    ctx.fillStyle = "#ffffff"; for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(x + Math.cos(k * 1.256) * 2.2 * s, y + Math.sin(k * 1.256) * 2.2 * s, 1.5 * s, 0, TAU); ctx.fill(); }
    ctx.fillStyle = "#f6c445"; ctx.beginPath(); ctx.arc(x, y, 1.2 * s, 0, TAU); ctx.fill();
  }
  function hedge(ctx, x, y, w, h, r) {
    ctx.save(); ctx.lineJoin = "round";
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.strokeStyle = "#1f5c2b"; ctx.lineWidth = 38; ctx.stroke();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.strokeStyle = hedgePattern(ctx); ctx.lineWidth = 30; ctx.stroke();
    ctx.beginPath(); ctx.roundRect(x + 13, y + 13, w - 26, h - 26, Math.max(4, r - 13)); ctx.strokeStyle = "rgba(0,0,0,.12)"; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();
  }
  function leaf(ctx, x, y, len, ang, col = "#4da54f") {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * .3, -len * .38, len * .75, -len * .42, len, -len * .08);
    ctx.bezierCurveTo(len * .75, len * .3, len * .3, len * .33, 0, 0); ctx.fill();
    ctx.strokeStyle = "#2f7a3a"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(len * .5, -len * .12, len, -len * .08); ctx.stroke();
    ctx.restore();
  }
  function tree(ctx, x, y, s, R) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.beginPath(); ctx.ellipse(14, 18, 62, 30, 0, 0, TAU); ctx.fill();
    const blobs = [[-26, 4, 30, "#2f7a3a"], [24, 6, 31, "#2f7a3a"], [0, -16, 35, "#37893f"], [-34, -18, 24, "#347f3c"], [33, -16, 25, "#347f3c"],
      [-14, 10, 26, "#3f9646"], [14, 12, 25, "#3f9646"], [-8, -24, 27, "#4fae52"], [16, -18, 22, "#57b958"], [-22, -18, 18, "#57b958"],
      [2, -32, 17, "#6cc861"], [-30, -6, 13, "#63c25d"], [28, -4, 12, "#5cbb5a"], [-12, -32, 9, "#84dd74"], [10, -30, 8, "#84dd74"]];
    blobs.forEach(([bx, by, r, c]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill(); });
    [[40, -6, .35], [-52, 2, 2.8], [-40, -28, -.6], [34, -30, -.3]].forEach(([lx, ly, a]) => leaf(ctx, lx, ly, 20, a));
    if (R && R() < .5) [[-10, -4], [18, 8], [-24, 14]].forEach(([fx, fy]) => { ctx.fillStyle = "#e8629b"; ctx.beginPath(); ctx.arc(fx, fy, 3, 0, TAU); ctx.fill(); ctx.fillStyle = "#fff3c4"; ctx.beginPath(); ctx.arc(fx, fy, 1.2, 0, TAU); ctx.fill(); });
    ctx.restore();
  }
  function topiary(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.beginPath(); ctx.ellipse(6, 8, 26, 12, 0, 0, TAU); ctx.fill();
    [[0, 0, 24, "#2f7a3a"], [-3, -3, 18, "#43a04a"], [-6, -6, 10, "#5fc05c"], [-8, -9, 4, "#84dd74"]].forEach(([bx, by, r, c]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill(); });
    ctx.restore();
  }
  function pond(ctx, x, y, rx, ry, R) {
    ctx.save();
    ctx.fillStyle = "#c9b98b"; ctx.beginPath(); ctx.ellipse(x, y, rx + 9, ry + 8, 0, 0, TAU); ctx.fill();
    const g = ctx.createRadialGradient(x - rx * .3, y - ry * .3, 4, x, y, rx);
    g.addColorStop(0, "#9fdcf0"); g.addColorStop(1, "#4a9fc4");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x - rx * .2, y - ry * .2, rx * .5, ry * .35, 0, 3.6, 5.2); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = R() * TAU, d = R() * .6, px = x + Math.cos(a) * rx * d, py = y + Math.sin(a) * ry * d, pr = 9 + R() * 6;
      ctx.fillStyle = "#4da54f"; ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr, a + .3, a + TAU - .3); ctx.closePath(); ctx.fill();
      if (i % 2) { ctx.fillStyle = "#ffd3e4"; ctx.beginPath(); ctx.arc(px + 2, py - 2, 3.5, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
  }
  function bed(ctx, x, y, n, R) {
    for (let i = 0; i < n; i++) {
      const fx = x + (R() - .5) * 46, fy = y + (R() - .5) * 26, col = ["#e8629b", "#f2b705", "#8e63d8", "#ffffff", "#f0812a"][Math.floor(R() * 5)];
      leaf(ctx, fx, fy, 10, R() * TAU, "#3f9646");
      ctx.fillStyle = col; for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(fx + Math.cos(k * 1.256) * 3.4, fy + Math.sin(k * 1.256) * 3.4, 2.8, 0, TAU); ctx.fill(); }
      ctx.fillStyle = "#f6c445"; ctx.beginPath(); ctx.arc(fx, fy, 2, 0, TAU); ctx.fill();
    }
  }
  function flower(ctx, x, y, r, col, t = 0, flash = 0) {
    const neutral = col == null, base = neutral ? "#e3e8cf" : col;
    const sway = Math.sin(t * 1.3 + x * .05) * .06, s = r * (1 + flash * .3);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(x + 3, y + s * .55, s * 1.15, s * .45, 0, 0, TAU); ctx.fill();
    leaf(ctx, x, y, s * 1.55, 2.4 + sway, "#4da54f"); leaf(ctx, x, y, s * 1.4, .55 + sway, "#3f9646");
    ctx.translate(x, y); ctx.rotate(sway);
    const n = r >= 17 ? 8 : 6;
    const g = ctx.createRadialGradient(0, 0, s * .1, 0, 0, s * 1.15);
    g.addColorStop(0, neutral ? "#ffffff" : mix(base, .78)); g.addColorStop(1, neutral ? "#e3e8cf" : base);
    ctx.fillStyle = g;
    for (let i = 0; i < n; i++) { const a = i * TAU / n; ctx.beginPath(); ctx.ellipse(Math.cos(a) * s * .55, Math.sin(a) * s * .55, s * .58, s * .34, a, 0, TAU); ctx.fill(); }
    ctx.strokeStyle = "rgba(0,0,0,.08)"; ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) { const a = i * TAU / n; ctx.beginPath(); ctx.moveTo(Math.cos(a) * s * .3, Math.sin(a) * s * .3); ctx.lineTo(Math.cos(a) * s * .9, Math.sin(a) * s * .9); ctx.stroke(); }
    ctx.fillStyle = "#f6c445"; ctx.beginPath(); ctx.arc(0, 0, s * .32, 0, TAU); ctx.fill();
    ctx.fillStyle = "#e09a1e"; ctx.beginPath(); ctx.arc(0, 0, s * .17, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff3c4"; ctx.beginPath(); ctx.arc(-s * .1, -s * .1, s * .06, 0, TAU); ctx.arc(s * .12, s * .07, s * .05, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function vine(ctx, a, b, col, t = 0) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const off = 22 * (((a.x * 7 + b.y * 3) | 0) % 2 ? 1 : -1);
    const cx = mx - dy / L * off, cy = my + dx / L * off;
    const P = u => [(1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x, (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * cy + u * u * b.y];
    ctx.save(); ctx.lineCap = "round";
    ctx.strokeStyle = "#2f6e31"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x, b.y); ctx.stroke();
    ctx.strokeStyle = "#5cbb5a"; ctx.lineWidth = 2; ctx.stroke();
    const k = Math.max(3, Math.round(L / 45));
    for (let i = 1; i < k; i++) { const u = i / k, [x, y] = P(u), [x2, y2] = P(u + .02); leaf(ctx, x, y, 13, Math.atan2(y2 - y, x2 - x) + (i % 2 ? 1 : -1) * (1 + Math.sin(t * 2 + i) * .1), i % 2 ? "#4da54f" : "#3f9646"); }
    const [bx, by] = P(.5); ctx.fillStyle = col; for (let j = 0; j < 5; j++) { ctx.beginPath(); ctx.arc(bx + Math.cos(j * 1.256) * 3.4, by + Math.sin(j * 1.256) * 3.4, 2.6, 0, TAU); ctx.fill(); }
    ctx.fillStyle = "#f6c445"; ctx.beginPath(); ctx.arc(bx, by, 1.8, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function bee(ctx, x, y, ang, col, t = 0, o = {}) {
    ctx.save(); ctx.translate(x, y);
    if (o.faint) ctx.globalAlpha = .45;
    ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.beginPath(); ctx.ellipse(4, 10, 11, 4.5, 0, 0, TAU); ctx.fill();
    if (o.you) { ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); }
    if (o.safe) { ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(0, 0, 18, t * 3, t * 3 + TAU); ctx.stroke(); ctx.setLineDash([]); }
    ctx.rotate(ang);
    const flap = o.faint ? .4 : .55 + .45 * Math.abs(Math.sin(t * 38));
    ctx.fillStyle = "rgba(255,255,255,.82)"; ctx.strokeStyle = "rgba(70,100,120,.55)"; ctx.lineWidth = 1;
    [-1, 1].forEach(sg => { ctx.beginPath(); ctx.ellipse(-2, sg * 8, 8, 5.2 * flap, sg * -.35, 0, TAU); ctx.fill(); ctx.stroke(); });
    // the body never changes, only the wings flap: it is drawn once per colour and size, then placed
    const m = ctx.getTransform(), k = Math.max(.5, Math.round(Math.hypot(m.a, m.b) * 4) / 4), key = col + "|" + k;
    let sp = beeBodies.get(key);
    if (!sp) {
      if (beeBodies.size > 120) beeBodies.clear();
      sp = document.createElement("canvas"); sp.width = Math.ceil(44 * k); sp.height = Math.ceil(24 * k);
      const c = sp.getContext("2d"); c.scale(k, k); c.translate(20, 12); beeBody(c, col);
      beeBodies.set(key, sp);
    }
    ctx.drawImage(sp, -20, -12, 44, 24);
    ctx.restore();
    if (o.dizzy) for (let i = 0; i < 3; i++) { const a = t * 6 + i * TAU / 3; star(ctx, x + Math.cos(a) * 14, y - 18 + Math.sin(a) * 5, 4.5, "#f6c445"); }
    if (o.faint) { ctx.save(); ctx.font = "800 13px Nunito, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#1e4423"; ctx.fillText("z z z", x + 4, y - 18 - Math.sin(t * 3) * 3); ctx.restore(); }
    if (o.hp != null && o.hp < 100 && !o.faint) {
      const w = 28, f = Math.max(0, o.hp) / 100;
      ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.roundRect(x - w / 2 - 1, y + 16, w + 2, 6, 3); ctx.fill();
      ctx.fillStyle = f > .5 ? "#4fae52" : f > .25 ? "#f0a824" : "#e8504f"; ctx.beginPath(); ctx.roundRect(x - w / 2, y + 17, w * f, 4, 2); ctx.fill();
    }
  }
  const beeBodies = new Map();
  function beeBody(ctx, col) {
    ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(-17, 0); ctx.strokeStyle = "#3a2a1a"; ctx.lineWidth = 2; ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 12.5, 8.5, 0, 0, TAU); ctx.fillStyle = col; ctx.fill(); ctx.clip();
    ctx.fillStyle = "#3a2a1a"; ctx.fillRect(-7, -10, 3.4, 20); ctx.fillRect(-.5, -10, 3.4, 20);
    ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.ellipse(1, -4, 8, 2.4, 0, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(58,42,26,.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, 12.5, 8.5, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = "#3a2a1a"; ctx.beginPath(); ctx.arc(12, 0, 5.6, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(14, -2.2, 1.6, 0, TAU); ctx.arc(14, 2.2, 1.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#3a2a1a"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(15, -3); ctx.quadraticCurveTo(20, -6, 21, -9); ctx.moveTo(15, 3); ctx.quadraticCurveTo(20, 6, 21, 9); ctx.stroke();
  }
  function star(ctx, x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); ctx.strokeStyle = "#a9701f"; ctx.lineWidth = .8; ctx.stroke(); }
  function flytrap(ctx, x, y, t) {
    ctx.save();
    for (let i = 0; i < 3; i++) { ctx.strokeStyle = `rgba(232,98,155,${.32 - i * .08})`; ctx.lineWidth = 2; ctx.setLineDash([6, 10]); ctx.lineDashOffset = -t * 20 * (i % 2 ? 1 : -1); ctx.beginPath(); ctx.arc(x, y, 50 + i * 30, 0, TAU); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(x + 3, y + 14, 40, 16, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#8a6437"; ctx.beginPath(); ctx.ellipse(x, y + 8, 36, 19, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#6e4e2a"; ctx.beginPath(); ctx.ellipse(x, y + 8, 27, 12, 0, 0, TAU); ctx.fill();
    leaf(ctx, x, y + 6, 32, -2.6, "#3f9646"); leaf(ctx, x, y + 6, 32, -.5, "#3f9646"); leaf(ctx, x, y + 8, 26, 1.6, "#4da54f");
    const open = .45 + .3 * Math.sin(t * 2.2);
    [1, -1].forEach(sg => {
      ctx.save(); ctx.translate(x, y); ctx.scale(1, sg); ctx.rotate(-open);
      ctx.fillStyle = "#6cbf4f"; ctx.beginPath(); ctx.ellipse(0, 0, 26, 15, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = "#d94a5a"; ctx.beginPath(); ctx.ellipse(0, -1, 20, 10, 0, Math.PI, TAU); ctx.fill();
      ctx.strokeStyle = "#f2f8d8"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
      for (let i = -4; i <= 4; i++) { const tx = i * 5.4, ty = -Math.sqrt(Math.max(0, 1 - (tx / 26) ** 2)) * 15; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx * 1.08, ty - 5); ctx.stroke(); }
      ctx.restore();
    });
    ctx.restore();
  }
  function dragonfly(ctx, x, y, ang, t) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,.16)"; ctx.beginPath(); ctx.ellipse(8, 14, 26, 6, ang, 0, TAU); ctx.fill();
    ctx.rotate(ang);
    const flap = .65 + .35 * Math.sin(t * 50);
    ctx.fillStyle = "rgba(220,245,255,.7)"; ctx.strokeStyle = "rgba(60,120,150,.6)"; ctx.lineWidth = 1;
    [[4, -1], [4, 1], [-4, -1], [-4, 1]].forEach(([wx, sg], i) => { ctx.save(); ctx.translate(wx, 0); ctx.rotate(sg * (i < 2 ? -1.25 : -1.85)); ctx.beginPath(); ctx.ellipse(13, 0, 15 * flap, 4.2, 0, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore(); });
    const g = ctx.createLinearGradient(-34, 0, 14, 0); g.addColorStop(0, "#0f6f8f"); g.addColorStop(1, "#22b8cf");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(-12, 0, 24, 3.2, 0, 0, TAU); ctx.fill();
    for (let i = 0; i < 6; i++) { ctx.fillStyle = "rgba(10,60,80,.5)"; ctx.fillRect(-30 + i * 6, -3, 1.4, 6); }
    ctx.fillStyle = "#1597b0"; ctx.beginPath(); ctx.ellipse(8, 0, 7, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#0b4f63"; ctx.beginPath(); ctx.arc(16, -3.6, 3.8, 0, TAU); ctx.arc(16, 3.6, 3.8, 0, TAU); ctx.fill();
    ctx.fillStyle = "#bff3ff"; ctx.beginPath(); ctx.arc(17, -4.4, 1.2, 0, TAU); ctx.arc(17, 2.8, 1.2, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function birdShadow(ctx, x, y, p, R, t) {
    const k = Math.min(1, p);
    ctx.save();
    ctx.fillStyle = `rgba(20,30,25,${.12 + .3 * k})`; ctx.beginPath(); ctx.ellipse(x, y, R * (.35 + .65 * k), R * (.25 + .5 * k), 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(232,80,79,${.5 + .4 * Math.sin(t * 14)})`; ctx.lineWidth = 3; ctx.setLineDash([8, 7]);
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = .35 + .4 * k; bird(ctx, x, y, -.4, .55 + .45 * k, "rgba(20,30,25,.55)");
    ctx.restore();
  }
  function bird(ctx, x, y, ang, s, col = "#4a5560") {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(34, 0); ctx.quadraticCurveTo(14, -6, 2, -6);
    ctx.quadraticCurveTo(-10, -44, -30, -58); ctx.quadraticCurveTo(-16, -22, -14, -6);
    ctx.lineTo(-30, -10); ctx.lineTo(-24, 0); ctx.lineTo(-30, 10); ctx.lineTo(-14, 6);
    ctx.quadraticCurveTo(-16, 22, -30, 58); ctx.quadraticCurveTo(-10, 44, 2, 6); ctx.quadraticCurveTo(14, 6, 34, 0); ctx.fill();
    ctx.restore();
  }
  function spider(ctx, x, y, t, drop) {
    ctx.save();
    if (drop < 1) { ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y - 160); ctx.lineTo(x, y - 160 * (1 - drop)); ctx.stroke(); y = y - 160 * (1 - drop); }
    ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.beginPath(); ctx.ellipse(x + 4, y + 8, 12, 5, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#2b211a"; ctx.lineWidth = 2; ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) for (const sg of [-1, 1]) {
      const a = (-.9 + i * .55) + Math.sin(t * 8 + i) * .08, l = 13;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + sg * Math.cos(a) * l * .8, y + Math.sin(a) * l * .4 - 6, x + sg * Math.cos(a) * l * 1.3, y + Math.sin(a) * l); ctx.stroke();
    }
    ctx.fillStyle = "#3a2c22"; ctx.beginPath(); ctx.ellipse(x, y + 3, 7, 8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#2b211a"; ctx.beginPath(); ctx.arc(x, y - 6, 4.5, 0, TAU); ctx.fill();
    ctx.fillStyle = "#e8504f"; ctx.beginPath(); ctx.arc(x, y + 3, 2.4, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x - 1.6, y - 7, 1, 0, TAU); ctx.arc(x + 1.6, y - 7, 1, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function web(ctx, x, y, R, alpha) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.2;
    const n = 10;
    for (let i = 0; i < n; i++) { const a = i * TAU / n; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R); ctx.stroke(); }
    for (let k = 1; k <= 4; k++) { const rr = R * k / 4.3; ctx.beginPath(); for (let i = 0; i <= n; i++) { const a = i * TAU / n, sag = i % 2 ? .9 : 1; ctx.lineTo(x + Math.cos(a) * rr * sag, y + Math.sin(a) * rr * sag); } ctx.stroke(); }
    ctx.restore();
  }
  function butterfly(ctx, x, y, t, col) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * .7) * .4);
    const f = .35 + .65 * Math.abs(Math.sin(t * 9));
    [-1, 1].forEach(sg => {
      ctx.save(); ctx.scale(sg * f, 1);
      ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(6, -4, 7, 6, -.4, 0, TAU); ctx.fill();
      ctx.fillStyle = mix(col, .4); ctx.beginPath(); ctx.ellipse(5, 5, 5, 4, .4, 0, TAU); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.beginPath(); ctx.arc(7, -5, 1.6, 0, TAU); ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "#3a2a1a"; ctx.fillRect(-1, -7, 2, 14);
    ctx.restore();
  }
  // the hedge a fortified flower grows: a ring of dark leaves, slower to break into
  function hedgeRing(ctx, x, y, r, t) {
    const n = Math.max(10, Math.round(r * .55));
    ctx.save();
    ctx.strokeStyle = "rgba(31,92,43,.55)"; ctx.lineWidth = 3; ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const a = i * TAU / n + Math.sin(t * .8 + i) * .02;
      leaf(ctx, x + Math.cos(a) * r, y + Math.sin(a) * r, 9, a + (i % 2 ? 1.2 : -1.9), i % 3 ? "#2f7a3a" : "#3f9646");
    }
    ctx.restore();
  }
  function ring(ctx, x, y, r, col, frac, w = 5) {
    ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = w + 3;
    ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * frac); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke(); ctx.restore();
  }
  function label(ctx, x, y, txt, col = "#1e4423", size = 13) {
    ctx.save(); ctx.font = `800 ${size}px Nunito, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(txt).width + 16;
    // no blurred shadow: a soft edge line instead (blur is slow on phones)
    ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.strokeStyle = "rgba(0,0,0,.12)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - size * .9, w, size * 1.8, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.fillText(txt, x, y + 1); ctx.restore();
  }
  return { mix, rng, lawn, daisy, hedge, leaf, tree, topiary, pond, bed, flower, vine, bee, star, flytrap, dragonfly, birdShadow, bird, spider, web, butterfly, ring, hedgeRing, label };
})();


const Garden = (() => {
  const M = 120;               // meadow margin around the hedge, for trees and beds
  let bgId = 0, openN = 0;         // openN: flowers open so far (the rest sprout during the round)                    // which background the backdrop layer currently shows
  let world = null, bg = null, parts = [], flies = [], flash = [], floats = [], honeyClock = 0;
  const BGS = 1.25;

  function setup(w) {
    world = w;
    world.fl = w.flowers.map(([x, y, r]) => ({ x, y, r, R: r + 26 }));
    flash = world.fl.map(() => 0);
    openN = w.open != null ? w.open : world.fl.length;
    parts = [];
    bg = paintBackground(); bgId++;
    const R = Art.rng(w.seed + 99);
    flies = Array.from({ length: 5 }, (_, i) => ({ x: R() * w.W, y: R() * w.H, a: R() * TAU, s: 30 + R() * 30, col: ["#f0812a", "#8e63d8", "#18a9b8", "#e8629b", "#f2b705"][i] }));
  }

  function paintBackground() {
    const W = world.W, H = world.H, c = document.createElement("canvas");
    c.width = Math.round((W + 2 * M) * BGS); c.height = Math.round((H + 2 * M) * BGS);
    const x = c.getContext("2d"); x.scale(BGS, BGS); x.translate(M, M);
    const R = Art.rng(world.seed);
    // meadow outside the hedge
    x.fillStyle = "#6fae5e"; x.fillRect(-M, -M, W + 2 * M, H + 2 * M);
    Art.lawn(x, -M, -M, W + 2 * M, H + 2 * M, false, world.seed + 1);
    x.fillStyle = "rgba(30,80,40,.12)"; x.fillRect(-M, -M, W + 2 * M, H + 2 * M);
    // the lawn inside
    x.save(); x.beginPath(); x.roundRect(14, 14, W - 28, H - 28, 30); x.clip();
    Art.lawn(x, 0, 0, W, H, true, world.seed + 2);
    // stepping-stone paths between a few flowers
    x.fillStyle = "rgba(238,226,192,.85)";
    for (let k = 0; k < 4; k++) {
      const a = world.fl[Math.floor(R() * world.fl.length)], b = world.fl[Math.floor(R() * world.fl.length)];
      const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 120) continue;
      for (let s = 40; s < d - 40; s += 34) { const u = s / d; x.beginPath(); x.ellipse(a.x + (b.x - a.x) * u + (R() - .5) * 6, a.y + (b.y - a.y) * u + (R() - .5) * 6, 9, 6, R() * 3, 0, TAU); x.fill(); }
    }
    // a small pond in an empty spot, if there is one
    for (let tries = 0; tries < 60; tries++) {
      const px = 160 + R() * (W - 320), py = 140 + R() * (H - 280);
      const clear = world.fl.every(f => Math.hypot(f.x - px, f.y - py) > f.R + 120) && Math.hypot(px - world.trap[0], py - world.trap[1]) > 220;
      if (clear) { Art.pond(x, px, py, 56, 34, R); break; }
    }
    x.restore();
    // beds along the hedge and trees in the meadow
    const along = (n, f) => { for (let i = 0; i < n; i++) f(i / (n - 1)); };
    along(Math.round(W / 260), u => { Art.bed(x, 60 + u * (W - 120), -58, 6, R); Art.bed(x, 60 + u * (W - 120), H + 58, 6, R); });
    along(Math.round(H / 260), u => { Art.bed(x, -58, 60 + u * (H - 120), 6, R); Art.bed(x, W + 58, 60 + u * (H - 120), 6, R); });
    Art.hedge(x, 14, 14, W - 28, H - 28, 30);
    [[-30, -30], [W + 30, -30], [-30, H + 30], [W + 30, H + 30]].forEach(([tx, ty]) => Art.topiary(x, tx, ty, 1.1));
    along(Math.max(3, Math.round(W / 330)), u => { if (R() < .75) Art.tree(x, 120 + u * (W - 240) + (R() - .5) * 60, -92 + R() * 14, .8 + R() * .3, R); if (R() < .75) Art.tree(x, 120 + u * (W - 240) + (R() - .5) * 60, H + 86 + R() * 14, .8 + R() * .3, R); });
    along(Math.max(2, Math.round(H / 330)), u => { if (R() < .7) Art.tree(x, -92 + R() * 14, 110 + u * (H - 220), .75 + R() * .25, R); if (R() < .7) Art.tree(x, W + 92 - R() * 14, 110 + u * (H - 220), .75 + R() * .25, R); });
    return c;
  }

  let rot = false;                 // tall screens get the garden turned sideways
  // how much of the meadow outside the hedge to show (o.margin): phones show only a strip of it
  let vm = M;
  function fit(vw, vh, pad = 0) {
    if (rot) [vw, vh] = [vh, vw];
    const ww = world.W + 2 * vm - pad * 2, wh = world.H + 2 * vm - pad * 2;
    const s = Math.min(vw / ww, vh / wh);
    return { s, ox: (vw - (world.W + 2 * vm) * s) / 2 + vm * s, oy: (vh - (world.H + 2 * vm) * s) / 2 + vm * s };
  }
  // text drawn in the garden stays upright even when the garden is turned
  function upright(ctx, x, y, fn) { ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(-Math.PI / 2); fn(); ctx.restore(); }
  let zoom = 1;                    // bees and labels grow when the garden is drawn small
  function tag(ctx, x, y, txt, col, size) { upright(ctx, x, y, () => { ctx.scale(zoom, zoom); Art.label(ctx, 0, 0, txt, col, size); }); }

  // patches only change when a snapshot does: work them out once per snapshot, not once per use
  let pcOwners = null; const pcMemo = new Map();
  function patches(owners, slot) {
    if (owners !== pcOwners) { pcOwners = owners; pcMemo.clear(); }
    let got = pcMemo.get(slot);
    if (!got) { got = patchesOf(owners, slot); pcMemo.set(slot, got); }
    return got;
  }
  function patchesOf(owners, slot) {
    const mine = world.fl.filter((f, i) => owners[i] === slot), seen = new Set(), out = [];
    for (const f of mine) {
      if (seen.has(f)) continue; const comp = [], st = [f]; seen.add(f);
      while (st.length) { const c = st.pop(); comp.push(c); for (const q of mine) if (!seen.has(q) && Math.hypot(c.x - q.x, c.y - q.y) <= world.link) { seen.add(q); st.push(q); } }
      out.push(comp);
    }
    return out;
  }

  // Each kind of flower is drawn once into a little picture, then placed (gently swaying) every
  // frame: a flower is two dozen shapes and a gradient, and redrawing them all every frame was the
  // next biggest cost on phones after the background.
  const sprites = new Map();
  function drawFlower(ctx, f, col, t, flash, dpr, still) {
    const k = Math.max(.5, Math.round(view.s * dpr * zoomFor(f) * 4) / 4), key = f.r + "|" + col + "|" + k;
    let sp = sprites.get(key);
    const half = Math.ceil(f.r * 1.7 + 6);
    if (!sp) {
      if (sprites.size > 300) sprites.clear();
      sp = document.createElement("canvas"); sp.width = sp.height = Math.ceil(half * 2 * k);
      const c = sp.getContext("2d"); c.scale(k, k);
      Art.flower(c, half, half, f.r, col, -half * .05 / 1.3, 0);        // drawn still (no sway)
      sprites.set(key, sp);
    }
    const sway = still ? 0 : Math.sin(t * 1.3 + f.x * .05) * .06, s = 1 + flash * .3;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(sway); if (s !== 1) ctx.scale(s, s);
    ctx.drawImage(sp, -half, -half, half * 2, half * 2); ctx.restore();
  }
  const zoomFor = () => 1;

  function addFx(list) {
    for (const [k, x, y, slot] of list) {
      const col = slot >= 0 ? PC[slot] : "#ffffff";
      if (k === "bloom") { const fi = world.fl.findIndex(f => Math.abs(f.x - x) < 2 && Math.abs(f.y - y) < 2); if (fi >= 0) flash[fi] = 1; burst(x, y, 18, () => ({ col, shape: "petal", v: 60 + Math.random() * 130 })); }
      else if (k === "hit") burst(x, y, 10, () => ({ col: "#e8504f", shape: "spark", v: 60 + Math.random() * 120 }));
      else if (k === "sting") { burst(x, y, 16, () => ({ col: Math.random() < .5 ? "#ff5a2a" : "#ffb347", shape: "spark", v: 90 + Math.random() * 160 })); burst(x, y, 4, () => ({ col: "#f6c445", shape: "star", v: 40 + Math.random() * 60 })); }
      else if (k === "bump") burst(x, y, 6, () => ({ col: "#f6c445", shape: "star", v: 50 + Math.random() * 80 }));
      else if (k === "faint") burst(x, y, 14, () => ({ col: "rgba(255,255,255,.9)", shape: "puff", v: 30 + Math.random() * 60 }));
      else if (k === "snap") burst(x, y, 10, () => ({ col: "#4da54f", shape: "petal", v: 80 + Math.random() * 120 }));
      else if (k === "sprout") { const fi = world.fl.findIndex(f => Math.abs(f.x - x) < 2 && Math.abs(f.y - y) < 2); if (fi >= 0) { flash[fi] = 1; openN = Math.max(openN, fi + 1); } burst(x, y, 14, () => ({ col: Math.random() < .5 ? "#7cc46a" : "#ffffff", shape: "petal", v: 40 + Math.random() * 90 })); }
      else if (k === "hatch") burst(x, y, 16, () => ({ col: Math.random() < .5 ? col : "#f6c445", shape: "star", v: 50 + Math.random() * 110 }));
      else if (k === "home") burst(x, y, 10, () => ({ col: "rgba(255,255,255,.9)", shape: "puff", v: 20 + Math.random() * 40 }));
      else if (k === "land") burst(x, y, 6, () => ({ col: "#f6c445", shape: "dot", v: 20 + Math.random() * 50 }));
      else if (k === "swoop") burst(x, y, 22, () => ({ col: "#5a6670", shape: "feather", v: 80 + Math.random() * 160 }));
    }
  }
  function burst(x, y, n, f) { for (let i = 0; i < n; i++) { const o = f(), a = Math.random() * TAU; parts.push({ x, y, vx: Math.cos(a) * o.v, vy: Math.sin(a) * o.v, rot: a, life: 1, col: o.col, shape: o.shape }); } }

  function segDist(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l));
    return Math.hypot(ax + u * dx - px, ay + u * dy - py);
  }
  const hitsTrap = (b, f) => segDist(b.x, b.y, f.x, f.y, world.trap[0], world.trap[1]) < world.cfg.trapR;

  // where the last frame was drawn, so a tap can be turned back into the garden
  let view = null;
  function toWorld(px, py) {
    if (!view) return null;
    const { s, ox, oy, rot: r, vw } = view;
    return r ? { x: (py - ox) / s, y: (vw - px - oy) / s } : { x: (px - ox) / s, y: (py - oy) / s };
  }
  function toScreen(x, y) {
    if (!view) return null;
    const { s, ox, oy, rot: r, vw } = view;
    return r ? { x: vw - (oy + s * y), y: ox + s * x } : { x: ox + s * x, y: oy + s * y };
  }
  // the bee nearest a finger, among the given bees, if it is close enough to mean that bee
  function beeAt(px, py, bees, reach = 46) {
    let best = null, bd = reach;
    for (const b of bees) { const p = toScreen(b.x, b.y); if (!p) continue; const d = Math.hypot(p.x - px, p.y - py); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  // the flower under a finger or the mouse (fingers get a little extra room)
  function flowerAt(px, py) {
    const p = toWorld(px, py); if (!p || !world) return -1;
    let best = -1, bd = 1e9;
    world.fl.forEach((f, i) => { if (i >= openN) return; const d = Math.hypot(p.x - f.x, p.y - f.y); if (d < f.R + Math.max(10, 22 / view.s) && d < bd) { bd = d; best = i; } });
    return best;
  }
  // flowers nearest a bee, nearest first: what the laptop keys step through
  function nearestFlowers(b) {
    return world.fl.slice(0, openN).map((f, i) => [i, Math.hypot(f.x - b.x, f.y - b.y)]).filter(([i]) => !(b.st === 0 && i === b.f)).sort((a, c) => a[1] - c[1]).map(a => a[0]);
  }

  function draw(ctx, vw, vh, S, t, o = {}) {
    if (!world) return;
    rot = !!o.rotate && vh > vw * 1.15;
    vm = o.margin != null ? o.margin : M;
    const { s, ox, oy } = fit(vw, vh, o.pad || 0);
    const dt = o.dt || 1 / 60;
    zoom = Math.max(1, Math.min(1.8, .62 / s));
    ctx.save();
    if (rot) { ctx.translate(vw, 0); ctx.rotate(Math.PI / 2); }
    ctx.translate(ox, oy); ctx.scale(s, s);
    view = { s, ox, oy, rot, vw };
    if (o.backdrop) {
      // the still background (lawn, hedges, trees) lives on its own canvas behind this one and is
      // painted only when the screen or the garden changes, not every frame: on phones that
      // scaled (and turned) picture was most of the cost of a frame
      const bc = o.backdrop, d = o.dpr || 1, key = [bgId, vw, vh, d, rot, s.toFixed(4), ox | 0, oy | 0].join();
      if (bc.dataset.key !== key) {
        bc.dataset.key = key; bc.width = Math.round(vw * d); bc.height = Math.round(vh * d);
        const b = bc.getContext("2d"); b.setTransform(d, 0, 0, d, 0, 0);
        if (rot) { b.translate(vw, 0); b.rotate(Math.PI / 2); }
        b.translate(ox, oy); b.scale(s, s); b.drawImage(bg, -M, -M, world.W + 2 * M, world.H + 2 * M);
      }
    } else ctx.drawImage(bg, -M, -M, world.W + 2 * M, world.H + 2 * M);
    const owners = S.o || [];
    if (owners.length > openN && owners.length <= world.fl.length) openN = owners.length;   // a flower sprouted
    const slots = [...new Set(owners.filter(v => v != null))];
    // fortified patches: 4+ joined flowers grow a hedge and take 3 loops to steal
    const fortSize = world.cfg.fortSize || 4, fortLoops = world.cfg.fortLoops || 3, fort = new Set();
    slots.forEach(sl => patches(owners, sl).forEach(p => { if (p.length >= fortSize) p.forEach(f => fort.add(world.fl.indexOf(f))); }));
    world.fl.forEach((f, i) => { if (i < openN) flash[i] = Math.max(0, flash[i] - dt * 1.5); });
    const dpr = o.dpr || devicePixelRatio || 1;
    // the flower bed: vines, hedges and flowers. They only change when a flower changes hands,
    // sprouts or flashes, so with a layer canvas (o.layer) they are painted only then, still
    // (no sway), and each frame draws only what moves
    const bed = (c, tt) => {
      slots.forEach(sl => patches(owners, sl).forEach(p => { for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) <= world.link) Art.vine(c, p[i], p[j], PC[sl], tt); }));
      // vine reach: faint dots from my flowers to every flower close enough to join them
      (o.reachSlots || []).forEach(sl => {
        c.save(); c.strokeStyle = PC[sl]; c.globalAlpha = .28; c.lineWidth = 2.5; c.lineCap = "round"; c.setLineDash([1, 9]);
        world.fl.forEach((a, i) => { if (owners[i] !== sl) return; world.fl.forEach((b, j) => {
          if (j >= openN || owners[j] === sl || Math.hypot(a.x - b.x, a.y - b.y) > world.link) return;
          const d = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
          c.beginPath(); c.moveTo(a.x + ux * a.r, a.y + uy * a.r); c.lineTo(b.x - ux * b.r, b.y - uy * b.r); c.stroke();
        }); });
        c.restore();
      });
      fort.forEach(i => { const f = world.fl[i]; Art.hedgeRing(c, f.x, f.y, f.r + 15, tt); });
      world.fl.forEach((f, i) => { if (i < openN) drawFlower(c, f, owners[i] == null ? null : PC[owners[i]], tt, flash[i], dpr, tt == null); });
    };
    if (o.layer) {
      const lc = o.layer, flashing = flash.some((v, i) => i < openN && v > 0);
      const key = [bgId, vw, vh, dpr, rot, s.toFixed(4), ox | 0, oy | 0, openN, owners.join(), (o.reachSlots || []).join()].join("|");
      if (flashing || lc.dataset.key !== key) {
        lc.dataset.key = flashing ? "" : key;
        if (lc.width !== Math.round(vw * dpr) || lc.height !== Math.round(vh * dpr)) { lc.width = Math.round(vw * dpr); lc.height = Math.round(vh * dpr); }
        const c = lc.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, lc.width, lc.height); c.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (rot) { c.translate(vw, 0); c.rotate(Math.PI / 2); }
        c.translate(ox, oy); c.scale(s, s); bed(c, null);
      }
    } else bed(ctx, t);
    Art.flytrap(ctx, world.trap[0], world.trap[1], t);
    // bird shadows sit under everything that flies
    (S.p || []).filter(p => p[0] === "b").forEach(p => { if (p[3] < 1) Art.birdShadow(ctx, p[1], p[2], p[3], 75, t); });
    const webs = new Map(); (S.p || []).filter(p => p[0] === "s").forEach(p => webs.set(p[1], p));
    webs.forEach((w, i) => { const f = world.fl[i]; if (f) Art.web(ctx, f.x, f.y, f.R - 2, Math.min(1, w[3] / .8) * Math.min(1, w[4] / 1.5)); });
    // pollination progress
    (S.b || []).forEach(b => { if (b.st === 0 && owners[b.f] !== b.slot && b.prog > 0) Art.ring(ctx, world.fl[b.f].x, world.fl[b.f].y, world.fl[b.f].r + 12, PC[b.slot], Math.min(1, b.prog / ((owners[b.f] == null ? 1 : fort.has(b.f) ? fortLoops : 2) * TAU)), 4); });
    // where my bees are going, and where a tap would send them
    const mineIds = new Set(o.mine || (o.me != null ? [o.me] : []));
    const solo = (o.mineSlots ? new Set(o.mineSlots).size : mineIds.size) <= 1;   // one player here (who may have several bees)
    const beeById = new Map((S.b || []).map(b => [b.id, b]));
    const aimLine = (b, f, col, txt, warnCol) => {
      ctx.save(); ctx.lineCap = "round"; ctx.setLineDash([1, 10]); ctx.lineWidth = 4; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(f.x, f.y); ctx.stroke(); ctx.setLineDash([6, 5]); ctx.lineDashOffset = -t * 30;
      ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(f.x, f.y, f.R + 3, 0, TAU); ctx.stroke(); ctx.restore();
      if (txt) tag(ctx, f.x, f.y + f.R + 16, txt, warnCol || (solo ? "#1e4423" : col), 12);
    };
    (S.b || []).forEach(b => { if (mineIds.has(b.id) && b.st === 1 && b.target >= 0) aimLine(b, world.fl[b.target], b.sting ? "#d9411e" : solo ? "rgba(255,255,255,.95)" : PC[b.slot], ""); });
    (o.aims || []).forEach(a => {
      const b = beeById.get(a.id); if (!b || a.f < 0 || !(b.st === 0 || b.st === 1) || (b.st === 0 && a.f === b.f)) return;
      const f = world.fl[a.f], bad = hitsTrap(b, f), who = solo ? "" : (b.name || "") + ": ";
      const armed = b.armed || b.sting;
      const col = bad ? "#e8504f" : armed ? "#d9411e" : solo ? "rgba(255,255,255,.95)" : PC[b.slot];
      let what = a.mode === "pick" ? "flying here…" : armed ? "sting dash here" : solo ? "tap to fly here" : "lift to fly here";
      if (owners[a.f] !== b.slot) {
        // what this flower would add: the patches of mine it touches, joined into one
        const touch = patches(owners, b.slot).filter(p => p.some(q => Math.hypot(q.x - f.x, q.y - f.y) <= world.link));
        const n = 1 + touch.reduce((s, p) => s + p.length, 0);
        what += n > 1 ? ` · joins ${n} flowers: +${n * n}/s` : " · too far to join yours";
      }
      aimLine(b, f, col, bad ? who + "this way hits the flytrap!" : who + what, bad ? "#c03a3a" : armed ? "#b8361a" : null);
    });
    // particles
    parts.forEach(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .96; p.vy *= .96; p.rot += dt * 4; p.life -= dt * (p.shape === "puff" ? .8 : 1.1);
      ctx.save(); ctx.globalAlpha = Math.max(0, p.life); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.col;
      if (p.shape === "star") { ctx.restore(); ctx.save(); ctx.globalAlpha = Math.max(0, p.life); Art.star(ctx, p.x, p.y, 4, p.col); }
      else if (p.shape === "puff") { ctx.beginPath(); ctx.arc(0, 0, 6 + (1 - p.life) * 10, 0, TAU); ctx.fill(); }
      else if (p.shape === "feather") { ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.2, 0, 0, TAU); ctx.fill(); }
      else if (p.shape === "dot") { ctx.beginPath(); ctx.arc(0, 0, 2, 0, TAU); ctx.fill(); }
      else if (p.shape === "spark") { ctx.fillRect(-1, -4, 2, 8); }
      else { ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.6, 0, 0, TAU); ctx.fill(); }
      ctx.restore();
    });
    parts = parts.filter(p => p.life > 0);
    // honey badges: every patch says what it is earning
    const mineSlots = new Set(o.mineSlots || (o.meSlot != null ? [o.meSlot] : []));
    slots.forEach(sl => patches(owners, sl).forEach(p => {
      const n = p.length, cx = p.reduce((a, f) => a + f.x, 0) / n, cy = p.reduce((a, f) => a + f.y, 0) / n;
      const mine = mineSlots.has(sl);
      // the big screen spells it out; a player's own screen stays clean: a small "+9/s" on their own patches
      if (o.allBadges) {
        const txt = n === 1 ? "+1/s" : `${n} flowers · ${n}×${n} = +${n * n}/s${n >= fortSize ? " · fortified" : ""}`;
        tag(ctx, cx, n === 1 ? p[0].y + p[0].R + 14 : cy + (n === 2 ? 18 : 0), txt, PC[sl], n === 1 ? 13 : 15);
      } else if (mine && n > 1) tag(ctx, cx, cy + (n === 2 ? 18 : 0), `+${n * n}/s`, PC[sl], 12);
    }));
    // a "+n" floats up from every patch each second, as the honey comes in
    honeyClock += dt;
    if (honeyClock >= 1 && S.ph === "play") {
      honeyClock -= 1;
      slots.forEach(sl => { if (mineSlots.size && !mineSlots.has(sl) && !o.allBadges) return; patches(owners, sl).forEach(p => { const n = p.length; if (n < 2 && !o.allBadges) return; floats.push({ x: p.reduce((a, f) => a + f.x, 0) / n, y: p.reduce((a, f) => a + f.y, 0) / n - 20, txt: "+" + n * n, col: PC[sl], life: 1, big: n > 1 }); }); });
    }
    if (honeyClock > 2) honeyClock = 0;
    // spiders
    webs.forEach(p => { const f = world.fl[p[1]]; Art.spider(ctx, f.x + 10, f.y - 8, t, Math.min(1, p[3] / .8)); });
    // bees
    (S.b || []).forEach(b => {
      const ang = b.st === 0 ? b.ang + b.dir * Math.PI / 2 : b.st === 1 ? Math.atan2(b.vy, b.vx) : t * 3;
      if (b.sting && b.st === 1) {
        // a sting dash: a hot streak behind the bee
        const sp = Math.hypot(b.vx, b.vy) || 1, ux = b.vx / sp, uy = b.vy / sp, L = 46 * zoom;
        const g = ctx.createLinearGradient(b.x, b.y, b.x - ux * L, b.y - uy * L);
        g.addColorStop(0, "rgba(255,120,60,.85)"); g.addColorStop(1, "rgba(255,190,90,0)");
        ctx.save(); ctx.strokeStyle = g; ctx.lineCap = "round"; ctx.lineWidth = 9 * zoom;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - ux * L, b.y - uy * L); ctx.stroke(); ctx.restore();
      }
      ctx.save(); ctx.translate(b.x, b.y); ctx.scale(zoom, zoom);
      // the stinger glows on the bee dashing now, or (while armed) on each bee free to take it
      if (b.st < 2 && (b.sting || (b.armed && (!o.ready || o.ready.has(b.id))))) {
        // the stinger glows while a sting is ready to go
        ctx.save(); ctx.rotate(ang);
        const p = .6 + .4 * Math.sin(t * 12);
        const g2 = ctx.createRadialGradient(-17, 0, 0, -17, 0, 9);
        g2.addColorStop(0, `rgba(255,80,40,${.9 * p})`); g2.addColorStop(1, "rgba(255,80,40,0)");
        ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(-17, 0, 9, 0, TAU); ctx.fill(); ctx.restore();
      }
      if (o.free && o.free.has(b.id)) {
        // with several bees: this one is free for your next tap
        ctx.save(); ctx.globalAlpha = .55 + .35 * Math.sin(t * 4); ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.stroke(); ctx.restore();
      }
      Art.bee(ctx, 0, 0, ang, PC[b.slot], t + b.slot, { you: mineIds.has(b.id), dizzy: b.st === 2, faint: b.st === 3, safe: b.safe, hp: b.hp });
      ctx.restore();
      if (o.names && b.name) upright(ctx, b.x, b.y, () => { ctx.font = "800 12px Nunito, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.scale(zoom, zoom); ctx.strokeText(b.name, 0, -24); ctx.fillStyle = "#1e4423"; ctx.fillText(b.name, 0, -24); });
    });
    // dragonflies and swooping birds above everything
    (S.p || []).forEach(p => {
      if (p[0] === "d") Art.dragonfly(ctx, p[1], p[2], p[3], t);
      if (p[0] === "b" && p[3] >= 1) { const k = (p[3] - 1) * 1.8 / 1.2; Art.bird(ctx, p[1] + k * 700 - 120, p[2] - k * 420 + 60, -.55, 1.4); }
    });
    // ambient butterflies
    if (o.ambient !== false) flies.forEach((f, i) => {
      f.a += (Math.sin(t * .5 + i) * .8) * dt; f.x += Math.cos(f.a) * f.s * dt; f.y += Math.sin(f.a) * f.s * dt;
      if (f.x < 40 || f.x > world.W - 40) f.a = Math.PI - f.a; if (f.y < 40 || f.y > world.H - 40) f.a = -f.a;
      f.x = Math.max(40, Math.min(world.W - 40, f.x)); f.y = Math.max(40, Math.min(world.H - 40, f.y));
      Art.butterfly(ctx, f.x, f.y, t + i, f.col);
    });
    floats.forEach(f => {
      f.life -= dt * .8; f.y -= dt * 34;
      upright(ctx, f.x, f.y, () => { ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.6)); ctx.scale(zoom, zoom); ctx.font = `800 ${f.big ? 20 : 15}px Nunito, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.strokeText(f.txt, 0, 0); ctx.fillStyle = f.col; ctx.fillText(f.txt, 0, 0); });
    });
    floats = floats.filter(f => f.life > 0);
    ctx.restore();
  }

  // what each bee controls and earns, from the flower owners
  function stats(owners) {
    const out = new Map();
    for (let sl = 0; sl < 8; sl++) {
      const ps = patches(owners || [], sl).map(p => p.length).sort((a, b) => b - a);
      out.set(sl, { flowers: ps.reduce((a, n) => a + n, 0), patches: ps, biggest: ps[0] || 0, rate: ps.reduce((a, n) => a + n * n, 0) });
    }
    return out;
  }

  return { setup, draw, fx: addFx, fit, stats, flowerAt, beeAt, toScreen, nearestFlowers, hitsTrap, get world() { return world; } };
})();


/* Network snapshots arrive 20 times a second; this smooths them out. */
const Smooth = (() => {
  let buf = [], gap = 50;
  // play this far behind the newest snapshot: 110 ms at 20 a second, more when they come slower (the relay sends 10)
  const delay = () => Math.max(110, Math.min(400, gap * 2.2));
  function push(m, world) {
    const bees = m.b.map(a => ({ id: a[0], x: a[1], y: a[2], ang: a[3], st: a[4], hp: a[5], score: a[6], prog: a[7], f: a[8], dir: a[9], rad: a[10], vx: a[11], vy: a[12], safe: a[13], v: a[14], target: a[15], sting: a[16], armed: a[17], stingCd: a[18], seat: a[19], total: a[20] }));
    const at = performance.now();
    if (buf.length) gap += (Math.min(500, at - buf[buf.length - 1].at) - gap) * .1;
    buf.push({ at, m, bees });
    if (buf.length > 12) buf.shift();
  }
  function reset() { buf = []; }
  function sample(world, info) {
    if (!buf.length) return null;
    const now = performance.now() - delay();
    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].at > now) i--;
    const b1 = buf[i], b0 = buf[Math.max(0, i - 1)];
    const span = b1.at - b0.at || 1, u = Math.max(0, Math.min(1, (now - b0.at) / span));
    const byId = new Map(b0.bees.map(b => [b.id, b]));
    const bees = b1.bees.map(b => {
      const a = byId.get(b.id), meta = info.get(b.id) || info.get("s" + b.seat) || {},   // a newly hatched bee: its hive's colour and name
      out = { ...b, slot: meta.slot, name: meta.name };
      if (!a) return out;
      if (a.st === 0 && b.st === 0 && a.f === b.f && world) {
        let da = b.ang - a.ang; if (da > Math.PI) da -= TAU; if (da < -Math.PI) da += TAU;
        const ang = a.ang + da * u, rad = a.rad + (b.rad - a.rad) * u, f = world.fl[b.f];
        out.ang = ang; out.x = f.x + Math.cos(ang) * rad; out.y = f.y + Math.sin(ang) * rad;
      } else { out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.vx = a.vx + (b.vx - a.vx) * u; out.vy = a.vy + (b.vy - a.vy) * u; }
      return out;
    });
    const p1 = b1.m.p || [], p0 = new Map((b0.m.p || []).map(p => [p[0] + (p[0] === "s" ? p[1] : p[4]), p]));
    const preds = p1.map(p => { const q = p0.get(p[0] + (p[0] === "s" ? p[1] : p[4])); if (!q || p[0] !== "d") return p; return [p[0], q[1] + (p[1] - q[1]) * u, q[2] + (p[2] - q[2]) * u, p[3], p[4]]; });
    return { b: bees, o: b1.m.o, p: preds, left: b1.m.left, ph: b1.m.ph };
  }
  return { push, sample, reset };
})();
