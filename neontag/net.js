/* NEON TAG - how a screen reaches the game.
 *
 * Two ways, chosen once when the page loads:
 *
 *   server mode   the page came from `python server.py`: one WebSocket per
 *                 player to that server, exactly as before.
 *   browser mode  no server (GitHub Pages, or the files opened directly):
 *                 whoever makes the garden runs sim.js in their own tab, and
 *                 everyone else connects to that tab peer-to-peer over WebRTC.
 *                 PeerJS's free public broker only introduces the browsers;
 *                 the garden code is the host tab's address on it.
 *
 * Either way a player sees the same messages, so the pages don't care which.
 *
 *   await Net.ready()                                   -> "server" | "browser"
 *   const link = Net.open(firstMessage, onMessage, onClose)
 *   link.send(obj); link.close();
 */
'use strict';

const Net = (() => {
  const PEERJS = ["https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js", "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"];
  const PREFIX = "neontag-arena-", RELAY_PREFIX = "neontag/v1";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let mode = null, host = null, peerLib = null;
  // ?broker=host:port uses a self-run PeerJS server instead of the public one
  // (remembered on this device; ?broker=public goes back to the public one)
  const BROKER = (() => { try { const q = new URLSearchParams(location.search).get("broker"); if (q) localStorage.setItem("peer-broker", q === "public" ? "" : q); return localStorage.getItem("peer-broker") || ""; } catch (e) { return ""; } })();
  // How two browsers find a way to each other. STUN servers let them connect
  // directly when the networks allow it; when they don't (mobile data, carrier
  // NAT, strict Wi-Fi) the traffic has to go through a relay (TURN). The free
  // relays are tried over UDP and also over TCP/TLS on port 443, which nearly
  // every network lets through. Your own relay: ?turn=turns:host:443|user|password
  // (remembered on this device; ?turn=none forgets it).
  const TURN = (() => { try { const q = new URLSearchParams(location.search).get("turn"); if (q) localStorage.setItem("peer-turn", q === "none" ? "" : q); return localStorage.getItem("peer-turn") || ""; } catch (e) { return ""; } })();
  // five servers at most: Firefox slows right down with more
  const ICE = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
    { urls: "turn:eu-0.turn.peerjs.com:3478", username: "peerjs", credential: "peerjsp" },
    { urls: ["turn:openrelay.metered.ca:443?transport=tcp", "turns:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
  ];
  if (TURN) { const [u, user, cred] = TURN.split("|"); ICE.unshift({ urls: u.split(","), username: user || "", credential: cred || "" }); }
  function peerOpts() {
    const base = { debug: 0, config: { iceServers: ICE, sdpSemantics: "unified-plan", iceCandidatePoolSize: 2 } };
    if (!BROKER) return base;
    const [h, port] = BROKER.split(":"), local = /^(localhost|127\.|192\.168\.|10\.)/.test(h);
    return { ...base, host: h, port: +port || (local ? 9000 : 443), path: "/", secure: !local };
  }

  function ready() {
    if (mode) return Promise.resolve(mode);
    const q = new URLSearchParams(location.search).get("mode");
    if (q === "browser" || location.protocol === "file:" || /\.github\.io$/.test(location.hostname)) return Promise.resolve(mode = "browser");
    // anything else: see whether a bumblebloom server answers here
    return new Promise(res => {
      let done = false;
      const finish = m => { if (!done) { done = true; mode = m; res(m); } };
      try {
        const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
        ws.onopen = () => { ws.close(); finish("server"); };
        ws.onerror = () => finish("browser");
        setTimeout(() => { try { ws.close(); } catch (e) {} finish("browser"); }, 1500);
      } catch (e) { finish("browser"); }
    });
  }

  // ---------------------------------------------------------------- server mode
  function openSocket(first, onMessage, onClose) {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    ws.onopen = () => ws.send(JSON.stringify(first));
    ws.onmessage = e => onMessage(JSON.parse(e.data));
    ws.onclose = () => onClose && onClose();
    return { send: o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }, close: () => ws.close() };
  }

  // ---------------------------------------------------------------- browser mode
  // the connection helper, from a second CDN if the first is blocked on this network
  function loadPeer() {
    if (peerLib) return peerLib;
    peerLib = new Promise((res, rej) => {
      if (window.Peer) return res(window.Peer);
      const tryUrl = i => {
        if (i >= PEERJS.length) { peerLib = null; rej(new Error("PeerJS did not load")); return; }
        const s = document.createElement("script");
        s.src = PEERJS[i]; s.onload = () => window.Peer ? res(window.Peer) : tryUrl(i + 1); s.onerror = () => tryUrl(i + 1);
        document.head.appendChild(s);
      };
      tryUrl(0);
    });
    return peerLib;
  }
  const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

  // A player on the hosting tab itself: straight into the simulation.
  function openLocal(first, onMessage, onClose) {
    let alive = true;
    const l = host.sim.connect({ send: o => { if (alive) queueMicrotask(() => alive && onMessage(o)); } });
    queueMicrotask(() => l.message(first));
    return { send: o => alive && l.message(o), close: () => { if (!alive) return; alive = false; l.close(); onClose && onClose(); } };
  }

  // This tab becomes the garden: run the simulation and, unless it is a solo
  // game, open it to the other browsers under its code.
  //
  // Phones drop their link to the broker whenever the tab sleeps (the host
  // switching apps to share the code is enough), so the host keeps checking
  // and reconnects. Players already in keep playing meanwhile: their
  // connection is browser to browser, not through the broker. A code that has
  // been online is never changed, since people may already have it.
  function becomeHost(solo, onStatus) {
    if (host) { clearInterval(host.keep); host.sim.stop(); if (host.peer) host.peer.destroy(); if (host.relay) host.relay.close(); }
    const h = host = { code: newCode(), sim: null, peer: null, online: false, wasOnline: false, Peer: null, waiting: false, keep: 0 };
    h.sim = new TagSim.Host(h.code);
    if (solo) return h;
    const status = (k, c) => onStatus && onStatus(k, c);
    const listen = () => {
      if (host !== h) return;
      const peer = new h.Peer(PREFIX + h.code, peerOpts());
      h.peer = peer;
      peer.on("open", () => { h.online = h.wasOnline = true; status("online", h.code); });
      peer.on("connection", conn => {
        // a player's first message can arrive before "open" fires here, so the
        // seat is made on whichever comes first
        let l = null;
        const seat = () => l || (l = h.sim.connect({ send: o => { if (conn.open) conn.send(o); } }));
        conn.on("open", seat);
        conn.on("data", d => seat().message(d));
        conn.on("close", () => { if (l) l.close(); });
        conn.on("error", () => { if (l) l.close(); });
      });
      peer.on("disconnected", () => { h.online = false; status("reconnecting"); });
      peer.on("error", err => {
        const type = err && err.type;
        if (type === "unavailable-id") {
          // After being online, PeerJS keeps the peer (and every player's connection) and
          // only stays disconnected: the broker still holds our last registration, and the
          // regular check claims the same code again in a few seconds.
          if (h.wasOnline) return;
          peer.destroy();
          if (h.sim.seats.size <= 1) {
            // someone else already has this code and nobody has seen ours yet: pick another
            h.code = h.sim.code = newCode(); listen(); if (h.relay) h.relay.retopic();
            h.sim.broadcast(h.sim.lobbyMsg());
            status("recode", h.code);
          } else { h.waiting = true; setTimeout(() => { h.waiting = false; listen(); }, 3000); }
        } else if (type === "peer-unavailable") {
          // a dead player connection, nothing to do with us
        } else if (!h.online && !(h.relay && h.relay.up)) status("offline");
      });
    };
    const check = () => {
      const p = h.peer;
      if (host !== h || !p || h.waiting) return;
      if (p.destroyed) listen();
      else if (p.disconnected) { try { p.reconnect(); } catch (e) {} }
    };
    h.keep = setInterval(check, 3000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
    // the relay: players whose network or browser will not do a direct link come in this way
    if (typeof Relay !== "undefined" && Relay.urls.length) {
      let skip = false, carry = null, n = 0;
      h.relay = Relay.host({
        prefix: RELAY_PREFIX, code: () => h.code, connect: link => h.sim.connect(link),
        onState: up => { if (up) status("online", h.code); },
        // the relay gets two snapshots in three (about 13 a second: smoother than 10, still kind to a free broker);
        // effects, notices and flower owners from a skipped one ride on the next
        thin: m => {
          if (m.t !== "s") return m;
          skip = ++n % 3 === 0;
          if (skip) { carry = carry || { fx: [], toast: null, o: null }; if (m.fx) carry.fx.push(...m.fx); if (m.toast) carry.toast = m.toast; if (m.o) carry.o = m.o; return null; }
          if (!carry) return m;
          const o = { ...m }, fx = [...carry.fx, ...(m.fx || [])]; if (fx.length) o.fx = fx; if (!o.toast && carry.toast) o.toast = carry.toast; if (!o.o && carry.o) o.o = carry.o;
          carry = null; return o;
        },
      });
    }
    loadPeer().then(P => { h.Peer = P; listen(); }, () => { if (!(h.relay && h.relay.up)) status("offline"); });
    return h;
  }

  // A player in another browser: find the host tab by its code. "Not found"
  // often only means the host's phone is asleep for a moment, so keep looking
  // for a while before giving up.
  const LOOK_FOR = 30000;
  function openRemote(code, first, onMessage, onClose, claim) {
    let peer = null, conn = null, closed = false, opened = false, found = false, retry = 0, fails = 0;
    const t0 = Date.now();
    // how far the join got, for the message if it fails
    const step = { lib: false, broker: false, host: false, ice: "", routes: "" };
    const details = () => `(helper ${step.lib ? "✓" : "✗"} · service ${step.broker ? "✓" : "✗"} · garden ${step.host ? "✓" : "✗"} · link ${({ "": "✗", new: "no route found", checking: "still trying", failed: "blocked", disconnected: "dropped" })[step.ice] || step.ice}${step.routes ? " · routes: " + step.routes : ""})`;
    const link = {
      send: o => { if (conn && conn.open) conn.send(o); },
      close: () => { if (closed) return; closed = true; clearTimeout(retry); clearTimeout(timer); try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} onClose && onClose(); },
      quiet: () => { const cb = onClose; onClose = null; link.close(); onClose = cb; },   // the relay won: leave without a word
    };
    const fail = msg => { if (closed) return; onMessage({ t: "err", msg }); link.close(); };
    const wait = msg => { if (!closed && !opened) onMessage({ t: "netwait", msg }); };
    const giveUp = () => {
      if (opened || closed) return;
      const report = () => fail(found ? `Found the garden but the two browsers could not link up: one of the networks blocks it. Try the same Wi-Fi for everyone, or mobile data. ${details()}`
                 : `No garden with the code ${code} is open right now. Check the letters, and that the host has it open and in front. ${details()}`);
      // which kinds of route this browser found: host = its own network, srflx = via STUN, relay = via TURN
      const pc = conn && conn.peerConnection;
      if (!pc || !pc.getStats) return report();
      const late = setTimeout(report, 1500);
      pc.getStats().then(stats => {
        const kinds = new Set(); stats.forEach(r => { if (r.type === "local-candidate" && r.candidateType) kinds.add(r.candidateType); });
        step.routes = [...kinds].join(", ") || "none";
        clearTimeout(late); report();
      }, () => {});
    };
    // 30 s to find the host; once it has answered, the link itself gets up to 30 s more
    const LINK_FOR = 30000, RANK = { "": 0, new: 1, checking: 2, disconnected: 2, failed: 2, connected: 3, completed: 3, closed: 0 };
    let timer = setTimeout(giveUp, LOOK_FOR);
    const dial = () => {
      if (closed || opened || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} retry = setTimeout(dial, 2000); return; }
      try { conn && conn.close(); } catch (e) {}
      const c = conn = peer.connect(PREFIX + code, { serialization: "json", reliable: true });
      let answered = false;
      c.on("open", () => { if (c !== conn) return; if (claim && !claim("rtc")) { link.quiet(); return; } opened = true; clearTimeout(timer); clearTimeout(retry); c.send(first); });
      c.on("data", d => { if (c === conn) onMessage(d); });
      c.on("close", () => { if (c === conn && opened) link.close(); });
      c.on("error", () => {});
      // watch the link without interrupting it: on a real network it can take several seconds
      const watch = setInterval(() => {
        if (c !== conn || closed || opened) { clearInterval(watch); return; }
        const pc = c.peerConnection; if (!pc) return;
        const st = pc.iceConnectionState;
        if ((RANK[st] || 0) >= (RANK[step.ice] || 0)) step.ice = st;          // keep the furthest it got
        if (!answered && pc.remoteDescription) {
          answered = step.host = found = true;
          clearTimeout(timer); timer = setTimeout(giveUp, LINK_FOR);
          wait(`Found garden ${code}, linking up…`);
        }
        if (st === "failed") { clearInterval(watch); if (++fails >= 2) giveUp(); else dial(); }
      }, 500);
      // no answer from the host at all (an offer can get lost): ask again
      retry = setTimeout(() => { if (!opened && !answered) dial(); }, 8000);
    };
    loadPeer().then(Peer => {
      if (closed) return;
      step.lib = true;
      peer = new Peer(peerOpts());
      peer.on("open", () => { step.broker = true; dial(); });
      peer.on("error", err => {
        const type = err && err.type;
        if (closed || opened) return;
        if (type === "peer-unavailable") {
          clearTimeout(retry);
          if (Date.now() - t0 > LOOK_FOR - 2500) return giveUp();
          wait(`Looking for garden ${code}… (the host's screen must be on, with the game in front)`);
          retry = setTimeout(dial, 2500);
        } else if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
          wait("Reaching the connection service…");
          clearTimeout(retry); retry = setTimeout(dial, 2500);
        } else if (type === "browser-incompatible") fail("This browser cannot play online games. Try an up-to-date Chrome, Safari or Firefox.");
      });
    }, () => fail("Could not load the connection helper. Are you online?"));
    return link;
  }

  function open(first, onMessage, onClose, onStatus) {
    if (mode === "server") return openSocket(first, onMessage, onClose);
    const code = String(first.code || "").toUpperCase();
    if (first.t === "hello" && (first.mode === "create" || first.mode === "solo")) {
      becomeHost(first.mode === "solo", onStatus);
      return openLocal(first, onMessage, onClose);
    }
    if (host && host.code === code) return openLocal(first, onMessage, onClose);
    return openGuest(code, first, onMessage, onClose);
  }

  // Another browser's garden: through the relay first (no ports opened, so no
  // firewall or browser prompts), and the direct link too if the relay has not
  // found the garden within a few seconds. Whichever reaches the host first is
  // used; the other is dropped before it takes a seat.
  function openGuest(code, first, onMessage, onClose) {
    let route = null, relay = null, rtc = null, ended = false;
    const claim = who => {
      if (route) return route === who;
      route = who;
      if (who === "relay" && rtc) rtc.quiet();
      if (who === "rtc" && relay) relay.quiet();
      return true;
    };
    const closed = () => { if (ended) return; ended = true; onClose && onClose(); };
    const direct = () => {
      if (rtc || route || ended) return;
      rtc = openRemote(code, first, m => { if (route !== "relay" && !ended) onMessage(m); }, () => { if (route !== "relay") { if (relay) relay.quiet(); closed(); } }, claim);
    };
    if (typeof Relay !== "undefined" && Relay.urls.length) {
      relay = Relay.guest({ prefix: RELAY_PREFIX, code, first, claim, onNoRelay: direct,
        deliver: m => { if (route === "relay" && !ended) onMessage(m); }, closed: () => { if (route === "relay") closed(); } });
      setTimeout(direct, 6000);
    } else direct();
    return {
      send: o => { if (route === "relay") relay.send(o); else if (rtc) rtc.send(o); },
      close: () => { if (ended) return; if (relay) (route === "relay" ? relay.close() : relay.quiet()); if (rtc) rtc.close(); closed(); },
    };
  }

  return { ready, open, _host: () => host, get mode() { return mode; }, get hosting() { return host ? { code: host.code, online: host.online || !!(host.relay && host.relay.up), solo: !host.peer && !host.relay } : null; } };
})();
