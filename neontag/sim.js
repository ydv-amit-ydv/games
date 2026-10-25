/* NEON TAG - the game itself, one copy that runs in the host's tab.
 * One player is IT. Touch someone else and they become IT; you are safe for a moment.
 * You score for every second you are NOT it. Dash to escape or to lunge.
 *
 * Speed notes: the host simulates at 60 Hz and sends a snapshot 20 times a second.
 * Players move their own orb at once on their own screen (TagSim.step is shared
 * with the page) and the host's word only nudges it back, so steering never waits for the network.
 *
 *   const sim = new TagSim.Host(code);  const seat = sim.connect({ send(obj) }); seat.message(obj); seat.close();
 */
'use strict';

const TagSim = (() => {
  const W = 1200, H = 1200, R = 18, TICK = 1 / 60, SEND_EVERY = 3;
  const SPEED = 250, IT_BOOST = 1.06, DASH_V = 640, DASH_T = .16, DASH_CD = 2.2, SAFE = 1.6, ROUND = 60, COUNT = 3, GRACE = 20000, MAX = 8;
  const NAMES = ["Zip", "Blip", "Nova", "Pixel", "Echo", "Flux", "Spark", "Volt"];
  const r1 = v => Math.round(v * 10) / 10;
  const clean = s => String(s || "").replace(/[^\w \-.!]/g, "").trim().slice(0, 12);

  // movement, shared by the host and by each page's own prediction
  function step(p, dt) {
    if (p.dashT > 0) { p.dashT -= dt; p.vx = p.ux * DASH_V; p.vy = p.uy * DASH_V; }
    else { const sp = SPEED * (p.it ? IT_BOOST : 1); p.vx = p.dx * sp; p.vy = p.dy * sp; }
    if (p.dcd > 0) p.dcd -= dt;
    p.x = Math.max(R, Math.min(W - R, p.x + p.vx * dt));
    p.y = Math.max(R, Math.min(H - R, p.y + p.vy * dt));
  }
  function aim(p, x, y) {
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    p.dx = x; p.dy = y;
    if (l > .1) { p.lx = x / l; p.ly = y / l; }
  }
  function dash(p) {
    if (p.dcd > 0 || p.dashT > 0) return false;
    p.ux = p.lx; p.uy = p.ly; p.dashT = DASH_T; p.dcd = DASH_CD; return true;
  }
  const fresh = (x, y) => ({ x, y, vx: 0, vy: 0, dx: 0, dy: 0, lx: 1, ly: 0, ux: 1, uy: 0, dashT: 0, dcd: 0, it: false, safe: 0, score: 0 });

  class Host {
    constructor(code) {
      this.code = code; this.seats = new Map(); this.phase = "lobby"; this.host = null; this.nextId = 1; this.solo = false; this.bots = 2;
      this.tGo = 0; this.tEnd = 0; this.tickN = 0; this.fxq = []; this.toast = null;
      let last = performance.now() / 1000, acc = 0;
      this.timer = setInterval(() => {
        const now = performance.now() / 1000; acc += Math.min(.25, now - last); last = now;
        while (acc >= TICK) { acc -= TICK; this.tick(now); }
        this.sweep(Date.now());
      }, 8);
    }
    stop() { clearInterval(this.timer); }
    send(s, o) { if (s.link) try { s.link.send(o); } catch (e) {} }
    broadcast(o) { this.seats.forEach(s => this.send(s, o)); }
    humans() { return [...this.seats.values()].filter(s => !s.bot); }
    lobbyMsg() {
      return { t: "lobby", code: this.code, host: this.host, solo: this.solo, bots: this.bots, phase: this.phase,
        players: [...this.seats.values()].filter(s => !s.bot).map(s => ({ id: s.id, slot: s.slot, name: s.name, away: s.gone != null })) };
    }
    freeSlot() { const used = new Set([...this.seats.values()].map(s => s.slot)); for (let i = 0; i < MAX; i++) if (!used.has(i)) return i; return -1; }

    connect(link) {
      let seat = null;
      return {
        message: m => {
          if (!m || typeof m !== "object") return;
          if (m.t === "ping") { try { link.send({ t: "pong", c: m.c }); } catch (e) {} return; }
          if (!seat) {
            if (m.t !== "hello") return;
            if (this.phase !== "lobby") { link.send({ t: "err", msg: "A round is in progress. Join when it ends." }); return; }
            const slot = this.freeSlot();
            if (slot < 0) { link.send({ t: "err", msg: "This arena is full." }); return; }
            seat = { id: this.nextId++, slot, name: clean(m.name) || NAMES[slot], link, bot: false, gone: null, p: null };
            this.seats.set(seat.id, seat);
            if (this.host == null) this.host = seat.id;
            if (m.mode === "solo") { this.solo = true; this.bots = 3; }
            link.send({ t: "hi", id: seat.id, code: this.code });
            this.broadcast(this.lobbyMsg());
            return;
          }
          this.onMessage(seat, m);
        },
        close: () => {
          if (!seat) return;
          const s = seat; seat = null; s.link = null;
          if (this.phase === "lobby") { this.seats.delete(s.id); this.reassignHost(); this.broadcast(this.lobbyMsg()); }
          else s.gone = Date.now();           // a bot plays on for them
        },
      };
    }
    reassignHost() {
      if (this.seats.has(this.host)) return;
      const h = this.humans().find(s => s.gone == null); this.host = h ? h.id : null;
    }
    onMessage(s, m) {
      if (m.t === "in" && s.p) {
        const x = +m.x, y = +m.y; if (!isFinite(x) || !isFinite(y)) return;
        if (this.phase === "play") { aim(s.p, x, y); if (m.d) dash(s.p); }
      } else if (m.t === "start" && this.host === s.id && this.phase === "lobby") this.begin();
      else if (m.t === "bots" && this.host === s.id && this.phase === "lobby") { this.bots = Math.max(0, Math.min(MAX - this.humans().length, m.v | 0)); this.broadcast(this.lobbyMsg()); }
      else if (m.t === "again" && this.host === s.id && this.phase === "end") this.toLobby();
      else if (m.t === "name" && this.phase === "lobby") { s.name = clean(m.v) || s.name; this.broadcast(this.lobbyMsg()); }
    }

    begin() {
      [...this.seats.values()].filter(s => s.bot).forEach(s => this.seats.delete(s.id));
      const humans = this.humans(), nb = Math.max(0, Math.min(MAX - humans.length, this.bots));
      for (let i = 0; i < nb; i++) { const slot = this.freeSlot(); const id = this.nextId++; this.seats.set(id, { id, slot, name: NAMES[(slot + 3) % 8] + " bot", link: null, bot: true, gone: null, p: null, wob: Math.random() * 6 }); }
      const all = [...this.seats.values()], n = all.length;
      all.forEach((s, i) => { const a = i / n * Math.PI * 2; s.p = fresh(W / 2 + Math.cos(a) * 380, H / 2 + Math.sin(a) * 380); });
      all[Math.floor(Math.random() * n)].p.it = true;
      this.phase = "count"; this.tGo = performance.now() / 1000 + COUNT;
      this.fxq = []; this.toast = null;
      all.forEach(s => this.send(s, { t: "go", in: COUNT, W, H, R, you: s.id, secs: ROUND, cfg: { speed: SPEED, itBoost: IT_BOOST, dashCd: DASH_CD, dashT: DASH_T }, players: all.map(o => ({ id: o.id, slot: o.slot, name: o.name, bot: o.bot })) }));
    }
    toLobby() {
      this.phase = "lobby";
      [...this.seats.values()].forEach(s => { if (s.bot || s.gone != null) this.seats.delete(s.id); else s.p = null; });
      this.reassignHost(); this.broadcast(this.lobbyMsg());
    }
    sweep(now) {
      if (this.phase === "lobby") return;
      if (this.humans().every(s => s.gone != null) && this.phase !== "end") { this.phase = "end"; }
      if (this.phase === "end") [...this.seats.values()].filter(s => s.gone != null && now - s.gone > GRACE).forEach(s => this.seats.delete(s.id));
    }

    bot(s, all) {
      const p = s.p, me = all.filter(o => o !== s); s.wob += .03;
      let tx = 0, ty = 0;
      if (p.it) {
        let best = null, bd = 1e9;
        me.forEach(o => { if (o.p.safe > 0) return; const d = Math.hypot(o.p.x - p.x, o.p.y - p.y); if (d < bd) { bd = d; best = o; } });
        if (best) { const lead = Math.min(.25, bd / 900); tx = best.p.x + best.p.vx * lead - p.x; ty = best.p.y + best.p.vy * lead - p.y; if (bd < 170 && Math.random() < .03) { p.lx = tx; p.ly = ty; const l = Math.hypot(tx, ty) || 1; p.lx /= l; p.ly /= l; dash(p); } }
      } else {
        const it = me.find(o => o.p.it);
        if (it) {
          const dx = p.x - it.p.x, dy = p.y - it.p.y, d = Math.hypot(dx, dy) || 1;
          tx = dx / d; ty = dy / d;
          const edge = 160, k = 2.2;                       // push off the walls so a corner is never a trap
          tx += Math.max(0, (edge - p.x) / edge) * k - Math.max(0, (p.x - (W - edge)) / edge) * k + Math.sin(s.wob) * .35;
          ty += Math.max(0, (edge - p.y) / edge) * k - Math.max(0, (p.y - (H - edge)) / edge) * k + Math.cos(s.wob * 1.3) * .35;
          if (d < 130 && it.p.safe <= 0 && Math.random() < .08) { const l = Math.hypot(tx, ty) || 1; p.lx = tx / l; p.ly = ty / l; dash(p); }
        }
      }
      const l = Math.hypot(tx, ty) || 1; aim(p, tx / l, ty / l);
    }

    tick(now) {
      if (this.phase === "lobby" || this.phase === "end") return;
      const all = [...this.seats.values()].filter(s => s.p);
      if (this.phase === "count") {
        if (now >= this.tGo) { this.phase = "play"; this.tEnd = now + ROUND; }
      } else {
        if ((this.tickN & 3) === 0) all.forEach(s => { if (s.bot || s.gone != null) this.bot(s, all); });
        all.forEach(s => { step(s.p, TICK); if (s.p.safe > 0) s.p.safe -= TICK; if (!s.p.it) s.p.score += TICK; });
        const it = all.find(s => s.p.it);
        if (it) for (const o of all) {
          if (o === it || o.p.safe > 0) continue;
          if (Math.hypot(o.p.x - it.p.x, o.p.y - it.p.y) < 2 * R - 4) {
            it.p.it = false; it.p.safe = SAFE; o.p.it = true;
            this.fxq.push([Math.round((o.p.x + it.p.x) / 2), Math.round((o.p.y + it.p.y) / 2), o.id]);
            this.toast = `${o.name} is IT!`;
            break;
          }
        }
        if (now >= this.tEnd) { this.finish(all); return; }
      }
      if (++this.tickN % SEND_EVERY === 0) this.broadcast(this.snap(now, all));
    }
    snap(now, all) {
      const m = { t: "s", ph: this.phase, left: r1(Math.max(0, (this.phase === "count" ? this.tGo : this.tEnd) - now)),
        p: all.map(s => { const p = s.p; return [s.id, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), p.it ? 1 : 0, r1(Math.max(0, p.safe)), r1(Math.max(0, p.dcd)), Math.floor(p.score), p.dashT > 0 ? 1 : 0]; }) };
      if (this.fxq.length) { m.fx = this.fxq; this.fxq = []; }
      if (this.toast) { m.toast = this.toast; this.toast = null; }
      return m;
    }
    finish(all) {
      this.phase = "end";
      const rank = all.map(s => ({ id: s.id, slot: s.slot, name: s.name, bot: s.bot, score: Math.floor(s.p.score) })).sort((a, b) => b.score - a.score);
      this.broadcast({ t: "end", rank });
    }
  }

  return { Host, step, aim, dash, fresh, W, H, R, DASH_CD };
})();
