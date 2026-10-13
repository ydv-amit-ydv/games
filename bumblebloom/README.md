# Game 3: *Bumblebloom*

> A tap-to-fly garden arcade game: bumblebees race to pollinate flowers and grow vines between them.
> **1–8 players · 2-minute rounds · one screen · ages 6+**
>
> **Play it online:** open the GitHub Pages site (no install). One player makes a garden, the others type its code.
> **Or run a server:** `python server.py`, then open the address it prints (phones on the same Wi-Fi can join).
> **Visual guide with a live demo:** open [`visual-guide.html`](visual-guide.html) in a browser, or `/guide` on the server.
> Same storybook garden art style as our Labyrinth maze concept: mowed lawn, leafy hedges, gradient petals, soft white UI cards.

Each player is a bumblebee. Your bee circles a flower on its own. **Tap any
flower** and it flies straight there; tap another mid-flight to change course.
Circle a flower fully to pollinate it, and it blooms in your colour. Your flowers
that grow close together get joined by **vines**, and joined flowers make far more honey.

The action is choosing routes and bumping rivals. The strategy is choosing *which*
flowers to take and keeping your vines connected.

---

## 0. Two ways to run it

The same pages work both ways. When they load, they check whether a Bumblebloom
server is answering and pick the mode by themselves.

### A. Browser mode: GitHub Pages or any static host, nothing to install

Open `index.html` from GitHub Pages (or any static web host).

1. One player taps **Make a garden for friends**. **That browser tab now runs the game**:
   it is the host, and it shows a 6-letter garden code.
2. Everyone else opens the same page on their own device and types the code
   (or opens `index.html?code=CODE`). Their browsers connect straight to the host's tab
   (WebRTC). PeerJS's free public broker only introduces them; the code is the host's address there.
3. A big screen can watch at `board.html?code=CODE`.
4. **Play solo** and **Play two on this screen** run entirely inside the one tab and work offline.

Things to know:
- **The host's tab has to stay open and in front** for the whole game. Phones slow down
  background tabs, so a laptop or tablet makes the best host. If the host closes the tab, the garden ends.
- A player whose connection drops can reload and rejoin their seat while the host is still there.
- About 1 in 10–20 networks (strict school, office or mobile-carrier networks) block direct
  browser-to-browser connections. Players there see "Could not connect…". Switching to another
  Wi-Fi, or using server mode, fixes it.
- The game logic lives in `sim.js`, a line-for-line JavaScript copy of `server.py`'s simulation.
  A rule changed in one belongs in the other.

### B. Server mode: `python server.py` (same as The Last Garden)

```bash
cd "Game 3"
python server.py            # Python 3.8+, no packages to install
```

| Address | What it is |
|---|---|
| `http://<your-ip>:8000` | The game. Open it on each phone or laptop. |
| `http://<your-ip>:8000/board?code=CODE` | Big screen: a join poster in the lobby, then the whole garden with live scores. |
| `http://<your-ip>:8000/guide` | The illustrated rules. |

The server runs the game itself, so nobody's tab has to stay open. It also works on a
local Wi-Fi with no internet at all (the connection helper is only loaded in browser mode).
A phone that drops out keeps its bee: autopilot flies it until the phone comes back.

| Setting | Default | |
|---|---|---|
| `PORT` | `8000` | port to listen on |
| `BLOOM_ROUND` | `120` | round length in seconds (server mode) |

You can force browser mode on any host with `?mode=browser`.

### Files

| File | Role |
|---|---|
| `server.py` | server mode: asyncio HTTP + WebSocket server and the whole simulation (flight, pollinating, honey, health, predators, bots) |
| `sim.js` | browser mode: the same simulation in JavaScript, run by the host's tab |
| `net.js` | picks the mode and connects each screen: WebSocket to the server, or WebRTC (PeerJS) to the host tab |
| `art.js` | all drawing, shared by phone and big screen: lawn, hedges, trees, pond, flowers, vines, bees, predators, path preview |
| `index.html` | the player page: home, lobby, tap-to-fly game (and the two-player drag buttons), results |
| `board.html` | the big screen |
| `visual-guide.html` | illustrated rules with an offline demo |

---

## 1. Design pillars

| Pillar | In practice |
|---|---|
| **Tap to fly** | Anyone can play in 10 seconds: tap a flower, the bee goes there. |
| **Easy to learn, hard to master** | Tapping is easy. Picking routes past rivals, predators and the flytrap is the skill. |
| **Territory strategy** | Joined flowers make much more honey than scattered ones (Go-style territory), so every flight is also a strategic choice. |
| **Always back in** | A bumped bee is dizzy for 1.6 seconds, not out of the round. Nobody waits around. |
| **Bright and friendly** | A sunny storybook garden that matches the Labyrinth art: grass stripes, hedges, swaying flowers. |

---

## 2. Tap to fly

1. **Circle:** your bee circles its flower at a calm, steady pace (about 3 s a loop).
2. **Tap a flower:** the bee flies straight to it at one fixed speed. On a computer, hovering
   the mouse over a flower shows the line first ("tap to fly here").
3. **Change your mind:** tap a different flower while flying and the bee turns towards it.
4. **Land:** it lands on that flower's ring and starts circling.

A straight line through the **flytrap** gets you bitten. The preview line turns red
and says "this way hits the flytrap!", so hop round it via another flower.

---

## 3. Rules

### Pollinating flowers
- **White flower:** circle it once (360°) and it blooms in your colour.
- **Rival's flower:** takes **two** loops. That gives the owner time to fly back and bump you off.
- A ring in your colour shows your progress. Leaving early resets it.

### Bumping
- A **flying** bee that hits a **circling** bee makes it dizzy. The dizzy bee reappears on one of its own flowers 1.6 s later.
- Two flying bees that collide **bounce** off each other.
- The **Venus flytrap** in the middle of the garden catches any bee that touches it.
- Flying bees bounce off the hedges and lose a little speed.

### Honey (every second)
- Your flowers close enough together are joined by **vines** and form one patch.
- A patch of *n* flowers makes **n honey per flower**, or **n²** in total:

| Your flowers | Honey / second |
|---|---|
| 3 scattered | 1 + 1 + 1 = **3** |
| 3 joined | 3 × 3 = **9** |
| 5 joined | 5 × 5 = **25** |

Pollinating the flower in the middle of a rival's patch cuts their vine and their
honey. It's the strongest play in the game.

**On screen:** every patch has a label saying what it earns ("3 flowers · 3×3 = +9/s"),
and a "+9" floats up from it each second as the honey comes in. Your card shows
your flowers, your biggest patch and your honey per second (e.g. `+11 honey/s = 3×3 + 1 + 1`).
The scoreboard lists every bee's flowers and rate, and the **?** button opens the
honey table. The big screen shows the same for every bee.

### Switching flowers
Tap the flower you want. A dotted line runs from your bee to it while it flies, and the
target flower gets a turning dashed ring. If that straight line crosses the flytrap,
the preview turns red and warns you before you commit.

### Health and predators
Every bee has **100 health** (the green bar under it).

| Danger | What happens | Damage |
|---|---|---|
| **Dragonfly** | darts in from the edge in a wobbly line and stings every bee it touches | 25 |
| **Bird** | its shadow and a red ring appear on the lawn; 1.8 s later it swoops on that spot | 45 |
| **Spider** | drops onto a flower and webs it for 10 s; circling a webbed flower hurts | 18 / s |
| **Venus flytrap** | always in the middle; bites any bee whose flight runs into it, dazing it and sending it home | 35 |
| **Bump** | a flying bee hitting a circling one leaves it dizzy for 1.6 s | 10 |

- A predator turns up at random every 7–13 seconds (the first after 12 s), with a toast message saying which.
- **Circling your own flower heals** 7 health a second.
- At **0 health your bee faints**: it drops 15% of its honey and comes back on one of its own flowers after 3 seconds, with a short shield (dashed white ring).

### Sting dash
Tap **Sting** (or press **E**; in two-on-one-screen mode, the Sting chip on your card).
- Already flying? This flight becomes the dash. Circling? Your next flight does.
- A dash flies 45% faster and hits the **first rival bee it touches**, flying or circling,
  for **−35 health**, and leaves it dizzy (a dizzy bee is sent back to one of its own flowers).
  A dash at a rival's flower strikes whoever is circling it.
- **Bounty:** if a bee you stung or bumped faints within 4 seconds, the honey it drops
  (15% of its honey) goes to you, and the toast says so.
- Then an **8 second** cooldown. A dash that hits nobody ends when you land.
- While armed, your stinger glows and the aim line turns red ("sting dash here").

### Fortified patches
A patch of **4 or more** joined flowers grows a hedge (a leafy ring around each flower,
and "· fortified" on its label). Stealing one of its flowers takes **3 loops** instead of 2,
so big patches are harder to break up, and a sting to clear the defender becomes the way in.
Bots know this too: they sting rivals in their path and avoid fortified flowers.

### Round
**2 minutes.** Most honey wins. A match is best of 3 rounds.

---

## 4. Modes

| Mode | Players | Description |
|---|---|---|
| **Garden Trail** (campaign) | 1 | 30 hand-made gardens: pollinate every flower in time, weave through hedge gaps, avoid moving flytraps. 1–3 stars per garden. |
| **Skirmish** | 1 + bots | You against 1–7 bot bees (Easy / Normal / Sharp). |
| **Free-for-all** | 2–8 | Every bee for itself. Empty seats can be filled with bots. |
| **Hives** (teams) | 4–8 | 2v2, 2v2v2, 4v4. Teammates' flowers join into one shared patch. |

### Scaling to the number of players
| Players | Flowers | Garden |
|---|---|---|
| 1–2 | 10 | small lawn |
| 3–4 | 14 | medium lawn |
| 5–6 | 18 | large lawn |
| 7–8 | 22 | large lawn, camera zooms out a little |

### Garden events (optional, every 30 s)
- **Butterfly:** flutters across. Catch it for 5 seconds of "sugar rush": you can bump circling bees without stopping.
- **Rain shower:** everyone flies slower for 6 seconds.
- **Gardener:** trims one random flower back to white.

---

## 5. Controls

| Setup | How you steer |
|---|---|
| **One player per device** (phone, tablet, laptop) | Tap or click a flower. On a keyboard you can also tap **Space** to step a ring through the nearest flowers; the bee flies there when you stop tapping. |
| **Two players on one phone or tablet** | Home screen → **Play two on this screen** (shown on touch screens only). **Swipe from your own bee** (or the flower it is circling) **to the flower you want**, and lift your finger: the bee flies there. Both players can swipe at the same time. Each player has a small card at their end of the screen (turned to face them) with health, honey, a **Sting** chip, and the game's notices, so both sides can read them. |

Every other player joins from their own device with the garden code, so a match can be
two friends on one tablet plus more on their phones. Each player on a shared screen is
a separate seat on the server and gets their own coloured aim line.

---

## 6. Build plan

Same approach as The Last Garden: a **zero-dependency Python server** plus plain HTML pages,
no build step. All art is drawn in code (canvas), in the Labyrinth garden style,
so there are no image files to manage.

- Canvas 2D, fixed-timestep physics (120 Hz) so it plays the same on every machine.
- Seeded random generator for garden layouts, so a match can be replayed.
- Bot bees: pick a target (nearest white flower, or the one that cuts the leader's patch), take off when facing it, avoid paths near the flytrap.
- `localStorage` for campaign progress and key bindings (wrapped in try/catch).

### Milestones
| # | Milestone | Done when |
|---|---|---|
| M1 | Core flight | Circle, take off, fly and land feel good with one key |
| M2 | Pollinating + honey | Progress rings, vines, n² honey, 2-minute round |
| M3 | Bumping + flytrap | Dizzy bees, respawn, bounces, flytrap pull |
| M4 | Bots | Easy/Normal/Sharp bots, fill empty seats |
| M5 | Multiplayer | Lobby, one player per device, two on one touch screen, Hives (teams, not built yet) |
| M6 | Garden Trail | 30 gardens with star ratings |
| M7 | Polish | Buzzing sounds, petal bursts, colour-blind bee patterns, scaling by player count |

### Status
M1–M5 are built (server mode, tap-to-fly, bots, predators, health, phone + big screen, two players on one touch screen). Teams (Hives) are not built yet.
Still to do: M6 Garden Trail campaign, sound, keyboard sharing for several players on one laptop, a QR code on the big screen.

---

## 7. Open questions

- Should a bee's speed reset when it lands on a new flower, or carry over? (The demo carries it over.)
- Is n² honey too swingy at 8 players? Try n × 1.5 per flower instead.
- Does a rival's flower need 2 loops, or 1.5?
