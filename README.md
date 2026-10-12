# Games

Browser games that run straight from GitHub Pages, no install.

| Game | Play | About |
|---|---|---|
| **Bumblebloom** | [`bumblebloom/`](bumblebloom/) | Tap-to-fly garden race for 1–8 players: pollinate flowers, grow vines, dodge predators. [Rules and how it works](bumblebloom/README.md). |

## Publishing on GitHub Pages

Settings → Pages → *Build and deployment*: **Deploy from a branch**, branch **main**, folder **/ (root)**.
The site appears at `https://<user>.github.io/games/`.

Bumblebloom works in two modes from the same files:

- **Browser mode** (GitHub Pages): the player who makes a garden hosts it in their own tab; everyone
  else joins with the 6-letter code over a direct browser-to-browser connection.
- **Server mode**: `python bumblebloom/server.py` on a laptop, for events on a local Wi-Fi with no internet.

The source of truth is `Game 3/` in the `claude_projects` repo; this repo is the published copy.
