/* THE LAST GARDEN - world generation, in the browser.
 *
 * world.py translated for browser mode, where the host's tab runs the game.
 * Same three levels and the same steps: braided thicket, plazas, roads,
 * rivers and bridges, ponds, the sanctum, ferries, shrines, props, beds and
 * orchards, then everything the idol cannot reach is sealed off. The random
 * numbers come from a seeded generator, so a seed always grows the same
 * world here (though not the same one Python would grow from it).
 */
'use strict';

const WorldGen = (() => {
  const GROUND = 0, WALL = 1, WATER = 2, BRIDGE = 3, DOCK = 4, PROP = 5, SHRINE = 6, FLOWERS = 7;
  const WALKABLE = new Set([GROUND, BRIDGE, DOCK, FLOWERS]);
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const LEVELS = [
    { name: "The Forest", cells: 41, plazas: 16, rivers: 2, ponds: 5, props: 0.055, shrines: 8, docks: 5, thicket: 0.72, gardens: 7, orchards: 4 },
    { name: "The Ruins", cells: 29, plazas: 12, rivers: 2, ponds: 4, props: 0.062, shrines: 7, docks: 4, thicket: 0.66, gardens: 5, orchards: 3 },
    { name: "The Temple", cells: 21, plazas: 9, rivers: 1, ponds: 3, props: 0.070, shrines: 5, docks: 2, thicket: 0.60, gardens: 4, orchards: 2 },
  ];

  // a seeded stand-in for Python's random.Random
  function Rnd(seed) {
    let a = (seed >>> 0) || 1;
    const random = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const randrange = (lo, hi) => lo + Math.floor(random() * (hi - lo));
    return {
      random, randrange,
      randint: (lo, hi) => randrange(lo, hi + 1),
      choice: arr => arr[Math.floor(random() * arr.length)],
      shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
      sample: (arr, k) => { const c = arr.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, k); },
    };
  }

  class World {
    constructor(level, seed) {
      const spec = LEVELS[level];
      this.level = level; this.name = spec.name;
      const rnd = Rnd(seed);
      const n = this.cells = spec.cells;
      const w = this.w = this.h = n * 2 + 1;
      this.g = new Uint8Array(w * w).fill(WALL);
      this._carveThicket(rnd, n, spec.thicket);
      const centres = this._plazas(rnd, n, spec.plazas);
      this._roads(rnd, centres);
      this.riverPath = [];
      for (let i = 0; i < spec.rivers; i++) this._river(rnd);
      this._ponds(rnd, spec.ponds || 0, centres);
      this.goal = this._sanctum(rnd);
      this.docks = this._docks(rnd, spec.docks);
      this.shrines = this._landmarks(rnd, centres, spec.shrines);
      this._props(rnd, spec.props);
      this._gardens(rnd, spec.gardens || 0, centres);
      this._orchards(rnd, spec.orchards || 0, centres);
      this._ensureGoalConnected();
      this._sealUnreachable();
      this.dist = this._bfs(this.goal);
      this.maxd = Math.max(...this.dist) || 1;
      this.floors = []; for (let t = 0; t < w * w; t++) if (this.dist[t] >= 0) this.floors.push(t);
      const far = this.floors.filter(t => this.dist[t] >= this.maxd * 0.78);
      this.spawn = far.length ? far : this.floors;
      this.chests = this._chests(rnd);
      this.nPassersby = Math.max(6, Math.floor(this.floors.length / 150));
    }

    inside(x, y, m = 1) { return m <= x && x < this.w - m && m <= y && y < this.h - m; }
    walkable(t) { return WALKABLE.has(this.g[t]); }
    _bfs(src) {
      const w = this.w, g = this.g, N = w * w, dist = new Int32Array(N).fill(-1), q = new Int32Array(N);
      let head = 0, tail = 0; dist[src] = 0; q[tail++] = src;
      while (head < tail) {
        const p = q[head++], d = dist[p] + 1;
        for (const r of [p - 1, p + 1, p - w, p + w]) if (r >= 0 && r < N && WALKABLE.has(g[r]) && dist[r] < 0) { dist[r] = d; q[tail++] = r; }
      }
      return Array.from(dist);
    }
    _clear(x, y, r, kind = GROUND) {
      for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) if (this.inside(xx, yy)) this.g[yy * this.w + xx] = kind;
    }

    // 1. braided thicket: a growing-tree maze, then most dead ends opened
    _carveThicket(rnd, n, braid) {
      const w = this.w, g = this.g, seen = new Uint8Array(n * n), c0 = Math.floor(n / 2);
      seen[c0 * n + c0] = 1; g[(2 * c0 + 1) * w + 2 * c0 + 1] = GROUND;
      const active = [[c0, c0]];
      while (active.length) {
        const i = rnd.random() < 0.88 ? active.length - 1 : rnd.randrange(0, active.length);
        const [cx, cy] = active[i];
        const opts = DIRS.map(([dx, dy]) => [cx + dx, cy + dy, dx, dy]).filter(([x, y]) => x >= 0 && x < n && y >= 0 && y < n && !seen[y * n + x]);
        if (!opts.length) { active[i] = active[active.length - 1]; active.pop(); continue; }
        const [nx, ny, dx, dy] = rnd.choice(opts);
        seen[ny * n + nx] = 1;
        g[(2 * cy + 1 + dy) * w + 2 * cx + 1 + dx] = GROUND;
        g[(2 * ny + 1) * w + 2 * nx + 1] = GROUND;
        active.push([nx, ny]);
      }
      for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
        const t = (2 * cy + 1) * w + 2 * cx + 1;
        const outs = DIRS.map((d, k) => k).filter(k => g[t + DIRS[k][0] + DIRS[k][1] * w] === GROUND);
        if (outs.length === 1 && rnd.random() < braid) {
          const shut = DIRS.map((d, k) => k).filter(k => !outs.includes(k) && cx + DIRS[k][0] >= 0 && cx + DIRS[k][0] < n && cy + DIRS[k][1] >= 0 && cy + DIRS[k][1] < n);
          if (shut.length) { const [dx, dy] = DIRS[rnd.choice(shut)]; g[t + dx + dy * w] = GROUND; }
        }
      }
    }
    // 2. open plazas
    _plazas(rnd, n, count) {
      const centres = [], margin = 5; let tries = 0;
      while (centres.length < count && tries < count * 60) {
        tries++;
        const cx = rnd.randrange(margin, this.w - margin), cy = rnd.randrange(margin, this.h - margin);
        if (centres.some(([ox, oy]) => Math.abs(cx - ox) + Math.abs(cy - oy) < 12)) continue;
        this._clear(cx, cy, rnd.choice([3, 3, 4, 5]));
        centres.push([cx, cy]);
      }
      return centres;
    }
    // 3. wide roads
    _road(x1, y1, x2, y2, half = 1) {
      let x = x1, y = y1;
      let step = x2 > x ? 1 : -1; while (x !== x2) { this._clear(x, y, half); x += step; }
      step = y2 > y ? 1 : -1; while (y !== y2) { this._clear(x, y, half); y += step; }
      this._clear(x, y, half);
    }
    _roads(rnd, centres) {
      if (centres.length < 2) return;
      const unlinked = centres.slice(1), linked = [centres[0]];
      while (unlinked.length) {
        let best = null, bd = Infinity;
        for (const a of linked) for (const b of unlinked) { const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); if (d < bd) { bd = d; best = [a, b]; } }
        const [a, b] = best;
        this._road(a[0], a[1], b[0], b[1], 1);
        linked.push(b); unlinked.splice(unlinked.indexOf(b), 1);
      }
      for (let i = 0; i < Math.floor(centres.length / 2); i++) { const [a, b] = rnd.sample(centres, 2); this._road(a[0], a[1], b[0], b[1], rnd.choice([0, 1])); }
    }
    // 4. a river, then bridges so both banks connect
    _river(rnd) {
      const w = this.w, vertical = rnd.random() < 0.5, span = vertical ? this.h : this.w;
      let pos = rnd.randrange(Math.floor(span * 0.3), Math.floor(span * 0.7));
      const width = rnd.choice([1, 2]), path = [];
      for (let i = 2; i < span - 2; i++) {
        pos += rnd.choice([-1, 0, 0, 0, 1]);
        pos = Math.max(4, Math.min(span - 5, pos));
        for (let k = 0; k <= width; k++) { const [x, y] = vertical ? [pos + k, i] : [i, pos + k]; if (this.inside(x, y, 2)) this.g[y * w + x] = WATER; }
        path.push([pos, i]);
      }
      this.riverPath.push([vertical, width, path]);
      const steps = Math.max(3, Math.floor(path.length / 14));
      for (let idx = Math.floor(steps / 2); idx < path.length; idx += steps) {
        const [posI, i] = path[idx];
        for (let k = -2; k < width + 3; k++) {
          const [x, y] = vertical ? [posI + k, i] : [i, posI + k];
          if (!this.inside(x, y, 2)) continue;
          const t = y * w + x; this.g[t] = this.g[t] === WATER ? BRIDGE : GROUND;
        }
        for (const side of [-1, 1]) {
          const [x, y] = vertical ? [posI + Math.floor(width / 2), i + side] : [i + side, posI + Math.floor(width / 2)];
          if (this.inside(x, y, 2) && this.g[y * w + x] === WALL) this.g[y * w + x] = GROUND;
        }
      }
    }
    _ponds(rnd, count, centres) {
      const w = this.w;
      if (this.w < 18) return;
      for (let c = 0; c < count; c++) for (let attempt = 0; attempt < 40; attempt++) {
        const cx = rnd.randrange(6, this.w - 6), cy = rnd.randrange(6, this.h - 6);
        if (centres.some(([px, py]) => Math.abs(cx - px) + Math.abs(cy - py) < 7)) continue;
        const rx = rnd.randint(2, 4), ry = rnd.randint(2, 3);
        let ok = true;
        for (let yy = cy - ry - 1; yy < cy + ry + 2; yy++) for (let xx = cx - rx - 1; xx < cx + rx + 2; xx++) if (!this.inside(xx, yy, 3)) ok = false;
        if (!ok) continue;
        for (let yy = cy - ry; yy <= cy + ry; yy++) for (let xx = cx - rx; xx <= cx + rx; xx++) if (((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1) this.g[yy * w + xx] = WATER;
        for (let xx = cx - rx - 1; xx < cx + rx + 2; xx++) { const t = cy * w + xx; if (this.inside(xx, cy, 2)) this.g[t] = this.g[t] === WATER ? BRIDGE : this.g[t]; }
        break;
      }
    }
    // 5. the inner sanctum
    _sanctum() {
      const c = Math.floor(this.w / 2), cx = c % 2 ? c : c + 1, goal = cx * this.w + cx;
      this._clear(cx, cx, 4);
      for (let d = -4; d <= 4; d++) for (const [x, y] of [[cx + d, cx - 4], [cx + d, cx + 4], [cx - 4, cx + d], [cx + 4, cx + d]])
        if ((Math.abs(d) === 2 || Math.abs(d) === 3) && this.inside(x, y)) this.g[y * this.w + x] = PROP;
      return goal;
    }
    // 6. ferries
    _docks(rnd, pairs) {
      if (!pairs) return [];
      const w = this.w, N = w * w, banks = [];
      for (let t = 0; t < N; t++) { if (this.g[t] !== GROUND) continue; if ([-1, 1, -w, w].some(o => t + o >= 0 && t + o < N && this.g[t + o] === WATER)) banks.push(t); }
      rnd.shuffle(banks);
      const docks = [], used = [];
      for (const a of banks) {
        if (docks.length >= pairs) break;
        const ax = a % w, ay = Math.floor(a / w);
        if (used.some(([ux, uy]) => Math.abs(ax - ux) + Math.abs(ay - uy) < 8)) continue;
        const far = banks.filter(b => Math.abs(b % w - ax) + Math.abs(Math.floor(b / w) - ay) > w * 0.55 && used.every(([ux, uy]) => Math.abs(b % w - ux) + Math.abs(Math.floor(b / w) - uy) >= 8));
        if (!far.length) continue;
        const b = rnd.choice(far);
        this.g[a] = DOCK; this.g[b] = DOCK;
        docks.push([a, b]); used.push([ax, ay]); used.push([b % w, Math.floor(b / w)]);
      }
      return docks;
    }
    // 7. landmarks
    _landmarks(rnd, centres, count) {
      const out = [];
      for (const [cx, cy] of rnd.sample(centres, Math.min(count, centres.length))) {
        const t = cy * this.w + cx;
        if (t === this.goal || Math.abs(cx - this.goal % this.w) + Math.abs(cy - Math.floor(this.goal / this.w)) < 8) continue;
        this.g[t] = SHRINE; out.push(t);
      }
      return out;
    }
    // 8. props, only where they cannot wall anyone in
    _props(rnd, density) {
      const w = this.w, g = this.g;
      for (let t = 0; t < w * w; t++) {
        if (g[t] !== GROUND || t === this.goal || rnd.random() > density) continue;
        const x = t % w, y = Math.floor(t / w);
        if (!this.inside(x, y, 3)) continue;
        const open = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1].filter(o => WALKABLE.has(g[t + o])).length;
        if (open >= 6) g[t] = PROP;
      }
    }
    // 8b. formal beds
    _gardens(rnd, count, centres) {
      const w = this.w, set = (xx, yy) => { if (this.inside(xx, yy, 2) && this.g[yy * w + xx] === GROUND) this.g[yy * w + xx] = FLOWERS; };
      for (let c = 0; c < count; c++) {
        if (!centres.length) return;
        const [cx, cy] = rnd.choice(centres), shape = rnd.random();
        if (shape < 0.45) {
          const r = rnd.choice([2, 3]);
          for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) { const d2 = (xx - cx) ** 2 + (yy - cy) ** 2; if (r * r - 2 <= d2 && d2 <= r * r + r) set(xx, yy); }
        } else if (shape < 0.75) {
          for (const dy of [-2, -1, 1, 2]) for (const dx of [-2, -1, 1, 2]) set(cx + dx, cy + dy);
        } else {
          const horiz = rnd.random() < 0.5, length = rnd.randint(4, 9), off = rnd.choice([-2, 2]);
          for (let i = Math.floor(-length / 2); i <= Math.floor(length / 2); i++) { const [xx, yy] = horiz ? [cx + i, cy + off] : [cx + off, cy + i]; set(xx, yy); }
        }
      }
    }
    _orchards(rnd, count) {
      const w = this.w;
      if (this.w < 24) return;
      for (let c = 0; c < count; c++) for (let attempt = 0; attempt < 40; attempt++) {
        const cx = rnd.randrange(8, this.w - 8), cy = rnd.randrange(8, this.h - 8), rows = rnd.randint(2, 3), cols = rnd.randint(2, 4);
        let clear = true;
        for (let yy = cy - 1; yy < cy + (rows - 1) * 3 + 2 && clear; yy++) for (let xx = cx - 1; xx < cx + (cols - 1) * 3 + 2; xx++) if (!this.inside(xx, yy, 3) || this.g[yy * w + xx] !== GROUND) { clear = false; break; }
        const spots = []; if (clear) for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) spots.push((cy + r * 3) * w + cx + k * 3);
        if (clear && spots.length >= 4) { spots.forEach(t => this.g[t] = PROP); break; }
      }
    }
    // 8c. join the idol to the world
    _components() {
      const w = this.w, N = w * this.h, g = this.g, seen = new Uint8Array(N), out = [];
      for (let s = 0; s < N; s++) {
        if (!WALKABLE.has(g[s]) || seen[s]) continue;
        const comp = [], st = [s]; seen[s] = 1;
        while (st.length) { const p = st.pop(); comp.push(p); for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < N && WALKABLE.has(g[q]) && !seen[q]) { seen[q] = 1; st.push(q); } }
        out.push(comp);
      }
      return out.sort((a, b) => b.length - a.length);
    }
    _ensureGoalConnected() {
      const w = this.w;
      for (let k = 0; k < 8; k++) {
        const comps = this._components(); if (!comps.length) return;
        const home = comps.find(c => c.includes(this.goal)); if (!home) return;
        if (home.length >= comps[0].length) return;
        const main = comps[0];
        let best = null;
        for (const a of home) { const ax = a % w, ay = Math.floor(a / w); for (const b of main) { const bx = b % w, by = Math.floor(b / w), d = Math.abs(ax - bx) + Math.abs(ay - by); if (!best || d < best[0]) best = [d, ax, ay, bx, by]; } }
        if (!best) return;
        let [, x, y, bx, by] = best;
        while (x !== bx || y !== by) {
          if (x !== bx) x += bx > x ? 1 : -1; else if (y !== by) y += by > y ? 1 : -1;
          const t = y * w + x;
          if (this.g[t] === WATER) this.g[t] = BRIDGE; else if (!WALKABLE.has(this.g[t])) this.g[t] = GROUND;
        }
      }
    }
    // 9. seal the strays
    _sealUnreachable() {
      const reach = this._bfs(this.goal);
      for (let t = 0; t < this.w * this.h; t++) if (WALKABLE.has(this.g[t]) && reach[t] < 0) this.g[t] = WALL;
      this.docks = this.docks.filter(([a, b]) => reach[a] >= 0 && reach[b] >= 0);
    }
    // 10. chests
    _chests(rnd) {
      const spots = rnd.shuffle(this.floors.filter(t => (this.g[t] === GROUND || this.g[t] === FLOWERS) && this.dist[t] > 5));
      const want = Math.max(8, Math.floor(this.floors.length / 46)), used = new Set(), chests = [];
      for (const t of spots) {
        if (chests.length >= want) break;
        if (used.has(t)) continue;
        chests.push({ id: chests.length, t, v: rnd.randint(5, 20) });
        const x = t % this.w, y = Math.floor(t / this.w);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) used.add((y + dy) * this.w + x + dx);
      }
      return chests;
    }
    progress(t) { const d = this.dist[t]; return d < 0 ? 0 : Math.max(0, Math.min(1, 1 - d / this.maxd)); }
    asString() { let s = ""; for (let i = 0; i < this.g.length; i++) s += String.fromCharCode(48 + this.g[i]); return s; }
  }

  return { World, LEVELS, GROUND, WALL, WATER, BRIDGE, DOCK, PROP, SHRINE, FLOWERS, WALKABLE, DIRS };
})();
