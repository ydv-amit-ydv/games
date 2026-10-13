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
  const PREFIX = "last-garden-tournament-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // as the server: no 0 O 1 I L
  let mode = null, host = null, peerLib = null;
  // ?broker=host:port uses a self-run PeerJS server instead of the public one
  // (remembered on this device; ?broker=public goes back to the public one)
  const BROKER = (() => { try { const q = new URLSearchParams(location.search).get("broker"); if (q) localStorage.setItem("peer-broker", q === "public" ? "" : q); return localStorage.getItem("peer-broker") || ""; } catch (e) { return ""; } })();
  function peerOpts() {
    if (!BROKER) return { debug: 0 };
    const [h, port] = BROKER.split(":"), local = /^(localhost|127\.|192\.168\.|10\.)/.test(h);
    return { debug: 0, host: h, port: +port || (local ? 9000 : 443), path: "/", secure: !local };
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
    if (host) { clearInterval(host.keep); host.sim.stop(); if (host.peer) host.peer.destroy(); }
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
          h.code = newCode(); h.sim.room.code = h.code; listen();
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
  function remote(code, deliver, closed, first) {
    let peer = null, conn = null, done = false, opened = false, found = false, retry = 0;
    const t0 = Date.now();
    const api = {
      send: o => { if (conn && conn.open) conn.send(o); },
      close: () => { if (done) return; done = true; clearTimeout(retry); clearTimeout(timer); try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} closed(); },
    };
    const fail = msg => { if (done) return; deliver({ t: "err", msg }); api.close(); };
    const wait = msg => { if (!done && !opened) deliver({ t: "netwait", msg }); };
    const giveUp = () => {
      if (opened) return;
      fail(found ? "Found the tournament but could not connect to it. This network may block games between browsers: try another Wi-Fi or mobile data."
                 : `No tournament with the code ${code} is open right now. Check the letters, and that the host has it open and in front.`);
    };
    const timer = setTimeout(giveUp, LOOK_FOR);
    const dial = () => {
      if (done || opened || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} retry = setTimeout(dial, 2000); return; }
      try { conn && conn.close(); } catch (e) {}
      const c = conn = peer.connect(PREFIX + code, { serialization: "json", reliable: true });
      c.on("open", () => { if (c !== conn) return; opened = true; clearTimeout(timer); clearTimeout(retry); c.send(first); });
      c.on("data", d => { if (c === conn) deliver(d); });
      c.on("close", () => { if (c === conn && opened) api.close(); });
      c.on("error", () => {});
      // the host answered on the broker but the browsers have not linked yet: give it time, then dial again
      retry = setTimeout(() => { if (!opened) { found = true; wait(`Connecting to tournament ${code}…`); dial(); } }, 9000);
    };
    loadPeer().then(Peer => {
      if (done) return;
      peer = new Peer(peerOpts());
      peer.on("open", dial);
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
      else { route = remote(code, deliver, closed, o); return; }
      route.send(o);
    };
    s.close = () => { if (ws) ws.close(); else if (route) route.close(); else closed(); };
    return s;
  }

  return { ready, socket, _host: () => host, get mode() { return mode; }, get hosting() { return host ? { code: host.code, online: host.online, practice: !host.peer } : null; } };
})();
