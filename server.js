require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = `${BASE_URL}/callback`;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── In-memory storage ───────────────────────────────────────────────
const rooms = {};    // roomCode -> room object
const tokens = {};   // visitorId -> { access_token, refresh_token, expires_at }

// ─── Helpers ─────────────────────────────────────────────────────────
async function ensureFreshToken(t) {
  if (Date.now() >= t.expires_at - 60000) {
    try {
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
        }),
      });
      const data = await response.json();
      if (data.access_token) {
        t.access_token = data.access_token;
        t.expires_at = Date.now() + data.expires_in * 1000;
        console.log('Token refreshed successfully');
      }
    } catch (err) {
      console.error('Token refresh error:', err.message);
    }
  }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function makeRoom(hostName) {
  const code = generateRoomCode();
  rooms[code] = {
    code,
    hostName,
    hostSocketId: null,
    players: [],          // { id, name, socketId, score }
    songs: [],            // { uri, name, artist, albumArt, addedBy, previewUrl }
    currentRound: 0,
    currentSongIndex: -1,
    gameStarted: false,
    guesserIndex: -1,     // which player is guessing
    roundActive: false,
    revealSong: false,
    roundTimer: null,       // server-side timer reference
    roundExtensions: 0,     // how many times guesser extended this round
    gameMode: 'round-robin', // 'round-robin' or 'challenge'
    challengeTargetIndex: -1, // in challenge mode, who is being challenged
    challengeQueue: [],       // ordered list of player indices to challenge
    musicPlayerId: null,      // socket id of whoever has Spotify playback
  };
  return rooms[code];
}

// ─── Spotify Auth Routes ─────────────────────────────────────────────
app.get('/login', (req, res) => {
  const state = req.query.roomCode || '';
  const scope = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
    'user-read-playback-state',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope,
    redirect_uri: REDIRECT_URI,
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await response.json();
    const { access_token, refresh_token, expires_in } = data;
    const visitorId = crypto.randomUUID();

    tokens[visitorId] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };

    // Redirect back to the app with the token identifier
    const roomParam = state ? `&room=${state}` : '';
    res.redirect(`/?spotifyAuth=${visitorId}${roomParam}`);
  } catch (err) {
    console.error('Spotify auth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

// Get a fresh access token
app.get('/api/token/:visitorId', async (req, res) => {
  const t = tokens[req.params.visitorId];
  if (!t) return res.status(401).json({ error: 'Not authenticated' });

  // Refresh if expired
  if (Date.now() >= t.expires_at - 60000) {
    try {
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
        }),
      });
      const data = await response.json();
      t.access_token = data.access_token;
      t.expires_at = Date.now() + data.expires_in * 1000;
    } catch (err) {
      console.error('Token refresh error:', err.message);
      return res.status(401).json({ error: 'Token refresh failed' });
    }
  }

  res.json({ access_token: t.access_token });
});

// Spotify search proxy
app.get('/api/search', async (req, res) => {
  const { q, visitorId } = req.query;
  const t = tokens[visitorId];
  if (!t) return res.status(401).json({ error: 'Not authenticated' });

  await ensureFreshToken(t);

  try {
    const searchParams = new URLSearchParams({ q, type: 'track', limit: '8' });
    const response = await fetch(`https://api.spotify.com/v1/search?${searchParams}`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    const data = await response.json();
    const tracks = data.tracks.items.map((track) => ({
      uri: track.uri,
      name: track.name,
      artist: track.artists.map((a) => a.name).join(', '),
      albumArt: track.album.images[1]?.url || track.album.images[0]?.url,
      previewUrl: track.preview_url,
      duration: track.duration_ms,
    }));
    res.json(tracks);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Fetch user's playlists
app.get('/api/playlists', async (req, res) => {
  const { visitorId } = req.query;
  const t = tokens[visitorId];
  if (!t) return res.status(401).json({ error: 'Not authenticated' });

  await ensureFreshToken(t);

  try {
    const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=30', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Spotify playlists API error:', response.status, errText);
      return res.status(response.status).json({ error: 'Spotify API error: ' + response.status });
    }

    const data = await response.json();
    console.log('Playlists fetched:', (data.items || []).length, 'playlists');
    const playlists = (data.items || []).map((pl) => ({
      id: pl.id,
      name: pl.name,
      image: pl.images?.[0]?.url || '',
      trackCount: pl.tracks?.total || 0,
      owner: pl.owner?.display_name || '',
    }));
    res.json(playlists);
  } catch (err) {
    console.error('Playlists error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Fetch tracks from a playlist
app.get('/api/playlist-tracks', async (req, res) => {
  const { playlistId, visitorId } = req.query;
  const t = tokens[visitorId];
  if (!t) return res.status(401).json({ error: 'Not authenticated' });

  await ensureFreshToken(t);

  try {
    // Fetch the playlist — Spotify may return tracks inside playlist.tracks.items or playlist.items
    const url = `https://api.spotify.com/v1/playlists/${playlistId}`;
    console.log('Fetching playlist:', url);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Spotify playlist error:', response.status, errText);
      return res.status(response.status).json({ error: 'Spotify error: ' + response.status });
    }

    const playlist = await response.json();

    // Debug: dump the raw response to understand the structure
    const raw = JSON.stringify(playlist);
    console.log('FULL RESPONSE (first 2000 chars):', raw.substring(0, 2000));

    // Spotify API can return items in different places depending on version
    let rawItems = [];
    if (playlist.tracks && playlist.tracks.items && playlist.tracks.items.length > 0) {
      rawItems = playlist.tracks.items;
    } else if (Array.isArray(playlist.items) && playlist.items.length > 0) {
      // playlist.items could be a paging object with its own items
      rawItems = playlist.items;
    } else if (playlist.items && playlist.items.items) {
      // playlist.items is a paging object like { href, items: [...], total, ... }
      rawItems = playlist.items.items;
    }
    console.log('Playlist name:', playlist.name, '| Raw items:', rawItems.length);

    // Spotify API may use "track" or "item" as the key for the song object
    const tracks = rawItems
      .map((item) => {
        const t = item.track || item.item || item;
        if (!t || !t.uri || t.uri.startsWith('spotify:local')) return null;
        return {
          uri: t.uri,
          name: t.name,
          artist: (t.artists || []).map((a) => a.name).join(', '),
          albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
          previewUrl: t.preview_url || null,
          duration: t.duration_ms,
        };
      })
      .filter(Boolean);
    console.log('Tracks after processing:', tracks.length);
    res.json(tracks);
  } catch (err) {
    console.error('Playlist tracks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// ─── Socket.io Game Logic ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create a room
  socket.on('create-room', ({ hostName }, callback) => {
    const room = makeRoom(hostName);
    room.hostSocketId = socket.id;
    room.players.push({
      id: socket.id,
      name: hostName,
      score: 0,
      isHost: true,
    });
    socket.join(room.code);
    socket.roomCode = room.code;
    callback({ success: true, roomCode: room.code, room: sanitizeRoom(room) });
  });

  // Join a room
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.gameStarted) return callback({ success: false, error: 'Game already in progress' });

    room.players.push({
      id: socket.id,
      name: playerName,
      score: 0,
      isHost: false,
    });
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('room-updated', sanitizeRoom(room));
    callback({ success: true, roomCode: code, room: sanitizeRoom(room) });
  });

  // Register as the music player (whoever has Spotify playback ready)
  socket.on('set-music-player', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.musicPlayerId = socket.id;
    console.log(`Music player set to ${socket.id} in room ${roomCode}`);
    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
  });

  // Add a song to the room's playlist
  socket.on('add-song', ({ roomCode, song }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Prevent duplicates
    if (room.songs.find((s) => s.uri === song.uri)) return;

    const player = room.players.find(p => p.id === socket.id);
    room.songs.push({ ...song, addedBy: socket.id, addedByName: player ? player.name : 'Unknown' });
    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
  });

  // Remove a song
  socket.on('remove-song', ({ roomCode, songUri }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.songs = room.songs.filter((s) => s.uri !== songUri);
    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
  });

  // Host starts the game
  socket.on('start-game', ({ roomCode, mode, challengeTargetIndex }) => {
    const room = rooms[roomCode];
    if (!room || room.songs.length < 2) return;

    room.gameStarted = true;
    room.currentRound = 0;
    room.gameMode = mode || 'round-robin';

    // Shuffle songs
    room.songs = shuffleArray([...room.songs]);

    if (room.gameMode === 'challenge') {
      // Challenge mode: play songs grouped by who added them
      // The challenged player guesses their own songs last;
      // other players' songs come first for each challenge target
      room.challengeQueue = [];
      if (typeof challengeTargetIndex === 'number') {
        room.challengeQueue = [challengeTargetIndex];
      } else {
        // Challenge everyone in order
        room.challengeQueue = room.players.map((_, i) => i);
      }
      room.challengeTargetIndex = room.challengeQueue.shift();
      room.guesserIndex = room.challengeTargetIndex;

      // Reorder songs: songs NOT added by the challenged player come first
      const targetId = room.players[room.challengeTargetIndex]?.id;
      const otherSongs = room.songs.filter(s => s.addedBy !== targetId);
      const ownSongs = room.songs.filter(s => s.addedBy === targetId);
      room.songs = shuffleArray([...otherSongs, ...ownSongs]);
    } else {
      room.guesserIndex = 0;
    }

    io.to(roomCode).emit('game-started', { ...sanitizeRoom(room), gameMode: room.gameMode });
    startRound(roomCode);
  });

  // Start next round
  socket.on('next-round', ({ roomCode }) => {
    startRound(roomCode);
  });

  // Player submits a guess (song name or artist separately)
  socket.on('submit-guess', ({ roomCode, guessSong, guessArtist }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;

    const currentSong = room.songs[room.currentSongIndex];
    const songName = currentSong.name.toLowerCase();
    const artistName = currentSong.artist.toLowerCase();

    const songGuess = (guessSong || '').toLowerCase().trim();
    const artistGuess = (guessArtist || '').toLowerCase().trim();

    // Check matches (fuzzy)
    const songMatch = songGuess && (songName.includes(songGuess) || songGuess.includes(songName));
    const artistMatch = artistGuess && (artistName.includes(artistGuess) || artistGuess.includes(artistName));

    if (songMatch || artistMatch) {
      const guesser = room.players[room.guesserIndex];
      let points = 0;
      if (songMatch && artistMatch) points = 2;    // Both = 2 points
      else points = 1;                              // One = 1 point

      // Subtract 0.5 for each extension used
      points -= room.roundExtensions * 0.5;
      if (points < 0) points = 0;

      if (guesser) guesser.score += points;

      // Stop the timer
      if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
      room.roundActive = false;
      room.revealSong = true;

      io.to(roomCode).emit('guess-result', {
        correct: true,
        songMatch,
        artistMatch,
        points,
        guessSong: guessSong || '',
        guessArtist: guessArtist || '',
        song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
        room: sanitizeRoom(room),
      });
    } else {
      socket.emit('guess-result', { correct: false, guessSong, guessArtist });
    }
  });

  // Guesser requests more time (-0.5 points)
  socket.on('extend-time', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;

    room.roundExtensions++;

    // Clear old timer and set a new 60s timer for extension
    if (room.roundTimer) clearTimeout(room.roundTimer);
    room.roundTimer = setTimeout(() => timeUp(roomCode), 60000);

    io.to(roomCode).emit('time-extended', {
      extensions: room.roundExtensions,
      penalty: room.roundExtensions * 0.5,
    });
  });

  // Host skips / reveals the answer
  socket.on('skip-round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

    const currentSong = room.songs[room.currentSongIndex];
    room.roundActive = false;
    room.revealSong = true;

    io.to(roomCode).emit('round-skipped', {
      song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
      room: sanitizeRoom(room),
    });
  });

  // Judge marks answer as correct (challenge mode — 1 point)
  socket.on('judge-correct', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;

    const currentSong = room.songs[room.currentSongIndex];
    const guesser = room.players[room.guesserIndex];
    if (guesser) guesser.score += 1;

    // Stop the timer
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    room.roundActive = false;
    room.revealSong = true;

    io.to(roomCode).emit('judge-result', {
      correct: true,
      points: 1,
      guesserName: guesser ? guesser.name : 'Unknown',
      song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
      room: sanitizeRoom(room),
    });
  });

  // End game
  socket.on('end-game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    room.gameStarted = false;
    room.roundActive = false;
    io.to(roomCode).emit('game-ended', sanitizeRoom(room));
  });

  // Reset game (back to lobby)
  socket.on('reset-game', ({ roomCode, keepSongs }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    room.gameStarted = false;
    room.roundActive = false;
    room.currentRound = 0;
    room.currentSongIndex = -1;
    room.guesserIndex = -1;
    room.revealSong = false;
    room.roundExtensions = 0;
    // Reset scores
    room.players.forEach(p => p.score = 0);
    // Optionally clear the playlist
    if (!keepSongs) room.songs = [];
    io.to(roomCode).emit('game-reset', sanitizeRoom(room));
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      // If host left, assign new host
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = room.players[0].id;
        room.players[0].isHost = true;
      }
      io.to(code).emit('room-updated', sanitizeRoom(room));
    }
  });
});

// ─── Game round logic ────────────────────────────────────────────────
function startRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentRound++;
  room.currentSongIndex++;
  room.revealSong = false;
  room.roundExtensions = 0;
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  // If we've gone through all songs
  if (room.currentSongIndex >= room.songs.length) {
    // In challenge mode, check if there are more players to challenge
    if (room.gameMode === 'challenge' && room.challengeQueue.length > 0) {
      room.challengeTargetIndex = room.challengeQueue.shift();
      room.guesserIndex = room.challengeTargetIndex;
      room.currentSongIndex = 0;
      room.currentRound = 0;

      // Reorder songs for new challenge target
      const targetId = room.players[room.challengeTargetIndex]?.id;
      const otherSongs = room.songs.filter(s => s.addedBy !== targetId);
      const ownSongs = room.songs.filter(s => s.addedBy === targetId);
      room.songs = shuffleArray([...otherSongs, ...ownSongs]);

      io.to(roomCode).emit('challenge-switch', {
        challengeName: room.players[room.challengeTargetIndex].name,
        room: sanitizeRoom(room),
      });
      // Short delay then start round
      setTimeout(() => startRound(roomCode), 2000);
      return;
    }

    room.gameStarted = false;
    room.roundActive = false;
    io.to(roomCode).emit('game-ended', sanitizeRoom(room));
    return;
  }

  // Rotate the guesser (only in round-robin mode)
  if (room.gameMode === 'round-robin') {
    room.guesserIndex = (room.currentRound - 1) % room.players.length;
  }
  // In challenge mode, guesserIndex stays the same (set at game start / challenge-switch)
  room.roundActive = true;

  const currentSong = room.songs[room.currentSongIndex];
  const guesserId = room.players[room.guesserIndex]?.id;

  // Send different data to guesser vs. everyone else
  room.players.forEach((player) => {
    const sock = io.sockets.sockets.get(player.id);
    if (!sock) return;

    if (player.id === guesserId) {
      // Guesser does NOT see the song info
      sock.emit('new-round', {
        round: room.currentRound,
        totalSongs: room.songs.length,
        guesserName: room.players[room.guesserIndex].name,
        isGuesser: true,
        songUri: currentSong.uri,  // needed for Spotify playback
        song: null,                // hidden!
        gameMode: room.gameMode,
        room: sanitizeRoom(room),
      });
    } else {
      // Everyone else CAN see the song
      sock.emit('new-round', {
        round: room.currentRound,
        totalSongs: room.songs.length,
        guesserName: room.players[room.guesserIndex].name,
        isGuesser: false,
        songUri: currentSong.uri,
        song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
        gameMode: room.gameMode,
        room: sanitizeRoom(room),
      });
    }
  });

  // Start 30-second timer
  room.roundTimer = setTimeout(() => timeUp(roomCode), 30000);
}

// Called when the 30-second timer runs out
function timeUp(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.roundActive) return;

  const currentSong = room.songs[room.currentSongIndex];
  room.roundActive = false;
  room.revealSong = true;
  room.roundTimer = null;

  io.to(roomCode).emit('time-up', {
    song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
    room: sanitizeRoom(room),
  });
}

// Strip sensitive data before sending room info to clients
function sanitizeRoom(room) {
  return {
    code: room.code,
    hostName: room.hostName,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      isHost: p.isHost,
    })),
    songCount: room.songs.length,
    songs: room.songs.map(s => ({
      name: s.name,
      artist: s.artist,
      albumArt: s.albumArt,
      uri: s.uri,
      addedByName: s.addedByName,
    })),
    gameStarted: room.gameStarted,
    currentRound: room.currentRound,
    totalSongs: room.songs.length,
    guesserIndex: room.guesserIndex,
    roundActive: room.roundActive,
    revealSong: room.revealSong,
    gameMode: room.gameMode,
    musicPlayerId: room.musicPlayerId,
    challengeName: room.gameMode === 'challenge' && room.challengeTargetIndex >= 0
      ? room.players[room.challengeTargetIndex]?.name : null,
  };
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Start server ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎵 Guess the Song is running at ${BASE_URL}\n`);
});
