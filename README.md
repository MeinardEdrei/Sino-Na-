# Sino Na? 🍺

Real-time Filipino inuman shot tracker — multiplayer via room codes, powered by Node.js, Express, and Socket.io.

## Local development

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

1. **Host** — Tap **Gumawa ng inuman**, enter **Pangalan mo?**, add other drinkers, then **Simulan na!** (your name is first in the circle).
2. Server creates a **4-character room code** (e.g. `B7KQ`) shown on the tracker screen.
3. **Players** — Open the same URL, tap **Sumali sa code**, enter the code and **Pangalan mo?** (must match a name the host added), then **Sumali na!**
4. When it's your turn, tap **Ininom ko na! 🥃** or **Preskong muna ⏭️** (skip). Host can skip on anyone's turn.
5. **Scoreboard** shows total drinks and skips per person for the session.
6. **Host** can add/remove drinkers (except themselves), end the session, or share the room code anytime.
7. On refresh/reconnect, your session is restored from browser storage when the room still exists.

## Deploy to Railway

1. Push this project to a GitHub repository.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your repo. Railway detects Node.js and runs `npm start`.
4. Railway sets `PORT` automatically; the server listens on `process.env.PORT || 3000`.
5. Copy the public URL Railway provides and share it with your barkada (same URL + room code to join).

## Project structure

```
sino-na/
├── public/
│   └── index.html    # Frontend (HTML/CSS/JS + Socket.io client)
├── server.js         # Express static server + Socket.io rooms
├── package.json
└── README.md
```

## Notes

- Room state is stored **in memory** on the server (no database). Restarts clear active rooms.
- Each room code is an isolated session; codes do not overlap.
- Host controls drinker list and ending the session; players can only mark a shot on their own turn.
