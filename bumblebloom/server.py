#!/usr/bin/env python3
"""
BUMBLEBLOOM - a tap-to-fly garden race for 1 to 8 players.
Zero dependencies (Python 3.8+).   Run:  python server.py   ->  open http://<your-ip>:8000

Same shape as The Last Garden's server: one asyncio process serves the pages
and speaks raw WebSocket, phones join a six-character room code, a big screen
can show the garden at /board?code=CODE, and the server owns the whole
simulation, so every phone sees the same garden.

The game
  Each player (a seat) commands one or more bees (workers). A bee circles a
  flower on its own. TAP any flower and a bee flies straight to it; a
  straight line through the flytrap gets bitten, so sometimes you hop round it.
  Circle a white flower once (a rival's: twice) and it blooms in your colour.
  Your flowers that sit close together are joined by vines into a patch, and
  a patch of n flowers makes n*n honey a second.

  Levels: a match is one round (Meadow, one bee each) or three levels -
  Meadow, Orchard (two bees each), Hive (three bees each), in ever bigger
  gardens, with honey added up across them. With more than one bee, a bee is
  FREE once it is circling one of your own flowers (it has finished
  pollinating), and a tap sends your nearest free bee.

  Bees have 100 health. Predators turn up at random:
    dragonfly  darts straight across the lawn and stings any bee it touches
    bird       its shadow grows for a moment, then it swoops on that spot
    spider     drops onto a flower and webs it; circling there hurts
  plus the Venus flytrap in the middle, which bites any bee that flies into it.
  Circling one of your own flowers heals. At 0 health a bee faints, drops
  some of its player's honey and comes back on one of their flowers.

  Sting dash: tap Sting and your next (or current) flight becomes a fast
  dash; the first rival it touches loses 35 health and goes dizzy. If that
  bee faints within a few seconds, the honey it drops goes to you (the
  bounty). Each bee's sting then recharges for 3 s on its own.
  Fortified patches: a patch of 4+ joined flowers grows a hedge, and its
  flowers take 3 loops to steal instead of 2.

  Bot bees come in three skills - easy, normal, hard - which change how
  quickly they move on, how well they choose, and whether they sting.
"""
import asyncio, base64, hashlib, json, math, os, random, socket, string, struct, time

# ------------------------------------------------------------------ config
HOST, PORT = "0.0.0.0", int(os.environ.get("PORT", 8000))
TICK = 1 / 60
SEND_EVERY = 3                      # state goes out at 20 Hz
ROUND_SECONDS = int(os.environ.get("BLOOM_ROUND", 120))   # default round length; the host can pick another
ROUND_CHOICES = (60, 120, 180, 300)
RESULTS_SECONDS = 15
BETWEEN_LEVELS = 10                 # the results pause between levels of a match
COUNTDOWN = 3
MAX_SEATS = 8
MAX_ROOMS = 100
ROOM_IDLE_TTL = 300
RESUME_GRACE = 120
HERE = os.path.dirname(os.path.abspath(__file__))
CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")
NAMES = ["Red", "Blue", "Gold", "Violet", "Orange", "Pink", "Teal", "Brown"]

# ---- levels: how many bees each player commands
LEVELS = [{"name": "Meadow", "workers": 1}, {"name": "Orchard", "workers": 2}, {"name": "Hive", "workers": 3}]

# ---- bot skill: pause before moving on (s), chance of a random pick, chance of
#      not checking the flytrap path, chance of using a sting when a rival is in the way
SKILL = {
    "easy":   {"wait": (1.6, 3.2), "random": 0.40, "careless": 0.25, "sting": 0.0},
    "normal": {"wait": (0.9, 1.8), "random": 0.15, "careless": 0.0, "sting": 0.4},
    "hard":   {"wait": (0.4, 1.0), "random": 0.0, "careless": 0.0, "sting": 1.0},
}

# ---- flight
# Circling only matters for pollinating now, so it is a steady, calm turn.
OMEGA0 = 2.0                        # radians per second: one loop is about 3 s
FLY_V = 320.0                       # tap a flower and the bee flies straight there at this speed
ORBIT_GAP = 26.0                    # orbit radius = flower radius + this
BEE_R = 9.0

# ---- health
HP_MAX = 100.0
HEAL_PER_S = 7.0                    # while circling one of your own flowers
FAINT_SECONDS = 3.0
FAINT_HONEY_LOSS = 0.15             # of the player's honey, split between their bees
SAFE_SECONDS = 1.5                  # after coming back nothing can hurt you
DIZZY_SECONDS = 1.6
BUMP_DMG = 10
TRAP_DMG = 35
DRAGON_DMG = 25
BIRD_DMG = 45
WEB_DPS = 18

# ---- sting dash
STING_DMG = 35
STING_CD = 3.0                      # seconds before a bee can sting again (each bee has its own)
STING_SPEED = 1.45                  # a dash flies this much faster than a normal flight
STING_REACH = BEE_R * 2.6           # a little more forgiving than a bump
STING_DIZZY = 1.0
BOUNTY_WINDOW = 4.0                 # faint this soon after a sting or bump and the honey goes to whoever hit you

# ---- fortified patches
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

# arena size and flower count by number of bees in it (all players' bees together)
SIZES = [(2, 1240, 780, 10), (4, 1440, 880, 14), (6, 1640, 980, 18), (8, 1840, 1080, 22),
         (12, 2040, 1180, 28), (16, 2240, 1300, 34), (24, 2540, 1460, 44)]


# ------------------------------------------------------------------ world
def make_world(n_bees, seed):
    rng = random.Random(seed)
    W, H, count = next(((w, h, c) for cap, w, h, c in SIZES if n_bees <= cap), SIZES[-1][1:])
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
    while len(picks) < min(n, len(fl)):
        best = max((i for i in range(len(fl)) if i not in picks),
                   key=lambda i: min(math.hypot(fl[i]["x"] - fl[j]["x"], fl[i]["y"] - fl[j]["y"]) for j in picks))
        picks.append(best)
    return picks


def seg_dist(ax, ay, bx, by, px, py):
    dx, dy = bx - ax, by - ay
    l = dx * dx + dy * dy or 1
    u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l))
    return math.hypot(ax + u * dx - px, ay + u * dy - py)


# ------------------------------------------------------------------ players and bees
class Seat:
    """A player: a phone (or a bot), their colour, their honey and their sting."""
    __slots__ = ("id", "slot", "name", "w", "room", "key", "bot", "gone", "dev",
                 "score", "total", "faints", "blooms", "knocks", "sting_armed", "auto")

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


class Worker:
    """One bee in the garden. A player has one in the Meadow, more in later levels."""
    __slots__ = ("id", "seat", "slot", "state", "f", "ang", "rad", "dir", "v", "prog", "x", "y", "vx", "vy",
                 "timer", "hp", "safe", "hit_cd", "target", "wait", "sting", "sting_cd", "last_hit")


class Watcher:
    __slots__ = ("w", "room")

    def send(self, frame):
        if not self.w.transport.is_closing():
            self.w.write(frame)


class Room:
    def __init__(self, code):
        self.code = code
        self.seats = {}             # id -> Seat (humans and bots)
        self.workers = []           # every bee in the garden this round
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
        self.shared = False         # two players on one screen: one bee each, always
        self.bots_wanted = 0
        self.skill = "easy"
        self.secs = ROUND_SECONDS     # length of each round (each level of a match)
        self.match = "single"       # single | levels
        self.level = 0
        self.last_end = None
        self.fort = set()           # flowers in a fortified patch, worked out each tick


ROOMS = {}
NEXT_ID = 1


def clean_name(v):
    return "".join(c for c in str(v or "") if c.isprintable())[:14].strip()


def new_seat(name, bot=False):
    global NEXT_ID
    s = Seat()
    s.id, NEXT_ID = NEXT_ID, NEXT_ID + 1
    s.name = clean_name(name)
    s.w, s.room, s.bot, s.gone, s.dev = None, None, bot, None, ""
    s.auto = not bot                # auto sting: a flight at a rival becomes a dash by itself
    s.key = base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")
    s.slot = 0
    s.total = 0.0
    reset_seat(s)
    return s


def reset_seat(s):
    s.score, s.faints, s.blooms, s.knocks, s.sting_armed = 0.0, 0, 0, 0, False


def new_worker(seat, k):
    w = Worker()
    w.id, w.seat, w.slot = seat.id * 10 + k, seat, seat.slot
    w.state, w.f, w.ang, w.rad, w.dir, w.v, w.prog = "orbit", 0, 0.0, 40.0, 1, OMEGA0, 0.0
    w.x = w.y = w.vx = w.vy = 0.0
    w.timer, w.hp, w.safe, w.hit_cd = 0.0, HP_MAX, 0.0, 0.0
    w.target, w.wait, w.sting, w.sting_cd, w.last_hit = None, 1.0, False, 0.0, None
    return w


def free_slot(room):
    used = {s.slot for s in room.seats.values()}
    return next(i for i in range(MAX_SEATS) if i not in used)


def label(s):
    return s.name or (NAMES[s.slot] + " bee")


def workers_per_seat(room):
    return LEVELS[room.level]["workers"]


def devices(room):
    """How many separate devices the human players are on."""
    return len({s.dev or s.id for s in room.seats.values() if not s.bot})


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
    for s in room.seats.values():
        s.send(frame)
    for w in room.watchers:
        w.send(frame)


def gen_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(6))
        if code not in ROOMS:
            return code


def level_info(room):
    lv = LEVELS[room.level]
    return {"idx": room.level, "name": lv["name"], "workers": lv["workers"],
            "of": len(LEVELS) if room.match == "levels" else 1, "match": room.match}


def lobby_msg(room):
    humans = [s for s in room.seats.values() if not s.bot]
    return F({"t": "lobby", "code": room.code, "host": room.host, "solo": room.solo, "shared": room.shared,
              "bots": room.bots_wanted, "skill": room.skill, "match": room.match, "secs": room.secs, "phase": room.phase,
              "devices": devices(room), "canLevels": not room.shared,
              "bees": [{"id": s.id, "slot": s.slot, "name": label(s), "bot": s.bot, "away": s.gone is not None,
                        "auto": s.auto} for s in sorted(humans, key=lambda s: s.slot)]})


def world_msg(room):
    wd = room.world
    return {"W": wd["W"], "H": wd["H"], "seed": wd["seed"], "link": wd["link"],
            "trap": wd["trap"], "flowers": [[f["x"], f["y"], f["r"]] for f in wd["flowers"]],
            "seats": [{"id": s.id, "slot": s.slot, "name": label(s), "bot": s.bot}
                      for s in sorted(room.seats.values(), key=lambda s: s.slot)],
            "bees": [{"id": w.id, "slot": w.slot, "name": label(w.seat), "bot": w.seat.bot, "seat": w.seat.id}
                     for w in room.workers],
            "level": level_info(room),
            "cfg": {"hp": HP_MAX, "secs": room.secs, "flyV": FLY_V, "trapR": TRAP_R + BEE_R,
                    "stingCd": STING_CD, "fortSize": FORTIFY_SIZE, "fortLoops": FORTIFY_LOOPS}}


def state_msg(room, now):
    wd = room.world
    bees = []
    for w in room.workers:
        s = w.seat
        st = {"orbit": 0, "fly": 1, "dizzy": 2, "faint": 3}[w.state]
        bees.append([w.id, round(w.x, 1), round(w.y, 1), round(w.ang, 3), st, round(w.hp),
                     int(s.score), round(w.prog, 2), w.f, w.dir, round(w.rad, 1),
                     round(w.vx, 1), round(w.vy, 1), 1 if w.safe > 0 else 0, round(w.v, 2),
                     -1 if w.target is None or w.state != "fly" else w.target,
                     1 if w.sting else 0, 1 if s.sting_armed else 0, round(w.sting_cd, 1), s.id, int(s.total)])
    preds = []
    for p in room.preds:
        if p["k"] == "dragon":
            preds.append(["d", round(p["x"]), round(p["y"]), round(math.atan2(p["vy"], p["vx"]), 2), p["id"]])
        elif p["k"] == "bird":
            preds.append(["b", round(p["x"]), round(p["y"]), round(p["age"] / BIRD_WARN, 2), p["id"]])
        elif p["k"] == "spider":
            preds.append(["s", p["f"], 0, round(p["age"], 2), round(p["life"], 2)])
    owners = [f["owner"] for f in wd["flowers"]]
    msg = {"t": "s", "left": round(max(0.0, room.t_end - now), 1) if room.phase == "play" else room.secs,
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


def note(seat, text):
    """A message for one player only (e.g. all their bees are busy)."""
    seat.send(F({"t": "note", "x": text}))


# ------------------------------------------------------------------ phases
def start_countdown(room, fresh=True):
    """Grow a garden and put everyone's bees in it. fresh: a new match from the lobby."""
    room.phase = "countdown"
    room.t_phase = time.time() + COUNTDOWN
    if fresh:
        room.level = 0
        if room.shared or room.match not in ("single", "levels"):
            room.match = "single"
        for s in [s for s in room.seats.values() if s.bot]:
            room.seats.pop(s.id)
        humans = [s for s in room.seats.values() if not s.bot]
        want = max(0, min(MAX_SEATS - len(humans), room.bots_wanted))
        for _ in range(want):
            bot = new_seat("", bot=True)
            bot.slot = free_slot(room)
            bot.room = room
            room.seats[bot.id] = bot
        for s in room.seats.values():
            s.total = 0.0
    for s in room.seats.values():
        reset_seat(s)
    k = workers_per_seat(room)
    seats = sorted(room.seats.values(), key=lambda s: s.slot)
    room.workers = [new_worker(s, j) for s in seats for j in range(k)]
    room.world = make_world(len(room.workers), random.randrange(1 << 30))
    fl = room.world["flowers"]
    homes = spread_starts(room.world, len(seats))
    taken = set(homes)
    for s, home in zip(seats, homes):
        # a player's bees start together: one on their home flower, the others on
        # the nearest white flowers, so they grow one patch instead of scattered ones
        fl[home]["owner"] = s.slot
        team = [w for w in room.workers if w.seat is s]
        near = sorted((i for i in range(len(fl)) if i not in taken),
                      key=lambda i: math.hypot(fl[i]["x"] - fl[home]["x"], fl[i]["y"] - fl[home]["y"]))
        spots = [home] + near[:len(team) - 1]
        taken.update(spots)
        for w, fi in zip(team, spots):
            f = fl[fi]
            w.f, w.rad, w.ang = fi, f["R"], random.uniform(0, math.tau)
            w.dir = 1 if w.slot % 2 == 0 else -1
            w.wait = random.uniform(*SKILL[room.skill]["wait"])
            place_on_orbit(w, f)
    room.preds = []
    room.fx = []
    room.last_end = None
    broadcast(room, lobby_msg(room))
    broadcast(room, F({"t": "go", "in": COUNTDOWN, **world_msg(room)}))


def start_play(room, now):
    room.phase = "play"
    room.t_end = now + room.secs
    room.next_pred = now + PRED_FIRST


def end_round(room, now):
    for s in room.seats.values():
        s.total += s.score
    more = room.match == "levels" and room.level < len(LEVELS) - 1
    room.phase = "results"
    room.t_phase = now + (BETWEEN_LEVELS if more else RESULTS_SECONDS)
    key = (lambda s: -s.score) if room.match == "single" else (lambda s: -s.total)
    rank = []
    for s in sorted(room.seats.values(), key=key):
        ps = patches(room.world, s.slot)
        rank.append({"slot": s.slot, "name": label(s), "honey": int(s.score), "total": int(s.total), "bot": s.bot,
                     "blooms": s.blooms, "faints": s.faints, "knocks": s.knocks,
                     "flowers": sum(1 for f in room.world["flowers"] if f["owner"] == s.slot),
                     "patch": max((len(p) for p in ps), default=0), "rate": sum(len(p) ** 2 for p in ps)})
    room.last_end = {"t": "end", "rank": rank, "level": level_info(room), "final": not more,
                     "next": LEVELS[room.level + 1]["name"] if more else None,
                     "nextWorkers": LEVELS[room.level + 1]["workers"] if more else None,
                     "in": BETWEEN_LEVELS if more else RESULTS_SECONDS}
    broadcast(room, F(room.last_end))


def after_results(room):
    if room.match == "levels" and room.level < len(LEVELS) - 1:
        room.level += 1
        start_countdown(room, fresh=False)
    else:
        back_to_lobby(room)


def back_to_lobby(room):
    room.phase = "lobby"
    room.level = 0
    room.workers = []
    for s in [s for s in room.seats.values() if s.bot or s.gone is not None]:
        room.seats.pop(s.id)
    if room.host not in room.seats and room.seats:
        room.host = next(iter(room.seats))
    broadcast(room, lobby_msg(room))


# ------------------------------------------------------------------ simulation
def place_on_orbit(w, f):
    w.x = f["x"] + math.cos(w.ang) * w.rad
    w.y = f["y"] + math.sin(w.ang) * w.rad


def hurt(room, w, dmg, why, by=None):
    if w.safe > 0 or w.state == "faint":
        return
    if by is not None and by.seat is not w.seat:
        w.last_hit = (by.seat, time.time())     # for the bounty, if this ends in a faint
    w.hp -= dmg
    if w.hit_cd <= 0:               # a web hurts every tick; only show a hit now and then
        w.hit_cd = 0.35
        fx(room, "hit", w.x, w.y, w.slot)
    if w.hp <= 0:
        faint(room, w, why)


def faint(room, w, why):
    s = w.seat
    w.state, w.timer, w.hp, w.sting = "faint", FAINT_SECONDS, 0, False
    lost = int(s.score * FAINT_HONEY_LOSS / workers_per_seat(room))
    s.score -= lost
    s.faints += 1
    fx(room, "faint", w.x, w.y, w.slot)
    hitter, at = w.last_hit or (None, 0)
    w.last_hit = None
    if hitter is not None and hitter.room is room and time.time() - at <= BOUNTY_WINDOW:
        hitter.score += lost                # the bounty: the honey goes to whoever knocked them out
        hitter.knocks += 1
        room.toast = "%s knocked out %s and took %d honey!" % (label(hitter), label(s), lost)
    else:
        room.toast = "%s fainted (%s) and dropped %d honey" % (label(s), why, lost)


def respawn(room, w):
    fl = room.world["flowers"]
    own = [i for i, f in enumerate(fl) if f["owner"] == w.slot and f["web"] <= 0]
    pool = own or [i for i, f in enumerate(fl) if f["owner"] is None and f["web"] <= 0] or list(range(len(fl)))
    fi = random.choice(pool)
    f = fl[fi]
    w.state, w.f, w.ang, w.rad, w.v, w.prog = "orbit", fi, random.uniform(0, math.tau), f["R"], OMEGA0, 0.0
    w.hp, w.safe, w.target, w.wait, w.sting = HP_MAX, SAFE_SECONDS, None, 0.6, False
    place_on_orbit(w, f)


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


def is_free(room, w):
    """May this bee take a new order? With one bee: whenever it is up. With
    several: only once it has finished pollinating - circling one of your own
    flowers (or caught in a web, which it should leave)."""
    if workers_per_seat(room) == 1:
        return w.state in ("orbit", "fly")
    if w.state != "orbit":
        return False
    f = room.world["flowers"][w.f]
    return f["owner"] == w.slot or f["web"] > 0


def launch(room, w, fi):
    """The bee flies straight to flower fi. A one-bee player can change course mid-flight."""
    if not (w.state in ("orbit", "fly")) or (w.state == "orbit" and fi == w.f):
        return False
    w.state, w.target, w.prog = "fly", fi, 0.0
    s = w.seat
    if w.sting_cd <= 0 and not w.sting and (s.sting_armed or (s.auto and not s.bot and rival_in_way(room, w, fi))):
        start_sting(w)
    return True


def rival_in_way(room, w, fi):
    """Is a rival on the straight line to flower fi, or circling it? (auto sting, and the bots)"""
    t = room.world["flowers"][fi]
    return any(o.slot != w.slot and o.state in ("orbit", "fly") and o.safe <= 0 and
               (seg_dist(w.x, w.y, t["x"], t["y"], o.x, o.y) < 40 or (o.state == "orbit" and o.f == fi))
               for o in room.workers)


def start_sting(w):
    """This bee's flight becomes a dash. A press of Sting is used up (all the player's bees are
    disarmed), and this bee's own sting recharges for STING_CD seconds."""
    w.sting, w.sting_cd, w.seat.sting_armed = True, STING_CD, False


def arm_sting(room, s):
    """Sting while a bee with a ready sting is flying and that flight becomes the dash;
    otherwise the next flight of a bee whose sting is ready does."""
    if s.sting_armed:
        return
    mine = [w for w in room.workers if w.seat is s and w.state in ("orbit", "fly")]
    flying = [w for w in mine if w.state == "fly" and w.sting_cd <= 0 and not w.sting]
    if flying:
        start_sting(flying[0])
    elif any(w.sting_cd <= 0 for w in mine):
        s.sting_armed = True


def command(room, s, fi, wid=None):
    """A player tapped flower fi: send the bee they picked, or their nearest free bee."""
    fl = room.world["flowers"]
    mine = [w for w in room.workers if w.seat is s]
    if wid is not None:
        pick = [w for w in mine if w.id == wid]
        if pick and is_free(room, pick[0]):
            launch(room, pick[0], fi)
            return
    t = fl[fi]
    if len(mine) > 1 and any(w.state == "fly" and w.target == fi for w in mine):
        return                                  # one of your bees is already on its way there
    free = [w for w in mine if is_free(room, w) and not (w.state == "orbit" and w.f == fi)]
    if not free:
        if any(w.state == "orbit" and w.f == fi for w in mine):
            return                              # already there
        note(s, "All your bees are busy pollinating - wait for one to finish")
        return
    w = min(free, key=lambda w: math.hypot(w.x - t["x"], w.y - t["y"]))
    launch(room, w, fi)


def bot_think(room, w, dt, skill):
    wd = room.world
    fl = wd["flowers"]
    if w.state != "orbit":
        return
    f = fl[w.f]
    if f["owner"] != w.slot and f["web"] <= 0:
        return                                  # finish pollinating first
    if f["owner"] == w.slot and w.hp < 45:
        w.wait = max(w.wait, 0.5)               # rest and heal on your own flower
    if f["web"] > 0:
        w.wait = 0                              # get off a webbed flower now
    w.wait -= dt
    if w.wait > 0:
        return
    sk = SKILL[skill]
    birds = [p for p in room.preds if p["k"] == "bird"]
    cx, cy = wd["trap"]
    careless = random.random() < sk["careless"]
    options = []
    for i, t in enumerate(fl):
        if i == w.f or t["owner"] == w.slot or t["web"] > 0:
            continue
        if any(o.seat is w.seat and o.target == i for o in room.workers):
            continue                            # a teammate is already on its way there
        if not careless and seg_dist(w.x, w.y, t["x"], t["y"], cx, cy) < TRAP_R + BEE_R + 30:
            continue                            # that straight line runs through the flytrap
        if any(math.hypot(t["x"] - p["x"], t["y"] - p["y"]) < BIRD_R + 40 for p in birds):
            continue
        sc = math.hypot(t["x"] - f["x"], t["y"] - f["y"]) + (120 if t["owner"] is not None else 0) + random.random() * 90
        if i in room.fort:
            sc += 220                           # a hedge makes it slow to take
        options.append((sc, i))
    if not options:
        w.wait = 0.5
        return
    options.sort()
    best = random.choice(options)[1] if random.random() < sk["random"] else options[0][1]
    s = w.seat
    if w.sting_cd <= 0 and random.random() < sk["sting"] and rival_in_way(room, w, best):
        s.sting_armed = True                    # a rival sits on the way: make it a dash
    launch(room, w, best)
    w.wait = random.uniform(*sk["wait"])        # how long it lingers after its next landing


def step(room, dt, now):
    wd = room.world
    fl = wd["flowers"]
    cx, cy = wd["trap"]
    for f in fl:
        f["flash"] = max(0.0, f["flash"] - dt)
        f["web"] = max(0.0, f["web"] - dt)
    room.fort = fortified(wd)

    for w in room.workers:
        s = w.seat
        if s.bot:
            bot_think(room, w, dt, room.skill)
        elif s.gone is not None:
            bot_think(room, w, dt, "normal")      # autopilot while their phone is away
        w.safe = max(0.0, w.safe - dt)
        w.hit_cd = max(0.0, w.hit_cd - dt)
        w.sting_cd = max(0.0, w.sting_cd - dt)
        if w.state in ("dizzy", "faint"):
            w.timer -= dt
            if w.timer <= 0:
                respawn(room, w)
            continue
        if w.state == "orbit":
            f = fl[w.f]
            w.rad += (f["R"] - w.rad) * min(1.0, 6 * dt)
            w.ang = (w.ang + w.dir * w.v * dt) % math.tau
            place_on_orbit(w, f)
            if f["web"] > 0:
                hurt(room, w, WEB_DPS * dt, "caught in a web")
                if w.state == "faint":
                    continue
            elif f["owner"] == w.slot:
                w.hp = min(HP_MAX, w.hp + HEAL_PER_S * dt)
            else:
                w.prog += w.v * dt
                loops = 1 if f["owner"] is None else FORTIFY_LOOPS if w.f in room.fort else 2
                if w.prog >= loops * math.tau:
                    f["owner"], f["flash"], w.prog = w.slot, 1.0, 0.0
                    s.blooms += 1
                    fx(room, "bloom", f["x"], f["y"], w.slot)
        elif w.state == "fly":
            t = fl[w.target]
            dx, dy = t["x"] - w.x, t["y"] - w.y
            d = math.hypot(dx, dy) or 1
            spd = FLY_V * (STING_SPEED if w.sting else 1.0)
            w.vx, w.vy = dx / d * spd, dy / d * spd
            if d - spd * dt <= t["R"]:
                # arrive on the flower's ring and start circling it
                w.x, w.y = t["x"] - dx / d * t["R"], t["y"] - dy / d * t["R"]
                rx, ry = w.x - t["x"], w.y - t["y"]
                w.state, w.f = "orbit", w.target
                w.ang = math.atan2(ry, rx) % math.tau
                w.rad = t["R"]
                w.dir = 1 if rx * w.vy - ry * w.vx >= 0 else -1
                w.v, w.prog, w.target = OMEGA0, 0.0, None
                if w.sting:
                    # a dash at a flower strikes a rival circling it, wherever they are on the ring
                    occ = [v for v in room.workers if v.slot != w.slot and v.f == w.f
                           and v.state in ("orbit", "dizzy") and v.safe <= 0]
                    if occ:
                        sting_hit(room, w, min(occ, key=lambda v: math.hypot(v.x - w.x, v.y - w.y)))
                w.sting = False                 # a dash that hit nobody ends when you land
                fx(room, "land", w.x, w.y, w.slot)
            else:
                w.x += w.vx * dt
                w.y += w.vy * dt
            if math.hypot(w.x - cx, w.y - cy) < TRAP_R + BEE_R:
                # flew straight into the flytrap: bitten, dazed, sent home
                fx(room, "snap", cx, cy, w.slot)
                w.x, w.y = cx - dx / d * (TRAP_R + BEE_R + 6), cy - dy / d * (TRAP_R + BEE_R + 6)
                w.state, w.timer, w.target, w.sting = "dizzy", DIZZY_SECONDS, None, False
                hurt(room, w, TRAP_DMG, "bitten by the flytrap")

    # stings: a dashing bee hits the first rival it reaches, flying or circling
    for a in room.workers:
        if not (a.sting and a.state == "fly"):
            continue
        for v in room.workers:
            if v.slot == a.slot or v.state not in ("orbit", "fly", "dizzy") or v.safe > 0:
                continue
            if math.hypot(a.x - v.x, a.y - v.y) < STING_REACH:
                sting_hit(room, a, v)
                break

    # bumping: a flying bee knocks a circling rival dizzy (teammates pass through each other)
    live = [w for w in room.workers if w.state in ("orbit", "fly")]
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            a, c = live[i], live[j]
            if a.slot == c.slot or math.hypot(a.x - c.x, a.y - c.y) > BEE_R * 2:
                continue
            if a.state == "fly" and c.state == "orbit":
                bump(room, a, c)
            elif c.state == "fly" and a.state == "orbit":
                bump(room, c, a)

    step_predators(room, dt, now)

    for s in room.seats.values():
        s.score += sum(len(p) ** 2 for p in patches(wd, s.slot)) * dt


def sting_hit(room, a, v):
    a.sting = False
    fx(room, "sting", v.x, v.y, a.slot)
    hurt(room, v, STING_DMG, "stung by %s" % label(a.seat), by=a)
    if v.state != "faint":
        v.state, v.timer, v.target, v.sting = "dizzy", STING_DIZZY, None, False


def bump(room, flier, victim):
    if victim.safe > 0:
        return
    victim.state, victim.timer, victim.sting = "dizzy", DIZZY_SECONDS, False
    fx(room, "bump", victim.x, victim.y, victim.slot)
    hurt(room, victim, BUMP_DMG, "bumped by %s" % label(flier.seat), by=flier)


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
            for w in room.workers:
                if w.id in p["hit"] or w.state not in ("orbit", "fly"):
                    continue
                if math.hypot(w.x - p["x"], w.y - p["y"]) < 26:
                    p["hit"].add(w.id)
                    hurt(room, w, DRAGON_DMG, "stung by a dragonfly")
            if -160 < p["x"] < W + 160 and -160 < p["y"] < H + 160:
                keep.append(p)
        elif p["k"] == "bird":
            if not p["struck"] and p["age"] >= BIRD_WARN:
                p["struck"] = True
                fx(room, "swoop", p["x"], p["y"])
                for w in room.workers:
                    if w.state in ("orbit", "fly", "dizzy") and math.hypot(w.x - p["x"], w.y - p["y"]) < BIRD_R:
                        hurt(room, w, BIRD_DMG, "caught by a bird")
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
    kind = random.choice(["dragon", "bird", "spider"])
    live = [w for w in room.workers if w.state in ("orbit", "fly")]
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
        w = random.choice(live)
        room.preds.append({"k": "bird", "id": pid, "x": w.x + random.uniform(-30, 30),
                           "y": w.y + random.uniform(-30, 30), "age": 0.0, "struck": False})
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
        after_results(room)


def sweep(room, now):
    for s in [s for s in room.seats.values() if s.gone is not None and now - s.gone > RESUME_GRACE]:
        if room.phase == "lobby":
            room.seats.pop(s.id, None)
            broadcast(room, lobby_msg(room))
    humans = [s for s in room.seats.values() if not s.bot and s.gone is None]
    if humans or room.watchers:
        room.empty_since = None
    elif room.empty_since is None:
        room.empty_since = now
    elif now - room.empty_since > ROOM_IDLE_TTL:
        ROOMS.pop(room.code, None)


# ------------------------------------------------------------------ joining
def apply_settings(room, m):
    """Bots, skill and match length, as chosen on the home screen or in the lobby."""
    v = m.get("bots")
    if type(v) is int:
        room.bots_wanted = max(0, min(MAX_SEATS - 1, v))
    if m.get("secs") in ROUND_CHOICES:
        room.secs = m["secs"]
    if m.get("skill") in SKILL:
        room.skill = m["skill"]
    if m.get("match") in ("single", "levels"):
        room.match = "single" if room.shared else m["match"]


def join(s, room):
    if room.phase != "lobby":
        s.send(F({"t": "err", "msg": "That garden is mid-round. Wait for the round to end and try again."}))
        return False
    if sum(1 for x in room.seats.values() if not x.bot) >= MAX_SEATS:
        s.send(F({"t": "err", "msg": "That garden is full (8 players)."}))
        return False
    s.room = room
    s.slot = free_slot(room)
    room.seats[s.id] = s
    if room.host is None:
        room.host = s.id
    s.send(F({"t": "hi", "id": s.id, "code": room.code, "key": s.key, "slot": s.slot}))
    broadcast(room, lobby_msg(room))
    return True


def create(s, m):
    if len(ROOMS) >= MAX_ROOMS:
        s.send(F({"t": "err", "msg": "Too many gardens are open right now."}))
        return None
    room = Room(gen_code())
    room.solo = m.get("mode") == "solo"
    room.shared = bool(m.get("shared"))
    apply_settings(room, m)
    ROOMS[room.code] = room
    join(s, room)
    if room.solo:
        start_countdown(room)
    return room


def resume(w, code, key):
    room = ROOMS.get(str(code or "").upper())
    if not room:
        return None
    for s in room.seats.values():
        if not s.bot and s.key == key:
            s.w, s.gone = w, None
            s.send(F({"t": "hi", "id": s.id, "code": room.code, "key": s.key, "slot": s.slot}))
            s.send(lobby_msg(room))
            if room.phase in ("countdown", "play"):
                s.send(F({"t": "go", "in": 0, **world_msg(room)}))
            elif room.phase == "results" and room.last_end:
                s.send(F(room.last_end))
            return s
    return None


def drop(s, w):
    room = s.room
    if s.w is not w or room is None:
        return
    s.w = None
    if room.phase == "lobby":
        room.seats.pop(s.id, None)
        if room.host == s.id:
            room.host = next((x.id for x in room.seats.values() if not x.bot), None)
        broadcast(room, lobby_msg(room))
    else:
        s.gone = time.time()        # autopilot flies their bees until they come back


def on_control(s, m):
    room = s.room
    t = m.get("t")
    if t == "sting":
        if room.phase == "play":
            arm_sting(room, s)
    elif t == "to":
        fi, wid = m.get("f"), m.get("b")
        if room.phase == "play" and type(fi) is int and 0 <= fi < len(room.world["flowers"]):
            command(room, s, fi, wid if type(wid) is int else None)
    elif t in ("bots", "skill", "match", "secs") and room.host == s.id and room.phase == "lobby":
        apply_settings(room, {t: m.get("v")})
        broadcast(room, lobby_msg(room))
    elif t == "auto":
        s.auto = bool(m.get("v"))
        if room.phase == "lobby":
            broadcast(room, lobby_msg(room))
    elif t == "name" and room.phase == "lobby":
        s.name = clean_name(m.get("v"))
        broadcast(room, lobby_msg(room))
    elif t == "start" and room.host == s.id and room.phase == "lobby":
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
                    b = new_seat(m.get("name"))
                    b.w = w
                    b.dev = str(m.get("dev") or "")[:40]
                    b.auto = m.get("auto") is not False
                    if m.get("mode") == "join":
                        room = ROOMS.get(str(m.get("code") or "").strip().upper())
                        if room is None:
                            b.send(F({"t": "err", "msg": "No garden has that code. Check the letters and try again."}))
                            b = None
                        elif not join(b, room):
                            b = None
                    elif create(b, m) is None:
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
                        elif room.phase == "results" and room.last_end:
                            watcher.send(F(room.last_end))
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
         "/art.js": "art.js", "/sim.js": "sim.js", "/net.js": "net.js", "/relay.js": "relay.js",
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
