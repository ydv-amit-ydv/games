/* Relay: game messages through a public MQTT broker, over an ordinary secure
 * WebSocket - the same kind of connection any web page makes. Unlike a direct
 * browser-to-browser link (WebRTC) it opens no network ports, so the browser
 * and the computer's firewall never ask "allow ... on public / private
 * networks?", and it works on networks that block direct links.
 *
 * Shared by Bumblebloom and The Last Garden (keep the two copies the same).
 *
 *   host:  Relay.host({ prefix, code: () => code, connect: send => seat, thin, onState })
 *          seat = { message(obj), close() }  (the game's own seat for one player)
 *   guest: Relay.guest({ prefix, code, first, deliver, closed, claim, onNoRelay, onWait })
 *          -> { send(obj), close() }
 *
 * Topics: <prefix>/<CODE>/h        players -> host   {g, m} {g, q} {g, p} {g, x}
 *         <prefix>/<CODE>/g/<id>   host -> one player
 *         <prefix>/<CODE>/all      host -> every player on that broker at once
 * Anyone who knows the code can join the game anyway; nothing private is sent.
 */
'use strict';

const Relay = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  // free public brokers with WebSocket over TLS; ?relay=wss://...,wss://... to use others, ?relay=off for none
  const DEFAULT = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt", "wss://test.mosquitto.org:8081/mqtt"];
  const URLS = (() => {
    try {
      const q = new URLSearchParams(location.search).get("relay");
      if (q) localStorage.setItem("game-relay", q === "default" ? "" : q);
      const v = localStorage.getItem("game-relay") || "";
      return v === "off" ? [] : v ? v.split(",") : DEFAULT;
    } catch (e) { return DEFAULT; }
  })();
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);

  // ---------------------------------------------------------------- MQTT 3.1.1, the small part we need
  function varint(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0); return out; }
  function concat(parts) {
    let n = 0; parts.forEach(p => n += p.length);
    const out = new Uint8Array(n); let i = 0; parts.forEach(p => { out.set(p, i); i += p.length; }); return out;
  }
  const str = s => { const b = enc.encode(s); return concat([Uint8Array.of(b.length >> 8, b.length & 255), b]); };
  const packet = (head, body) => concat([Uint8Array.of(head), Uint8Array.from(varint(body.length)), body]);

  class Client {
    constructor(url, onMessage, onState) {
      this.url = url; this.onMessage = onMessage; this.onState = onState;
      this.ws = null; this.up = false; this.dead = false; this.subs = new Set(); this.queue = []; this.buf = new Uint8Array(0);
      this.pid = 1; this.tries = 0; this.ping = 0;
      this.open();
    }
    open() {
      if (this.dead) return;
      let ws;
      try { ws = this.ws = new WebSocket(this.url, ["mqtt"]); } catch (e) { this.retry(); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        const body = concat([str("MQTT"), Uint8Array.of(4, 0x02, 0, 60), str("g" + rid())]);   // clean session, 60 s keep-alive
        ws.send(packet(0x10, body));
      };
      ws.onmessage = e => this.read(new Uint8Array(e.data));
      ws.onclose = () => { const was = this.up; this.up = false; clearInterval(this.ping); if (was) this.onState && this.onState(this, "down"); this.retry(); };
      ws.onerror = () => {};
    }
    retry() { if (this.dead) return; const wait = Math.min(8000, 800 * 2 ** this.tries++); setTimeout(() => this.open(), wait); }
    read(chunk) {
      let b = this.buf.length ? concat([this.buf, chunk]) : chunk, i = 0;
      while (b.length - i >= 2) {
        let len = 0, mul = 1, j = i + 1, byte;
        do { if (j >= b.length) { this.buf = b.slice(i); return; } byte = b[j++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
        if (b.length < j + len) break;
        this.packet(b[i], b.subarray(j, j + len));
        i = j + len;
      }
      this.buf = b.slice(i);
    }
    packet(head, body) {
      const type = head >> 4;
      if (type === 2) {                          // CONNACK
        if (body[1] !== 0) { this.ws.close(); return; }
        this.up = true; this.tries = 0;
        this.subs.forEach(t => this.sendSub(t));
        const q = this.queue; this.queue = []; q.forEach(p => this.ws.send(p));
        clearInterval(this.ping); this.ping = setInterval(() => { if (this.up) this.ws.send(Uint8Array.of(0xc0, 0)); }, 25000);
        this.onState && this.onState(this, "up");
      } else if (type === 3) {                   // PUBLISH
        const tl = (body[0] << 8) | body[1], topic = dec.decode(body.subarray(2, 2 + tl));
        const qos = (head >> 1) & 3, start = 2 + tl + (qos ? 2 : 0);
        this.onMessage(topic, dec.decode(body.subarray(start)));
      }                                          // SUBACK, PINGRESP: nothing to do
    }
    sendSub(topic) {
      const id = this.pid = (this.pid % 65535) + 1;
      this.ws.send(packet(0x82, concat([Uint8Array.of(id >> 8, id & 255), str(topic), Uint8Array.of(0)])));
    }
    subscribe(topic) { if (this.subs.has(topic)) return; this.subs.add(topic); if (this.up) this.sendSub(topic); }
    // lossy: a snapshot that would wait behind a backlog is dropped, since the next one replaces it (a backlog is what turns a slow link into lag)
    publish(topic, text, lossy) {
      const p = packet(0x30, concat([str(topic), enc.encode(text)]));
      if (this.up) { if (this.ws.bufferedAmount < (lossy ? 16e3 : 2e6)) this.ws.send(p); }
      else if (this.queue.length < 50) this.queue.push(p);
    }
    close() { this.dead = true; this.up = false; clearInterval(this.ping); try { this.ws && this.ws.close(); } catch (e) {} }
  }

  // ---------------------------------------------------------------- the host tab
  // Listens on every broker at once (players use whichever their network reaches).
  function host(o) {
    const guests = new Map();                    // player id -> { id, c, seat, last, open }
    let base = "", stopped = false;
    const topicFor = () => `${o.prefix}/${o.code()}`;
    const pend = new Map();                      // message -> players it goes to (one broadcast is one object)
    const flush = () => {
      const items = [...pend]; pend.clear();
      for (const [msg, set] of items) {
        const out = o.thin ? o.thin(msg) : msg; if (!out) continue;
        const text = JSON.stringify(out), lossy = out.t === "s";
        clients.forEach(c => {
          const to = [...set].filter(g => g.c === c), all = [...guests.values()].filter(g => g.c === c && g.open);
          if (to.length > 1 && to.length === all.length) c.publish(base + "/all", text, lossy);
          else to.forEach(g => c.publish(base + "/g/" + g.id, text, lossy));
        });
      }
    };
    const out = (g, msg) => { let s = pend.get(msg); if (!s) { s = new Set(); pend.set(msg, s); if (pend.size === 1) queueMicrotask(flush); } s.add(g); };
    const direct = (g, msg) => g.c.publish(base + "/g/" + g.id, JSON.stringify(msg));
    const drop = g => { if (!guests.has(g.id)) return; guests.delete(g.id); try { g.seat && g.seat.close(); } catch (e) {} };
    const onMessage = c => (topic, text) => {
      if (stopped || topic !== base + "/h") return;
      let e; try { e = JSON.parse(text); } catch (err) { return; }
      if (!e || typeof e.g !== "string" || e.g.length > 16) return;
      let g = guests.get(e.g);
      if (e.q) { direct({ id: e.g, c }, { _r: 1 }); return; }     // "are you there?" - yes, on this broker
      if (e.x) { if (g) drop(g); return; }
      if (!g) {
        if (!e.m) return;
        g = { id: e.g, c, seat: null, last: Date.now(), open: true };
        guests.set(g.id, g);
        g.seat = o.connect({ send: m => { if (guests.get(g.id) === g) out(g, m); }, kick: () => { direct(g, { _k: 1 }); drop(g); } });
      }
      g.last = Date.now();
      if (e.p) { direct(g, { _r: 1 }); return; }
      if (e.m && typeof e.m === "object") g.seat.message(e.m);
    };
    const state = () => o.onState && o.onState(clients.some(c => c.up));
    const clients = URLS.map(u => { const c = new Client(u, null, () => state()); c.onMessage = onMessage(c); return c; });
    const listen = () => { base = topicFor(); clients.forEach(c => c.subscribe(base + "/h")); };
    listen();
    // a player who has gone quiet (closed the tab, lost the network) leaves their seat; the game keeps it for a while
    const sweep = setInterval(() => { const now = Date.now(); guests.forEach(g => { if (now - g.last > 20000) drop(g); }); }, 5000);
    return {
      get up() { return clients.some(c => c.up); },
      retopic: () => { guests.forEach(drop); listen(); },     // the code changed before anyone joined
      close: () => { stopped = true; clearInterval(sweep); guests.forEach(drop); clients.forEach(c => c.close()); },
    };
  }

  // ---------------------------------------------------------------- a player in another browser
  // Asks every broker "is garden CODE here?" and uses the first that answers.
  // claim("relay") must return true before the first message is sent, so the
  // direct link and the relay never both take a seat.
  function guest(o) {
    const id = rid(), base = `${o.prefix}/${o.code}`;
    let chosen = null, done = false, last = 0, beat = 0, probe = 0, gated = false;
    const clients = URLS.map(u => new Client(u, null, null));
    const finish = () => { if (done) return; done = true; clearInterval(beat); clearInterval(probe); clients.forEach(c => c.close()); };
    const api = {
      send: m => { if (chosen && !done) chosen.publish(base + "/h", JSON.stringify({ g: id, m })); },
      close: () => {
        if (done) return;
        if (chosen) chosen.publish(base + "/h", JSON.stringify({ g: id, x: 1 }));   // "I'm leaving"
        done = true; clearInterval(beat); clearInterval(probe);
        setTimeout(() => clients.forEach(c => c.close()), 200);
        o.closed && o.closed();
      },
      quiet: () => finish(),                     // the other route won: go away without telling the page
    };
    clients.forEach(c => {
      c.subscribe(base + "/g/" + id); c.subscribe(base + "/all");
      c.onMessage = (topic, text) => {
        if (done) return;
        let m; try { m = JSON.parse(text); } catch (e) { return; }
        if (!chosen) {
          if (!(topic.endsWith("/g/" + id) && m && m._r)) return;
          if (o.claim && !o.claim("relay")) { finish(); return; }
          chosen = c; clearInterval(probe);
          clients.forEach(x => { if (x !== c) x.close(); });
          c.publish(base + "/h", JSON.stringify({ g: id, m: o.first }));
          last = Date.now();
          beat = setInterval(() => {
            if (done) return;
            c.publish(base + "/h", JSON.stringify({ g: id, p: 1 }));
            if (Date.now() - last > 15000) { finish(); o.closed && o.closed(); }   // the host has gone quiet
          }, 4000);
          return;
        }
        if (c !== chosen) return;
        last = Date.now();
        if (m && m._r) return;
        if (m && m._k) { finish(); o.closed && o.closed(); return; }
        if (topic.endsWith("/all") && !gated) return;      // broadcasts count once the host has spoken to us
        if (topic.endsWith("/g/" + id)) gated = true;
        o.deliver(m);
      };
    });
    const ask = () => clients.forEach(c => { if (c.up) c.publish(base + "/h", JSON.stringify({ g: id, q: 1 })); });
    probe = setInterval(ask, 2500); setTimeout(ask, 300);
    // no broker reachable from this network at all: say so, so the direct link can take over
    setTimeout(() => { if (!done && !chosen && !clients.some(c => c.up)) o.onNoRelay && o.onNoRelay(); }, 5000);
    return api;
  }

  return { host, guest, Client, get urls() { return URLS; } };
})();
