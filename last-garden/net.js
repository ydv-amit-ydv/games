/* THE LAST GARDEN - how a page reaches the tournament.
 *
 *   server mode   the page came from `python server.py` (or ?server=host:port):
 *                 a real WebSocket, exactly as before.
 *   browser mode  no server (GitHub Pages, or the files opened directly): the
 *                 tab that creates a tournament runs sim.js itself, and every
 *                 other phone, the organiser view and the big screen connect to
 *                 that tab peer-to-peer (WebRTC). PeerJS's public broker only
 *                 introduces the browsers; the tournament code is the host
 *                 tab's address on it.
 *
 * Net.socket(url) returns something that behaves like a WebSocket (readyState,
 * send(string), close(), onopen/onmessage/onclose), so the pages keep their
 * own connection code and simply call Net.socket where they called
 * new WebSocket.
 */
'use strict';

const Net = (() => {
  const PEERJS = ["https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js", "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"];
  const PREFIX = "last-garden-tournament-", RELAY_PREFIX = "lastgarden/v1";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // as the server: no 0 O 1 I L
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
    const q = new URLSearchParams(location.search);
    if (q.get("server")) return Promise.resolve(mode = "server");
    if (q.get("mode") === "browser" || location.protocol === "file:" || /\.github\.io$/.test(location.hostname)) return Promise.resolve(mode = "browser");
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

  // This tab becomes the tournament.
  //
  // Phones drop their link to the broker whenever the tab sleeps (the organiser
  // switching apps to share the code is enough), so the host keeps checking and
  // reconnects. Runners already in keep playing meanwhile: their connection is
  // browser to browser. A code that has been online is never changed, since
  // people may already have it.
  function becomeHost(practice) {
    if (host) { clearInterval(host.keep); host.sim.stop(); if (host.peer) host.peer.destroy(); if (host.relay) host.relay.close(); }
    const h = host = { code: newCode(), sim: new GardenSim.Host(), peer: null, online: false, wasOnline: false, Peer: null, waiting: false, keep: 0 };
    if (practice) return h;
    const listen = () => {
      if (host !== h) return;
      const peer = new h.Peer(PREFIX + h.code, peerOpts());
      h.peer = peer;
      peer.on("open", () => { h.online = h.wasOnline = true; });
      peer.on("connection", conn => {
        let seat = null;
        const link = { send: o => { if (conn.open) conn.send(o); }, kick: () => conn.close() };
        const get = () => seat || (seat = h.sim.connect(link, h.code));
        conn.on("open", get);
        conn.on("data", d => get().message(d));
        conn.on("close", () => { if (seat) seat.close(); });
        conn.on("error", () => { if (seat) seat.close(); });
      });
      peer.on("disconnected", () => { h.online = false; });
      peer.on("error", err => {
        if (!(err && err.type === "unavailable-id")) return;
        // after being online PeerJS keeps the peer and every runner's connection, and the
        // regular check below claims the same code again once the broker lets go of it
        if (h.wasOnline) return;
        peer.destroy();
        if (h.sim.room && h.sim.room.players.size <= 1) {
          // someone else already holds this code and nobody has seen ours yet: take another
          h.code = newCode(); h.sim.room.code = h.code; listen(); if (h.relay) h.relay.retopic();
        } else { h.waiting = true; setTimeout(() => { h.waiting = false; listen(); }, 3000); }
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
    // the relay: runners whose network or browser will not do a direct link come in this way
    if (typeof Relay !== "undefined" && Relay.urls.length)
      h.relay = Relay.host({ prefix: RELAY_PREFIX, code: () => h.code, connect: link => h.sim.connect(link, h.code) });
    loadPeer().then(P => { h.Peer = P; listen(); }, () => {});
    return h;
  }

  // A seat in this tab's own tournament.
  function local(deliver, closed) {
    let alive = true;
    const seat = host.sim.connect({ send: o => { if (alive) queueMicrotask(() => alive && deliver(o)); }, kick: () => api.close() }, host.code);
    const api = { send: o => alive && seat.message(o), close: () => { if (!alive) return; alive = false; seat.close(); closed(); } };
    return api;
  }

  // A seat in a tournament hosted by another browser. "Not found" often only
  // means the host's phone is asleep for a moment, so keep looking for a while.
  const LOOK_FOR = 30000;
  function remote(code, deliver, closed, first, claim) {
    let peer = null, conn = null, done = false, opened = false, found = false, retry = 0, fails = 0;
    const t0 = Date.now();
    // how far the join got, for the message if it fails
    const step = { lib: false, broker: false, host: false, ice: "", routes: "" };
    const details = () => `(helper ${step.lib ? "✓" : "✗"} · service ${step.broker ? "✓" : "✗"} · tournament ${step.host ? "✓" : "✗"} · link ${({ "": "✗", new: "no route found", checking: "still trying", failed: "blocked", disconnected: "dropped" })[step.ice] || step.ice}${step.routes ? " · routes: " + step.routes : ""})`;
    const api = {
      send: o => { if (conn && conn.open) conn.send(o); },
      close: () => { if (done) return; done = true; clearTimeout(retry); clearTimeout(timer); try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} closed && closed(); },
      quiet: () => { const cb = closed; closed = null; api.close(); closed = cb; },   // the relay won: leave without a word
    };
    const fail = msg => { if (done) return; deliver({ t: "err", msg }); api.close(); };
    const wait = msg => { if (!done && !opened) deliver({ t: "netwait", msg }); };
    const giveUp = () => {
      if (opened || done) return;
      const report = () => fail(found ? `Found the tournament but the two browsers could not link up: one of the networks blocks it. Try the same Wi-Fi for everyone, or mobile data. ${details()}`
                 : `No tournament with the code ${code} is open right now. Check the letters, and that the host has it open and in front. ${details()}`);
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
      if (done || opened || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} retry = setTimeout(dial, 2000); return; }
      try { conn && conn.close(); } catch (e) {}
      const c = conn = peer.connect(PREFIX + code, { serialization: "json", reliable: true });
      let answered = false;
      c.on("open", () => { if (c !== conn) return; if (claim && !claim("rtc")) { api.quiet(); return; } opened = true; clearTimeout(timer); clearTimeout(retry); c.send(first); });
      c.on("data", d => { if (c === conn) deliver(d); });
      c.on("close", () => { if (c === conn && opened) api.close(); });
      c.on("error", () => {});
      // watch the link without interrupting it: on a real network it can take several seconds
      const watch = setInterval(() => {
        if (c !== conn || done || opened) { clearInterval(watch); return; }
        const pc = c.peerConnection; if (!pc) return;
        const st = pc.iceConnectionState;
        if ((RANK[st] || 0) >= (RANK[step.ice] || 0)) step.ice = st;          // keep the furthest it got
        if (!answered && pc.remoteDescription) {
          answered = step.host = found = true;
          clearTimeout(timer); timer = setTimeout(giveUp, LINK_FOR);
          wait(`Found tournament ${code}, linking up…`);
        }
        if (st === "failed") { clearInterval(watch); if (++fails >= 2) giveUp(); else dial(); }
      }, 500);
      // no answer from the host at all (an offer can get lost): ask again
      retry = setTimeout(() => { if (!opened && !answered) dial(); }, 8000);
    };
    loadPeer().then(Peer => {
      if (done) return;
      step.lib = true;
      peer = new Peer(peerOpts());
      peer.on("open", () => { step.broker = true; dial(); });
      peer.on("error", err => {
        const type = err && err.type;
        if (done || opened) return;
        if (type === "peer-unavailable") {
          clearTimeout(retry);
          if (Date.now() - t0 > LOOK_FOR - 2500) return giveUp();
          wait(`Looking for tournament ${code}… (the host's screen must be on, with the game in front)`);
          retry = setTimeout(dial, 2500);
        } else if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
          wait("Reaching the connection service…");
          clearTimeout(retry); retry = setTimeout(dial, 2500);
        } else if (type === "browser-incompatible") fail("This browser cannot play online games. Try an up-to-date Chrome, Safari or Firefox.");
      });
    }, () => fail("Could not load the connection helper. Are you online?"));
    return api;
  }

  // Another browser's tournament: through the relay first (no ports opened, so
  // no firewall or browser prompts), and the direct link too if the relay has
  // not found it within a few seconds. Whichever reaches the host first is used;
  // the other is dropped before it takes a seat.
  function guest(code, deliver, closed, first) {
    let route = null, relay = null, rtc = null, ended = false;
    const claim = who => {
      if (route) return route === who;
      route = who;
      if (who === "relay" && rtc) rtc.quiet();
      if (who === "rtc" && relay) relay.quiet();
      return true;
    };
    const end = () => { if (ended) return; ended = true; closed(); };
    const direct = () => {
      if (rtc || route || ended) return;
      rtc = remote(code, m => { if (route !== "relay" && !ended) deliver(m); }, () => { if (route !== "relay") { if (relay) relay.quiet(); end(); } }, first, claim);
    };
    if (typeof Relay !== "undefined" && Relay.urls.length) {
      relay = Relay.guest({ prefix: RELAY_PREFIX, code, first, claim, onNoRelay: direct,
        deliver: m => { if (route === "relay" && !ended) deliver(m); }, closed: () => { if (route === "relay") end(); } });
      setTimeout(direct, 6000);
    } else direct();
    return {
      send: o => { if (route === "relay") relay.send(o); else if (rtc) rtc.send(o); },
      close: () => { if (ended) return; if (relay) (route === "relay" ? relay.close() : relay.quiet()); if (rtc) rtc.close(); end(); },
    };
  }

  // Looks like a WebSocket to the page. The first message decides where it goes.
  function socket(url) {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
    let route = null, ws = null, closedOnce = false;
    const deliver = o => { if (s.readyState === 1 && s.onmessage) s.onmessage({ data: JSON.stringify(o) }); };
    const closed = () => { if (closedOnce) return; closedOnce = true; s.readyState = 3; if (s.onclose) s.onclose({}); };
    ready().then(m => {
      if (s.readyState === 3) return;
      if (m === "server") {
        ws = new WebSocket(url);
        ws.onopen = () => { s.readyState = 1; s.onopen && s.onopen({}); };
        ws.onmessage = e => s.onmessage && s.onmessage(e);
        ws.onerror = e => s.onerror && s.onerror(e);
        ws.onclose = () => closed();
      } else { s.readyState = 1; queueMicrotask(() => s.onopen && s.onopen({})); }
    });
    s.send = data => {
      if (ws) return ws.send(data);
      if (s.readyState !== 1) return;
      const o = typeof data === "string" ? JSON.parse(data) : data;
      if (route) return route.send(o);
      const code = String(o.code || "").trim().toUpperCase();
      if (o.t === "hi" && (o.mode === "create" || o.mode === "practice")) { becomeHost(o.mode === "practice"); route = local(deliver, closed); }
      else if (host && host.code === code) route = local(deliver, closed);
      else { route = guest(code, deliver, closed, o); return; }
      route.send(o);
    };
    s.close = () => { if (ws) ws.close(); else if (route) route.close(); else closed(); };
    return s;
  }

  return { ready, socket, _host: () => host, get mode() { return mode; }, get hosting() { return host ? { code: host.code, online: host.online || !!(host.relay && host.relay.up), practice: !host.peer && !host.relay } : null; } };
})();
