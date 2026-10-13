#!/usr/bin/env python3
"""
BUMBLEBLOOM - a one-button garden race for 1 to 8 bumblebees.
Zero dependencies (Python 3.8+).   Run:  python server.py   ->  open http://<your-ip>:8000

Same shape as The Last Garden's server: one asyncio process serves the pages
and speaks raw WebSocket, phones join a six-character room code, a big screen
can show the garden at /board?code=CODE, and the server owns the whole
simulation, so every phone sees the same garden.

The game
  Each bee circles a flower on its own. TAP any flower and the bee flies
  straight to it (tap another mid-flight to change course); a straight line
  through the flytrap gets bitten, so sometimes you hop round it.
  Circle a white flower once (a rival's: twice) and it blooms in your colour.
  Your flowers that sit close together are joined by vines into a patch, and
  a patch of n flowers makes n*n honey a second.

  Bees have 100 health. Predators turn up at random:
    dragonfly  darts straight across the lawn and stings any bee it touches
    bird       its shadow grows for a moment, then it swoops on that spot
    spider     drops onto a flower and webs it; circling there hurts
  plus the Venus flytrap in the middle, which bites any bee that flies into it.
  Circling one of your own flowers heals. At 0 health a bee faints, drops
  some honey and comes back on one of its flowers a few seconds later.

  Sting dash: tap Sting and your flight becomes a fast dash; the first rival
  it touches loses 35 health and goes dizzy. If that rival faints within a
  few seconds, its dropped honey goes to you (the bounty). 8 s cooldown.
  Fortified patches: a patch of 4+ joined flowers grows a hedge, and its
  flowers take 3 loops to steal instead of 2.
"""
import asyncio, base64, hashlib, json, math, os, random, socket, string, struct, time

# ------------------------------------------------------------------ config
HOST, PORT = "0.0.0.0", int(os.environ.get("PORT", 8000))
TICK = 1 / 60
SEND_EVERY = 3                      # state goes out at 20 Hz
ROUND_SECONDS = int(os.environ.get("BLOOM_ROUND", 120))
RESULTS_SECONDS = 15
COUNTDOWN = 3
MAX_BEES = 8
MAX_ROOMS = 100
ROOM_IDLE_TTL = 300
RESUME_GRACE = 120
HERE = os.path.dirname(os.path.abspath(__file__))
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")
NAMES = ["Red", "Blue", "Gold", "Violet", "Orange", "Pink", "Teal", "Brown"]

# ---- flight
# Circling only matters for pollinating now, so it is a steady, calm turn.
OMEGA0 = OMEGA1 = 2.0               # radians per second: one loop is about 3 s
OMEGA_GAIN = 0.0
FLY_V = 320.0                       # tap a flower and the bee flies straight there at this speed
ORBIT_GAP = 26.0                    # orbit radius = flower radius + this
BEE_R = 9.0

# ---- health
HP_MAX = 100.0
HEAL_PER_S = 7.0                    # while circling one of your own flowers
FAINT_SECONDS = 3.0
FAINT_HONEY_LOSS = 0.15
SAFE_SECONDS = 1.5                  # after coming back nothing can hurt you
DIZZY_SECONDS = 1.6
BUMP_DMG = 10
TRAP_DMG = 35
DRAGON_DMG = 25
BIRD_DMG = 45
WEB_DPS = 18

# ---- sting dash: tap Sting, and your flight becomes a fast dash that hits the first rival it touches
STING_DMG = 35
STING_CD = 8.0                      # seconds between stings
STING_SPEED = 1.45                  # a dash flies this much faster than a normal flight
STING_REACH = BEE_R * 2.6           # a little more forgiving than a bump
STING_DIZZY = 1.0
BOUNTY_WINDOW = 4.0                 # faint this soon after a sting or bump and the honey goes to whoever hit you

# ---- fortified patches: big patches grow a hedge, so their flowers are slower to steal
FORTIFY_SIZE = 4                    # a patch of this many joined flowers is fortified
FORTIFY_LOOPS = 3                   # loops a rival needs to take one of its flowers (normally 2)

# ---- flytrap
TRAP_R = 24.0

# ---- predators
PRED_FIRST = 12.0
PRED_GAP = (7.0, 13.0)
DRAGON_SPEED = 380.0
BIRD_WARN = 1.8
BIRD_R = 75.0
WEB_SECONDS = 10.0

# arena size and flower count by number of bees
SIZES = [(2, 1240, 780, 10), (4, 1440, 880, 14), (6, 1640, 980, 18), (8, 1840, 1080, 22)]


# ------------------------------------------------------------------ world
def make_world(n_bees, seed):
    rng = random.Random(seed)
    W, H, count = next((w, h, c) for cap, w, h, c in SIZES if n_bees <= cap)
    cx, cy = W / 2, H / 2
    flowers = []
    dmin = math.sqrt(W * H / count) * 0.66
    fails = 0
    while len(flowers) < count:
        x, y = rng.uniform(120, W - 120), rng.uniform(120, H - 120)
        ok = math.hypot(x - cx, y - cy) > 170 and all(math.hypot(x - f["x"], y - f["y"]) > dmin for f in flowers)
        if ok:
            r = rng.choice([14, 15, 16, 17, 18, 20, 21])
            flowers.append({"x": round(x, 1), "y": round(y, 1), "r": r, "R": r + ORBIT_GAP,
                            "owner": None, "flash": 0.0, "web": 0.0})
            fails = 0
        else:
            fails += 1
            if fails > 400:
                dmin *= 0.96
                fails = 0
    nn = sorted(min(math.hypot(a["x"] - b["x"], a["y"] - b["y"]) for b in flowers if b is not a) for a in flowers)
    link = round(nn[len(nn) // 2] * 1.45, 1)
    return {"W": W, "H": H, "seed": seed, "trap": (cx, cy), "flowers": flowers, "link": link}


def spread_starts(world, n):
    """Pick n flowers far from each other (and from the flytrap) as home flowers."""
    fl = world["flowers"]
    cx, cy = world["trap"]
    first = max(range(len(fl)), key=lambda i: math.hypot(fl[i]["x"] - cx, fl[i]["y"] - cy))
    picks = [first]
    while len(picks) < n:
        best = max((i for i in range(len(fl)) if i not in picks),
                   key=lambda i: min(math.hypot(fl[i]["x"] - fl[j]["x"], fl[i]["y"] - fl[j]["y"]) for j in picks))
        picks.append(best)
    return picks


def seg_dist(ax, ay, bx, by, px, py):
    dx, dy = bx - ax, by - ay
    l = dx * dx + dy * dy or 1
    u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l))
    return math.hypot(ax + u * dx - px, ay + u * dy - py)


# ------------------------------------------------------------------ bees
class Bee:
    __slots__ = ("id", "slot", "name", "w", "room", "key", "bot", "gone", "down",
                 "state", "f", "ang", "rad", "dir", "v", "prog", "x", "y", "vx", "vy",
                 "timer", "hp", "safe", "score", "hit_cd", "target", "wait", "fly_t", "faints", "blooms",
                 "sting", "sting_armed", "sting_cd", "last_hit", "knocks")

    def send(self, frame):
        if self.w is None:
            return
        tr = self.w.transport
        if tr.is_closing():
            return
        if tr.get_write_buffer_size() > 1_000_000:
            tr.abort()
            return
        self.w.write(frame)


class Watcher:
    __slots__ = ("w", "room")

    def send(self, frame):
        if not self.w.transport.is_closing():
            self.w.write(frame)


class Room:
    def __init__(self, code):
        self.code = code
        self.bees = {}              # id -> Bee (humans and bots)
        self.watchers = set()
        self.host = None
        self.phase = "lobby"        # lobby | countdown | play | results
        self.world = None
        self.preds = []
        self.fx = []
        self.toast = None
        self.t_end = 0.0
        self.t_phase = 0.0
        self.next_pred = 0.0
        self.pred_id = 0
        self.tick = 0
        self.empty_since = None
        self.solo = False
        self.bots_wanted = 0
        self.last_rank = []
        self.fort = set()           # flowers in a fortified patch, worked out each tick


ROOMS = {}
NEXT_ID = 1


def new_bee(name, bot=False):
    global NEXT_ID
    b = Bee()
    b.id, NEXT_ID = NEXT_ID, NEXT_ID + 1
    name = "".join(c for c in str(name or "") if c.isprintable())[:14].strip()
    b.name = name
    b.w, b.room, b.bot, b.gone, b.down = None, None, bot, None, False
    b.key = base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")
    b.slot = 0
    reset_bee(b)
    return b


def reset_bee(b):
    b.state, b.f, b.ang, b.rad, b.dir, b.v, b.prog = "orbit", 0, 0.0, 40.0, 1, OMEGA0, 0.0
    b.x = b.y = b.vx = b.vy = 0.0
    b.timer, b.hp, b.safe, b.score, b.hit_cd = 0.0, HP_MAX, 0.0, 0.0, 0.0
    b.target, b.wait, b.fly_t, b.faints, b.blooms = None, 1.0, 0.0, 0, 0
    b.sting, b.sting_armed, b.sting_cd, b.last_hit, b.knocks = False, False, 0.0, None, 0


def free_slot(room):
    used = {b.slot for b in room.bees.values()}
    return next(i for i in range(MAX_BEES) if i not in used)


def label(b):
    return b.name or (NAMES[b.slot] + " bee")


# ------------------------------------------------------------------ wire
def ws_frame(text):
    data = text.encode()
    n = len(data)
    if n < 126:
        h = struct.pack(">BB", 0x81, n)
    elif n < 65536:
        h = struct.pack(">BBH", 0x81, 126, n)
    else:
        h = struct.pack(">BBQ", 0x81, 127, n)
    return h + data


def F(o):
    return ws_frame(json.dumps(o, separators=(",", ":")))


def broadcast(room, frame):
    for b in room.bees.values():
        b.send(frame)
    for w in room.watchers:
        w.send(frame)


def gen_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(6))
        if code not in ROOMS:
            return code


def lobby_msg(room):
    return F({"t": "lobby", "code": room.code, "host": room.host, "solo": room.solo,
              "bots": room.bots_wanted, "phase": room.phase,
              "bees": [{"id": b.id, "slot": b.slot, "name": label(b), "bot": b.bot,
                        "away": b.gone is not None}
                       for b in sorted(room.bees.values(), key=lambda b: b.slot)]})


def world_msg(room):
    wd = room.world
    return {"W": wd["W"], "H": wd["H"], "seed": wd["seed"], "link": wd["link"],
            "trap": wd["trap"], "flowers": [[f["x"], f["y"], f["r"]] for f in wd["flowers"]],
            "bees": [{"id": b.id, "slot": b.slot, "name": label(b), "bot": b.bot}
                     for b in sorted(room.bees.values(), key=lambda b: b.slot)],
            "cfg": {"hp": HP_MAX, "secs": ROUND_SECONDS, "flyV": FLY_V, "trapR": TRAP_R + BEE_R,
                    "stingCd": STING_CD, "fortSize": FORTIFY_SIZE, "fortLoops": FORTIFY_LOOPS}}


def state_msg(room, now):
    wd = room.world
    bees = []
    for b in room.bees.values():
        st = {"orbit": 0, "fly": 1, "dizzy": 2, "faint": 3}[b.state]
        bees.append([b.id, round(b.x, 1), round(b.y, 1), round(b.ang, 3), st, round(b.hp),
                     int(b.score), round(b.prog, 2), b.f, b.dir, round(b.rad, 1),
                     round(b.vx, 1), round(b.vy, 1), 1 if b.safe > 0 else 0, round(b.v, 2), -1 if b.target is None or b.state != "fly" else b.target,
                     1 if b.sting else 0, 1 if b.sting_armed else 0, round(b.sting_cd, 1)])
    preds = []
    for p in room.preds:
        if p["k"] == "dragon":
            preds.append(["d", round(p["x"]), round(p["y"]), round(math.atan2(p["vy"], p["vx"]), 2), p["id"]])
        elif p["k"] == "bird":
            preds.append(["b", round(p["x"]), round(p["y"]), round(p["age"] / BIRD_WARN, 2), p["id"]])
        elif p["k"] == "spider":
            preds.append(["s", p["f"], 0, round(p["age"], 2), round(p["life"], 2)])
    owners = [f["owner"] for f in wd["flowers"]]
    msg = {"t": "s", "left": round(max(0.0, room.t_end - now), 1) if room.phase == "play" else ROUND_SECONDS,
           "ph": room.phase, "b": bees, "o": owners, "p": preds}
    if room.fx:
        msg["fx"] = room.fx
        room.fx = []
    if room.toast:
        msg["toast"] = room.toast
        room.toast = None
    return F(msg)


def fx(room, kind, x, y, slot=-1):
    room.fx.append([kind, round(x), round(y), slot])


# ------------------------------------------------------------------ phases
def start_countdown(room):
    room.phase = "countdown"
    room.t_phase = time.time() + COUNTDOWN
    # fill seats with bots
    humans = [b for b in room.bees.values() if not b.bot]
    for b in [b for b in room.bees.values() if b.bot]:
        room.bees.pop(b.id)
    want = max(0, min(MAX_BEES - len(humans), room.bots_wanted))
    if len(humans) == 1 and want == 0:
        want = 3                    # nobody plays a garden alone
    for _ in range(want):
        bot = new_bee("", bot=True)
        bot.slot = free_slot(room)
        bot.room = room
        room.bees[bot.id] = bot
    room.world = make_world(len(room.bees), random.randrange(1 << 30))
    starts = spread_starts(room.world, len(room.bees))
    for b, fi in zip(sorted(room.bees.values(), key=lambda b: b.slot), starts):
        reset_bee(b)
        f = room.world["flowers"][fi]
        f["owner"] = b.slot
        b.f, b.rad, b.ang = fi, f["R"], random.uniform(0, math.tau)
        b.dir = 1 if b.slot % 2 == 0 else -1
        place_on_orbit(b, f)
    room.preds = []
    room.fx = []
    broadcast(room, lobby_msg(room))
    broadcast(room, F({"t": "go", "in": COUNTDOWN, **world_msg(room)}))


def start_play(room, now):
    room.phase = "play"
    room.t_end = now + ROUND_SECONDS
    room.next_pred = now + PRED_FIRST


def end_round(room, now):
    room.phase = "results"
    room.t_phase = now + RESULTS_SECONDS
    rank = sorted(room.bees.values(), key=lambda b: -b.score)
    room.last_rank = [{"slot": b.slot, "name": label(b), "honey": int(b.score), "bot": b.bot,
                       "blooms": b.blooms, "faints": b.faints, "knocks": b.knocks,
                       "flowers": sum(1 for f in room.world["flowers"] if f["owner"] == b.slot),
                       "patch": max((len(p) for p in patches(room.world, b.slot)), default=0),
                       "rate": sum(len(p) ** 2 for p in patches(room.world, b.slot))}
                      for b in rank]
    broadcast(room, F({"t": "end", "rank": room.last_rank}))


def back_to_lobby(room):
    room.phase = "lobby"
    for b in [b for b in room.bees.values() if b.bot]:
        room.bees.pop(b.id)
    for b in [b for b in room.bees.values() if b.gone is not None]:
        room.bees.pop(b.id)
    if room.host not in room.bees and room.bees:
        room.host = next(iter(room.bees))
    broadcast(room, lobby_msg(room))


# ------------------------------------------------------------------ simulation
def place_on_orbit(b, f):
    b.x = f["x"] + math.cos(b.ang) * b.rad
    b.y = f["y"] + math.sin(b.ang) * b.rad


def hurt(room, b, dmg, why, by=None):
    if b.safe > 0 or b.state == "faint":
        return
    if by is not None and by is not b:
        b.last_hit = (by, time.time())      # for the bounty, if this ends in a faint
    b.hp -= dmg
    if b.hit_cd <= 0:               # a web hurts every tick; only show a hit now and then
        b.hit_cd = 0.35
        fx(room, "hit", b.x, b.y, b.slot)
    if b.hp <= 0:
        faint(room, b, why)


def faint(room, b, why):
    b.state, b.timer, b.hp, b.sting, b.sting_armed = "faint", FAINT_SECONDS, 0, False, False
    lost = int(b.score * FAINT_HONEY_LOSS)
    b.score -= lost
    b.faints += 1
    fx(room, "faint", b.x, b.y, b.slot)
    hitter, at = b.last_hit or (None, 0)
    b.last_hit = None
    if hitter is not None and hitter.room is room and time.time() - at <= BOUNTY_WINDOW:
        hitter.score += lost                # the bounty: the honey goes to whoever knocked them out
        hitter.knocks += 1
        room.toast = "%s knocked out %s and took %d honey!" % (label(hitter), label(b), lost)
    else:
        room.toast = "%s fainted (%s) and dropped %d honey" % (label(b), why, lost)


def respawn(room, b):
    fl = room.world["flowers"]
    own = [i for i, f in enumerate(fl) if f["owner"] == b.slot and f["web"] <= 0]
    pool = own or [i for i, f in enumerate(fl) if f["owner"] is None and f["web"] <= 0] or list(range(len(fl)))
    fi = random.choice(pool)
    f = fl[fi]
    b.state, b.f, b.ang, b.rad, b.v, b.prog = "orbit", fi, random.uniform(0, math.tau), f["R"], OMEGA0, 0.0
    b.hp, b.safe, b.target, b.wait, b.sting = HP_MAX, SAFE_SECONDS, None, 0.6, False
    place_on_orbit(b, f)


def patches(wd, slot):
    mine = [f for f in wd["flowers"] if f["owner"] == slot]
    seen, out = set(), []
    for f in mine:
        if id(f) in seen:
            continue
        comp, stack = [], [f]
        seen.add(id(f))
        while stack:
            c = stack.pop()
            comp.append(c)
            for q in mine:
                if id(q) not in seen and math.hypot(c["x"] - q["x"], c["y"] - q["y"]) <= wd["link"]:
                    seen.add(id(q))
                    stack.append(q)
        out.append(comp)
    return out


def launch(b, fi):
    """Tap a flower and the bee flies straight to it. A new tap changes course."""
    if b.state not in ("orbit", "fly") or (b.state == "orbit" and fi == b.f):
        return
    b.state, b.target, b.prog, b.fly_t = "fly", fi, 0.0, 0.0
    if b.sting_armed:
        start_sting(b)


def start_sting(b):
    b.sting, b.sting_armed, b.sting_cd = True, False, STING_CD


def arm_sting(b):
    """Sting while flying and this flight becomes the dash; while circling, the next one does."""
    if b.sting_cd > 0 or b.sting or b.state not in ("orbit", "fly"):
        return
    if b.state == "fly":
        start_sting(b)
    else:
        b.sting_armed = True


def fortified(wd):
    """Indexes of flowers in a patch big enough to be fortified."""
    out = set()
    slots = {f["owner"] for f in wd["flowers"] if f["owner"] is not None}
    index = {id(f): i for i, f in enumerate(wd["flowers"])}
    for sl in slots:
        for p in patches(wd, sl):
            if len(p) >= FORTIFY_SIZE:
                out.update(index[id(f)] for f in p)
    return out


def bot_think(room, b, dt):
    wd = room.world
    fl = wd["flowers"]
    if b.state != "orbit":
        return
    f = fl[b.f]
    if f["owner"] != b.slot and f["web"] <= 0:
        return                                  # finish pollinating first
    if f["owner"] == b.slot and b.hp < 45:
        b.wait = max(b.wait, 0.5)               # rest and heal on your own flower
    if f["web"] > 0:
        b.wait = 0                              # get off a webbed flower now
    b.wait -= dt
    if b.wait > 0:
        return
    birds = [p for p in room.preds if p["k"] == "bird"]
    cx, cy = wd["trap"]
    fort = room.fort
    best, bs = None, 1e9
    for i, t in enumerate(fl):
        if i == b.f or t["owner"] == b.slot or t["web"] > 0:
            continue
        if seg_dist(b.x, b.y, t["x"], t["y"], cx, cy) < TRAP_R + BEE_R + 30:
            continue                            # that straight line runs through the flytrap
        if any(math.hypot(t["x"] - p["x"], t["y"] - p["y"]) < BIRD_R + 40 for p in birds):
            continue
        sc = math.hypot(t["x"] - f["x"], t["y"] - f["y"]) + (120 if t["owner"] is not None else 0) + random.random() * 90
        if i in fort:
            sc += 220                           # a hedge makes it slow to take
        if sc < bs:
            bs, best = sc, i
    if best is not None:
        t = fl[best]
        if b.sting_cd <= 0 and any(o.slot != b.slot and o.state in ("orbit", "fly") and
                                   seg_dist(b.x, b.y, t["x"], t["y"], o.x, o.y) < 40 for o in room.bees.values()):
            b.sting_armed = True                # a rival sits on the way: make it a dash
        launch(b, best)
    else:
        b.wait = 0.5


def step(room, dt, now):
    wd = room.world
    fl = wd["flowers"]
    cx, cy = wd["trap"]
    W, H = wd["W"], wd["H"]
    for f in fl:
        f["flash"] = max(0.0, f["flash"] - dt)
        f["web"] = max(0.0, f["web"] - dt)
    room.fort = fortified(wd)

    for b in room.bees.values():
        if b.bot or b.gone is not None:
            bot_think(room, b, dt)
        b.safe = max(0.0, b.safe - dt)
        b.hit_cd = max(0.0, b.hit_cd - dt)
        b.sting_cd = max(0.0, b.sting_cd - dt)
        if b.state in ("dizzy", "faint"):
            b.timer -= dt
            if b.timer <= 0:
                respawn(room, b)
            continue
        if b.state == "orbit":
            f = fl[b.f]
            b.v = min(OMEGA1, b.v + OMEGA_GAIN * dt)
            b.rad += (f["R"] - b.rad) * min(1.0, 6 * dt)
            w = b.v
            b.ang = (b.ang + b.dir * w * dt) % math.tau
            place_on_orbit(b, f)
            if f["web"] > 0:
                hurt(room, b, WEB_DPS * dt, "caught in a web")
                if b.state == "faint":
                    continue
            elif f["owner"] == b.slot:
                b.hp = min(HP_MAX, b.hp + HEAL_PER_S * dt)
            else:
                b.prog += w * dt
                loops = 1 if f["owner"] is None else FORTIFY_LOOPS if b.f in room.fort else 2
                need = loops * math.tau
                if b.prog >= need:
                    f["owner"], f["flash"], b.prog = b.slot, 1.0, 0.0
                    b.blooms += 1
                    b.wait = 0.3 + random.random() * 0.8
                    fx(room, "bloom", f["x"], f["y"], b.slot)
        elif b.state == "fly":
            t = fl[b.target]
            dx, dy = t["x"] - b.x, t["y"] - b.y
            d = math.hypot(dx, dy) or 1
            spd = FLY_V * (STING_SPEED if b.sting else 1.0)
            b.vx, b.vy = dx / d * spd, dy / d * spd
            step_len = spd * dt
            if d - step_len <= t["R"]:
                # arrive on the flower's ring and start circling it
                b.x, b.y = t["x"] - dx / d * t["R"], t["y"] - dy / d * t["R"]
                rx, ry = b.x - t["x"], b.y - t["y"]
                b.state, b.f = "orbit", b.target
                b.ang = math.atan2(ry, rx) % math.tau
                b.rad = t["R"]
                b.dir = 1 if rx * b.vy - ry * b.vx >= 0 else -1
                b.v, b.prog, b.target = OMEGA0, 0.0, None
                if b.sting:
                    # a dash at a flower strikes a rival circling it, wherever they are on the ring
                    occ = [v for v in room.bees.values() if v is not b and v.slot != b.slot and v.f == b.f
                           and v.state in ("orbit", "dizzy") and v.safe <= 0]
                    if occ:
                        sting_hit(room, b, min(occ, key=lambda v: math.hypot(v.x - b.x, v.y - b.y)))
                b.sting = False                 # a dash that hit nobody ends when you land
                b.wait = 0.4 + random.random() * 0.6
                fx(room, "land", b.x, b.y, b.slot)
            else:
                b.x += b.vx * dt
                b.y += b.vy * dt
            if math.hypot(b.x - cx, b.y - cy) < TRAP_R + BEE_R:
                # flew straight into the flytrap: bitten, dazed, sent home
                fx(room, "snap", cx, cy, b.slot)
                b.x, b.y = cx - dx / d * (TRAP_R + BEE_R + 6), cy - dy / d * (TRAP_R + BEE_R + 6)
                b.state, b.timer, b.target, b.sting = "dizzy", DIZZY_SECONDS, None, False
                hurt(room, b, TRAP_DMG, "bitten by the flytrap")

    # stings: a dashing bee hits the first rival it reaches, flying or circling
    for a in room.bees.values():
        if not (a.sting and a.state == "fly"):
            continue
        for v in room.bees.values():
            if v is a or v.slot == a.slot or v.state not in ("orbit", "fly", "dizzy") or v.safe > 0:
                continue
            if math.hypot(a.x - v.x, a.y - v.y) < STING_REACH:
                sting_hit(room, a, v)
                break

    # bumping
    live = [b for b in room.bees.values() if b.state in ("orbit", "fly")]
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            a, c = live[i], live[j]
            if math.hypot(a.x - c.x, a.y - c.y) > BEE_R * 2:
                continue
            if a.state == "fly" and c.state == "orbit":
                bump(room, a, c)
            elif c.state == "fly" and a.state == "orbit":
                bump(room, c, a)

    step_predators(room, dt, now)

    for b in room.bees.values():
        b.score += sum(len(p) ** 2 for p in patches(wd, b.slot)) * dt


def sting_hit(room, a, v):
    a.sting = False
    fx(room, "sting", v.x, v.y, a.slot)
    hurt(room, v, STING_DMG, "stung by %s" % label(a), by=a)
    if v.state != "faint":
        v.state, v.timer, v.target, v.sting = "dizzy", STING_DIZZY, None, False


def bump(room, flier, victim):
    if victim.safe > 0:
        return
    victim.state, victim.timer, victim.sting = "dizzy", DIZZY_SECONDS, False
    fx(room, "bump", victim.x, victim.y, victim.slot)
    hurt(room, victim, BUMP_DMG, "bumped by %s" % label(flier), by=flier)


def step_predators(room, dt, now):
    wd = room.world
    fl = wd["flowers"]
    W, H = wd["W"], wd["H"]
    if now >= room.next_pred:
        room.next_pred = now + random.uniform(*PRED_GAP)
        spawn_predator(room)
    keep = []
    for p in room.preds:
        p["age"] += dt
        if p["k"] == "dragon":
            p["wob"] += dt
            nx, ny = -p["vy"], p["vx"]
            n = math.hypot(nx, ny) or 1
            wob = math.cos(p["wob"] * 9) * 60
            p["x"] += p["vx"] * dt + nx / n * wob * dt
            p["y"] += p["vy"] * dt + ny / n * wob * dt
            for b in room.bees.values():
                if b.id in p["hit"] or b.state not in ("orbit", "fly"):
                    continue
                if math.hypot(b.x - p["x"], b.y - p["y"]) < 26:
                    p["hit"].add(b.id)
                    hurt(room, b, DRAGON_DMG, "stung by a dragonfly")
            if -160 < p["x"] < W + 160 and -160 < p["y"] < H + 160:
                keep.append(p)
        elif p["k"] == "bird":
            if not p["struck"] and p["age"] >= BIRD_WARN:
                p["struck"] = True
                fx(room, "swoop", p["x"], p["y"])
                for b in room.bees.values():
                    if b.state in ("orbit", "fly", "dizzy") and math.hypot(b.x - p["x"], b.y - p["y"]) < BIRD_R:
                        hurt(room, b, BIRD_DMG, "caught by a bird")
            if p["age"] < BIRD_WARN + 1.2:
                keep.append(p)
        elif p["k"] == "spider":
            p["life"] -= dt
            if p["life"] > 0:
                fl[p["f"]]["web"] = max(fl[p["f"]]["web"], min(p["life"], WEB_SECONDS))
                keep.append(p)
    room.preds = keep


def spawn_predator(room):
    wd = room.world
    fl = wd["flowers"]
    W, H = wd["W"], wd["H"]
    room.pred_id += 1
    pid = room.pred_id
    kinds = ["dragon", "bird", "spider"]
    kind = random.choice(kinds)
    live = [b for b in room.bees.values() if b.state in ("orbit", "fly")]
    if kind == "spider":
        choices = [i for i, f in enumerate(fl) if f["owner"] is not None and f["web"] <= 0] or \
                  [i for i, f in enumerate(fl) if f["web"] <= 0]
        if not choices:
            kind = "dragon"
        else:
            fi = random.choice(choices)
            room.preds.append({"k": "spider", "id": pid, "f": fi, "age": 0.0, "life": WEB_SECONDS})
            fl[fi]["web"] = WEB_SECONDS
            room.toast = "A spider is spinning a web on a flower!"
            return
    if kind == "bird" and live:
        b = random.choice(live)
        room.preds.append({"k": "bird", "id": pid, "x": b.x + random.uniform(-30, 30),
                           "y": b.y + random.uniform(-30, 30), "age": 0.0, "struck": False})
        room.toast = "A bird's shadow! Fly out of it!"
        return
    # dragonfly: from one edge, aimed through a random flower
    side = random.randrange(4)
    if side == 0:
        x, y = -120, random.uniform(80, H - 80)
    elif side == 1:
        x, y = W + 120, random.uniform(80, H - 80)
    elif side == 2:
        x, y = random.uniform(80, W - 80), -120
    else:
        x, y = random.uniform(80, W - 80), H + 120
    t = random.choice(fl)
    dx, dy = t["x"] - x, t["y"] - y
    d = math.hypot(dx, dy) or 1
    room.preds.append({"k": "dragon", "id": pid, "x": x, "y": y, "vx": dx / d * DRAGON_SPEED,
                       "vy": dy / d * DRAGON_SPEED, "age": 0.0, "wob": 0.0, "hit": set()})
    room.toast = "A dragonfly is darting across the garden!"


# ------------------------------------------------------------------ loop
async def game_loop():
    last = time.time()
    acc = 0.0
    while True:
        await asyncio.sleep(TICK / 2)
        now = time.time()
        acc += min(0.25, now - last)
        last = now
        while acc >= TICK:
            acc -= TICK
            for room in list(ROOMS.values()):
                tick_room(room, now)
        for room in list(ROOMS.values()):
            sweep(room, now)


def tick_room(room, now):
    if room.phase == "countdown":
        if now >= room.t_phase:
            start_play(room, now)
        else:
            room.tick += 1
            if room.tick % SEND_EVERY == 0:
                broadcast(room, state_msg(room, now))
            return
    if room.phase == "play":
        step(room, TICK, now)
        room.tick += 1
        if room.tick % SEND_EVERY == 0:
            broadcast(room, state_msg(room, now))
        if now >= room.t_end:
            end_round(room, now)
    elif room.phase == "results" and now >= room.t_phase:
        back_to_lobby(room)


def sweep(room, now):
    for b in [b for b in room.bees.values() if b.gone is not None and now - b.gone > RESUME_GRACE]:
        room.bees.pop(b.id, None)
        if room.phase in ("lobby",):
            broadcast(room, lobby_msg(room))
    humans = [b for b in room.bees.values() if not b.bot and b.gone is None]
    if humans or room.watchers:
        room.empty_since = None
    elif room.empty_since is None:
        room.empty_since = now
    elif now - room.empty_since > ROOM_IDLE_TTL:
        ROOMS.pop(room.code, None)


# ------------------------------------------------------------------ joining
def join(b, room, w):
    if room.phase != "lobby":
        b.send(F({"t": "err", "msg": "That garden is mid-round. Wait for the round to end and try again."}))
        return False
    if sum(1 for x in room.bees.values() if not x.bot) >= MAX_BEES:
        b.send(F({"t": "err", "msg": "That garden is full (8 bees)."}))
        return False
    b.room = room
    b.slot = free_slot(room)
    room.bees[b.id] = b
    if room.host is None:
        room.host = b.id
    b.send(F({"t": "hi", "id": b.id, "code": room.code, "key": b.key, "slot": b.slot}))
    broadcast(room, lobby_msg(room))
    return True


def create(b, w, solo=False):
    if len(ROOMS) >= MAX_ROOMS:
        b.send(F({"t": "err", "msg": "Too many gardens are open right now."}))
        return None
    room = Room(gen_code())
    room.solo = solo
    room.bots_wanted = 3 if solo else 0
    ROOMS[room.code] = room
    join(b, room, w)
    if solo:
        start_countdown(room)
    return room


def resume(w, code, key):
    room = ROOMS.get(str(code or "").upper())
    if not room:
        return None
    for b in room.bees.values():
        if not b.bot and b.key == key:
            b.w, b.gone = w, None
            b.send(F({"t": "hi", "id": b.id, "code": room.code, "key": b.key, "slot": b.slot}))
            b.send(lobby_msg(room))
            if room.phase in ("countdown", "play"):
                b.send(F({"t": "go", "in": 0, **world_msg(room)}))
            elif room.phase == "results":
                b.send(F({"t": "end", "rank": room.last_rank}))
            return b
    return None


def drop(b, w):
    room = b.room
    if b.w is not w or room is None:
        return
    b.w, b.down = None, False
    if room.phase == "lobby":
        room.bees.pop(b.id, None)
        if room.host == b.id:
            room.host = next((x.id for x in room.bees.values() if not x.bot), None)
        broadcast(room, lobby_msg(room))
    else:
        b.gone = time.time()        # autopilot flies the bee until they come back


def on_control(b, m):
    room = b.room
    t = m.get("t")
    if t == "sting":
        if room.phase == "play":
            arm_sting(b)
    elif t == "to":
        fi = m.get("f")
        if room.phase == "play" and type(fi) is int and 0 <= fi < len(room.world["flowers"]):
            launch(b, fi)
    elif t == "bots" and room.host == b.id and room.phase == "lobby":
        v = m.get("v")
        if type(v) is int:
            room.bots_wanted = max(0, min(MAX_BEES - 1, v))
            broadcast(room, lobby_msg(room))
    elif t == "name" and room.phase == "lobby":
        b.name = "".join(c for c in str(m.get("v") or "") if c.isprintable())[:14].strip()
        broadcast(room, lobby_msg(room))
    elif t == "start" and room.host == b.id and room.phase == "lobby":
        start_countdown(room)


# ------------------------------------------------------------------ http + websocket
async def read_frame(r):
    h = await r.readexactly(2)
    op, ln, masked = h[0] & 15, h[1] & 127, h[1] & 128
    if ln == 126:
        ln = struct.unpack(">H", await r.readexactly(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", await r.readexactly(8))[0]
    if ln > 4096:
        raise ValueError("frame too large")
    mask = await r.readexactly(4) if masked else None
    data = await r.readexactly(ln) if ln else b""
    if mask:
        data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
    return op, data


async def ws_session(r, w, headers):
    key = headers.get("sec-websocket-key")
    if not key:
        w.close()
        return
    acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    w.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + acc + b"\r\n\r\n")
    sock = w.get_extra_info("socket")
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
    b, watcher = None, None
    try:
        while True:
            op, data = await asyncio.wait_for(read_frame(r), 75)
            if op == 8:
                break
            if op == 9:
                w.write(b"\x8a" + bytes([len(data)]) + data)
                continue
            if op != 1:
                continue
            try:
                m = json.loads(data)
                t = m.get("t")
            except (ValueError, AttributeError):
                continue
            if b is None and watcher is None:
                if t == "hello":
                    b = new_bee(m.get("name"))
                    b.w = w
                    mode = m.get("mode")
                    if mode == "join":
                        room = ROOMS.get(str(m.get("code") or "").strip().upper())
                        if room is None:
                            b.send(F({"t": "err", "msg": "No garden has that code. Check the letters and try again."}))
                            b = None
                        elif not join(b, room, w):
                            b = None
                    elif create(b, w, solo=(mode == "solo")) is None:
                        b = None
                elif t == "resume":
                    b = resume(w, m.get("code"), str(m.get("key") or ""))
                    if b is None:
                        w.write(F({"t": "lost"}))
                elif t == "watch":
                    room = ROOMS.get(str(m.get("code") or "").strip().upper())
                    if room is None:
                        w.write(F({"t": "err", "msg": "No garden has that code."}))
                    else:
                        watcher = Watcher()
                        watcher.w, watcher.room = w, room
                        room.watchers.add(watcher)
                        watcher.send(lobby_msg(room))
                        if room.phase in ("countdown", "play"):
                            watcher.send(F({"t": "go", "in": 0, **world_msg(room)}))
                        elif room.phase == "results":
                            watcher.send(F({"t": "end", "rank": room.last_rank}))
                continue
            if b and b.room:
                on_control(b, m)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, OSError):
        pass
    finally:
        if b:
            drop(b, w)
        if watcher:
            watcher.room.watchers.discard(watcher)
        w.close()


PAGES = {"/": "index.html", "/index.html": "index.html", "/board": "board.html", "/board.html": "board.html",
         "/art.js": "art.js", "/sim.js": "sim.js", "/net.js": "net.js",
         "/guide": "visual-guide.html", "/visual-guide.html": "visual-guide.html"}
TYPES = {".html": b"text/html; charset=utf-8", ".js": b"application/javascript; charset=utf-8"}


async def handle(r, w):
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin1").split("\r\n")
        _, path, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    except Exception:
        w.close()
        return
    if headers.get("upgrade", "").lower() == "websocket":
        await ws_session(r, w, headers)
        return
    try:
        fname = PAGES.get(path.split("?")[0])
        if fname:
            with open(os.path.join(HERE, fname), "rb") as f:
                body, status = f.read(), b"200 OK"
            ctype = TYPES[".js" if fname.endswith(".js") else ".html"]
        else:
            body, status, ctype = b"Not found", b"404 Not Found", b"text/plain"
        w.write(b"HTTP/1.1 " + status + b"\r\nContent-Type: " + ctype + b"\r\nContent-Length: " +
                str(len(body)).encode() + b"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n" + body)
        await w.drain()
    except Exception:
        pass
    finally:
        w.close()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


async def main():
    server = await asyncio.start_server(handle, HOST, PORT, backlog=512)
    asyncio.create_task(game_loop())
    ip = lan_ip()
    print("BUMBLEBLOOM      ->  http://%s:%d   (local: http://localhost:%d)" % (ip, PORT, PORT))
    print("Big screen       ->  http://%s:%d/board?code=CODE" % (ip, PORT))
    print("Rules guide      ->  http://%s:%d/guide" % (ip, PORT))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
