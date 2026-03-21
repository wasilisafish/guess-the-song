# 🎵 Guess the Song

A multiplayer "Guess the Song" quiz game with Spotify integration.
One person guesses while everyone else can see what's playing!

## Quick Setup (5 minutes)

### Step 1: Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in:
   - App name: `Guess the Song`
   - Redirect URI: `http://localhost:3000/callback`
4. Copy your **Client ID** and **Client Secret**

### Step 2: Configure the App

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Open `.env` and paste in your Spotify credentials:
   ```
   SPOTIFY_CLIENT_ID=your_client_id_here
   SPOTIFY_CLIENT_SECRET=your_client_secret_here
   ```

### Step 3: Install & Run

```
npm install
npm start
```

Open **http://localhost:3000** in your browser.

## How to Play

1. **Host** creates a room and connects their Spotify account
2. Share the **room code** with friends — they join from their devices
3. Everyone searches for songs and adds them to the playlist
4. Host hits **Start Game** when ready
5. Each round, one player is the **guesser** — they hear the song but can't see the title
6. Everyone else can see the song info (so they know the answer!)
7. The guesser types guesses until they get it right (or the host skips)
8. Players take turns guessing — highest score wins!

## Requirements

- Node.js 16+
- A **Spotify Premium** account (needed for playback)
- Friends on the same network (or deploy to share publicly)

## Playing with Friends on Different Networks

For friends to join from their own devices over the internet, you can use a tool like [ngrok](https://ngrok.com):

```
npx ngrok http 3000
```

Then update your `.env` file's `BASE_URL` to the ngrok URL, and add it as a redirect URI in your Spotify Dashboard.
