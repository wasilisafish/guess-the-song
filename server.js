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
    players: [],          // { id, name, socketId, score, isHost, playlistId?, playlistName?, playlistTracks? }
    songs: [],            // { uri, name, artist, albumArt, addedBy, addedByName, previewUrl }
    currentRound: 0,
    currentSongIndex: -1,
    gameStarted: false,
    guesserIndex: -1,
    pickerIndex: -1,      // in take-turns mode: who picks the song
    roundActive: false,
    revealSong: false,
    roundTimer: null,
    roundExtensions: 0,
    gameMode: 'take-turns', // 'take-turns', 'challenge', or 'buzzer'
    challengeTargetIndex: -1,
    challengeQueue: [],
    musicPlayerId: null,
    // Buzzer mode
    buzzerOpen: false,      // true when players can buzz in
    buzzedPlayerId: null,   // who buzzed in first
    // Take-turns mode
    pickPhase: false,       // true when picker is choosing a song
    pickerSongUri: null,    // the song the picker chose for this round
    pickerSong: null,       // full song object for current round
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
    const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Spotify playlists API error:', response.status, errText);
      return res.status(response.status).json({ error: 'Spotify API error: ' + response.status });
    }

    const data = await response.json();
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
    const url = `https://api.spotify.com/v1/playlists/${playlistId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Spotify playlist error:', response.status, errText);
      return res.status(response.status).json({ error: 'Spotify error: ' + response.status });
    }

    const playlist = await response.json();

    let rawItems = [];
    if (playlist.tracks && playlist.tracks.items && playlist.tracks.items.length > 0) {
      rawItems = playlist.tracks.items;
      let nextUrl = playlist.tracks.next;
      while (nextUrl) {
        const nextRes = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${t.access_token}` },
        });
        if (!nextRes.ok) break;
        const nextData = await nextRes.json();
        if (nextData.items) rawItems = rawItems.concat(nextData.items);
        nextUrl = nextData.next;
      }
    } else if (Array.isArray(playlist.items) && playlist.items.length > 0) {
      rawItems = playlist.items;
    }

    // Fallback: fetch tracks endpoint directly
    if (rawItems.length === 0) {
      let tracksUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
      while (tracksUrl) {
        const tracksRes = await fetch(tracksUrl, {
          headers: { Authorization: `Bearer ${t.access_token}` },
        });
        if (!tracksRes.ok) break;
        const tracksData = await tracksRes.json();
        if (tracksData.items) rawItems = rawItems.concat(tracksData.items);
        tracksUrl = tracksData.next;
      }
    }

    const tracks = rawItems
      .map((item) => {
        const t = item.track || item.item || item;
        if (!t || !t.uri || t.uri.startsWith('spotify:local')) return null;
        if (t.type && t.type !== 'track') return null;
        if (!t.name || !t.artists) return null;
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
      playlistId: null,
      playlistName: null,
      playlistTracks: [],
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
      playlistId: null,
      playlistName: null,
      playlistTracks: [],
    });
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('room-updated', sanitizeRoom(room));
    callback({ success: true, roomCode: code, room: sanitizeRoom(room) });
  });

  // Register as the music player
  socket.on('set-music-player', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.musicPlayerId = socket.id;
    console.log(`Music player set to ${socket.id} in room ${roomCode}`);
    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
  });

  // Player selects their playlist (for take-turns and buzzer modes)
  socket.on('select-playlist', ({ roomCode, playlistId, playlistName, tracks }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.playlistId = playlistId;
    player.playlistName = playlistName;
    player.playlistTracks = tracks || [];
    console.log(`${player.name} selected playlist "${playlistName}" (${player.playlistTracks.length} tracks) in room ${roomCode}`);

    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
  });

  // Add a song to the room's playlist (used in lobby for manual add, or during take-turns pick phase)
  socket.on('add-song', ({ roomCode, song }) => {
    const room = rooms[roomCode];
    if (!room) return;

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
    if (!room) return;

    room.gameStarted = true;
    room.currentRound = 0;
    room.currentSongIndex = -1;
    room.gameMode = mode || 'take-turns';

    if (room.gameMode === 'challenge') {
      // Challenge mode needs songs pre-added
      if (room.songs.length < 2) return;
      room.songs = shuffleArray([...room.songs]);
      room.challengeQueue = [];
      if (typeof challengeTargetIndex === 'number') {
        room.challengeQueue = [challengeTargetIndex];
      } else {
        room.challengeQueue = room.players.map((_, i) => i);
      }
      room.challengeTargetIndex = room.challengeQueue.shift();
      room.guesserIndex = room.challengeTargetIndex;

      const targetId = room.players[room.challengeTargetIndex]?.id;
      const otherSongs = room.songs.filter(s => s.addedBy !== targetId);
      const ownSongs = room.songs.filter(s => s.addedBy === targetId);
      room.songs = shuffleArray([...otherSongs, ...ownSongs]);

      io.to(roomCode).emit('game-started', { ...sanitizeRoom(room), gameMode: room.gameMode });
      startRound(roomCode);

    } else if (room.gameMode === 'take-turns') {
      // Take-turns: players pick songs from their playlists during the game
      // Need at least 2 players, each with a playlist selected
      const playersWithPlaylists = room.players.filter(p => p.playlistTracks && p.playlistTracks.length > 0);
      if (playersWithPlaylists.length < 2) {
        socket.emit('game-error', { message: 'At least 2 players need to select a playlist' });
        room.gameStarted = false;
        return;
      }

      room.pickerIndex = 0;
      room.guesserIndex = 1;
      room.currentRound = 0;
      room.songs = []; // songs get added during play

      io.to(roomCode).emit('game-started', { ...sanitizeRoom(room), gameMode: room.gameMode });
      startPickPhase(roomCode);

    } else if (room.gameMode === 'buzzer') {
      // Buzzer mode: pool all player playlist tracks, shuffle, play random
      const allTracks = [];
      room.players.forEach(p => {
        if (p.playlistTracks && p.playlistTracks.length > 0) {
          p.playlistTracks.forEach(track => {
            allTracks.push({ ...track, addedBy: p.id, addedByName: p.name });
          });
        }
      });

      if (allTracks.length < 2) {
        socket.emit('game-error', { message: 'Need at least 2 songs total from player playlists' });
        room.gameStarted = false;
        return;
      }

      room.songs = shuffleArray(allTracks);
      room.guesserIndex = -1; // no fixed guesser in buzzer mode
      room.buzzerOpen = false;
      room.buzzedPlayerId = null;

      io.to(roomCode).emit('game-started', { ...sanitizeRoom(room), gameMode: room.gameMode });
      startBuzzerRound(roomCode);
    }
  });

  // ─── Take-Turns: picker selects a song ────────────────────────────
  socket.on('pick-song', ({ roomCode, song }) => {
    const room = rooms[roomCode];
    if (!room || !room.pickPhase) return;
    if (socket.id !== room.players[room.pickerIndex]?.id) return; // only picker can pick

    room.pickPhase = false;
    room.pickerSong = { ...song, addedBy: socket.id, addedByName: room.players[room.pickerIndex].name };
    room.songs.push(room.pickerSong);
    room.currentSongIndex = room.songs.length - 1;

    // Now start the guessing round
    startGuessingRound(roomCode);
  });

  // ─── Buzzer: player raises hand ───────────────────────────────────
  socket.on('buzz-in', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.buzzerOpen) return;
    if (room.buzzedPlayerId) return; // someone already buzzed

    room.buzzerOpen = false;
    room.buzzedPlayerId = socket.id;

    const player = room.players.find(p => p.id === socket.id);
    console.log(`${player?.name} buzzed in for room ${roomCode}`);

    // Notify everyone who buzzed in — music stops, they say answer out loud
    io.to(roomCode).emit('player-buzzed', {
      playerId: socket.id,
      playerName: player ? player.name : 'Unknown',
      room: sanitizeRoom(room),
    });
  });

  // Host/judge marks buzzer answer correct or wrong
  socket.on('buzzer-judge', ({ roomCode, correct }) => {
    const room = rooms[roomCode];
    if (!room || !room.buzzedPlayerId) return;

    const currentSong = room.songs[room.currentSongIndex];
    const buzzer = room.players.find(p => p.id === room.buzzedPlayerId);

    if (correct && buzzer) {
      buzzer.score += 1;
    }

    room.roundActive = false;
    room.revealSong = true;
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

    io.to(roomCode).emit('buzzer-result', {
      correct,
      playerName: buzzer ? buzzer.name : 'Unknown',
      points: correct ? 1 : 0,
      song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
      room: sanitizeRoom(room),
    });
  });

  // Start next round
  socket.on('next-round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.gameMode === 'take-turns') {
      // Rotate: old guesser becomes picker, next player becomes guesser
      const numPlayers = room.players.length;
      room.pickerIndex = room.guesserIndex;
      room.guesserIndex = (room.pickerIndex + 1) % numPlayers;
      startPickPhase(roomCode);
    } else if (room.gameMode === 'buzzer') {
      startBuzzerRound(roomCode);
    } else {
      startRound(roomCode);
    }
  });

  // Player submits a guess (song name or artist)
  socket.on('submit-guess', ({ roomCode, guessSong, guessArtist }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;

    const currentSong = room.songs[room.currentSongIndex];
    const songName = currentSong.name.toLowerCase();
    const artistName = currentSong.artist.toLowerCase();

    const songGuess = (guessSong || '').toLowerCase().trim();
    const artistGuess = (guessArtist || '').toLowerCase().trim();

    const songMatch = songGuess && (songName.includes(songGuess) || songGuess.includes(songName));
    const artistMatch = artistGuess && (artistName.includes(artistGuess) || artistGuess.includes(artistName));

    if (songMatch || artistMatch) {
      const guesser = room.players[room.guesserIndex];
      let points = 0;
      if (songMatch && artistMatch) points = 2;
      else points = 1;

      points -= room.roundExtensions * 0.5;
      if (points < 0) points = 0;

      if (guesser) guesser.score += points;

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

  // Guesser requests more time
  socket.on('extend-time', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;
    if (room.gameMode === 'challenge') return;

    room.roundExtensions++;
    if (room.roundTimer) clearTimeout(room.roundTimer);
    room.roundTimer = setTimeout(() => timeUp(roomCode), 60000);

    io.to(roomCode).emit('time-extended', {
      extensions: room.roundExtensions,
      penalty: room.roundExtensions * 0.5,
    });
  });

  // Skip / reveal
  socket.on('skip-round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

    const currentSong = room.songs[room.currentSongIndex];
    room.roundActive = false;
    room.revealSong = true;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;

    io.to(roomCode).emit('round-skipped', {
      song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
      room: sanitizeRoom(room),
    });
  });

  // Judge marks answer as correct (challenge mode)
  socket.on('judge-correct', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;

    const currentSong = room.songs[room.currentSongIndex];
    const guesser = room.players[room.guesserIndex];
    if (guesser) guesser.score += 1;

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

  // Reset game
  socket.on('reset-game', ({ roomCode, keepSongs }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    room.gameStarted = false;
    room.roundActive = false;
    room.currentRound = 0;
    room.currentSongIndex = -1;
    room.guesserIndex = -1;
    room.pickerIndex = -1;
    room.revealSong = false;
    room.roundExtensions = 0;
    room.pickPhase = false;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.players.forEach(p => p.score = 0);
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
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = room.players[0].id;
        room.players[0].isHost = true;
      }
      io.to(code).emit('room-updated', sanitizeRoom(room));
    }
  });
});

// ─── Take-Turns: Pick Phase ─────────────────────────────────────────
function startPickPhase(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentRound++;
  room.pickPhase = true;
  room.roundActive = false;
  room.revealSong = false;
  room.roundExtensions = 0;
  room.pickerSong = null;
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  const picker = room.players[room.pickerIndex];
  const guesser = room.players[room.guesserIndex];

  // Send pick-phase event to all players
  room.players.forEach((player) => {
    const sock = io.sockets.sockets.get(player.id);
    if (!sock) return;

    sock.emit('pick-phase', {
      round: room.currentRound,
      pickerName: picker.name,
      guesserName: guesser.name,
      isPicker: player.id === picker.id,
      isGuesser: player.id === guesser.id,
      // Send picker their own playlist tracks so they can choose
      pickerTracks: player.id === picker.id ? picker.playlistTracks : null,
      room: sanitizeRoom(room),
    });
  });
}

// ─── Take-Turns: Guessing Round ─────────────────────────────────────
function startGuessingRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.pickerSong) return;

  room.roundActive = true;
  room.revealSong = false;

  const currentSong = room.pickerSong;
  const guesserId = room.players[room.guesserIndex]?.id;

  room.players.forEach((player) => {
    const sock = io.sockets.sockets.get(player.id);
    if (!sock) return;

    if (player.id === guesserId) {
      sock.emit('new-round', {
        round: room.currentRound,
        totalSongs: '?',
        guesserName: room.players[room.guesserIndex].name,
        isGuesser: true,
        songUri: currentSong.uri,
        song: null,
        gameMode: room.gameMode,
        room: sanitizeRoom(room),
      });
    } else {
      sock.emit('new-round', {
        round: room.currentRound,
        totalSongs: '?',
        guesserName: room.players[room.guesserIndex].name,
        isGuesser: false,
        songUri: currentSong.uri,
        song: { name: currentSong.name, artist: currentSong.artist, albumArt: currentSong.albumArt },
        gameMode: room.gameMode,
        room: sanitizeRoom(room),
      });
    }
  });

  // 30-second timer for take-turns guessing
  room.roundTimer = setTimeout(() => timeUp(roomCode), 30000);
}

// ─── Buzzer Mode: Start Round ───────────────────────────────────────
function startBuzzerRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentRound++;
  room.currentSongIndex++;
  room.revealSong = false;
  room.roundExtensions = 0;
  room.buzzedPlayerId = null;
  room.buzzerOpen = false;
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  if (room.currentSongIndex >= room.songs.length) {
    room.gameStarted = false;
    room.roundActive = false;
    io.to(roomCode).emit('game-ended', sanitizeRoom(room));
    return;
  }

  room.roundActive = true;
  const currentSong = room.songs[room.currentSongIndex];

  // In buzzer mode, everyone hears the song but no one sees the answer
  // After a short delay, buzzer opens
  io.to(roomCode).emit('buzzer-round', {
    round: room.currentRound,
    totalSongs: room.songs.length,
    songUri: currentSong.uri,
    gameMode: 'buzzer',
    room: sanitizeRoom(room),
  });

  // Open buzzer after 3 seconds (give song time to start)
  setTimeout(() => {
    if (!room.roundActive) return;
    room.buzzerOpen = true;
    io.to(roomCode).emit('buzzer-open');
  }, 3000);

  // 30-second timeout for buzzer round
  room.roundTimer = setTimeout(() => {
    if (!room.roundActive) return;
    room.buzzerOpen = false;
    timeUp(roomCode);
  }, 30000);
}

// ─── Challenge / old round-robin start round ────────────────────────
function startRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentRound++;
  room.currentSongIndex++;
  room.revealSong = false;
  room.roundExtensions = 0;
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  if (room.currentSongIndex >= room.songs.length) {
    if (room.gameMode === 'challenge' && room.challengeQueue.length > 0) {
      room.challengeTargetIndex = room.challengeQueue.shift();
      room.guesserIndex = room.challengeTargetIndex;
      room.currentSongIndex = 0;
      room.currentRound = 0;

      const targetId = room.players[room.challengeTargetIndex]?.id;
      const otherSongs = room.songs.filter(s => s.addedBy !== targetId);
      const ownSongs = room.songs.filter(s => s.addedBy === targetId);
      room.songs = shuffleArray([...otherSongs, ...ownSongs]);

      io.to(roomCode).emit('challenge-switch', {
        challengeName: room.players[room.challengeTargetIndex].name,
        room: sanitizeRoom(room),
      });
      setTimeout(() => startRound(roomCode), 2000);
      return;
    }

    room.gameStarted = false;
    room.roundActive = false;
    io.to(roomCode).emit('game-ended', sanitizeRoom(room));
    return;
  }

  room.roundActive = true;

  const currentSong = room.songs[room.currentSongIndex];
  const guesserId = room.players[room.guesserIndex]?.id;

  room.players.forEach((player) => {
    const sock = io.sockets.sockets.get(player.id);
    if (!sock) return;

    if (player.id === guesserId) {
      sock.emit('new-round', {
        round: room.currentRound,
        totalSongs: room.songs.length,
        guesserName: room.players[room.guesserIndex].name,
        isGuesser: true,
        songUri: currentSong.uri,
        song: null,
        gameMode: room.gameMode,
        room: sanitizeRoom(room),
      });
    } else {
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

  // Timer only for non-challenge modes
  if (room.gameMode !== 'challenge') {
    room.roundTimer = setTimeout(() => timeUp(roomCode), 30000);
  }
}

function timeUp(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.roundActive) return;

  const currentSong = room.songs[room.currentSongIndex];
  room.roundActive = false;
  room.revealSong = true;
  room.roundTimer = null;
  room.buzzerOpen = false;

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
      playlistName: p.playlistName || null,
      hasPlaylist: !!(p.playlistTracks && p.playlistTracks.length > 0),
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
    pickerIndex: room.pickerIndex,
    roundActive: room.roundActive,
    revealSong: room.revealSong,
    gameMode: room.gameMode,
    musicPlayerId: room.musicPlayerId,
    pickPhase: room.pickPhase,
    buzzerOpen: room.buzzerOpen,
    buzzedPlayerId: room.buzzedPlayerId,
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
