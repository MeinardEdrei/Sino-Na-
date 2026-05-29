# Sino Na? 🍺

> A fun little personal project I built for me and my barkada — real-time inuman shot tracker so nobody argues whose turn it is na.

Built with Node.js, Express, and Socket.io. No database, no accounts, just a room code and a circle of bubbles going around.

---

## Why I made this

Tired of the classic *"sino na ba?"* every time a shot goes around. Now everyone just looks at their phone. The active bubble glows, it's your turn, you drink or you skip — simple.

Works best on mobile (it's meant to be used at an actual inuman 🍻).

---

## How to use it

### Starting a room (Tanggero)

1. Open the app and tap **Gumawa ng inuman (Tanggero)**
2. Enter your name — you'll be the first tanggero (the one who manages the shots)
3. Add everyone else's names one by one, then tap **Simulan na!**
4. A **4-character room code** appears at the top (e.g. `B7KQ`) — share this with the group

### Joining a room

1. Open the same URL on your phone
2. Tap **Sumali sa room code**
3. Enter the 4-letter room code
4. Tap **Hanapin ang room**, then type your name exactly as the tanggero added it
5. Tap **Sumali na!** — you're in the circle

### During the inuman

| What you see | What it means |
|---|---|
| Glowing bubble 🥃 | It's that person's turn |
| Green bubble ✓ | Already drank this round |
| ⏭️ badge | Skipped this round |
| 🍺 bubble | That person is the tanggero |

- **Your turn** — tap **Ininom ko na! 🥃** when you drink, or **Skip muna** if you're passing
- **Tanggero** — can tap drink on behalf of anyone, skip anyone, or transfer the tanggero role
- **Scoreboard** — tap 📊 to see total drinks and skips for the whole session
- **End** — tanggero taps **Tapusin ang inuman** when everyone's done

### Tips

- Enable notifications when prompted — you'll get a lock screen alert when it's your turn (works great on Android Chrome)
- If you reload or disconnect, the app reconnects and restores your slot automatically as long as the room is still alive
- Room codes expire after **6 hours** of inactivity or when the tanggero ends the session

---

## Running locally

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000) on your phone (or share your local IP with the group on the same WiFi).

---

## Deploying (so the whole barkada can use it anywhere)

I host this on [Railway](https://railway.app) — free tier works fine for a night out:

1. Push this repo to GitHub
2. Go to **railway.app → New Project → Deploy from GitHub repo**
3. Select the repo — Railway auto-detects Node.js and runs `npm start`
4. Copy the public URL Railway gives you and share it with the group

That's it. Same URL + room code = everyone connected.

---

## Stack

```
sino-na/
├── public/
│   └── index.html    # Everything frontend — HTML, CSS, vanilla JS, Socket.io client
├── server.js         # Express + Socket.io rooms (all in-memory, no DB)
├── package.json
└── README.md
```

No build step, no framework, no database. Just vibes and websockets.

> Room state lives in memory — server restart clears active rooms. Good enough for a night out.
