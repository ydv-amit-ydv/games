/* BUMBLEBLOOM - the game itself, running in the host's browser.
 *
 * This is server.py's simulation translated line for line, for when there is
 * no Python server (GitHub Pages, or just opening the files). One browser -
 * whoever made the garden - runs it, and every player talks to it with the
 * very same messages they would send the Python server. Keep the two in step:
 * a rule changed in one belongs in the other.
 *
 * const g = new BloomSim.Host(code)   // the room
 * g.connect(link)                      // link = { send(obj) }; returns { message(obj), close() }
 */
'use strict';

const BloomSim = (() => {
  const TICK = 1 / 60, SEND_EVERY = 3;
  const ROUND_SECONDS = 120, RESULTS_SECONDS = 15, COUNTDOWN = 3, MAX_BEES = 8, RESUME_GRACE = 120;
  const NAMES = ["Red", "Blue", "Gold", "Violet", "Orange", "Pink", "Teal", "Brown"];
  const OMEGA0 = 2.0, FLY_V = 320, ORBIT_GAP = 26, BEE_R = 9;
  const HP_MAX = 100, HEAL_PER_S = 7, FAINT_SECONDS = 3, FAINT_HONEY_LOSS = .15, SAFE_SECONDS = 1.5, DIZZY_SECONDS = 1.6;
  const BUMP_DMG = 10, TRAP_DMG = 35, DRAGON_DMG = 25, BIRD_DMG = 45, WEB_DPS = 18, TRAP_R = 24;
  // sting dash and fortified patches (see server.py)
  const STING_DMG = 35, STING_CD = 8, STING_SPEED = 1.45, STING_REACH = BEE_R * 2.6, STING_DIZZY = 1, BOUNTY_WINDOW = 4;
  const FORTIFY_SIZE = 4, FORTIFY_LOOPS = 3;
  const PRED_FIRST = 12, PRED_GAP = [7, 13], DRAGON_SPEED = 380, BIRD_WARN = 1.8, BIRD_R = 75, WEB_SECONDS = 10;
  const SIZES = [[2, 1240, 780, 10], [4, 1440, 880, 14], [6, 1640, 980, 18], [8, 1840, 1080, 22]];
  const TAU = Math.PI * 2;

  const rand = Math.random, uniform = (a, b) => a + rand() * (b - a), choice = a => a[Math.floor(rand() * a.length)];
  const hyp = Math.hypot, r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
  function seeded(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function segDist(ax, ay, bx, by, px, py) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)); return hyp(ax + u * dx - px, ay + u * dy - py); }
  const clean = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 14).trim();
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");

  // ---------------------------------------------------------------- world
  function makeWorld(nBees, seed) {
    const R = seeded(seed), [, W, H, count] = SIZES.find(s => nBees <= s[0]);
    const cx = W / 2, cy = H / 2, flowers = [];
    let dmin = Math.sqrt(W * H / count) * .66, fails = 0;
    while (flowers.length < count) {
      const x = 120 + R() * (W - 240), y = 120 + R() * (H - 240);
      if (hyp(x - cx, y - cy) > 170 && flowers.every(f => hyp(x - f.x, y - f.y) > dmin)) {
        const r = [14, 15, 16, 17, 18, 20, 21][Math.floor(R() * 7)];
        flowers.push({ x: r1(x), y: r1(y), r, R: r + ORBIT_GAP, owner: null, flash: 0, web: 0 }); fails = 0;
      } else if (++fails > 400) { dmin *= .96; fails = 0; }
    }
    const nn = flowers.map(a => Math.min(...flowers.filter(b => b !== a).map(b => hyp(a.x - b.x, a.y - b.y)))).sort((a, b) => a - b);
    return { W, H, seed, trap: [cx, cy], flowers, link: r1(nn[Math.floor(nn.length / 2)] * 1.45) };
  }
  function spreadStarts(wd, n) {
    const fl = wd.flowers, [cx, cy] = wd.trap;
    let first = 0; fl.forEach((f, i) => { if (hyp(f.x - cx, f.y - cy) > hyp(fl[first].x - cx, fl[first].y - cy)) first = i; });
    const picks = [first];
    while (picks.length < n) {
      let best = -1, bd = -1;
      fl.forEach((f, i) => { if (picks.includes(i)) return; const d = Math.min(...picks.map(j => hyp(f.x - fl[j].x, f.y - fl[j].y))); if (d > bd) { bd = d; best = i; } });
      picks.push(best);
    }
    return picks;
  }

  // ---------------------------------------------------------------- the room
  class Host {
    constructor(code) {
      this.code = code; this.bees = new Map(); this.watchers = new Set(); this.host = null; this.phase = "lobby";
      this.world = null; this.preds = []; this.fxq = []; this.toast = null; this.tEnd = 0; this.tPhase = 0; this.nextPred = 0;
      this.predId = 0; this.tickN = 0; this.fort = new Set(); this.solo = false; this.botsWanted = 0; this.lastRank = []; this.nextId = 1;
      let last = performance.now() / 1000, acc = 0;
      this.timer = setInterval(() => {
        const now = performance.now() / 1000; acc += Math.min(.25, now - last); last = now;
        while (acc >= TICK) { acc -= TICK; this.tick(now); }
        this.sweep(now);
      }, 8);
    }
    stop() { clearInterval(this.timer); }
    now() { return performance.now() / 1000; }

    newBee(name, bot = false) {
      const b = { id: this.nextId++, name: clean(name), link: null, bot, gone: null, key: newKey(), slot: 0 };
      this.reset(b); return b;
    }
    reset(b) {
      Object.assign(b, { state: "orbit", f: 0, ang: 0, rad: 40, dir: 1, v: OMEGA0, prog: 0, x: 0, y: 0, vx: 0, vy: 0,
        timer: 0, hp: HP_MAX, safe: 0, score: 0, hitCd: 0, target: null, wait: 1, flyT: 0, faints: 0, blooms: 0,
        sting: false, stingArmed: false, stingCd: 0, lastHit: null, knocks: 0 });
    }
    freeSlot() { const used = new Set([...this.bees.values()].map(b => b.slot)); for (let i = 0; i < MAX_BEES; i++) if (!used.has(i)) return i; }
    label(b) { return b.name || NAMES[b.slot] + " bee"; }
    send(b, o) { if (b.link) b.link.send(o); }
    broadcast(o) { this.bees.forEach(b => this.send(b, o)); this.watchers.forEach(w => w.send(o)); }
    sorted() { return [...this.bees.values()].sort((a, b) => a.slot - b.slot); }

    lobbyMsg() {
      return { t: "lobby", code: this.code, host: this.host, solo: this.solo, bots: this.botsWanted, phase: this.phase,
        bees: this.sorted().map(b => ({ id: b.id, slot: b.slot, name: this.label(b), bot: b.bot, away: b.gone != null })) };
    }
    worldMsg() {
      const wd = this.world;
      return { W: wd.W, H: wd.H, seed: wd.seed, link: wd.link, trap: wd.trap, flowers: wd.flowers.map(f => [f.x, f.y, f.r]),
        bees: this.sorted().map(b => ({ id: b.id, slot: b.slot, name: this.label(b), bot: b.bot })),
        cfg: { hp: HP_MAX, secs: ROUND_SECONDS, flyV: FLY_V, trapR: TRAP_R + BEE_R, stingCd: STING_CD, fortSize: FORTIFY_SIZE, fortLoops: FORTIFY_LOOPS } };
    }
    stateMsg(now) {
      const st = { orbit: 0, fly: 1, dizzy: 2, faint: 3 };
      const msg = { t: "s", left: this.phase === "play" ? r1(Math.max(0, this.tEnd - now)) : ROUND_SECONDS, ph: this.phase,
        b: [...this.bees.values()].map(b => [b.id, r1(b.x), r1(b.y), r3(b.ang), st[b.state], Math.round(b.hp), Math.floor(b.score), r2(b.prog), b.f, b.dir, r1(b.rad), r1(b.vx), r1(b.vy), b.safe > 0 ? 1 : 0, r2(b.v), b.target == null || b.state !== "fly" ? -1 : b.target, b.sting ? 1 : 0, b.stingArmed ? 1 : 0, r1(b.stingCd)]),
        o: this.world.flowers.map(f => f.owner),
        p: this.preds.map(p => p.k === "dragon" ? ["d", Math.round(p.x), Math.round(p.y), r2(Math.atan2(p.vy, p.vx)), p.id]
          : p.k === "bird" ? ["b", Math.round(p.x), Math.round(p.y), r2(p.age / BIRD_WARN), p.id] : ["s", p.f, 0, r2(p.age), r2(p.life)]) };
      if (this.fxq.length) { msg.fx = this.fxq; this.fxq = []; }
      if (this.toast) { msg.toast = this.toast; this.toast = null; }
      return msg;
    }
    fx(kind, x, y, slot = -1) { this.fxq.push([kind, Math.round(x), Math.round(y), slot]); }

    // ---- phases
    startCountdown() {
      this.phase = "countdown"; this.tPhase = this.now() + COUNTDOWN;
      const humans = [...this.bees.values()].filter(b => !b.bot);
      [...this.bees.values()].filter(b => b.bot).forEach(b => this.bees.delete(b.id));
      let want = Math.max(0, Math.min(MAX_BEES - humans.length, this.botsWanted));
      if (humans.length === 1 && want === 0) want = 3;
      for (let i = 0; i < want; i++) { const bot = this.newBee("", true); bot.slot = this.freeSlot(); this.bees.set(bot.id, bot); }
      this.world = makeWorld(this.bees.size, Math.floor(rand() * 2 ** 30));
      const starts = spreadStarts(this.world, this.bees.size);
      this.sorted().forEach((b, i) => {
        this.reset(b); const f = this.world.flowers[starts[i]];
        f.owner = b.slot; b.f = starts[i]; b.rad = f.R; b.ang = uniform(0, TAU); b.dir = b.slot % 2 === 0 ? 1 : -1; this.place(b, f);
      });
      this.preds = []; this.fxq = [];
      this.broadcast(this.lobbyMsg());
      this.broadcast({ t: "go", in: COUNTDOWN, ...this.worldMsg() });
    }
    startPlay(now) { this.phase = "play"; this.tEnd = now + ROUND_SECONDS; this.nextPred = now + PRED_FIRST; }
    endRound(now) {
      this.phase = "results"; this.tPhase = now + RESULTS_SECONDS;
      this.lastRank = [...this.bees.values()].sort((a, b) => b.score - a.score).map(b => {
        const ps = this.patches(b.slot);
        return { slot: b.slot, name: this.label(b), honey: Math.floor(b.score), bot: b.bot, blooms: b.blooms, faints: b.faints, knocks: b.knocks,
          flowers: this.world.flowers.filter(f => f.owner === b.slot).length, patch: Math.max(0, ...ps.map(p => p.length)), rate: ps.reduce((a, p) => a + p.length ** 2, 0) };
      });
      this.broadcast({ t: "end", rank: this.lastRank });
    }
    backToLobby() {
      this.phase = "lobby";
      [...this.bees.values()].filter(b => b.bot || b.gone != null).forEach(b => this.bees.delete(b.id));
      if (!this.bees.has(this.host) && this.bees.size) this.host = this.bees.keys().next().value;
      this.broadcast(this.lobbyMsg());
    }

    // ---- simulation
    place(b, f) { b.x = f.x + Math.cos(b.ang) * b.rad; b.y = f.y + Math.sin(b.ang) * b.rad; }
    hurt(b, dmg, why, by = null) {
      if (b.safe > 0 || b.state === "faint") return;
      if (by && by !== b) b.lastHit = [by, this.now()];
      b.hp -= dmg;
      if (b.hitCd <= 0) { b.hitCd = .35; this.fx("hit", b.x, b.y, b.slot); }
      if (b.hp <= 0) this.faint(b, why);
    }
    faint(b, why) {
      b.state = "faint"; b.timer = FAINT_SECONDS; b.hp = 0; b.sting = b.stingArmed = false;
      const lost = Math.floor(b.score * FAINT_HONEY_LOSS); b.score -= lost; b.faints++;
      this.fx("faint", b.x, b.y, b.slot);
      const [hitter, at] = b.lastHit || [null, 0]; b.lastHit = null;
      if (hitter && this.bees.has(hitter.id) && this.now() - at <= BOUNTY_WINDOW) {
        hitter.score += lost; hitter.knocks++;              // the bounty
        this.toast = `${this.label(hitter)} knocked out ${this.label(b)} and took ${lost} honey!`;
      } else this.toast = `${this.label(b)} fainted (${why}) and dropped ${lost} honey`;
    }
    respawn(b) {
      const fl = this.world.flowers, idx = (pred) => fl.map((f, i) => pred(f) ? i : -1).filter(i => i >= 0);
      const own = idx(f => f.owner === b.slot && f.web <= 0), pool = own.length ? own : idx(f => f.owner == null && f.web <= 0);
      const fi = choice(pool.length ? pool : fl.map((_, i) => i)), f = fl[fi];
      Object.assign(b, { state: "orbit", f: fi, ang: uniform(0, TAU), rad: f.R, v: OMEGA0, prog: 0, hp: HP_MAX, safe: SAFE_SECONDS, target: null, wait: .6, sting: false });
      this.place(b, f);
    }
    patches(slot) {
      const wd = this.world, mine = wd.flowers.filter(f => f.owner === slot), seen = new Set(), out = [];
      for (const f of mine) {
        if (seen.has(f)) continue; const comp = [], st = [f]; seen.add(f);
        while (st.length) { const c = st.pop(); comp.push(c); for (const q of mine) if (!seen.has(q) && hyp(c.x - q.x, c.y - q.y) <= wd.link) { seen.add(q); st.push(q); } }
        out.push(comp);
      }
      return out;
    }
    launch(b, fi) {
      if (!(b.state === "orbit" || b.state === "fly") || (b.state === "orbit" && fi === b.f)) return;
      b.state = "fly"; b.target = fi; b.prog = 0; b.flyT = 0;
      if (b.stingArmed) this.startSting(b);
    }
    startSting(b) { b.sting = true; b.stingArmed = false; b.stingCd = STING_CD; }
    armSting(b) {
      if (b.stingCd > 0 || b.sting || !(b.state === "orbit" || b.state === "fly")) return;
      if (b.state === "fly") this.startSting(b); else b.stingArmed = true;
    }
    fortified() {
      const out = new Set(), fl = this.world.flowers;
      new Set(fl.map(f => f.owner).filter(o => o != null)).forEach(sl => this.patches(sl).forEach(p => { if (p.length >= FORTIFY_SIZE) p.forEach(f => out.add(fl.indexOf(f))); }));
      return out;
    }
    botThink(b, dt) {
      const wd = this.world, fl = wd.flowers;
      if (b.state !== "orbit") return;
      const f = fl[b.f];
      if (f.owner !== b.slot && f.web <= 0) return;
      if (f.owner === b.slot && b.hp < 45) b.wait = Math.max(b.wait, .5);
      if (f.web > 0) b.wait = 0;
      b.wait -= dt;
      if (b.wait > 0) return;
      const birds = this.preds.filter(p => p.k === "bird"), [cx, cy] = wd.trap;
      let best = null, bs = 1e9;
      fl.forEach((t, i) => {
        if (i === b.f || t.owner === b.slot || t.web > 0) return;
        if (segDist(b.x, b.y, t.x, t.y, cx, cy) < TRAP_R + BEE_R + 30) return;
        if (birds.some(p => hyp(t.x - p.x, t.y - p.y) < BIRD_R + 40)) return;
        const sc = hyp(t.x - f.x, t.y - f.y) + (t.owner != null ? 120 : 0) + rand() * 90 + (this.fort.has(i) ? 220 : 0);
        if (sc < bs) { bs = sc; best = i; }
      });
      if (best != null) {
        const t = fl[best];
        if (b.stingCd <= 0 && [...this.bees.values()].some(o => o.slot !== b.slot && (o.state === "orbit" || o.state === "fly") && segDist(b.x, b.y, t.x, t.y, o.x, o.y) < 40)) b.stingArmed = true;
        this.launch(b, best);
      } else b.wait = .5;
    }
    step(dt, now) {
      const wd = this.world, fl = wd.flowers, [cx, cy] = wd.trap;
      fl.forEach(f => { f.flash = Math.max(0, f.flash - dt); f.web = Math.max(0, f.web - dt); });
      this.fort = this.fortified();
      for (const b of this.bees.values()) {
        if (b.bot || b.gone != null) this.botThink(b, dt);
        b.safe = Math.max(0, b.safe - dt); b.hitCd = Math.max(0, b.hitCd - dt); b.stingCd = Math.max(0, b.stingCd - dt);
        if (b.state === "dizzy" || b.state === "faint") { b.timer -= dt; if (b.timer <= 0) this.respawn(b); continue; }
        if (b.state === "orbit") {
          const f = fl[b.f];
          b.rad += (f.R - b.rad) * Math.min(1, 6 * dt);
          const w = b.v;
          b.ang = ((b.ang + b.dir * w * dt) % TAU + TAU) % TAU;
          this.place(b, f);
          if (f.web > 0) { this.hurt(b, WEB_DPS * dt, "caught in a web"); if (b.state === "faint") continue; }
          else if (f.owner === b.slot) b.hp = Math.min(HP_MAX, b.hp + HEAL_PER_S * dt);
          else {
            b.prog += w * dt;
            if (b.prog >= (f.owner == null ? 1 : this.fort.has(b.f) ? FORTIFY_LOOPS : 2) * TAU) { f.owner = b.slot; f.flash = 1; b.prog = 0; b.blooms++; b.wait = .3 + rand() * .8; this.fx("bloom", f.x, f.y, b.slot); }
          }
        } else if (b.state === "fly") {
          const t = fl[b.target], dx = t.x - b.x, dy = t.y - b.y, d = hyp(dx, dy) || 1;
          const spd = FLY_V * (b.sting ? STING_SPEED : 1);
          b.vx = dx / d * spd; b.vy = dy / d * spd;
          if (d - spd * dt <= t.R) {
            b.x = t.x - dx / d * t.R; b.y = t.y - dy / d * t.R;
            const rx = b.x - t.x, ry = b.y - t.y;
            const dashing = b.sting;
            Object.assign(b, { state: "orbit", f: b.target, ang: (Math.atan2(ry, rx) + TAU) % TAU, rad: t.R, dir: rx * b.vy - ry * b.vx >= 0 ? 1 : -1, v: OMEGA0, prog: 0, target: null, wait: .4 + rand() * .6 });
            if (dashing) {
              // a dash at a flower strikes a rival circling it, wherever they are on the ring
              const occ = [...this.bees.values()].filter(v => v !== b && v.slot !== b.slot && v.f === b.f && (v.state === "orbit" || v.state === "dizzy") && v.safe <= 0);
              if (occ.length) this.stingHit(b, occ.reduce((m, v) => hyp(v.x - b.x, v.y - b.y) < hyp(m.x - b.x, m.y - b.y) ? v : m));
            }
            b.sting = false;
            this.fx("land", b.x, b.y, b.slot);
          } else { b.x += b.vx * dt; b.y += b.vy * dt; }
          if (hyp(b.x - cx, b.y - cy) < TRAP_R + BEE_R) {
            this.fx("snap", cx, cy, b.slot);
            b.x = cx - dx / d * (TRAP_R + BEE_R + 6); b.y = cy - dy / d * (TRAP_R + BEE_R + 6);
            b.state = "dizzy"; b.timer = DIZZY_SECONDS; b.target = null; b.sting = false;
            this.hurt(b, TRAP_DMG, "bitten by the flytrap");
          }
        }
      }
      // stings: a dashing bee hits the first rival it reaches
      for (const a of this.bees.values()) {
        if (!(a.sting && a.state === "fly")) continue;
        for (const v of this.bees.values()) {
          if (v === a || v.slot === a.slot || !["orbit", "fly", "dizzy"].includes(v.state) || v.safe > 0) continue;
          if (hyp(a.x - v.x, a.y - v.y) < STING_REACH) { this.stingHit(a, v); break; }
        }
      }
      const live = [...this.bees.values()].filter(b => b.state === "orbit" || b.state === "fly");
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], c = live[j];
        if (hyp(a.x - c.x, a.y - c.y) > BEE_R * 2) continue;
        if (a.state === "fly" && c.state === "orbit") this.bump(a, c);
        else if (c.state === "fly" && a.state === "orbit") this.bump(c, a);
      }
      this.stepPredators(dt, now);
      this.bees.forEach(b => { b.score += this.patches(b.slot).reduce((s, p) => s + p.length ** 2, 0) * dt; });
    }
    stingHit(a, v) {
      a.sting = false;
      this.fx("sting", v.x, v.y, a.slot);
      this.hurt(v, STING_DMG, `stung by ${this.label(a)}`, a);
      if (v.state !== "faint") { v.state = "dizzy"; v.timer = STING_DIZZY; v.target = null; v.sting = false; }
    }
    bump(flier, victim) {
      if (victim.safe > 0) return;
      victim.state = "dizzy"; victim.timer = DIZZY_SECONDS; victim.sting = false;
      this.fx("bump", victim.x, victim.y, victim.slot);
      this.hurt(victim, BUMP_DMG, `bumped by ${this.label(flier)}`, flier);
    }
    stepPredators(dt, now) {
      const wd = this.world, fl = wd.flowers, W = wd.W, H = wd.H;
      if (now >= this.nextPred) { this.nextPred = now + uniform(...PRED_GAP); this.spawnPredator(); }
      const keep = [];
      for (const p of this.preds) {
        p.age += dt;
        if (p.k === "dragon") {
          p.wob += dt;
          const nx = -p.vy, ny = p.vx, n = hyp(nx, ny) || 1, wob = Math.cos(p.wob * 9) * 60;
          p.x += p.vx * dt + nx / n * wob * dt; p.y += p.vy * dt + ny / n * wob * dt;
          this.bees.forEach(b => { if (p.hit.has(b.id) || !(b.state === "orbit" || b.state === "fly")) return; if (hyp(b.x - p.x, b.y - p.y) < 26) { p.hit.add(b.id); this.hurt(b, DRAGON_DMG, "stung by a dragonfly"); } });
          if (p.x > -160 && p.x < W + 160 && p.y > -160 && p.y < H + 160) keep.push(p);
        } else if (p.k === "bird") {
          if (!p.struck && p.age >= BIRD_WARN) {
            p.struck = true; this.fx("swoop", p.x, p.y);
            this.bees.forEach(b => { if (["orbit", "fly", "dizzy"].includes(b.state) && hyp(b.x - p.x, b.y - p.y) < BIRD_R) this.hurt(b, BIRD_DMG, "caught by a bird"); });
          }
          if (p.age < BIRD_WARN + 1.2) keep.push(p);
        } else if (p.k === "spider") {
          p.life -= dt;
          if (p.life > 0) { fl[p.f].web = Math.max(fl[p.f].web, Math.min(p.life, WEB_SECONDS)); keep.push(p); }
        }
      }
      this.preds = keep;
    }
    spawnPredator() {
      const wd = this.world, fl = wd.flowers, W = wd.W, H = wd.H, id = ++this.predId;
      let kind = choice(["dragon", "bird", "spider"]);
      const live = [...this.bees.values()].filter(b => b.state === "orbit" || b.state === "fly");
      if (kind === "spider") {
        let ch = fl.map((f, i) => f.owner != null && f.web <= 0 ? i : -1).filter(i => i >= 0);
        if (!ch.length) ch = fl.map((f, i) => f.web <= 0 ? i : -1).filter(i => i >= 0);
        if (!ch.length) kind = "dragon";
        else { const fi = choice(ch); this.preds.push({ k: "spider", id, f: fi, age: 0, life: WEB_SECONDS }); fl[fi].web = WEB_SECONDS; this.toast = "A spider is spinning a web on a flower!"; return; }
      }
      if (kind === "bird" && live.length) {
        const b = choice(live);
        this.preds.push({ k: "bird", id, x: b.x + uniform(-30, 30), y: b.y + uniform(-30, 30), age: 0, struck: false });
        this.toast = "A bird's shadow! Fly out of it!"; return;
      }
      const side = Math.floor(rand() * 4);
      const [x, y] = side === 0 ? [-120, uniform(80, H - 80)] : side === 1 ? [W + 120, uniform(80, H - 80)] : side === 2 ? [uniform(80, W - 80), -120] : [uniform(80, W - 80), H + 120];
      const t = choice(fl), dx = t.x - x, dy = t.y - y, d = hyp(dx, dy) || 1;
      this.preds.push({ k: "dragon", id, x, y, vx: dx / d * DRAGON_SPEED, vy: dy / d * DRAGON_SPEED, age: 0, wob: 0, hit: new Set() });
      this.toast = "A dragonfly is darting across the garden!";
    }

    tick(now) {
      if (this.phase === "countdown") {
        if (now >= this.tPhase) this.startPlay(now);
        else { if (++this.tickN % SEND_EVERY === 0) this.broadcast(this.stateMsg(now)); return; }
      }
      if (this.phase === "play") {
        this.step(TICK, now);
        if (++this.tickN % SEND_EVERY === 0) this.broadcast(this.stateMsg(now));
        if (now >= this.tEnd) this.endRound(now);
      } else if (this.phase === "results" && now >= this.tPhase) this.backToLobby();
    }
    sweep(now) {
      [...this.bees.values()].filter(b => b.gone != null && now - b.gone > RESUME_GRACE).forEach(b => { this.bees.delete(b.id); if (this.phase === "lobby") this.broadcast(this.lobbyMsg()); });
    }

    // ---- joining (same messages as server.py)
    join(b) {
      if (this.phase !== "lobby") { this.send(b, { t: "err", msg: "That garden is mid-round. Wait for the round to end and try again." }); return false; }
      if ([...this.bees.values()].filter(x => !x.bot).length >= MAX_BEES) { this.send(b, { t: "err", msg: "That garden is full (8 bees)." }); return false; }
      b.slot = this.freeSlot(); this.bees.set(b.id, b);
      if (this.host == null) this.host = b.id;
      this.send(b, { t: "hi", id: b.id, code: this.code, key: b.key, slot: b.slot });
      this.broadcast(this.lobbyMsg());
      return true;
    }
    resume(link, key) {
      for (const b of this.bees.values()) if (!b.bot && b.key === key) {
        b.link = link; b.gone = null;
        this.send(b, { t: "hi", id: b.id, code: this.code, key: b.key, slot: b.slot });
        this.send(b, this.lobbyMsg());
        if (this.phase === "countdown" || this.phase === "play") this.send(b, { t: "go", in: 0, ...this.worldMsg() });
        else if (this.phase === "results") this.send(b, { t: "end", rank: this.lastRank });
        return b;
      }
      return null;
    }
    drop(b, link) {
      if (b.link !== link) return;
      b.link = null;
      if (this.phase === "lobby") {
        this.bees.delete(b.id);
        if (this.host === b.id) { const h = [...this.bees.values()].find(x => !x.bot); this.host = h ? h.id : null; }
        this.broadcast(this.lobbyMsg());
      } else b.gone = this.now();
    }
    control(b, m) {
      if (m.t === "sting") { if (this.phase === "play") this.armSting(b); }
      else if (m.t === "to") { const fi = m.f; if (this.phase === "play" && Number.isInteger(fi) && fi >= 0 && fi < this.world.flowers.length) this.launch(b, fi); }
      else if (m.t === "bots" && this.host === b.id && this.phase === "lobby" && Number.isInteger(m.v)) { this.botsWanted = Math.max(0, Math.min(MAX_BEES - 1, m.v)); this.broadcast(this.lobbyMsg()); }
      else if (m.t === "name" && this.phase === "lobby") { b.name = clean(m.v); this.broadcast(this.lobbyMsg()); }
      else if (m.t === "start" && this.host === b.id && this.phase === "lobby") this.startCountdown();
    }

    // one player, phone or big screen: messages in, messages out
    connect(link) {
      let bee = null, watcher = null;
      return {
        message: m => {
          if (!m || typeof m !== "object") return;
          if (!bee && !watcher) {
            if (m.t === "hello") {
              const b = this.newBee(m.name); b.link = link;
              if (m.mode === "solo" && this.bees.size === 0) { this.solo = true; this.botsWanted = 3; if (this.join(b)) { bee = b; this.startCountdown(); } }
              else if (this.join(b)) bee = b;
            } else if (m.t === "resume") { bee = this.resume(link, String(m.key || "")); if (!bee) link.send({ t: "lost" }); }
            else if (m.t === "watch") {
              watcher = link; this.watchers.add(link); link.send(this.lobbyMsg());
              if (this.phase === "countdown" || this.phase === "play") link.send({ t: "go", in: 0, ...this.worldMsg() });
              else if (this.phase === "results") link.send({ t: "end", rank: this.lastRank });
            }
            return;
          }
          if (bee) this.control(bee, m);
        },
        close: () => { if (bee) this.drop(bee, link); if (watcher) this.watchers.delete(watcher); },
      };
    }
  }
  return { Host };
})();
