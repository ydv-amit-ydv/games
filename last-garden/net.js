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
  const PEERJS = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
  const PREFIX = "last-garden-tournament-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // as the server: no 0 O 1 I L
  let mode = null, host = null, peerLib = null;

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

  function loadPeer() {
    if (peerLib) return peerLib;
    peerLib = new Promise((res, rej) => {
      if (window.Peer) return res(window.Peer);
      const s = document.createElement("script");
      s.src = PEERJS; s.onload = () => res(window.Peer); s.onerror = () => { peerLib = null; rej(new Error("PeerJS did not load")); };
      document.head.appendChild(s);
    });
    return peerLib;
  }
  const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

  // This tab becomes the tournament.
  function becomeHost(practice) {
    if (host) { host.sim.stop(); if (host.peer) host.peer.destroy(); }
    host = { code: newCode(), sim: new GardenSim.Host(), peer: null, online: false };
    if (practice) return host;
    const listen = Peer => {
      const peer = new Peer(PREFIX + host.code, { debug: 0 });
      host.peer = peer;
      peer.on("open", () => { host.online = true; });
      peer.on("connection", conn => {
        let seat = null;
        const link = { send: o => { if (conn.open) conn.send(o); }, kick: () => conn.close() };
        const get = () => seat || (seat = host.sim.connect(link, host.code));
        conn.on("open", get);
        conn.on("data", d => get().message(d));
        conn.on("close", () => { if (seat) seat.close(); });
        conn.on("error", () => { if (seat) seat.close(); });
      });
      peer.on("error", err => {
        // someone else already holds this code on the broker: take another before anyone joins
        if (err && err.type === "unavailable-id" && host.sim.room && host.sim.room.players.size <= 1) {
          peer.destroy(); host.code = newCode(); host.sim.room.code = host.code; listen(Peer);
        }
      });
      peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
    };
    loadPeer().then(listen, () => {});
    return host;
  }

  // A seat in this tab's own tournament.
  function local(deliver, closed) {
    let alive = true;
    const seat = host.sim.connect({ send: o => { if (alive) queueMicrotask(() => alive && deliver(o)); }, kick: () => api.close() }, host.code);
    const api = { send: o => alive && seat.message(o), close: () => { if (!alive) return; alive = false; seat.close(); closed(); } };
    return api;
  }

  // A seat in a tournament hosted by another browser.
  function remote(code, deliver, closed, first) {
    let peer = null, conn = null, done = false, opened = false;
    const api = {
      send: o => { if (conn && conn.open) conn.send(o); },
      close: () => { if (done) return; done = true; try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} closed(); },
    };
    const fail = msg => { if (done) return; deliver({ t: "err", msg }); api.close(); };
    const timer = setTimeout(() => { if (!opened) fail("Could not reach that tournament. Check the code, and that the host still has it open."); }, 12000);
    loadPeer().then(Peer => {
      if (done) return;
      peer = new Peer({ debug: 0 });
      peer.on("open", () => {
        conn = peer.connect(PREFIX + code, { serialization: "json", reliable: true });
        conn.on("open", () => { opened = true; clearTimeout(timer); conn.send(first); });
        conn.on("data", deliver);
        conn.on("close", api.close);
        conn.on("error", api.close);
      });
      peer.on("error", err => {
        if (err && err.type === "peer-unavailable") fail("That tournament code was not found. Check the letters, and that the host still has it open.");
        else if (!opened) fail("Could not connect. This network may block games between browsers.");
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

  return { ready, socket, get mode() { return mode; }, get hosting() { return host ? { code: host.code, online: host.online, practice: !host.peer } : null; } };
})();
