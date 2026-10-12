/* THE LAST GARDEN - the tournament, running in the host's browser.
 *
 * server.py's game translated for browser mode (GitHub Pages): whoever
 * creates a tournament runs it in their own tab, and every runner, the
 * organiser's aerial view and the big screen talk to it with exactly the
 * messages they would send the Python server. Keep the two in step.
 *
 *   const host = new GardenSim.Host();
 *   const seat = host.connect({ send(obj) {...} });   // one per phone / admin / board
 *   seat.message(obj); seat.close();
 *
 * Left out compared with the server: the crash snapshot on disk (a tab has
 * no disk; if the host closes the tab the tournament ends).
 */
'use strict';

const GardenSim = (() => {
  const { World, LEVELS, GROUND, DOCK, WALKABLE, DIRS } = WorldGen;

  // ---------------------------------------------------------------- config (as server.py)
  const MOVE_INTERVAL = 0.11, TICK = 0.1, PASSERBY_INTERVAL = 0.5, INTERMISSION = 20, MIN_DELAY = 10, MAX_DELAY = 3600;
  const RESUME_GRACE = 150, PRACTICE_SECONDS = 90;
  const STAGE_NAMES = LEVELS.map(l => l.name), STAGE_CAPS = [300, 50, 10], STAGE_SECONDS = [180, 180, 240], REVEAL_FROM_STAGE = 1;
  const EMOTES = ["\u{1F44B}", "\u{1F602}", "\u{1F631}", "\u{1F4B0}", "\u{1F3C3}", "\u{1F64F}"];
  const EMOTE_COOLDOWN = 1.2, CHAT_COOLDOWN = 2.5, CHAT_MAX = 120, FEED_KEEP = 40;
  const CHEST_RESPAWN = 22, BONUS_PER_ARRIVAL = 3, BONUS_MIN = 18, BONUS_MAX = 40;
  const LOOT_FRAC = 0.28, LOOT_COOLDOWN = 3.0;
  const SANCTUARY_STEPS = 4, LURK_STEPS = 12, LURK_SECONDS = 12, LURK_DECAY = 2.5, BOAT_COOLDOWN = 6;
  const GOLD_POINTS = 10, UNBANKED_SHARE = 0.5, PROGRESS_POINTS = 500, FINISH_BONUS = 200;
  const VIEW_RADIUS = 16, VIEW_MAX = 24;
  const WANDER = 0, PILGRIM = 1, CUTPURSE = 2, SHY = 3;

  const now = () => performance.now() / 1000;          // the server's monotonic clock
  const wall = () => Date.now() / 1000;                 // and its time.time()
  const rnd = Math.random, randint = (a, b) => a + Math.floor(rnd() * (b - a + 1)), choice = a => a[Math.floor(rnd() * a.length)];
  const pyRound = v => Math.round(v);
  const newKey = () => { const b = crypto.getRandomValues(new Uint8Array(12)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const clean = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 16).trim();
  const weighted = (items, weights) => { let r = rnd() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; } return items[items.length - 1]; };

  class Host {
    constructor() {
      this.room = null; this.nextId = 1;
      let lastMeta = 0;
      this.timer = setInterval(() => {
        const t = wall();
        if (this.room) this.tickRoom(this.room, t);
        if (t - lastMeta >= 1) { lastMeta = t; if (this.room && this.room.phase === "play" && this.room.players.size) this.sendMeta(this.room, t); }
      }, TICK * 1000);
    }
    stop() { clearInterval(this.timer); }

    // ---------------------------------------------------------------- rooms
    newRoom(code, startAt) {
      return { code, players: new Map(), admins: new Set(), passersby: [], stage: 0, world: null, phase: "lobby", startAt, t0: 0,
        endsAt: 0, lastWalk: 0, lastChest: 0, history: [], feed: [], champion: null, nextNpc: -1, nextChest: 0, seed: 0, practice: false };
    }
    stageInfo(room) { return { idx: room.stage, name: STAGE_NAMES[room.stage], cap: STAGE_CAPS[room.stage], reveal: room.stage >= REVEAL_FROM_STAGE ? 1 : 0 }; }
    worldMsg(room) {
      const wd = room.world;
      return { W: wd.w, H: wd.h, g: wd.asString(), goal: wd.goal, level: room.stage, chests: wd.chests.map(c => [c.id, c.t, c.v]), docks: wd.docks.map(([a, b]) => [a, b]), shrines: wd.shrines };
    }
    cfgMsg() {
      return { mi: Math.round(MOVE_INTERVAL * 1000), view: VIEW_RADIUS, emotes: EMOTES, revealFrom: REVEAL_FROM_STAGE, sanct: SANCTUARY_STEPS, lurkSteps: LURK_STEPS, lurkSecs: LURK_SECONDS,
        stages: STAGE_NAMES.map((n, i) => ({ name: n, cap: STAGE_CAPS[i], secs: STAGE_SECONDS[i] })) };
    }
    send(p, o) { if (p.link) p.link.send(o); }
    broadcast(room, o) { room.players.forEach(p => this.send(p, o)); }
    broadcastAdmins(room, o) { room.admins.forEach(a => a.send(o)); }
    lobbyMsg(room) { return { t: "lobby", code: room.code, startIn: Math.max(0, pyRound(room.startAt - wall())), stage: this.stageInfo(room), n: room.players.size }; }

    // ---------------------------------------------------------------- scoring
    scoreOf(p) {
      let s = pyRound(p.banked * GOLD_POINTS) + pyRound(p.money * GOLD_POINTS * UNBANKED_SHARE) + pyRound(p.best * PROGRESS_POINTS);
      if (p.fin) s += FINISH_BONUS;
      return s;
    }
    ranked(room) {
      return [...room.players.values()].sort((a, b) => (this.scoreOf(b) - this.scoreOf(a)) || (b.banked - a.banked) || (b.best - a.best) || (b.trips - a.trips) || (a.id - b.id));
    }
    inSanctuary(wd, e) { if (!wd) return false; const d = wd.dist[e.t]; return d >= 0 && d <= SANCTUARY_STEPS; }
    posMsg(p, force = false, boat = false) {
      const wd = p.room ? p.room.world : null;
      const m = { t: "p", x: p.x, y: p.y, s: p.seq, money: p.money, face: p.face, left: wd ? wd.dist[p.t] : 0, prog: pyRound(p.best * 100), bank: p.banked, sc: this.scoreOf(p) };
      if (wd) { if (this.inSanctuary(wd, p)) m.safe = 1; if (p.lurk >= LURK_SECONDS) m.lurk = 1; }
      if (force) m.f = 1; if (boat) m.boat = 1; if (p.fin) m.fin = 1;
      return m;
    }
    place(p, t, wd) { p.t = t; p.x = t % wd.w; p.y = Math.floor(t / wd.w); }
    resetPlayer(room, p) {
      this.place(p, choice(room.world.spawn), room.world);
      Object.assign(p, { got: new Set(), money: 0, banked: 0, trips: 0, fin: false, tok: 1, face: 2, lm: now(), lastO: null, lootCd: 0, boatCd: 0, emCd: 0, chatCd: 0, lurk: 0, score: 0 });
      p.best = room.world.progress(p.t);
    }

    // ---------------------------------------------------------------- looting
    doLoot(a, b, wd) {
      const t = now();
      if (t < a.lootCd || t < b.lootCd || a.money === b.money) return null;
      if (this.inSanctuary(wd, a) || this.inSanctuary(wd, b)) return "sanctuary";
      const [rich, poor] = a.money > b.money ? [a, b] : [b, a];
      if ((poor.lurk || 0) >= LURK_SECONDS) return "lurking";
      const amount = Math.max(1, pyRound(rich.money * LOOT_FRAC));
      rich.money -= amount; poor.money += amount;
      rich.lootCd = poor.lootCd = t + LOOT_COOLDOWN;
      return [rich, poor, amount];
    }
    noteLoot(e, delta, fromPlayer) { if (e.isPlayer) this.send(e, { t: "loot", d: delta, who: fromPlayer ? 1 : 0, money: e.money }); }
    noteBlocked(e, why) { if (e.isPlayer) this.send(e, { t: "safe", why }); }
    spawnChests(room, count, bonus = false) {
      const wd = room.world;
      if (!wd || wd.chests.length > Math.floor(wd.floors.length / 18)) return [];
      const taken = new Set(wd.chests.map(c => c.t)); room.players.forEach(p => taken.add(p.t));
      const spots = wd.floors.filter(t => wd.g[t] === GROUND && !taken.has(t) && wd.dist[t] > 4);
      if (!spots.length) return [];
      const made = [];
      for (let i = 0; i < count; i++) {
        const t = choice(spots), cid = room.nextChest++, v = bonus ? randint(BONUS_MIN, BONUS_MAX) : randint(5, 20);
        wd.chests.push({ id: cid, t, v }); made.push([cid, t, v, bonus ? 1 : 0]); taken.add(t);
      }
      if (made.length) {
        this.broadcast(room, { t: "chestAdd", l: made });
        if (room.admins.size) this.broadcastAdmins(room, { t: "adminChests", l: wd.chests.map(c => [c.id, c.t, c.v]) });
      }
      return made;
    }

    // ---------------------------------------------------------------- stages
    startStage(room) {
      room.feed = [];
      room.seed = Math.floor(rnd() * 2 ** 31);
      room.world = new World(room.stage, room.seed);
      room.phase = "play"; room.t0 = wall();
      room.endsAt = room.t0 + (room.practice ? PRACTICE_SECONDS : STAGE_SECONDS[room.stage]);
      room.lastWalk = room.lastChest = room.t0;
      room.nextChest = room.world.chests.length;
      room.passersby = [];
      for (let i = 0; i < room.world.nPassersby; i++) {
        const kind = weighted([WANDER, PILGRIM, CUTPURSE, SHY], [34, 30, 22, 14]);
        room.passersby.push({ id: room.nextNpc--, t: choice(room.world.floors), money: randint(0, 40), lootCd: 0, face: 0, kind, isPlayer: false });
      }
      this.broadcast(room, { t: "n", stage: this.stageInfo(room), secs: STAGE_SECONDS[room.stage], ...this.worldMsg(room) });
      room.players.forEach(p => { this.resetPlayer(room, p); this.send(p, this.posMsg(p, true)); });
      if (room.admins.size) {
        this.broadcastAdmins(room, { t: "adminMaze", ...this.worldMsg(room) });
        this.broadcastAdmins(room, { t: "adminStage", stage: this.stageInfo(room), phase: room.phase, history: room.history, champion: room.champion });
      }
    }
    endStage(room, t) {
      room.players.forEach(p => p.score = this.scoreOf(p));
      let ranked = this.ranked(room);
      room.history.push({ stage: room.stage, name: STAGE_NAMES[room.stage], top: ranked.slice(0, 10).map(p => [p.name, p.score, p.banked + p.money, pyRound(p.best * 100)]) });
      if (room.practice) {
        room.phase = "done";
        ranked.forEach(p => this.send(p, { t: "tourEnd", champion: p.name, practice: 1, score: p.score, money: p.banked + p.money, prog: pyRound(p.best * 100), history: room.history }));
        return;
      }
      const nxt = room.stage + 1;
      if (nxt < STAGE_CAPS.length && ranked.length > 1) {
        const cut = STAGE_CAPS[nxt];
        ranked = ranked.filter(p => p.gone == null).concat(ranked.filter(p => p.gone != null));
        const qualifiers = ranked.slice(0, cut), out = ranked.slice(cut);
        out.forEach((p, i) => { this.send(p, { t: "eliminated", rank: cut + i + 1, score: p.score, money: p.banked + p.money, bank: p.banked, prog: pyRound(p.best * 100), stage: STAGE_NAMES[room.stage] }); p.room = null; });
        room.players = new Map(qualifiers.map(p => [p.id, p]));
        room.stage = nxt; room.phase = "lobby"; room.startAt = t + INTERMISSION; room.passersby = [];
        this.broadcast(room, { t: "qualified", stage: STAGE_NAMES[room.stage], startIn: INTERMISSION });
      } else {
        const champ = ranked[0] || null;
        room.champion = champ ? champ.name : null; room.phase = "done"; room.passersby = [];
        this.broadcast(room, { t: "tourEnd", champion: room.champion, top: ranked.slice(0, 10).map(p => [p.name, p.score, p.banked + p.money]) });
      }
      this.broadcastAdmins(room, { t: "adminStage", stage: this.stageInfo(room), phase: room.phase, history: room.history, champion: room.champion });
    }

    // ---------------------------------------------------------------- talk
    who(room, p) { return room.stage >= REVEAL_FROM_STAGE ? p.name : "someone"; }
    feed(room, text) {
      room.feed.push(text); room.feed = room.feed.slice(-FEED_KEEP);
      this.broadcast(room, { t: "feed", x: text }); this.broadcastAdmins(room, { t: "adminFeed", x: text });
    }
    onEmote(p, idx) {
      const room = p.room, t = now();
      if (!room || room.phase !== "play" || t < p.emCd) return;
      p.emCd = t + EMOTE_COOLDOWN;
      room.players.forEach(q => { if (Math.abs(q.x - p.x) <= VIEW_RADIUS && Math.abs(q.y - p.y) <= VIEW_RADIUS) this.send(q, { t: "em", id: p.id, e: idx }); });
    }
    onSay(p, text) {
      const room = p.room, t = now();
      if (!room || room.stage < STAGE_NAMES.length - 1) { this.send(p, { t: "sayErr", msg: "Open talk opens in the final." }); return; }
      if (t < p.chatCd) return;
      text = String(text || "").split(/\s+/).filter(Boolean).join(" ").slice(0, CHAT_MAX);
      if (!text) return;
      p.chatCd = t + CHAT_COOLDOWN;
      this.broadcast(room, { t: "say", n: p.name, x: text }); this.broadcastAdmins(room, { t: "adminSay", n: p.name, x: text });
    }
    adminControl(adm, what, arg) {
      const room = adm.room; if (!room) return;
      const t = wall();
      if (what === "start" && room.phase === "lobby" && room.players.size) { room.startAt = t; this.feed(room, "The organiser started the level"); }
      else if (what === "extend") {
        const secs = Math.max(-300, Math.min(300, parseInt(arg || 60, 10) || 60));
        if (room.phase === "play") { room.endsAt += secs; this.broadcast(room, { t: "ann", x: `${secs >= 0 ? "+" : ""}${secs} seconds on the clock` }); }
        else if (room.phase === "lobby") room.startAt = Math.max(t, room.startAt + secs);
      } else if (what === "end" && room.phase === "play") room.endsAt = t;
      else if (what === "kick") {
        const p = room.players.get(parseInt(arg || 0, 10));
        if (p) { this.send(p, { t: "err", msg: "The organiser removed you from this tournament." }); room.players.delete(p.id); p.room = null; if (p.link && p.link.kick) p.link.kick(); }
      }
      adm.send({ t: "adminStage", stage: this.stageInfo(room), phase: room.phase, startIn: Math.max(0, pyRound(room.startAt - t)), tl: room.phase === "play" ? Math.max(0, Math.floor(room.endsAt - t)) : 0 });
    }
    onAnnounce(adm, text) {
      const room = adm.room; if (!room) return;
      text = String(text || "").split(/\s+/).filter(Boolean).join(" ").slice(0, CHAT_MAX);
      if (!text) return;
      this.broadcast(room, { t: "ann", x: text }); this.broadcastAdmins(room, { t: "adminSay", n: "Organiser", x: text });
    }

    // ---------------------------------------------------------------- movement
    onMove(p, d, seq) {
      const room = p.room, t = now();
      p.seq = seq;
      p.tok = Math.min(3, p.tok + (t - p.lm) / MOVE_INTERVAL); p.lm = t;
      if (!room || room.phase !== "play" || p.tok < 1) { this.send(p, this.posMsg(p)); return; }
      const wd = room.world;
      p.face = d;
      const nt = p.t + DIRS[d][0] + DIRS[d][1] * wd.w;
      if (!(nt >= 0 && nt < wd.w * wd.h) || !WALKABLE.has(wd.g[nt])) { this.send(p, this.posMsg(p)); return; }
      p.tok -= 1;
      this.place(p, nt, wd);
      p.best = Math.max(p.best, wd.progress(nt));
      for (const c of wd.chests) if (c.t === nt && !p.got.has(c.id)) { p.got.add(c.id); p.money += c.v; this.send(p, { t: "chest", id: c.id, v: c.v, money: p.money }); }
      let met = false;
      for (const q of room.players.values()) {
        if (q !== p && q.gone == null && q.t === nt) {
          const r = this.doLoot(p, q, wd);
          if (typeof r === "string") { this.noteBlocked(p, r); this.noteBlocked(q, r); }
          else if (r) { this.noteLoot(r[0], -r[2], true); this.noteLoot(r[1], r[2], true); if (r[2] >= 10) this.feed(room, `${this.who(room, r[1])} took ${r[2]} gold from ${this.who(room, r[0])}`); }
          met = true; break;
        }
      }
      if (!met) for (const npc of room.passersby) if (npc.t === nt) {
        const r = this.doLoot(p, npc, wd);
        if (typeof r === "string") this.noteBlocked(p, r);
        else if (r) { this.noteLoot(r[0], -r[2], false); this.noteLoot(r[1], r[2], false); }
        break;
      }
      if (wd.g[nt] === DOCK && t >= p.boatCd) {
        for (const [a, b] of wd.docks) if (nt === a || nt === b) {
          p.boatCd = t + BOAT_COOLDOWN;
          this.place(p, nt === a ? b : a, wd);
          p.best = Math.max(p.best, wd.progress(p.t));
          this.send(p, this.posMsg(p, true, true));
          return;
        }
      }
      if (nt === wd.goal) {
        const first = !p.fin, dropped = p.money;
        p.banked += dropped; p.money = 0; p.fin = true; p.best = 1; p.trips++; p.lurk = 0;
        if (dropped || first) {
          this.spawnChests(room, first ? BONUS_PER_ARRIVAL : 1, true);
          this.send(p, { t: "banked", added: dropped, bank: p.banked, trips: p.trips });
          if (dropped) this.feed(room, `${this.who(room, p)} laid ${dropped} gold at the idol`);
        }
        if (first) { this.broadcast(room, { t: "reached", id: p.id }); this.feed(room, `${this.who(room, p)} reached the idol`); }
      }
      this.send(p, this.posMsg(p));
    }
    walkPassersby(room) {
      const wd = room.world, here = [...room.players.values()].filter(p => p.gone == null).map(p => [p.x, p.y, p]);
      for (const npc of room.passersby) {
        const opts = [];
        DIRS.forEach(([dx, dy], d) => { const nt = npc.t + dx + dy * wd.w; if (nt >= 0 && nt < wd.w * wd.h && WALKABLE.has(wd.g[nt])) opts.push([d, nt]); });
        if (!opts.length) continue;
        const nx = npc.t % wd.w, ny = Math.floor(npc.t / wd.w);
        let near = null;
        if ((npc.kind === CUTPURSE || npc.kind === SHY) && here.length) {
          near = here.reduce((m, e) => Math.abs(e[0] - nx) + Math.abs(e[1] - ny) < Math.abs(m[0] - nx) + Math.abs(m[1] - ny) ? e : m);
          if (Math.abs(near[0] - nx) + Math.abs(near[1] - ny) > 9) near = null;
        }
        let pick;
        if (near) {
          const want = npc.kind === CUTPURSE ? 1 : -1;
          const toward = o => want * (Math.abs(near[0] - o[1] % wd.w) + Math.abs(near[1] - Math.floor(o[1] / wd.w)));
          pick = rnd() < .8 ? opts.reduce((m, o) => toward(o) < toward(m) ? o : m) : choice(opts);
        } else {
          const ahead = opts.filter(o => o[0] === npc.face);
          pick = ahead.length && rnd() < (npc.kind === PILGRIM ? .88 : .65) ? ahead[0] : choice(opts);
        }
        [npc.face, npc.t] = pick;
        for (const p of room.players.values()) if (p.gone == null && p.t === npc.t) {
          const r = this.doLoot(p, npc, wd);
          if (typeof r === "string") this.noteBlocked(p, r);
          else if (r) { this.noteLoot(r[0], -r[2], false); this.noteLoot(r[1], r[2], false); }
          break;
        }
      }
    }

    // ---------------------------------------------------------------- fan-out
    tickLurk(room, dt) {
      const wd = room.world; if (!wd) return;
      room.players.forEach(p => {
        if (p.gone != null) return;
        const d = wd.dist[p.t];
        if (d >= 0 && d <= LURK_STEPS) p.lurk = Math.min(LURK_SECONDS * 2, p.lurk + dt);
        else if (p.lurk > 0) p.lurk = Math.max(0, p.lurk - dt * LURK_DECAY);
      });
    }
    broadcastNear(room) {
      const wd = room.world, ps = [...room.players.values()].filter(q => q.gone == null), reveal = room.stage >= REVEAL_FROM_STAGE;
      const ents = ps.map(e => [e.id, e.x, e.y, reveal ? e.name : ""]).concat(room.passersby.map(n => [n.id, n.t % wd.w, Math.floor(n.t / wd.w), ""]));
      for (const p of ps) {
        const near = [];
        for (const e of ents) { if (e[0] !== p.id && Math.abs(e[1] - p.x) <= VIEW_RADIUS && Math.abs(e[2] - p.y) <= VIEW_RADIUS) { near.push(e); if (near.length >= VIEW_MAX) break; } }
        const key = JSON.stringify(near);
        if (key !== p.lastO) { p.lastO = key; this.send(p, { t: "o", l: near }); }
      }
      if (room.admins.size) this.broadcastAdmins(room, { t: "adminPos", p: ps.map(e => [e.id, e.name, e.x, e.y, e.banked + e.money, e.fin ? 1 : 0, this.scoreOf(e)]) });
    }
    sendMeta(room, t) {
      const reveal = room.stage >= REVEAL_FROM_STAGE, ps = this.ranked(room);
      const top = ps.slice(0, 8).map(p => [reveal ? p.name : "Runner", this.scoreOf(p), p.banked + p.money, pyRound(p.best * 100)]);
      const left = Math.max(0, Math.floor(room.endsAt - t)), wd = room.world;
      ps.forEach((p, i) => {
        const m = { t: "m", n: ps.length, tl: left, lb: top, rk: i + 1, sc: this.scoreOf(p), money: p.money, prog: pyRound(p.best * 100) };
        if (wd) { if (this.inSanctuary(wd, p)) m.safe = 1; if (p.lurk >= LURK_SECONDS) m.lurk = 1; else if (p.lurk > LURK_SECONDS * .6) m.lurkSoon = 1; }
        this.send(p, m);
      });
      if (room.admins.size) this.broadcastAdmins(room, { t: "adminMeta", n: ps.length, tl: left, lb: ps.slice(0, 20).map(p => [p.name, this.scoreOf(p), p.banked + p.money, pyRound(p.best * 100)]) });
    }
    tickRoom(room, t) {
      if (room.phase === "lobby") {
        if (t >= room.startAt && room.players.size) this.startStage(room); else this.broadcast(room, this.lobbyMsg(room));
      } else if (room.phase === "play") {
        const m = now();
        [...room.players.values()].filter(q => q.gone != null && m - q.gone > RESUME_GRACE).forEach(q => { room.players.delete(q.id); q.room = null; });
        this.tickLurk(room, TICK);
        if (t - room.lastWalk >= PASSERBY_INTERVAL) { room.lastWalk = t; this.walkPassersby(room); }
        if (t - room.lastChest >= CHEST_RESPAWN) { room.lastChest = t; this.spawnChests(room, 2 + Math.floor(room.players.size / 40)); }
        if (t >= room.endsAt) this.endStage(room, t); else this.broadcastNear(room);
      }
    }

    // ---------------------------------------------------------------- joining
    newPlayer(link, name) {
      const p = { id: this.nextId++, isPlayer: true, link, room: null, seq: 0, score: 0, x: 0, y: 0, t: 0, money: 0, banked: 0, trips: 0, fin: false, best: 0, face: 2,
        got: new Set(), lastO: null, tok: 1, lm: now(), lootCd: 0, boatCd: 0, emCd: 0, chatCd: 0, lurk: 0, key: newKey(), gone: null };
      p.name = clean(name) || "Runner" + randint(100, 999);
      return p;
    }
    joinRoom(p, room) {
      if (room.practice) { this.send(p, { t: "err", msg: "That code belongs to a practice run." }); return false; }
      if (room.stage !== 0 || room.phase === "done") { this.send(p, { t: "err", msg: "This tournament has already moved past the first level." }); return false; }
      if (room.players.size >= STAGE_CAPS[0]) { this.send(p, { t: "err", msg: "This tournament is full (300 runners)." }); return false; }
      p.room = room; room.players.set(p.id, p);
      this.send(p, { t: "w", id: p.id, code: room.code, ph: room.phase, key: p.key, stage: this.stageInfo(room), cfg: this.cfgMsg() });
      if (room.phase === "lobby") this.broadcast(room, this.lobbyMsg(room));
      else { this.resetPlayer(room, p); this.send(p, { t: "n", stage: this.stageInfo(room), secs: Math.max(1, Math.floor(room.endsAt - wall())), ...this.worldMsg(room) }); this.send(p, this.posMsg(p, true)); }
      return true;
    }
    // the host tab owns one tournament; Net hands it the code it is listening on
    createRoom(p, code, delay, practice) {
      if (this.room) { this.send(p, { t: "err", msg: "This tab is already running a tournament." }); return null; }
      const room = this.newRoom(code, wall() + (practice ? 2 : Math.max(MIN_DELAY, Math.min(MAX_DELAY, parseInt(delay || MIN_DELAY, 10) || MIN_DELAY))));
      room.practice = !!practice; this.room = room;
      if (practice) {
        p.room = room; room.players.set(p.id, p);
        this.send(p, { t: "w", id: p.id, code: room.code, ph: room.phase, key: p.key, stage: this.stageInfo(room), cfg: this.cfgMsg(), practice: 1 });
        this.broadcast(room, this.lobbyMsg(room));
      } else this.joinRoom(p, room);
      return room;
    }
    dropSocket(p, link) {
      const room = p.room;
      if (p.link !== link || !room) return;
      if (room.phase === "lobby") { room.players.delete(p.id); p.room = null; this.broadcast(room, this.lobbyMsg(room)); return; }
      p.gone = now(); p.lastO = null; p.link = null;
    }
    resumePlayer(link, code, key) {
      const room = this.room;
      if (!room || room.code !== String(code || "").trim().toUpperCase()) { link.send({ t: "err", msg: "That tournament is no longer running." }); return null; }
      for (const p of room.players.values()) if (p.key === key) {
        p.link = link; p.gone = null; p.lastO = null; p.lm = now(); p.tok = 1;
        this.send(p, { t: "w", id: p.id, code: room.code, ph: room.phase, key: p.key, stage: this.stageInfo(room), cfg: this.cfgMsg(), resumed: 1 });
        if (room.phase === "play" && room.world) {
          this.send(p, { t: "n", stage: this.stageInfo(room), secs: Math.max(1, Math.floor(room.endsAt - wall())), ...this.worldMsg(room) });
          this.send(p, this.posMsg(p, true));
          this.send(p, { t: "banked", added: 0, bank: p.banked, trips: p.trips });
          room.feed.slice(-6).forEach(line => this.send(p, { t: "feed", x: line }));
        } else this.send(p, this.lobbyMsg(room));
        return p;
      }
      link.send({ t: "err", msg: "We could not find your place in that tournament." });
      return null;
    }
    joinAdmin(link, code) {
      const room = this.room;
      if (!room || room.code !== code) { link.send({ t: "err", msg: "No tournament with that ID." }); return null; }
      const a = { send: o => link.send(o), room };
      room.admins.add(a);
      a.send({ t: "adminHi", code: room.code, stage: this.stageInfo(room), phase: room.phase, history: room.history, champion: room.champion });
      if (room.world) a.send({ t: "adminMaze", ...this.worldMsg(room) });
      return a;
    }

    // one phone, organiser view or big screen: the same messages as the server's WebSocket
    connect(link, code) {
      let p = null, adm = null;
      return {
        message: m => {
          if (!m || typeof m !== "object") return;
          const t = m.t;
          if (!p && !adm) {
            if (t === "hi") {
              p = this.newPlayer(link, m.name);
              if (m.mode === "join") {
                const room = this.room;
                if (!room || room.code !== String(m.code || "").trim().toUpperCase()) { link.send({ t: "err", msg: "That tournament code was not found." }); p = null; }
                else if (!this.joinRoom(p, room)) p = null;
              } else if (!this.createRoom(p, code, m.delay, m.mode === "practice")) p = null;
            } else if (t === "resume") p = this.resumePlayer(link, m.code, String(m.key || ""));
            else if (t === "admin") adm = this.joinAdmin(link, String(m.code || "").trim().toUpperCase());
            return;
          }
          if (p && t === "m") { if (Number.isInteger(m.d) && m.d >= 0 && m.d < 4 && Number.isInteger(m.s)) this.onMove(p, m.d, m.s); }
          else if (p && t === "em") { if (Number.isInteger(m.e) && m.e >= 0 && m.e < EMOTES.length) this.onEmote(p, m.e); }
          else if (p && t === "say") this.onSay(p, m.x);
          else if (adm && t === "ann") this.onAnnounce(adm, m.x);
          else if (adm && t === "ctl") this.adminControl(adm, String(m.k || ""), m.v);
        },
        close: () => { if (p) this.dropSocket(p, link); if (adm && adm.room) adm.room.admins.delete(adm); },
      };
    }
  }
  return { Host };
})();
