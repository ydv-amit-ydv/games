# The Last Garden

A three-level treasure race through a living hedge maze, for live events.
Gather gold from chests, carry it back to the idol at the heart of the maze to bank it,
and watch who you pass: when two figures meet, whoever carries **less** takes a cut from
whoever carries **more**. Passersby play by the same rule.

| Level | Runners | What it is |
|---|---|---|
| **The Forest** | up to 300 | open glades, tracks, a river with bridges and ferries |
| **The Ruins** | the top 50 | collapsed courtyards and vine-eaten walls |
| **The Temple** | the last 10 | the inner sanctum around the idol; names are shown |

Gold left at the idol is safe and counts in full; gold still in your hands counts half.
Nobody can be robbed on the idol's doorstep, and loitering by the idol stops you robbing others.

**Who to meet.** You are the red-cloaked walker. Everyone else, runner or passerby, wears a
cloak coloured by what meeting them would do to your purse right now:

| Cloak | Means |
|---|---|
| **orange**, deeper for a bigger gap | they carry less than you: they would take a cut of your gold |
| **blue**, deeper for a bigger gap | they carry more than you: you would take a cut of theirs |
| **yellow** | nothing would change hands: equal purses, the sanctuary, a robbery just happened (3 s cooldown), or the poorer one is loitering at the idol |

Only the colour level is sent, never anyone's actual gold. The whole-map view draws the same
walkers (sized to stay readable) instead of dots and a pin.

## Two ways to run it

The same pages work both ways. When they load they check whether a Last Garden server is
answering, and pick the mode by themselves.

### A. Browser mode: GitHub Pages, nothing to install

Open `index.html` from GitHub Pages.

1. The organiser taps **New tournament** and picks a start delay. **That tab now runs the
   tournament**, so keep it open and in front until the champion is crowned.
2. Runners open the same page on their phones and use **Join by code**, or `index.html?code=CODE`.
3. The organiser's aerial view is `admin.html?code=CODE`, and the big-screen join poster with
   its QR code is `board.html?code=CODE`.
4. **Try it alone first** (the 90-second practice run) works entirely inside one tab, offline.

Phones connect straight to the host tab (WebRTC). PeerJS's free public broker only
introduces the browsers; the tournament code is the host tab's address there.

Limits of browser mode:
- **One tab is the whole tournament.** If it is closed or put in the background on a phone,
  the tournament stops, so host from a laptop. A runner whose phone drops can reload and rejoin.
- **Size.** A browser can hold a few dozen direct connections comfortably, not 300. For a
  big event, use server mode.
- Some strict school, office or mobile-carrier networks block browser-to-browser connections.
- The crash snapshot to disk exists only in server mode.

### B. Server mode: `python server.py`

```bash
cd last-garden
python server.py            # Python 3.8+, no packages to install
```

It prints the game address, the organiser view (`/admin`) and the big screen (`/board?code=CODE`).
This is the mode for big events on a local Wi-Fi: it handles 300 runners, needs no internet,
and saves a snapshot every few seconds so a restart loses nothing.

## Files

| File | Role |
|---|---|
| `index.html` | the runner's phone: login, waiting room, the maze (top-down and 3D), standings, talk |
| `admin.html` | the organiser's aerial view: everyone on the map, controls, announcements |
| `board.html` | the big screen: join poster with QR, then live standings |
| `painted.js`, `atlas.js` | the hand-painted garden art |
| `qr.js` | a QR encoder, so the big screen needs no network |
| `server.py`, `world.py` | server mode: the tournament and world generation in Python |
| `world.js`, `sim.js` | browser mode: the same world generation and tournament in JavaScript |
| `net.js` | picks the mode: a real WebSocket to the server, or a stand-in that talks to the host tab |

`world.js` and `sim.js` are line-for-line translations of `world.py` and `server.py`, so a rule
changed in one belongs in the other. The JavaScript world uses its own seeded random numbers,
so a seed grows a different (but equally valid) maze than Python would.

Source: the original game lives in the `Claude_game` repo; this copy adds browser mode.
