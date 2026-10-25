/* BUMBLEBLOOM - the game itself, running in the host's browser.
 *
 * This is server.py's simulation translated line for line, for when there is
 * no Python server (GitHub Pages, or just opening the files). One browser -
 * whoever made the garden - runs it, and every player talks to it with the
 * very same messages they would send the Python server. Keep the two in step:
 * a rule changed in one belongs in the other.
 *
 * A seat is a player (a phone or a bot): a hive; a worker is one bee in the garden.
 * Solo hives grow with their flowers; with friends each round has a fixed number of bees.
 *
 * const g = new BloomSim.Host(code)   // the room
 * g.connect(link)                      // link = { send(obj) }; returns { message(obj), close() }
 */
'use strict';

const BloomSim = (() => {
  const TICK = 1 / 60, SEND_EVERY = 3;
  const ROUND_SECONDS = 120, ROUND_CHOICES = [60, 120, 180, 300], RESULTS_SECONDS = 15, BETWEEN_ROUNDS = 10, COUNTDOWN = 3, MAX_SEATS = 8, RESUME_GRACE = 120;
  const NAMES = ["Red", "Blue", "Gold", "Violet", "Orange", "Pink", "Teal", "Brown"];
  // how many bees a hive has (see server.py): solo hives grow with their flowers, friends' rounds are fixed
  const GROW_STEPS = [0, 3, 5, 7];
  const ROUNDS = [{ name: "Round 1", bees: 2 }, { name: "Round 2", bees: 3 }, { name: "Final", bees: 3, bonus: 6, top: 4 }];
  const SHRINK_GRACE = 5, MAX_BEES = 4;
  // the garden grows during a round
  const START_SHARE = .65, SPROUT_FIRST = 10;
  // bot skill: pause before moving on (s), chance of a random pick, of not checking the flytrap path, of stinging
  const SKILL = {
    easy: { wait: [1.6, 3.2], random: .40, careless: .25, sting: 0 },
    normal: { wait: [.9, 1.8], random: .15, careless: 0, sting: .4 },
    hard: { wait: [.4, 1.0], random: 0, careless: 0, sting: 1 },
  };
  const SKILL_ORDER = ["easy", "normal", "hard"];
  // a bot skill between the named ones: 0 = easy, 1 = normal, 2 = hard (solo bots move along it)
  function skillAt(f) {
    f = Math.max(0, Math.min(2, f));
    const i = Math.floor(f), a = SKILL[SKILL_ORDER[i]], b = SKILL[SKILL_ORDER[Math.min(2, i + 1)]], u = f - i, mix = (x, y) => x + (y - x) * u;
    return { wait: [mix(a.wait[0], b.wait[0]), mix(a.wait[1], b.wait[1])], random: mix(a.random, b.random), careless: mix(a.careless, b.careless), sting: mix(a.sting, b.sting) };
  }
  const ordinal = n => ({ 1: "1st", 2: "2nd", 3: "3rd" })[n] || n + "th";
  const OMEGA0 = 2.0, FLY_V = 480, ORBIT_GAP = 26, BEE_R = 9;
  const HP_MAX = 100, HEAL_PER_S = 7, FAINT_SECONDS = 3, FAINT_HONEY_LOSS = .15, SAFE_SECONDS = 1.5, DIZZY_SECONDS = 1.6;
  const BUMP_DMG = 10, TRAP_DMG = 35, DRAGON_DMG = 25, BIRD_DMG = 45, WEB_DPS = 18, TRAP_R = 24;
  // sting dash and fortified patches (see server.py)
  const STING_DMG = 35, STING_CD = 2, STING_SPEED = 1.45, STING_REACH = BEE_R * 2.6, STING_DIZZY = 1, BOUNTY_WINDOW = 4;
  const FORTIFY_SIZE = 4, FORTIFY_LOOPS = 3;
  // pace: fast sprouting in most rounds, longer flights go faster, the last 15 s count double, the hive in last place gets a lift
  const FAST_ROUNDS = .85, FAST_SPROUT = [4, 5], FINAL_SECONDS = 15, MAX_EXTRA = 45;
  const POWER_FIRST = 14, POWER_GAP = [12, 16], POWER_LIFE = 12, POWER_BOOST = 7, POWER_MULT = 1.8;
  const CATCH_FLY = 1.12, CATCH_STING = .6, CATCH_POLLEN = 1.1;
  const distSpeed = D => 1 + Math.max(0, Math.min(.9, (D - 300) / 1000));   // a long flight is up to 1.9x as fast
  // teamwork: each extra bee of yours circling a flower you are taking adds this much speed
  const CO_POLLEN = .8;
  const PRED_FIRST = 12, PRED_GAP = [7, 13], DRAGON_SPEED = 380, BIRD_WARN = 1.8, BIRD_R = 75, WEB_SECONDS = 10;
  const SIZES = [[2, 1240, 780, 10], [4, 1440, 880, 14], [6, 1640, 980, 18], [8, 1840, 1080, 22],
    [12, 2040, 1180, 28], [16, 2240, 1300, 34], [24, 2540, 1460, 44]];
  const TAU = Math.PI * 2;

  const rand = Math.random, uniform = (a, b) => a + rand() * (b - a), choice = a => a[Math.floor(rand() * a.length)];
  const hyp = Math.hypot, r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
  function seeded(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function segDist(ax, ay, bx, by, px, py) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)); return hyp(ax + u * dx - px, ay + u * dy - py); }
  const clean = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 14).trim();
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");

  // ---------------------------------------------------------------- world
  function makeWorld(nBees, seed, aspect, extra = 0) {
    const R = seeded(seed);
    let [, W, H, count0] = SIZES.find(s => nBees <= s[0]) || SIZES[SIZES.length - 1];
    const count = count0 + extra;                       // extra flowers wait to sprout in fast rounds
    if (aspect) {
      // the same lawn area in the shape of the host's screen, so a phone held sideways is filled
      const a = Math.max(1.3, Math.min(2.2, aspect)), area = W * H;
      W = Math.round(Math.sqrt(area * a) / 10) * 10; H = Math.round(Math.sqrt(area / a) / 10) * 10;
    }
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
    // most flowers are open at the start; the rest (the gaps the spacing filled last) sprout during the round
    const nOpen = Math.max(Math.min(count0, 6), Math.round(count0 * START_SHARE));
    return { W, H, seed, trap: [cx, cy], flowers: flowers.slice(0, nOpen), dormant: flowers.slice(nOpen), link: r1(nn[Math.floor(nn.length / 2)] * 1.45) };
  }
  function spreadStarts(wd, n) {
    const fl = wd.flowers, [cx, cy] = wd.trap;
    let first = 0; fl.forEach((f, i) => { if (hyp(f.x - cx, f.y - cy) > hyp(fl[first].x - cx, fl[first].y - cy)) first = i; });
    const picks = [first];
    while (picks.length < Math.min(n, fl.length)) {
      let best = -1, bd = -1;
      fl.forEach((f, i) => { if (picks.includes(i)) return; const d = Math.min(...picks.map(j => hyp(f.x - fl[j].x, f.y - fl[j].y))); if (d > bd) { bd = d; best = i; } });
      picks.push(best);
    }
    return picks;
  }

  // ---------------------------------------------------------------- the room
  class Host {
    constructor(code) {
      this.code = code; this.seats = new Map(); this.workers = []; this.watchers = new Set(); this.host = null; this.phase = "lobby";
      this.world = null; this.preds = []; this.fxq = []; this.toast = null; this.tEnd = 0; this.tPhase = 0; this.nextPred = 0;
      this.predId = 0; this.tickN = 0; this.lastOwners = ""; this.ownerN = 0; this.fort = new Set(); this.solo = false; this.shared = false;
      this.botsWanted = 0; this.skill = "easy"; this.secs = ROUND_SECONDS; this.match = "single"; this.level = 0; this.lastEnd = null; this.nextId = 1;
      this.skillF = 0; this.nextSprout = 0; this.sproutGap = 10; this.nextAdapt = 0; this.sproutTold = false; this.aspect = null;
      let last = performance.now() / 1000, acc = 0;
      this.timer = setInterval(() => {
        const now = performance.now() / 1000; acc += Math.min(.25, now - last); last = now;
        while (acc >= TICK) { acc -= TICK; this.tick(now); }
        this.sweep(now);
      }, 8);
    }
    stop() { clearInterval(this.timer); }
    now() { return performance.now() / 1000; }

    newSeat(name, bot = false) {
      const s = { id: this.nextId++, name: clean(name), link: null, bot, gone: null, dev: "", key: newKey(), slot: 0, total: 0, out: false, auto: !bot };   // auto: a flight at a rival becomes a dash by itself
      this.resetSeat(s); return s;
    }
    resetSeat(s) { Object.assign(s, { help: false, score: 0, faints: 0, blooms: 0, knocks: 0, stingArmed: false, shrinkAt: null }); }
    newWorker(seat, k) {
      return { id: seat.id * 10 + k, seat, slot: seat.slot, state: "orbit", f: 0, ang: 0, rad: 40, dir: 1, v: OMEGA0, prog: 0,
        x: 0, y: 0, vx: 0, vy: 0, timer: 0, hp: HP_MAX, safe: 0, hitCd: 0, target: null, wait: 1, sting: false, stingCd: 0, lastHit: null };   // stingCd: each bee recharges its own sting
    }
    freeSlot() { const used = new Set([...this.seats.values()].map(s => s.slot)); for (let i = 0; i < MAX_SEATS; i++) if (!used.has(i)) return i; }
    label(s) { return s.name || NAMES[s.slot] + " bee"; }
    // this round's bee rule: grow with your flowers (solo) or a fixed number (with friends)
    rule() {
      if (this.solo) return { kind: "grow", name: "Solo", bees: 1, steps: GROW_STEPS };
      if (this.match === "rounds") return { ...ROUNDS[this.level], kind: "fixed" };
      const r = { ...ROUNDS[ROUNDS.length - 1], kind: "fixed", name: "One round" }; delete r.top; return r;
    }
    beesOf(s) { return this.workers.filter(w => w.seat === s); }
    devices() { return new Set([...this.seats.values()].filter(s => !s.bot).map(s => s.dev || s.id)).size; }
    send(s, o) { if (s.link) s.link.send(o); }
    note(s, x) { this.send(s, { t: "note", x }); }
    broadcast(o) { this.seats.forEach(s => this.send(s, o)); this.watchers.forEach(w => w.send(o)); }
    sorted() { return [...this.seats.values()].sort((a, b) => a.slot - b.slot); }

    levelInfo() {
      const r = this.rule();
      return { idx: this.level, name: r.name, kind: r.kind, bees: r.bees, bonus: r.bonus || null, steps: r.steps || null, top: r.top || null, max: MAX_BEES,
        of: this.match === "rounds" && !this.solo ? ROUNDS.length : 1, match: this.match };
    }
    lobbyMsg() {
      return { t: "lobby", code: this.code, host: this.host, solo: this.solo, shared: this.shared, bots: this.botsWanted, skill: this.skill, secs: this.secs,
        match: this.match, phase: this.phase, devices: this.devices(), canLevels: true,
        bees: this.sorted().filter(s => !s.bot).map(s => ({ id: s.id, slot: s.slot, name: this.label(s), bot: s.bot, away: s.gone != null, auto: s.auto })) };
    }
    worldMsg() {
      this.lastOwners = "";     // the next snapshot carries the owners, for a new round or a player just joining
      const wd = this.world;
      // open flowers first, then the ones still to sprout (the state's owner list says how many are open)
      return { W: wd.W, H: wd.H, seed: wd.seed, link: wd.link, trap: wd.trap, flowers: wd.flowers.concat(wd.dormant).map(f => [f.x, f.y, f.r]), open: wd.flowers.length,
        seats: this.sorted().map(s => ({ id: s.id, slot: s.slot, name: this.label(s), bot: s.bot, out: !!s.out })),
        bees: this.workers.map(w => ({ id: w.id, slot: w.slot, name: this.label(w.seat), bot: w.seat.bot, seat: w.seat.id })),
        level: this.levelInfo(),
        cfg: { hp: HP_MAX, secs: this.secs, flyV: FLY_V, trapR: TRAP_R + BEE_R, stingCd: STING_CD, fortSize: FORTIFY_SIZE, fortLoops: FORTIFY_LOOPS } };
    }
    stateMsg(now) {
      const st = { orbit: 0, fly: 1, dizzy: 2, faint: 3 };
      const msg = { t: "s", left: this.phase === "play" ? r1(Math.max(0, this.tEnd - now)) : this.secs, ph: this.phase,
        b: this.workers.map(w => { const s = w.seat; return [w.id, r1(w.x), r1(w.y), r3(w.ang), st[w.state], Math.round(w.hp), Math.floor(s.score), r2(w.prog), w.f, w.dir, r1(w.rad), r1(w.vx), r1(w.vy), w.safe > 0 ? 1 : 0, r2(w.v), w.target == null || w.state !== "fly" ? -1 : w.target, w.sting ? 1 : 0, s.stingArmed ? 1 : 0, r1(w.stingCd), s.id, Math.floor(s.total), w.boost > 0 ? 1 : 0]; }),
        p: this.preds.map(p => p.k === "dragon" ? ["d", Math.round(p.x), Math.round(p.y), r2(Math.atan2(p.vy, p.vx)), p.id]
          : p.k === "bird" ? ["b", Math.round(p.x), Math.round(p.y), r2(p.age / BIRD_WARN), p.id] : ["s", p.f, 0, r2(p.age), r2(p.life)]) };
      const o = this.world.flowers.map(f => f.owner), key = o.join();
      if (key !== this.lastOwners || ++this.ownerN >= 20) { msg.o = o; this.lastOwners = key; this.ownerN = 0; }
      if (this.power) msg.pw = [this.power.f, r1(Math.max(0, this.power.until - now))];
      if (this.fxq.length) { msg.fx = this.fxq; this.fxq = []; }
      if (this.toast) { msg.toast = this.toast; this.toast = null; }
      return msg;
    }
    fx(kind, x, y, slot = -1) { this.fxq.push([kind, Math.round(x), Math.round(y), slot]); }

    // ---- phases
    startCountdown(fresh = true) {
      this.phase = "countdown"; this.tPhase = this.now() + COUNTDOWN;
      if (fresh) {
        this.level = 0;
        if (!["single", "rounds"].includes(this.match)) this.match = "single";
        [...this.seats.values()].filter(s => s.bot).forEach(s => this.seats.delete(s.id));
        const humans = [...this.seats.values()].filter(s => !s.bot).length;
        const want = Math.max(0, Math.min(MAX_SEATS - humans, this.botsWanted));
        for (let i = 0; i < want; i++) { const bot = this.newSeat("", true); bot.slot = this.freeSlot(); this.seats.set(bot.id, bot); }
        this.seats.forEach(s => { s.total = 0; s.out = false; });
        this.skillF = SKILL_ORDER.indexOf(this.skill);
      }
      this.seats.forEach(s => this.resetSeat(s));
      const r = this.rule(), seats = this.sorted().filter(s => !s.out);
      this.workers = seats.flatMap(s => Array.from({ length: r.bees }, (_, j) => this.newWorker(s, j)));
      // the garden is sized for every hive at full strength
      const full = seats.length * (r.kind === "grow" ? 3 : r.bees + (r.bonus ? 1 : 0));
      this.fast = rand() < FAST_ROUNDS; this.power = null; this.nextHelp = 0;
      const extra = this.fast ? Math.min(MAX_EXTRA, Math.ceil((this.secs - 5 - FINAL_SECONDS) / 4.5) + Math.ceil(FINAL_SECONDS / 2.25)) : 0;
      this.world = makeWorld(full, Math.floor(rand() * 2 ** 30), this.aspect, extra);
      const fl = this.world.flowers, homes = spreadStarts(this.world, seats.length), taken = new Set(homes);
      seats.forEach((s, k) => {
        // a player's bees start together: one on their home flower, the others on
        // the nearest white flowers, so they grow one patch instead of scattered ones
        const home = homes[k]; if (home == null) return;
        fl[home].owner = s.slot;
        const team = this.beesOf(s);
        const near = fl.map((_, i) => i).filter(i => !taken.has(i)).sort((a, b) => hyp(fl[a].x - fl[home].x, fl[a].y - fl[home].y) - hyp(fl[b].x - fl[home].x, fl[b].y - fl[home].y));
        const spots = [home, ...near.slice(0, team.length - 1)];
        spots.forEach(i => taken.add(i));
        team.forEach((w, j) => {
          const f = fl[spots[j]];
          w.f = spots[j]; w.rad = f.R; w.ang = uniform(0, TAU); w.dir = w.slot % 2 === 0 ? 1 : -1;
          w.wait = uniform(...SKILL[this.skill].wait); this.place(w, f);
        });
      });
      this.preds = []; this.fxq = []; this.lastEnd = null;
      this.broadcast(this.lobbyMsg());
      this.broadcast({ t: "go", in: COUNTDOWN, ...this.worldMsg() });
    }
    startPlay(now) {
      this.phase = "play"; this.tEnd = now + this.secs; this.nextPred = now + PRED_FIRST;
      // the flowers still to come sprout evenly over most of the round
      this.nextSprout = now + (this.fast ? FAST_SPROUT[0] : SPROUT_FIRST); this.sproutGap = Math.max(3, (this.secs * .75 - SPROUT_FIRST) / Math.max(1, this.world.dormant.length));
      this.nextPower = now + POWER_FIRST; this.power = null;
      this.nextAdapt = now + 10; this.sproutTold = false;
    }
    endRound(now) {
      this.seats.forEach(s => { s.total += s.score; });
      const more = this.match === "rounds" && !this.solo && this.level < ROUNDS.length - 1;
      this.phase = "results"; this.tPhase = now + (more ? BETWEEN_ROUNDS : RESULTS_SECONDS);
      const key = this.match === "single" || this.solo ? s => s.score : s => s.total;
      const rank = [...this.seats.values()].sort((a, b) => (!!a.out - !!b.out) || key(b) - key(a)).map(s => {
        const ps = this.patches(s.slot);
        return { slot: s.slot, name: this.label(s), honey: Math.floor(s.score), total: Math.floor(s.total), bot: s.bot, blooms: s.blooms, faints: s.faints, knocks: s.knocks, out: !!s.out,
          flowers: this.world.flowers.filter(f => f.owner === s.slot).length, patch: Math.max(0, ...ps.map(p => p.length)), rate: ps.reduce((a, p) => a + p.length ** 2, 0) };
      });
      const nxt = more ? ROUNDS[this.level + 1] : null;
      this.lastEnd = { t: "end", rank, level: this.levelInfo(), final: !more, next: nxt ? nxt.name : null, nextWorkers: nxt ? nxt.bees : null,
        nextTop: nxt ? nxt.top || null : null, in: more ? BETWEEN_ROUNDS : RESULTS_SECONDS };
      this.broadcast(this.lastEnd);
    }
    afterResults() {
      if (this.match === "rounds" && !this.solo && this.level < ROUNDS.length - 1) {
        this.level++;
        const top = ROUNDS[this.level].top;
        // the final: only the best hives so far play it; the others watch
        if (top) [...this.seats.values()].sort((a, b) => b.total - a.total).forEach((s, i) => { s.out = i >= top; });
        this.startCountdown(false);
      } else this.backToLobby();
    }
    backToLobby() {
      this.phase = "lobby"; this.level = 0; this.workers = [];
      [...this.seats.values()].filter(s => s.bot || s.gone != null).forEach(s => this.seats.delete(s.id));
      this.seats.forEach(s => { s.out = false; });
      if (!this.seats.has(this.host) && this.seats.size) this.host = this.seats.keys().next().value;
      this.broadcast(this.lobbyMsg());
    }

    // ---- simulation
    place(w, f) { w.x = f.x + Math.cos(w.ang) * w.rad; w.y = f.y + Math.sin(w.ang) * w.rad; }
    hurt(w, dmg, why, by = null) {
      if (w.safe > 0 || w.state === "faint") return;
      if (by && by.seat !== w.seat) w.lastHit = [by.seat, this.now()];   // for the bounty, if this ends in a faint
      w.hp -= dmg;
      if (w.hitCd <= 0) { w.hitCd = .35; this.fx("hit", w.x, w.y, w.slot); }
      if (w.hp <= 0) this.faint(w, why);
    }
    faint(w, why) {
      const s = w.seat;
      w.state = "faint"; w.timer = FAINT_SECONDS; w.hp = 0; w.sting = false;
      const lost = Math.floor(s.score * FAINT_HONEY_LOSS / Math.max(1, this.beesOf(s).length)); s.score -= lost; s.faints++;
      this.fx("faint", w.x, w.y, w.slot);
      const [hitter, at] = w.lastHit || [null, 0]; w.lastHit = null;
      if (hitter && this.seats.get(hitter.id) === hitter && this.now() - at <= BOUNTY_WINDOW) {
        hitter.score += lost; hitter.knocks++;              // the bounty
        this.toast = `${this.label(hitter)} knocked out ${this.label(s)} and took ${lost} honey!`;
      } else this.toast = `${this.label(s)} fainted (${why}) and dropped ${lost} honey`;
    }
    respawn(w) {
      const fl = this.world.flowers, idx = (pred) => fl.map((f, i) => pred(f) ? i : -1).filter(i => i >= 0);
      const own = idx(f => f.owner === w.slot && f.web <= 0), pool = own.length ? own : idx(f => f.owner == null && f.web <= 0);
      const fi = choice(pool.length ? pool : fl.map((_, i) => i)), f = fl[fi];
      Object.assign(w, { state: "orbit", f: fi, ang: uniform(0, TAU), rad: f.R, v: OMEGA0, prog: 0, hp: HP_MAX, safe: SAFE_SECONDS, target: null, wait: .6, sting: false });
      this.place(w, f);
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
    fortified() {
      const out = new Set(), fl = this.world.flowers;
      new Set(fl.map(f => f.owner).filter(o => o != null)).forEach(sl => this.patches(sl).forEach(p => { if (p.length >= FORTIFY_SIZE) p.forEach(f => out.add(fl.indexOf(f))); }));
      return out;
    }
    // May this bee take a new order? With one bee: whenever it is up. With several:
    // only once it has finished pollinating - circling one of your own flowers (or a webbed one).
    isFree(w) {
      if (this.workers.filter(o => o.seat === w.seat).length === 1) return w.state === "orbit" || w.state === "fly";
      if (w.state !== "orbit") return false;
      const f = this.world.flowers[w.f];
      return f.owner === w.slot || f.web > 0;
    }
    launch(w, fi) {
      if (!(w.state === "orbit" || w.state === "fly") || (w.state === "orbit" && fi === w.f)) return false;
      w.state = "fly"; w.target = fi; w.prog = 0; { const tf = this.world.flowers[fi]; w.flyD = hyp(w.x - tf.x, w.y - tf.y); }
      const s = w.seat;
      if (w.stingCd <= 0 && !w.sting && (s.stingArmed || (s.auto && !s.bot && this.rivalInWay(w, fi)))) this.startSting(w);
      return true;
    }
    // Is a rival on the straight line to flower fi, or circling it? (auto sting, and the bots)
    rivalInWay(w, fi) {
      const t = this.world.flowers[fi];
      return this.workers.some(o => o.slot !== w.slot && (o.state === "orbit" || o.state === "fly") && o.safe <= 0 &&
        (segDist(w.x, w.y, t.x, t.y, o.x, o.y) < 40 || (o.state === "orbit" && o.f === fi)));
    }
    // this bee's flight becomes a dash: a press of Sting is used up (all the player's bees are
    // disarmed), and this bee's own sting recharges for STING_CD seconds
    startSting(w) { w.sting = true; w.stingCd = STING_CD * (w.seat.help ? CATCH_STING : 1); w.seat.stingArmed = false; }
    // Sting while a bee with a ready sting is flying and that flight becomes the dash;
    // otherwise the next flight of a bee whose sting is ready does
    armSting(s) {
      if (s.stingArmed) return;
      const mine = this.workers.filter(w => w.seat === s && (w.state === "orbit" || w.state === "fly"));
      const flying = mine.find(w => w.state === "fly" && w.stingCd <= 0 && !w.sting);
      if (flying) this.startSting(flying); else if (mine.some(w => w.stingCd <= 0)) s.stingArmed = true;
    }
    // A player tapped flower fi: send the bee they picked, or their nearest free bee.
    command(s, fi, wid = null) {
      const fl = this.world.flowers, mine = this.workers.filter(w => w.seat === s);
      if (wid != null) { const p = mine.find(w => w.id === wid); if (p && this.isFree(p)) { this.launch(p, fi); return; } }
      const t = fl[fi];
      if (t.owner === s.slot && mine.some(w => (w.state === "fly" && w.target === fi) || (w.state === "orbit" && w.f === fi))) return;   // already on your flower
      // a flower you are taking: another tap sends another free bee to help (see CO_POLLEN)
      const free = mine.filter(w => this.isFree(w) && !(w.state === "orbit" && w.f === fi));
      if (!free.length) {
        if (mine.some(w => w.state === "orbit" && w.f === fi)) return;                     // already there
        this.note(s, "All your bees are busy pollinating - wait for one to finish"); return;
      }
      this.launch(free.reduce((m, w) => hyp(w.x - t.x, w.y - t.y) < hyp(m.x - t.x, m.y - t.y) ? w : m), fi);
    }
    botThink(w, dt, sk) {
      const wd = this.world, fl = wd.flowers;
      if (w.state !== "orbit") return;
      const f = fl[w.f];
      if (f.owner !== w.slot && f.web <= 0) return;           // finish pollinating first
      if (f.owner === w.slot && w.hp < 45) w.wait = Math.max(w.wait, .5);
      if (f.web > 0) w.wait = 0;
      w.wait -= dt;
      if (w.wait > 0) return;
      const birds = this.preds.filter(p => p.k === "bird"), [cx, cy] = wd.trap;
      const careless = rand() < sk.careless, options = [];
      fl.forEach((t, i) => {
        if (i === w.f || t.owner === w.slot || t.web > 0) return;
        const mates = this.workers.some(o => o.seat === w.seat && (o.target === i || (o.state === "orbit" && o.f === i)));
        if (mates && !this.fort.has(i)) return;   // a teammate is already on it (on a hedge, though, help it)
        if (!careless && segDist(w.x, w.y, t.x, t.y, cx, cy) < TRAP_R + BEE_R + 30) return;
        if (birds.some(p => hyp(t.x - p.x, t.y - p.y) < BIRD_R + 40)) return;
        options.push([hyp(t.x - f.x, t.y - f.y) + (t.owner != null ? 120 : 0) + rand() * 90 + (this.fort.has(i) ? (mates ? 20 : 220) : 0), i]);
      });
      if (!options.length) { w.wait = .5; return; }
      options.sort((a, b) => a[0] - b[0]);
      const best = rand() < sk.random ? choice(options)[1] : options[0][1], s = w.seat;
      if (w.stingCd <= 0 && rand() < sk.sting && this.rivalInWay(w, best)) s.stingArmed = true;
      this.launch(w, best);
      w.wait = uniform(...sk.wait);                            // how long it lingers after its next landing
    }
    step(dt, now) {
      const wd = this.world, fl = wd.flowers, [cx, cy] = wd.trap;
      fl.forEach(f => { f.flash = Math.max(0, f.flash - dt); f.web = Math.max(0, f.web - dt); });
      this.fort = this.fortified();
      for (const w of this.workers) {
        const s = w.seat;
        if (s.bot) this.botThink(w, dt, this.solo ? skillAt(this.skillF) : SKILL[this.skill]);
        else if (s.gone != null) this.botThink(w, dt, SKILL.normal);   // autopilot while their phone is away
        if (w.boost > 0) w.boost -= dt;
        w.safe = Math.max(0, w.safe - dt); w.hitCd = Math.max(0, w.hitCd - dt); w.stingCd = Math.max(0, w.stingCd - dt);
        if (w.state === "dizzy" || w.state === "faint") { w.timer -= dt; if (w.timer <= 0) this.respawn(w); continue; }
        if (w.state === "orbit") {
          const f = fl[w.f];
          w.rad += (f.R - w.rad) * Math.min(1, 6 * dt);
          w.ang = ((w.ang + w.dir * w.v * dt) % TAU + TAU) % TAU;
          this.place(w, f);
          if (f.web > 0) { this.hurt(w, WEB_DPS * dt, "caught in a web"); if (w.state === "faint") continue; }
          else if (f.owner === w.slot) w.hp = Math.min(HP_MAX, w.hp + HEAL_PER_S * dt);
          else {
            const k = this.workers.filter(o => o.seat === s && o.state === "orbit" && o.f === w.f).length;
            w.prog += w.v * dt * (1 + CO_POLLEN * (k - 1)) * (w.boost > 0 ? POWER_MULT : 1) * (s.help ? CATCH_POLLEN : 1);
            if (w.prog >= (f.owner == null ? 1 : this.fort.has(w.f) ? FORTIFY_LOOPS : 2) * TAU) {
              f.owner = w.slot; f.flash = 1; s.blooms++; this.fx("bloom", f.x, f.y, w.slot);
              if (f.power) this.takePower(f);
              this.workers.forEach(o => { if (o.seat === s && o.f === w.f) o.prog = 0; });   // the helpers are done too
            }
          }
        } else if (w.state === "fly") {
          const t = fl[w.target], dx = t.x - w.x, dy = t.y - w.y, d = hyp(dx, dy) || 1;
          const spd = FLY_V * distSpeed(w.flyD || 0) * (s.help ? CATCH_FLY : 1) * (w.sting ? STING_SPEED : 1);
          w.vx = dx / d * spd; w.vy = dy / d * spd;
          if (d - spd * dt <= t.R) {
            // arrive on the flower's ring and start circling it
            w.x = t.x - dx / d * t.R; w.y = t.y - dy / d * t.R;
            const rx = w.x - t.x, ry = w.y - t.y;
            Object.assign(w, { state: "orbit", f: w.target, ang: (Math.atan2(ry, rx) + TAU) % TAU, rad: t.R, dir: rx * w.vy - ry * w.vx >= 0 ? 1 : -1, v: OMEGA0, prog: 0, target: null });
            if (w.sting) {
              // a dash at a flower strikes a rival circling it, wherever they are on the ring
              const occ = this.workers.filter(v => v.slot !== w.slot && v.f === w.f && (v.state === "orbit" || v.state === "dizzy") && v.safe <= 0);
              if (occ.length) this.stingHit(w, occ.reduce((m, v) => hyp(v.x - w.x, v.y - w.y) < hyp(m.x - w.x, m.y - w.y) ? v : m));
            }
            w.sting = false;                                    // a dash that hit nobody ends when you land
            this.fx("land", w.x, w.y, w.slot);
          } else { w.x += w.vx * dt; w.y += w.vy * dt; }
          if (hyp(w.x - cx, w.y - cy) < TRAP_R + BEE_R) {
            // flew straight into the flytrap: bitten, dazed, sent home
            this.fx("snap", cx, cy, w.slot);
            w.x = cx - dx / d * (TRAP_R + BEE_R + 6); w.y = cy - dy / d * (TRAP_R + BEE_R + 6);
            w.state = "dizzy"; w.timer = DIZZY_SECONDS; w.target = null; w.sting = false;
            this.hurt(w, TRAP_DMG, "bitten by the flytrap");
          }
        }
      }
      // stings: a dashing bee hits the first rival it reaches, flying or circling
      for (const a of this.workers) {
        if (!(a.sting && a.state === "fly")) continue;
        for (const v of this.workers) {
          if (v.slot === a.slot || !["orbit", "fly", "dizzy"].includes(v.state) || v.safe > 0) continue;
          if (hyp(a.x - v.x, a.y - v.y) < STING_REACH) { this.stingHit(a, v); break; }
        }
      }
      // bumping: a flying bee knocks a circling rival dizzy (teammates pass through each other)
      const live = this.workers.filter(w => w.state === "orbit" || w.state === "fly");
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], c = live[j];
        if (a.slot === c.slot || hyp(a.x - c.x, a.y - c.y) > BEE_R * 2) continue;
        if (a.state === "fly" && c.state === "orbit") this.bump(a, c);
        else if (c.state === "fly" && a.state === "orbit") this.bump(c, a);
      }
      this.stepPredators(dt, now);
      this.stepGarden(now);
      this.manageHives(now);
      const mult = this.phase === "play" && this.tEnd - now <= FINAL_SECONDS ? 2 : 1;
      this.seats.forEach(s => { s.score += this.patches(s.slot).reduce((n, p) => n + p.length ** 2, 0) * dt * mult; });
      if (now >= this.nextHelp) { this.nextHelp = now + 1; this.updateHelp(now); }
    }
    // new flowers sprout during the round, and stay; solo bots adjust to the player
    stepGarden(now) {
      const wd = this.world;
      if (wd.dormant.length && now >= this.nextSprout) {
        const f = wd.dormant.shift(); wd.flowers.push(f); f.flash = 1;
        this.fx("sprout", f.x, f.y);
        const gap = this.fast ? uniform(FAST_SPROUT[0], FAST_SPROUT[1]) : this.sproutGap;
        this.nextSprout = now + (this.tEnd - now <= FINAL_SECONDS ? gap / 2 : gap);     // faster still in the last 15 s
      }
      this.stepPower(now);
      if (this.solo && now >= this.nextAdapt) {
        // sharper while the player is well ahead, easing back (never below the chosen skill) while well behind
        this.nextAdapt = now + 10;
        const all = [...this.seats.values()], me = Math.max(0, ...all.filter(s => !s.bot).map(s => s.score)), best = Math.max(0, ...all.filter(s => s.bot).map(s => s.score));
        const base = SKILL_ORDER.indexOf(this.skill);
        if (me > best * 1.15 + 20) this.skillF = Math.min(2, this.skillF + .25);
        else if (me < best * .7) this.skillF = Math.max(base, this.skillF - .25);
      }
    }
    // a power flower blooms for a while; whoever takes it (or the time running out) ends it. Taking it
    // boosts the pollination speed of half the bees, drawn at random from the ones farthest from it.
    stepPower(now) {
      const fl = this.world.flowers;
      if (this.power) {
        if (now >= this.power.until) { const f = fl[this.power.f]; f.power = 0; this.fx("fade", f.x, f.y); this.power = null; this.nextPower = now + uniform(...POWER_GAP); }
      } else if (this.phase === "play" && now >= this.nextPower && this.tEnd - now > 4) {
        const ok = fl.map((f, i) => i).filter(i => fl[i].web <= 0);
        if (!ok.length) return;
        const i = choice(ok); fl[i].power = 1; this.power = { f: i, until: now + POWER_LIFE }; this.fx("power", fl[i].x, fl[i].y);
      }
    }
    takePower(f) {
      f.power = 0; this.power = null; this.nextPower = this.now() + uniform(...POWER_GAP);
      const bees = this.workers.filter(w => w.state === "orbit" || w.state === "fly").sort((a, b) => hyp(b.x - f.x, b.y - f.y) - hyp(a.x - f.x, a.y - f.y));
      const pool = bees.slice(0, Math.ceil(bees.length * .75));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      pool.slice(0, Math.ceil(bees.length / 2)).forEach(w => { w.boost = POWER_BOOST; this.fx("boost", w.x, w.y, w.slot); });
    }
    // the hive furthest behind gets a small lift (faster flight, quicker stings, a little faster pollination) so nobody is out of it
    updateHelp(now) {
      const live = [...this.seats.values()].filter(s => !s.out);
      live.forEach(s => { s.help = false; });
      if (this.phase !== "play" || live.length < 2 || this.tEnd - now > this.secs - 15) return;
      const sorted = live.slice().sort((a, b) => a.score - b.score), lead = sorted[sorted.length - 1].score;
      if (sorted[0].score < lead * .85 - 10 && sorted[0].score < sorted[1].score) sorted[0].help = true;
    }
    // how many bees this hive may have right now
    beesAllowed(s, flowers, humansMost) {
      if (s.out) return 0;
      const r = this.rule();
      if (r.kind === "grow") {
        const n = Math.max(1, GROW_STEPS.filter(k => flowers >= k).length);
        return s.bot ? Math.min(n, MAX_BEES, humansMost) : Math.min(n, MAX_BEES);   // bots never have more bees than the player
      }
      return r.bees + (r.bonus && flowers >= r.bonus ? 1 : 0);
    }
    // hatch a bee when a hive reaches a step; send one home when it has stayed below a step too long
    manageHives(now) {
      const counts = new Map();
      this.world.flowers.forEach(f => { if (f.owner != null) counts.set(f.owner, (counts.get(f.owner) || 0) + 1); });
      const have = new Map([...this.seats.values()].map(s => [s, this.beesOf(s)]));
      const humansMost = Math.max(1, ...[...this.seats.values()].filter(s => !s.bot).map(s => have.get(s).length));
      const r = this.rule();
      this.seats.forEach(s => {
        const mine = have.get(s), want = this.beesAllowed(s, counts.get(s.slot) || 0, humansMost);
        if (want > mine.length) {
          s.shrinkAt = null; this.hatch(s, mine);
          if (!s.bot) this.note(s, `A new bee hatched: you have ${mine.length + 1} bees`);
        } else if (want < mine.length && mine.length) {
          const need = r.kind === "grow" ? GROW_STEPS[mine.length - 1] : r.bonus;
          if (s.shrinkAt == null) {
            s.shrinkAt = now + SHRINK_GRACE;
            if (!s.bot && need) this.note(s, `Hold ${need} flowers or your ${ordinal(mine.length)} bee flies home in ${SHRINK_GRACE} s`);
          } else if (now >= s.shrinkAt) {
            s.shrinkAt = null;
            const w = mine.reduce((a, b) => b.id > a.id ? b : a);        // the newest bee goes
            this.workers.splice(this.workers.indexOf(w), 1);
            this.fx("home", w.x, w.y, w.slot);
            if (!s.bot && need) this.note(s, `Your ${ordinal(mine.length)} bee flew home. Hold ${need} flowers to get it back`);
          }
        } else s.shrinkAt = null;
      });
    }
    // a new bee for this hive, on one of its own flowers, with a short shield
    hatch(s, mine) {
      const used = new Set(mine.map(w => w.id - s.id * 10));
      let k = 0; while (used.has(k)) k++;
      const w = this.newWorker(s, k), fl = this.world.flowers;
      const own = fl.map((f, i) => f.owner === s.slot && f.web <= 0 ? i : -1).filter(i => i >= 0);
      const fi = choice(own.length ? own : fl.map((_, i) => i)), f = fl[fi];
      Object.assign(w, { f: fi, rad: f.R, ang: uniform(0, TAU), safe: SAFE_SECONDS, wait: 1, dir: s.slot % 2 === 0 ? 1 : -1 });
      this.place(w, f); this.workers.push(w);
      this.fx("hatch", w.x, w.y, w.slot);
    }
    stingHit(a, v) {
      a.sting = false;
      this.fx("sting", v.x, v.y, a.slot);
      this.hurt(v, STING_DMG, `stung by ${this.label(a.seat)}`, a);
      if (v.state !== "faint") { v.state = "dizzy"; v.timer = STING_DIZZY; v.target = null; v.sting = false; }
    }
    bump(flier, victim) {
      if (victim.safe > 0) return;
      victim.state = "dizzy"; victim.timer = DIZZY_SECONDS; victim.sting = false;
      this.fx("bump", victim.x, victim.y, victim.slot);
      this.hurt(victim, BUMP_DMG, `bumped by ${this.label(flier.seat)}`, flier);
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
          this.workers.forEach(w => { if (p.hit.has(w.id) || !(w.state === "orbit" || w.state === "fly")) return; if (hyp(w.x - p.x, w.y - p.y) < 26) { p.hit.add(w.id); this.hurt(w, DRAGON_DMG, "stung by a dragonfly"); } });
          if (p.x > -160 && p.x < W + 160 && p.y > -160 && p.y < H + 160) keep.push(p);
        } else if (p.k === "bird") {
          if (!p.struck && p.age >= BIRD_WARN) {
            p.struck = true; this.fx("swoop", p.x, p.y);
            this.workers.forEach(w => { if (["orbit", "fly", "dizzy"].includes(w.state) && hyp(w.x - p.x, w.y - p.y) < BIRD_R) this.hurt(w, BIRD_DMG, "caught by a bird"); });
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
      const live = this.workers.filter(w => w.state === "orbit" || w.state === "fly");
      if (kind === "spider") {
        let ch = fl.map((f, i) => f.owner != null && f.web <= 0 ? i : -1).filter(i => i >= 0);
        if (!ch.length) ch = fl.map((f, i) => f.web <= 0 ? i : -1).filter(i => i >= 0);
        if (!ch.length) kind = "dragon";
        else { const fi = choice(ch); this.preds.push({ k: "spider", id, f: fi, age: 0, life: WEB_SECONDS }); fl[fi].web = WEB_SECONDS; this.toast = "A spider is spinning a web on a flower!"; return; }
      }
      if (kind === "bird" && live.length) {
        const w = choice(live);
        this.preds.push({ k: "bird", id, x: w.x + uniform(-30, 30), y: w.y + uniform(-30, 30), age: 0, struck: false });
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
      } else if (this.phase === "results" && now >= this.tPhase) this.afterResults();
    }
    sweep(now) {
      if (this.phase !== "lobby") return;
      [...this.seats.values()].filter(s => s.gone != null && now - s.gone > RESUME_GRACE).forEach(s => { this.seats.delete(s.id); this.broadcast(this.lobbyMsg()); });
    }

    // ---- joining (same messages as server.py)
    applySettings(m) {
      if (Number.isInteger(m.bots)) this.botsWanted = Math.max(0, Math.min(MAX_SEATS - 1, m.bots));
      if (ROUND_CHOICES.includes(m.secs)) this.secs = m.secs;
      if (SKILL[m.skill]) this.skill = m.skill;
      if (m.match === "single" || m.match === "rounds" || m.match === "levels") this.match = m.match === "single" ? "single" : "rounds";
    }
    join(s) {
      if (this.phase !== "lobby") { this.send(s, { t: "err", msg: "That garden is mid-round. Wait for the round to end and try again." }); return false; }
      if ([...this.seats.values()].filter(x => !x.bot).length >= MAX_SEATS) { this.send(s, { t: "err", msg: "That garden is full (8 players)." }); return false; }
      s.slot = this.freeSlot(); this.seats.set(s.id, s);
      if (this.host == null) this.host = s.id;
      this.send(s, { t: "hi", id: s.id, code: this.code, key: s.key, slot: s.slot });
      this.broadcast(this.lobbyMsg());
      return true;
    }
    resume(link, key) {
      for (const s of this.seats.values()) if (!s.bot && s.key === key) {
        s.link = link; s.gone = null;
        this.send(s, { t: "hi", id: s.id, code: this.code, key: s.key, slot: s.slot });
        this.send(s, this.lobbyMsg());
        if (this.phase === "countdown" || this.phase === "play") this.send(s, { t: "go", in: 0, ...this.worldMsg() });
        else if (this.phase === "results" && this.lastEnd) this.send(s, this.lastEnd);
        return s;
      }
      return null;
    }
    drop(s, link) {
      if (s.link !== link) return;
      s.link = null;
      if (this.phase === "lobby") {
        this.seats.delete(s.id);
        if (this.host === s.id) { const h = [...this.seats.values()].find(x => !x.bot); this.host = h ? h.id : null; }
        this.broadcast(this.lobbyMsg());
      } else s.gone = this.now();                              // autopilot flies their bees until they come back
    }
    control(s, m) {
      if (m.t === "sting") { if (this.phase === "play") this.armSting(s); }
      else if (m.t === "to") { const fi = m.f; if (this.phase === "play" && Number.isInteger(fi) && fi >= 0 && fi < this.world.flowers.length) this.command(s, fi, Number.isInteger(m.b) ? m.b : null); }
      else if ((m.t === "bots" || m.t === "skill" || m.t === "match" || m.t === "secs") && this.host === s.id && this.phase === "lobby") { this.applySettings({ [m.t]: m.v }); this.broadcast(this.lobbyMsg()); }
      else if (m.t === "auto") { s.auto = !!m.v; if (this.phase === "lobby") this.broadcast(this.lobbyMsg()); }
      else if (m.t === "name" && this.phase === "lobby") { s.name = clean(m.v); this.broadcast(this.lobbyMsg()); }
      else if (m.t === "start" && this.host === s.id && this.phase === "lobby") this.startCountdown();
    }

    // one player, phone or big screen: messages in, messages out
    connect(link) {
      let seat = null, watcher = null;
      return {
        message: m => {
          if (!m || typeof m !== "object") return;
          if (!seat && !watcher) {
            if (m.t === "hello") {
              const s = this.newSeat(m.name); s.link = link; s.dev = String(m.dev || "").slice(0, 40); s.auto = m.auto !== false;
              const first = this.seats.size === 0 && (m.mode === "create" || m.mode === "solo");
              if (first) { this.solo = m.mode === "solo"; this.shared = !!m.shared; if (typeof m.aspect === "number") this.aspect = m.aspect; this.applySettings(m); }
              if (this.join(s)) { seat = s; if (first && this.solo) this.startCountdown(); }
            } else if (m.t === "resume") { seat = this.resume(link, String(m.key || "")); if (!seat) link.send({ t: "lost" }); }
            else if (m.t === "watch") {
              watcher = link; this.watchers.add(link); link.send(this.lobbyMsg());
              if (this.phase === "countdown" || this.phase === "play") link.send({ t: "go", in: 0, ...this.worldMsg() });
              else if (this.phase === "results" && this.lastEnd) link.send(this.lastEnd);
            }
            return;
          }
          if (seat) this.control(seat, m);
        },
        close: () => { if (seat) this.drop(seat, link); if (watcher) this.watchers.delete(watcher); },
      };
    }
  }
  return { Host };
})();
