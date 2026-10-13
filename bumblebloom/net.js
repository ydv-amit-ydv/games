/* BUMBLEBLOOM - how a screen reaches the game.
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
  const PEERJS = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
  const PREFIX = "bumblebloom-garden-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let mode = null, host = null, peerLib = null;

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

  // A player on the hosting tab itself: straight into the simulation.
  function openLocal(first, onMessage, onClose) {
    let alive = true;
    const l = host.sim.connect({ send: o => { if (alive) queueMicrotask(() => alive && onMessage(o)); } });
    queueMicrotask(() => l.message(first));
    return { send: o => alive && l.message(o), close: () => { if (!alive) return; alive = false; l.close(); onClose && onClose(); } };
  }

  // This tab becomes the garden: run the simulation and, unless it is a solo
  // game, open it to the other browsers.
  function becomeHost(solo, onStatus) {
    if (host) { host.sim.stop(); if (host.peer) host.peer.destroy(); }
    host = { code: newCode(), sim: null, peer: null, online: false };
    host.sim = new BloomSim.Host(host.code);
    if (solo) return host;
    const listen = Peer => {
      const peer = new Peer(PREFIX + host.code, { debug: 0 });
      host.peer = peer;
      peer.on("open", () => { host.online = true; onStatus && onStatus("online", host.code); });
      peer.on("connection", conn => {
        // a player's first message can arrive before "open" fires here, so the
        // seat is made on whichever comes first
        let l = null;
        const seat = () => l || (l = host.sim.connect({ send: o => { if (conn.open) conn.send(o); } }));
        conn.on("open", seat);
        conn.on("data", d => seat().message(d));
        conn.on("close", () => { if (l) l.close(); });
        conn.on("error", () => { if (l) l.close(); });
      });
      peer.on("error", err => {
        if (err && err.type === "unavailable-id" && host.sim.seats.size <= 1) {
          // someone else already has this code: pick another before anyone joins
          peer.destroy(); host.code = host.sim.code = newCode(); listen(Peer);
          host.sim.broadcast(host.sim.lobbyMsg());
          onStatus && onStatus("recode", host.code);
        } else if (!host.online) onStatus && onStatus("offline");
      });
      peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
    };
    loadPeer().then(listen, () => onStatus && onStatus("offline"));
    return host;
  }

  // A player in another browser: find the host tab by its code.
  function openRemote(code, first, onMessage, onClose) {
    let peer = null, conn = null, closed = false, opened = false;
    const fail = msg => { if (closed) return; onMessage({ t: "err", msg }); link.close(); };
    const link = {
      send: o => { if (conn && conn.open) conn.send(o); },
      close: () => { if (closed) return; closed = true; try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} onClose && onClose(); },
    };
    const timer = setTimeout(() => { if (!opened) fail("Could not reach that garden. Check the code, and that the host still has the game open."); }, 12000);
    loadPeer().then(Peer => {
      if (closed) return;
      peer = new Peer({ debug: 0 });
      peer.on("open", () => {
        conn = peer.connect(PREFIX + code, { serialization: "json", reliable: true });
        conn.on("open", () => { opened = true; clearTimeout(timer); conn.send(first); });
        conn.on("data", d => onMessage(d));
        conn.on("close", () => link.close());
        conn.on("error", () => link.close());
      });
      peer.on("error", err => {
        if (err && err.type === "peer-unavailable") fail("No garden has that code. Check the letters, and that the host still has the game open.");
        else if (!opened) fail("Could not connect. This network may block games between browsers.");
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
    return openRemote(code, first, onMessage, onClose);
  }

  return { ready, open, get mode() { return mode; }, get hosting() { return host ? { code: host.code, online: host.online, solo: !host.peer } : null; } };
})();
