// ─── State ────────────────────────────────────────────────────────
let socket = io();
let myName = '';
let roomCode = '';
let isHost = false;
let spotifyVisitorId = null;
let spotifyPlayer = null;
let spotifyDeviceId = null;
let currentRoom = null;
let timerInterval = null;
let timerSeconds = 30;
let currentExtensions = 0;
let selectedMode = 'take-turns';
let selectedChallengeTarget = null;
let isMusicPlayer = false;
let myPlaylistTracks = []; // full track list from my selected playlist

// Detect if this is a desktop browser (Spotify SDK only works on desktop)
const isDesktop = !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// ─── DOM Elements ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const screens = {
  welcome: $('screen-welcome'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  gameover: $('screen-gameover'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── Check URL params (after Spotify redirect) ──────────────────
(function checkAuth() {
  const params = new URLSearchParams(window.location.search);
  const authId = params.get('spotifyAuth');
  const roomParam = params.get('room');

  if (authId) {
    spotifyVisitorId = authId;
    localStorage.setItem('spotifyVisitorId', authId);
    window.history.replaceState({}, '', '/');
  } else {
    spotifyVisitorId = localStorage.getItem('spotifyVisitorId');
  }

  if (roomParam) {
    localStorage.setItem('pendingRoom', roomParam);
  }
})();

// ─── Welcome Screen Logic ────────────────────────────────────────
$('btn-create').addEventListener('click', () => {
  $('form-create').classList.toggle('hidden');
  $('form-join').classList.add('hidden');
});

$('btn-join').addEventListener('click', () => {
  $('form-join').classList.toggle('hidden');
  $('form-create').classList.add('hidden');
});

$('btn-create-go').addEventListener('click', () => {
  const name = $('input-host-name').value.trim();
  if (!name) return showError('Please enter your name');

  myName = name;
  isHost = true;

  socket.emit('create-room', { hostName: name }, (res) => {
    if (res.success) {
      roomCode = res.roomCode;
      currentRoom = res.room;
      updateLobby(res.room);
      showScreen('lobby');

      if (!spotifyVisitorId) {
        localStorage.setItem('pendingIsHost', '1');
        localStorage.setItem('pendingName', myName);
        window.location.href = `/login?roomCode=${roomCode}`;
      } else {
        initSpotify();
      }
    }
  });
});

$('btn-join-go').addEventListener('click', () => {
  const name = $('input-join-name').value.trim();
  const code = $('input-room-code').value.trim().toUpperCase();
  if (!name) return showError('Please enter your name');
  if (!code) return showError('Please enter a room code');

  myName = name;
  isHost = false;

  socket.emit('join-room', { roomCode: code, playerName: name }, (res) => {
    if (res.success) {
      roomCode = res.roomCode;
      currentRoom = res.room;
      updateLobby(res.room);
      showScreen('lobby');
      if (spotifyVisitorId) initSpotify();
    } else {
      showError(res.error);
    }
  });
});

// Auto-rejoin after Spotify redirect
if (localStorage.getItem('pendingRoom') && spotifyVisitorId) {
  const pendingRoom = localStorage.getItem('pendingRoom');
  const pendingName = localStorage.getItem('pendingName') || 'Player';
  const pendingIsHost = localStorage.getItem('pendingIsHost');
  localStorage.removeItem('pendingRoom');
  localStorage.removeItem('pendingName');
  localStorage.removeItem('pendingIsHost');

  myName = pendingName;

  if (pendingIsHost === '0') {
    isHost = false;
    socket.emit('join-room', { roomCode: pendingRoom, playerName: pendingName }, (res) => {
      if (res.success) {
        roomCode = res.roomCode;
        currentRoom = res.room;
        updateLobby(res.room);
        showScreen('lobby');
        initSpotify();
      }
    });
  } else {
    isHost = true;
    socket.emit('create-room', { hostName: pendingName }, (res) => {
      if (res.success) {
        roomCode = res.roomCode;
        currentRoom = res.room;
        updateLobby(res.room);
        showScreen('lobby');
        initSpotify();
      }
    });
  }
}

function showError(msg) {
  const el = $('welcome-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Lobby ───────────────────────────────────────────────────────
function updateLobby(room) {
  currentRoom = room;
  $('lobby-room-code').textContent = room.code;
  $('game-room-code').textContent = room.code;

  // Players list with playlist status
  const playersHtml = room.players
    .map(
      (p) =>
        `<div class="player-item">
          <span>${p.name}${p.id === socket.id ? ' (you)' : ''}</span>
          <span class="player-badges">
            ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
            ${p.id === room.musicPlayerId ? '<span class="host-badge" style="background:var(--green)">🎵 DJ</span>' : ''}
            ${p.hasPlaylist ? '<span class="host-badge" style="background:var(--accent)">🎶 ' + escapeHtml(p.playlistName || 'Playlist') + '</span>' : ''}
          </span>
        </div>`
    )
    .join('');
  $('lobby-players').innerHTML = playersHtml;

  // Show/hide sections based on mode
  const isChallengeMode = selectedMode === 'challenge';
  const needsPlaylist = selectedMode === 'take-turns' || selectedMode === 'buzzer';
  const spotifyConnected = !!spotifyVisitorId;

  // Challenge mode: show the song search/add panel (right column)
  if (isChallengeMode && spotifyConnected) {
    $('lobby-songs-section').classList.remove('hidden');
    $('song-search-area').classList.remove('hidden');
  } else {
    $('lobby-songs-section').classList.add('hidden');
    $('song-search-area').classList.add('hidden');
  }

  // Take-turns / Buzzer: show "Choose Playlist" only after Spotify is connected
  if (spotifyConnected && needsPlaylist) {
    $('my-playlist-section').classList.remove('hidden');
  } else {
    $('my-playlist-section').classList.add('hidden');
  }

  // Adjust layout: two columns only when challenge mode shows the song panel
  const lobbyLayout = document.querySelector('.lobby-layout');
  if (isChallengeMode && spotifyConnected) {
    lobbyLayout.classList.remove('single-column');
  } else {
    lobbyLayout.classList.add('single-column');
  }

  // Song count
  $('song-count').textContent = room.songCount;
  updatePlaylist(room.songs || []);

  // Spotify connect prompt: show if not connected yet
  if (!spotifyConnected) {
    $('spotify-connect-prompt').classList.remove('hidden');
  } else {
    $('spotify-connect-prompt').classList.add('hidden');
  }

  // Show DJ connect prompt for non-host desktop players
  if (!isHost && isDesktop && !room.musicPlayerId && !spotifyVisitorId) {
    $('dj-connect-prompt').classList.remove('hidden');
  } else {
    $('dj-connect-prompt').classList.add('hidden');
  }

  // Host controls
  if (isHost) {
    $('lobby-host-controls').classList.remove('hidden');
    updateStartButton(room);

    // Update challenge player list
    $('challenge-player-list').innerHTML = room.players
      .map((p, i) =>
        `<button class="challenge-player-btn ${selectedChallengeTarget === i ? 'active' : ''}" data-index="${i}">
          🎯 Challenge ${p.name}
        </button>`
      ).join('');

    document.querySelectorAll('.challenge-player-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedChallengeTarget = parseInt(btn.dataset.index);
        document.querySelectorAll('.challenge-player-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateLobby(currentRoom);
      });
    });
  }
}

function updateStartButton(room) {
  const btn = $('btn-start-game');

  if (selectedMode === 'challenge') {
    const canStart = room.songCount >= 2 && selectedChallengeTarget !== null;
    btn.disabled = !canStart;
    if (room.songCount < 2) {
      btn.textContent = `Start Game (need ${2 - room.songCount} more songs)`;
    } else if (selectedChallengeTarget === null) {
      btn.textContent = 'Pick a player to challenge';
    } else {
      btn.textContent = `Start Game (${room.songCount} songs)`;
    }
  } else if (selectedMode === 'take-turns') {
    const playersReady = room.players.filter(p => p.hasPlaylist).length;
    const canStart = playersReady >= 2;
    btn.disabled = !canStart;
    if (playersReady < 2) {
      btn.textContent = `Waiting for playlists (${playersReady}/${room.players.length} ready)`;
    } else {
      btn.textContent = `Start Game — Take Turns`;
    }
  } else if (selectedMode === 'buzzer') {
    const playersReady = room.players.filter(p => p.hasPlaylist).length;
    const canStart = playersReady >= 1;
    btn.disabled = !canStart;
    if (playersReady < 1) {
      btn.textContent = 'Waiting for at least 1 playlist';
    } else {
      btn.textContent = `Start Buzzer Mode`;
    }
  }
}

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    $('btn-copy-code').textContent = '✅ Copied!';
    setTimeout(() => ($('btn-copy-code').textContent = '📋 Copy'), 1500);
  });
});

// ─── Spotify ─────────────────────────────────────────────────────
$('btn-connect-spotify').addEventListener('click', () => {
  localStorage.setItem('pendingName', myName);
  localStorage.setItem('pendingRoom', roomCode);
  localStorage.setItem('pendingIsHost', isHost ? '1' : '0');
  window.location.href = `/login?roomCode=${roomCode}`;
});

$('btn-connect-spotify-dj').addEventListener('click', () => {
  localStorage.setItem('pendingName', myName);
  localStorage.setItem('pendingRoom', roomCode);
  localStorage.setItem('pendingIsHost', isHost ? '1' : '0');
  window.location.href = `/login?roomCode=${roomCode}`;
});

async function initSpotify() {
  if (spotifyVisitorId) {
    const tokenCheck = await fetch(`/api/token/${spotifyVisitorId}`);
    if (!tokenCheck.ok) {
      spotifyVisitorId = null;
      localStorage.removeItem('spotifyVisitorId');
      // Refresh the lobby to show connect prompt
      if (currentRoom) updateLobby(currentRoom);
      return;
    }
  }

  // Refresh lobby UI — it will show/hide the right sections based on spotifyVisitorId
  if (currentRoom) updateLobby(currentRoom);

  // Initialize Spotify Web Playback SDK on desktop browsers
  if (isDesktop) {
    if (window.Spotify) {
      setupSpotifyPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = setupSpotifyPlayer;
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.onerror = () => console.warn('Spotify SDK failed to load');
      document.body.appendChild(script);
    }
  }
}

async function getToken() {
  if (!spotifyVisitorId) return null;
  try {
    const res = await fetch(`/api/token/${spotifyVisitorId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token;
  } catch {
    return null;
  }
}

function setupSpotifyPlayer() {
  if (spotifyPlayer) return;

  spotifyPlayer = new Spotify.Player({
    name: 'Guess the Song 🎵',
    getOAuthToken: async (cb) => {
      const token = await getToken();
      if (token) cb(token);
    },
    volume: 0.8,
  });

  spotifyPlayer.addListener('ready', ({ device_id }) => {
    spotifyDeviceId = device_id;
    isMusicPlayer = true;
    console.log('Spotify player ready, device:', device_id);
    if (roomCode) {
      socket.emit('set-music-player', { roomCode });
    }
  });

  spotifyPlayer.addListener('initialization_error', ({ message }) => {
    console.error('Spotify init error:', message);
  });

  spotifyPlayer.connect();
}

async function playSong(spotifyUri) {
  if (!spotifyDeviceId) {
    console.warn('Spotify device not ready');
    return;
  }
  const token = await getToken();
  if (!token) return;

  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: [spotifyUri] }),
  });
}

async function pauseSong() {
  if (!spotifyDeviceId) return;
  const token = await getToken();
  if (!token) return;
  await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${spotifyDeviceId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── My Playlist Selection (for take-turns / buzzer) ─────────────
let myPlaylistsLoaded = false;

$('btn-pick-my-playlist').addEventListener('click', () => {
  const picker = $('my-playlist-picker');
  if (picker.classList.contains('hidden')) {
    picker.classList.remove('hidden');
    loadMyPlaylists();
  } else {
    picker.classList.add('hidden');
  }
});

async function loadMyPlaylists() {
  if (myPlaylistsLoaded) return;
  if (!spotifyVisitorId) {
    alert('Connect Spotify first to load playlists.');
    return;
  }

  const listEl = $('my-playlist-list');
  listEl.innerHTML = '<p class="loading-text">Loading your playlists...</p>';

  try {
    const res = await fetch(`/api/playlists?visitorId=${spotifyVisitorId}`);
    if (!res.ok) {
      listEl.innerHTML = '<p class="loading-text">Could not load playlists. Try reconnecting Spotify.</p>';
      return;
    }
    const playlists = await res.json();
    myPlaylistsLoaded = true;

    if (playlists.length === 0) {
      listEl.innerHTML = '<p class="loading-text">No playlists found.</p>';
      return;
    }

    listEl.innerHTML = playlists.map(pl =>
      `<div class="playlist-card" data-id="${pl.id}" data-name="${escapeHtml(pl.name)}">
        <img src="${pl.image || ''}" alt="" />
        <div class="playlist-card-info">
          <div class="name">${escapeHtml(pl.name)}</div>
          <div class="meta">${pl.trackCount > 0 ? pl.trackCount + ' songs' : ''}</div>
        </div>
      </div>`
    ).join('');

    document.querySelectorAll('#my-playlist-list .playlist-card').forEach(card => {
      card.addEventListener('click', () => selectMyPlaylist(card.dataset.id, card.dataset.name));
    });
  } catch (err) {
    console.error('loadMyPlaylists error:', err);
    listEl.innerHTML = '<p class="loading-text">Error loading playlists.</p>';
  }
}

async function selectMyPlaylist(playlistId, name) {
  $('my-playlist-list').innerHTML = '<p class="loading-text">Loading tracks...</p>';

  try {
    const res = await fetch(`/api/playlist-tracks?playlistId=${playlistId}&visitorId=${spotifyVisitorId}`);
    if (!res.ok) {
      $('my-playlist-status').innerHTML = '<p style="color:var(--danger)">Failed to load playlist tracks.</p>';
      return;
    }
    const tracks = await res.json();
    myPlaylistTracks = tracks;

    // Tell server about my playlist selection
    socket.emit('select-playlist', {
      roomCode,
      playlistId,
      playlistName: name,
      tracks: tracks,
    });

    // Update UI
    $('my-playlist-status').innerHTML =
      `<p style="color:var(--green)">✅ Selected: <strong>${escapeHtml(name)}</strong> (${tracks.length} songs)</p>`;
    $('my-playlist-picker').classList.add('hidden');
    $('btn-pick-my-playlist').textContent = 'Change Playlist';

    // Show track preview
    const previewEl = $('my-playlist-tracks-preview');
    if (tracks.length > 0) {
      previewEl.classList.remove('hidden');
      previewEl.innerHTML = tracks.map((t) =>
        `<div class="playlist-item">
          <img src="${t.albumArt || ''}" alt="" class="playlist-thumb" />
          <div class="playlist-item-info">
            <div class="name">${escapeHtml(t.name)}</div>
            <div class="artist">${escapeHtml(t.artist)}</div>
          </div>
        </div>`
      ).join('');
    } else {
      previewEl.classList.remove('hidden');
      previewEl.innerHTML = '<p class="empty-playlist">This playlist appears to be empty.</p>';
    }

  } catch {
    $('my-playlist-status').innerHTML = '<p style="color:var(--danger)">Error loading tracks.</p>';
  }
}

// ─── Song Search (for Challenge mode) ────────────────────────────
let searchTimeout;
$('input-search').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(doSearch, 400);
});
$('btn-search').addEventListener('click', doSearch);
$('input-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const query = $('input-search').value.trim();
  if (!query) return;

  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&visitorId=${spotifyVisitorId}`);
  if (res.status === 401) {
    spotifyVisitorId = null;
    localStorage.removeItem('spotifyVisitorId');
    $('song-search-area').classList.add('hidden');
    $('spotify-connect-prompt').classList.remove('hidden');
    alert('Spotify session expired. Please reconnect Spotify.');
    return;
  }
  if (!res.ok) return;

  const tracks = await res.json();
  $('search-results').innerHTML = tracks
    .map(
      (t) =>
        `<div class="search-item" data-track='${JSON.stringify(t).replace(/'/g, '&#39;')}'>
          <img src="${t.albumArt || ''}" alt="" />
          <div class="search-item-info">
            <div class="name">${escapeHtml(t.name)}</div>
            <div class="artist">${escapeHtml(t.artist)}</div>
          </div>
          <button class="add-btn" title="Add to playlist">+</button>
        </div>`
    )
    .join('');

  document.querySelectorAll('.search-item .add-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.search-item');
      const track = JSON.parse(item.dataset.track);
      socket.emit('add-song', { roomCode, song: track });
      btn.textContent = '✓';
      btn.disabled = true;
    });
  });
}

// ─── Playlist display (Challenge mode lobby) ─────────────────────
let previewAudio = null;
let previewingUri = null;

function updatePlaylist(songs) {
  const el = $('playlist');
  if (!songs || songs.length === 0) {
    el.innerHTML = '<p class="empty-playlist">No songs added yet</p>';
    return;
  }
  el.innerHTML = songs.map((s, i) =>
    `<div class="playlist-item" data-uri="${s.uri}">
      <img src="${s.albumArt || ''}" alt="" class="playlist-thumb" />
      <div class="playlist-item-info">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="artist">${escapeHtml(s.artist)}</div>
      </div>
      <div class="playlist-item-actions">
        <button class="preview-btn" data-uri="${s.uri}" title="Preview song">▶</button>
        <button class="remove-btn" data-uri="${s.uri}" title="Remove song">✕</button>
      </div>
    </div>`
  ).join('');

  document.querySelectorAll('.playlist-item .preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePreview(btn.dataset.uri, btn);
    });
  });

  document.querySelectorAll('.playlist-item .remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('remove-song', { roomCode, songUri: btn.dataset.uri });
    });
  });
}

async function togglePreview(uri, btn) {
  if (previewingUri === uri) {
    await pauseSong();
    resetPreviewButtons();
    previewingUri = null;
    return;
  }

  resetPreviewButtons();

  if (spotifyDeviceId) {
    await playSong(uri);
    previewingUri = uri;
    btn.textContent = '⏸';
    btn.classList.add('previewing');

    setTimeout(async () => {
      if (previewingUri === uri) {
        await pauseSong();
        resetPreviewButtons();
        previewingUri = null;
      }
    }, 15000);
  }
}

function resetPreviewButtons() {
  document.querySelectorAll('.preview-btn').forEach(b => {
    b.textContent = '▶';
    b.classList.remove('previewing');
  });
}

// ─── Socket Events ───────────────────────────────────────────────
socket.on('room-updated', (room) => {
  updateLobby(room);
});

socket.on('game-error', (data) => {
  alert(data.message);
});

socket.on('game-started', (data) => {
  currentRoom = data;
  showScreen('game');
  updateScoreboard(data);

  // Hide all game sub-areas initially
  $('pick-phase-area').classList.add('hidden');
  $('buzzer-area').classList.add('hidden');
  $('main-game-area').classList.add('hidden');

  if (data.gameMode === 'challenge' && data.challengeName) {
    $('challenge-banner').classList.remove('hidden');
    $('challenge-target-name').textContent = data.challengeName;
    $('game-host-controls').classList.add('hidden');
  } else {
    $('challenge-banner').classList.add('hidden');
    if (isHost && data.gameMode !== 'buzzer') $('game-host-controls').classList.remove('hidden');
    else $('game-host-controls').classList.add('hidden');
  }
});

socket.on('challenge-switch', (data) => {
  $('challenge-banner').classList.remove('hidden');
  $('challenge-target-name').textContent = data.challengeName;
  $('round-result').classList.add('hidden');
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  updateScoreboard(data.room);
});

// ─── Pick Phase (Take-Turns mode) ────────────────────────────────
socket.on('pick-phase', (data) => {
  const { round, pickerName, guesserName, isPicker, isGuesser, pickerTracks, room } = data;
  currentRoom = room;

  $('game-round-info').textContent = `Round ${round}`;
  updateScoreboard(room);

  // Show pick phase area, hide others
  $('pick-phase-area').classList.remove('hidden');
  $('buzzer-area').classList.add('hidden');
  $('main-game-area').classList.add('hidden');
  $('round-result').classList.add('hidden');
  $('game-host-controls').classList.add('hidden');

  $('pick-phase-picker-name').textContent = pickerName;

  if (isPicker && pickerTracks) {
    // I'm the picker — show my playlist tracks to choose from
    $('picker-area').classList.remove('hidden');
    $('pick-waiting').classList.add('hidden');
    $('picker-guesser-name').textContent = guesserName;

    renderPickerTracks(pickerTracks);
  } else {
    // I'm waiting (guesser or spectator)
    $('picker-area').classList.add('hidden');
    $('pick-waiting').classList.remove('hidden');
  }
});

function renderPickerTracks(tracks, filter = '') {
  const filtered = filter
    ? tracks.filter(t =>
        t.name.toLowerCase().includes(filter.toLowerCase()) ||
        t.artist.toLowerCase().includes(filter.toLowerCase())
      )
    : tracks;

  $('pick-track-list').innerHTML = filtered.map((t, i) =>
    `<div class="search-item pick-track-item" data-index="${tracks.indexOf(t)}">
      <img src="${t.albumArt || ''}" alt="" />
      <div class="search-item-info">
        <div class="name">${escapeHtml(t.name)}</div>
        <div class="artist">${escapeHtml(t.artist)}</div>
      </div>
      <button class="add-btn pick-btn" title="Pick this song">🎵 Pick</button>
    </div>`
  ).join('');

  document.querySelectorAll('.pick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.closest('.search-item').dataset.index);
      const song = tracks[idx];
      socket.emit('pick-song', { roomCode, song });
      btn.textContent = '✓ Picked';
      btn.disabled = true;
      // Disable all other pick buttons
      document.querySelectorAll('.pick-btn').forEach(b => { b.disabled = true; });
    });
  });
}

// Pick search/filter
$('input-pick-search').addEventListener('input', () => {
  if (!currentRoom || !currentRoom.pickPhase) return;
  const me = currentRoom.players.find(p => p.id === socket.id);
  if (me && myPlaylistTracks.length > 0) {
    renderPickerTracks(myPlaylistTracks, $('input-pick-search').value.trim());
  }
});

// ─── Buzzer Mode Events ──────────────────────────────────────────
socket.on('buzzer-round', async (data) => {
  const { round, totalSongs, songUri, room } = data;
  currentRoom = room;

  $('game-round-info').textContent = `Round ${round} / ${totalSongs}`;
  updateScoreboard(room);

  // Show buzzer area, hide others
  $('buzzer-area').classList.remove('hidden');
  $('pick-phase-area').classList.add('hidden');
  $('main-game-area').classList.add('hidden');
  $('round-result').classList.add('hidden');
  $('buzzed-area').classList.add('hidden');

  $('btn-buzz-in').disabled = true;
  $('btn-buzz-in').textContent = '🎵 Listen...';
  $('buzzer-status-text').textContent = 'Listen... get ready to buzz in! 🎵';

  // Show host controls for buzzer
  if (isHost) {
    $('game-host-controls').classList.remove('hidden');
  }

  // Start buzzer timer
  startBuzzerTimer(30);

  // Music player plays the song
  if (isMusicPlayer && songUri) {
    await playSong(songUri);
  }
});

socket.on('buzzer-open', () => {
  $('btn-buzz-in').disabled = false;
  $('btn-buzz-in').textContent = '🖐 BUZZ IN!';
  $('buzzer-status-text').textContent = 'Know the song? Buzz in! 🖐';
});

socket.on('player-buzzed', (data) => {
  const { playerId, playerName, room } = data;
  currentRoom = room;

  // Pause music
  if (isMusicPlayer) pauseSong();

  $('btn-buzz-in').disabled = true;
  $('btn-buzz-in').textContent = '🔒 Buzzed!';
  $('buzzer-status-text').textContent = `${playerName} buzzed in!`;

  // Show buzzed area with judge controls
  $('buzzed-area').classList.remove('hidden');
  $('buzzed-player-text').textContent = `${playerName} says their answer out loud! 🎤`;

  // Only host sees judge controls
  if (isHost) {
    $('buzzer-judge-controls').classList.remove('hidden');
  } else {
    $('buzzer-judge-controls').classList.add('hidden');
  }

  stopBuzzerTimer();
});

socket.on('buzzer-result', (data) => {
  const { correct, playerName, points, song, room } = data;
  currentRoom = room;

  // Hide buzzer area, show result
  $('buzzer-area').classList.add('hidden');
  $('main-game-area').classList.remove('hidden');
  $('round-result').classList.remove('hidden');
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('guesser-badge').classList.add('hidden');

  if (correct) {
    $('result-content').innerHTML =
      `<h2 style="color: var(--green)">✅ ${escapeHtml(playerName)} got it! (+${points} pt)</h2>`;
  } else {
    $('result-content').innerHTML =
      `<h2 style="color: var(--danger)">❌ ${escapeHtml(playerName)} was wrong!</h2>`;
  }
  $('result-album-art').src = song.albumArt || '';
  $('result-song-info').textContent = `${song.name} — ${song.artist}`;
  if (isHost) $('btn-next-round').classList.remove('hidden');
  updateScoreboard(room);

  stopBuzzerTimer();
});

$('btn-buzz-in').addEventListener('click', () => {
  socket.emit('buzz-in', { roomCode });
  $('btn-buzz-in').disabled = true;
  $('btn-buzz-in').textContent = '⏳ Buzzing...';
});

$('btn-buzzer-correct').addEventListener('click', () => {
  socket.emit('buzzer-judge', { roomCode, correct: true });
});

$('btn-buzzer-wrong').addEventListener('click', () => {
  socket.emit('buzzer-judge', { roomCode, correct: false });
});

$('btn-buzzer-skip').addEventListener('click', () => {
  socket.emit('skip-round', { roomCode });
});

// Buzzer timer
let buzzerTimerInterval = null;
let buzzerTimerSeconds = 30;

function startBuzzerTimer(seconds) {
  stopBuzzerTimer();
  buzzerTimerSeconds = seconds;
  updateBuzzerTimerDisplay();

  buzzerTimerInterval = setInterval(() => {
    buzzerTimerSeconds--;
    updateBuzzerTimerDisplay();
    if (buzzerTimerSeconds <= 0) stopBuzzerTimer();
  }, 1000);
}

function stopBuzzerTimer() {
  if (buzzerTimerInterval) {
    clearInterval(buzzerTimerInterval);
    buzzerTimerInterval = null;
  }
}

function updateBuzzerTimerDisplay() {
  const bar = $('buzzer-timer-bar');
  const text = $('buzzer-timer-text');
  if (!bar || !text) return;
  const pct = (buzzerTimerSeconds / 30) * 100;
  bar.style.width = pct + '%';
  text.textContent = buzzerTimerSeconds + 's';
  if (buzzerTimerSeconds <= 10) bar.classList.add('low');
  else bar.classList.remove('low');
}

// ─── Standard Round Events (take-turns guessing + challenge) ─────
socket.on('new-round', async (data) => {
  const { round, totalSongs, guesserName, isGuesser, songUri, song, room, gameMode } = data;
  currentRoom = room;

  $('game-round-info').textContent = `Round ${round}${totalSongs !== '?' ? ' / ' + totalSongs : ''}`;
  updateScoreboard(room);

  // Show main game area, hide others
  $('main-game-area').classList.remove('hidden');
  $('pick-phase-area').classList.add('hidden');
  $('buzzer-area').classList.add('hidden');

  // Reset visibility
  $('guesser-badge').classList.remove('hidden');
  $('guesser-name').textContent = guesserName;
  $('round-result').classList.add('hidden');
  $('guess-feedback').classList.add('hidden');

  const isChallengeMode = gameMode === 'challenge';

  if (isGuesser && isChallengeMode) {
    // Challenge mode guesser: say answer out loud
    $('song-reveal').classList.add('hidden');
    $('guess-area').classList.remove('hidden');
    $('input-guess-song').classList.add('hidden');
    $('input-guess-artist').classList.add('hidden');
    $('btn-guess').classList.add('hidden');
    $('btn-extend').classList.add('hidden');
    $('penalty-info').classList.add('hidden');
    $('guess-area').querySelector('.guess-prompt').textContent = 'Listen and say your answer out loud! 🎤';
    stopTimer();
    $('timer-bar').style.display = 'none';
  } else if (isGuesser) {
    // Take-turns mode guesser: type answer
    $('song-reveal').classList.add('hidden');
    $('guess-area').classList.remove('hidden');
    $('input-guess-song').classList.remove('hidden');
    $('input-guess-artist').classList.remove('hidden');
    $('btn-guess').classList.remove('hidden');
    $('btn-extend').classList.remove('hidden');
    $('penalty-info').classList.add('hidden');
    $('guess-area').querySelector('.guess-prompt').textContent = 'What song is this? 🤔';
    $('input-guess-song').value = '';
    $('input-guess-artist').value = '';
    $('input-guess-song').focus();
    currentExtensions = 0;
    $('timer-bar').style.display = '';
    startTimer(30);
  } else {
    // Non-guesser: see the answer
    $('guess-area').classList.add('hidden');
    $('song-reveal').classList.remove('hidden');
    if (song) {
      $('reveal-album-art').src = song.albumArt || '';
      $('reveal-song-name').textContent = song.name;
      $('reveal-song-artist').textContent = song.artist;
    }

    if (isChallengeMode) {
      $('judge-controls').classList.remove('hidden');
      $('hint-text-default').classList.add('hidden');
    } else {
      $('judge-controls').classList.add('hidden');
      $('hint-text-default').classList.remove('hidden');
    }
  }

  // Show host controls for take-turns
  if (isHost && gameMode === 'take-turns') {
    $('game-host-controls').classList.remove('hidden');
  }

  // Music player plays the song
  if (isMusicPlayer && songUri) {
    await playSong(songUri);
  }
});

socket.on('guess-result', (data) => {
  if (data.correct) {
    stopTimer();
    $('guess-area').classList.add('hidden');
    $('song-reveal').classList.add('hidden');
    $('round-result').classList.remove('hidden');

    let matchInfo = '';
    if (data.songMatch && data.artistMatch) matchInfo = 'Song + Artist';
    else if (data.songMatch) matchInfo = 'Song name';
    else matchInfo = 'Artist';

    $('result-content').innerHTML =
      `<h2 style="color: var(--green)">✅ Correct! (${matchInfo})</h2>` +
      `<p style="color: var(--accent); font-size: 18px; font-weight: 700;">+${data.points} pts</p>`;
    $('result-album-art').src = data.song.albumArt || '';
    $('result-song-info').textContent = `${data.song.name} — ${data.song.artist}`;
    if (isHost) $('btn-next-round').classList.remove('hidden');
    updateScoreboard(data.room);
    if (isMusicPlayer) pauseSong();
  } else {
    const fb = $('guess-feedback');
    fb.classList.remove('hidden');
    fb.classList.remove('correct');
    fb.classList.add('wrong');
    const parts = [];
    if (data.guessSong) parts.push(data.guessSong);
    if (data.guessArtist) parts.push(data.guessArtist);
    fb.textContent = `"${parts.join(' / ')}" — Nope, try again!`;
    $('input-guess-song').value = '';
    $('input-guess-artist').value = '';
    $('input-guess-song').focus();
  }
});

socket.on('judge-result', (data) => {
  stopTimer();
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('judge-controls').classList.add('hidden');
  $('round-result').classList.remove('hidden');

  $('result-content').innerHTML =
    `<h2 style="color: var(--green)">✅ ${data.guesserName} got it! (+${data.points} pt)</h2>`;
  $('result-album-art').src = data.song.albumArt || '';
  $('result-song-info').textContent = `${data.song.name} — ${data.song.artist}`;
  if (isHost) $('btn-next-round').classList.remove('hidden');
  updateScoreboard(data.room);
  if (isMusicPlayer) pauseSong();
});

socket.on('time-up', (data) => {
  stopTimer();
  stopBuzzerTimer();
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('judge-controls').classList.add('hidden');
  $('buzzer-area').classList.add('hidden');
  $('main-game-area').classList.remove('hidden');
  $('round-result').classList.remove('hidden');
  $('guesser-badge').classList.add('hidden');
  $('result-content').innerHTML = '<h2 style="color: var(--danger)">⏰ Time\'s up!</h2>';
  $('result-album-art').src = data.song.albumArt || '';
  $('result-song-info').textContent = `${data.song.name} — ${data.song.artist}`;
  if (isHost) $('btn-next-round').classList.remove('hidden');
  if (isMusicPlayer) pauseSong();
});

socket.on('time-extended', (data) => {
  currentExtensions = data.extensions;
  timerSeconds = 60;
  startTimer(60);
  $('penalty-info').classList.remove('hidden');
  $('penalty-info').textContent = `Penalty: -${data.penalty} pts from your score this round`;
});

socket.on('round-skipped', (data) => {
  stopTimer();
  stopBuzzerTimer();
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('judge-controls').classList.add('hidden');
  $('buzzer-area').classList.add('hidden');
  $('main-game-area').classList.remove('hidden');
  $('round-result').classList.remove('hidden');
  $('guesser-badge').classList.add('hidden');
  $('result-content').innerHTML = '<h2 style="color: var(--text-dim)">⏭ Skipped!</h2>';
  $('result-album-art').src = data.song.albumArt || '';
  $('result-song-info').textContent = `${data.song.name} — ${data.song.artist}`;
  if (isHost) $('btn-next-round').classList.remove('hidden');
  if (isMusicPlayer) pauseSong();
});

socket.on('game-ended', (room) => {
  currentRoom = room;
  showScreen('gameover');
  if (isMusicPlayer) pauseSong();

  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  $('final-scores').innerHTML = sorted
    .map(
      (p, i) =>
        `<div class="final-score-row">
          <span><span class="medal">${medals[i] || ''}</span>${p.name}</span>
          <span>${p.score} pts</span>
        </div>`
    )
    .join('');
});

socket.on('game-reset', (room) => {
  currentRoom = room;
  updateLobby(room);
  showScreen('lobby');
});

// ─── Tab switching (Challenge mode song search) ──────────────────
function switchTab(activeTab) {
  ['tab-search', 'tab-bulk', 'tab-playlist'].forEach(id => $(id).classList.remove('active'));
  ['search-mode', 'bulk-mode', 'playlist-mode'].forEach(id => $(id).classList.add('hidden'));
  $(activeTab).classList.add('active');

  if (activeTab === 'tab-search') $('search-mode').classList.remove('hidden');
  else if (activeTab === 'tab-bulk') $('bulk-mode').classList.remove('hidden');
  else if (activeTab === 'tab-playlist') {
    $('playlist-mode').classList.remove('hidden');
    loadPlaylists();
  }
}

$('tab-search').addEventListener('click', () => switchTab('tab-search'));
$('tab-bulk').addEventListener('click', () => switchTab('tab-bulk'));
$('tab-playlist').addEventListener('click', () => switchTab('tab-playlist'));

// ─── Bulk paste ──────────────────────────────────────────────────
$('btn-bulk-add').addEventListener('click', async () => {
  const text = $('input-bulk').value.trim();
  if (!text) return;

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length === 0) return;

  const status = $('bulk-status');
  status.classList.remove('hidden', 'success', 'error');
  status.classList.add('loading');
  status.textContent = `Searching for ${lines.length} songs...`;
  $('btn-bulk-add').disabled = true;

  let found = 0;
  let notFound = [];

  for (const line of lines) {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(line)}&visitorId=${spotifyVisitorId}`);
      if (!res.ok) { notFound.push(line); continue; }
      const tracks = await res.json();
      if (tracks.length > 0) {
        socket.emit('add-song', { roomCode, song: tracks[0] });
        found++;
        status.textContent = `Added ${found}/${lines.length}...`;
      } else {
        notFound.push(line);
      }
    } catch {
      notFound.push(line);
    }
  }

  $('btn-bulk-add').disabled = false;
  status.classList.remove('loading');
  status.classList.add('success');
  status.innerHTML = `Added ${found} songs.` +
    (notFound.length > 0 ? `<br>Could not find: ${notFound.join(', ')}` : '');
  $('input-bulk').value = '';
});

// ─── Playlist import (Challenge mode) ────────────────────────────
let playlistsLoaded = false;
let loadedPlaylistTracks = [];

async function loadPlaylists() {
  if (playlistsLoaded) return;

  const listEl = $('playlist-list');
  listEl.innerHTML = '<p class="loading-text">Loading your playlists...</p>';

  try {
    const res = await fetch(`/api/playlists?visitorId=${spotifyVisitorId}`);
    if (!res.ok) {
      listEl.innerHTML =
        '<div style="text-align:center; padding: 16px;">' +
        '<p class="loading-text">Could not load playlists.</p>' +
        '<button id="btn-reconnect-spotify" class="btn btn-spotify" style="margin-top:10px;">Reconnect Spotify</button>' +
        '</div>';
      const reconnBtn = document.getElementById('btn-reconnect-spotify');
      if (reconnBtn) {
        reconnBtn.addEventListener('click', () => {
          localStorage.setItem('pendingRoom', roomCode);
          localStorage.setItem('pendingName', myName);
          localStorage.removeItem('spotifyVisitorId');
          spotifyVisitorId = null;
          window.location.href = `/login?roomCode=${roomCode}`;
        });
      }
      return;
    }
    const playlists = await res.json();
    playlistsLoaded = true;

    if (playlists.length === 0) {
      listEl.innerHTML = '<p class="loading-text">No playlists found.</p>';
      return;
    }

    listEl.innerHTML = playlists.map(pl =>
      `<div class="playlist-card" data-id="${pl.id}" data-name="${escapeHtml(pl.name)}">
        <img src="${pl.image || ''}" alt="" />
        <div class="playlist-card-info">
          <div class="name">${escapeHtml(pl.name)}</div>
          <div class="meta">${pl.trackCount > 0 ? pl.trackCount + ' songs · ' : ''}${escapeHtml(pl.owner)}</div>
        </div>
      </div>`
    ).join('');

    document.querySelectorAll('#playlist-list .playlist-card').forEach(card => {
      card.addEventListener('click', () => openPlaylist(card.dataset.id, card.dataset.name));
    });
  } catch (err) {
    console.error('loadPlaylists error:', err);
    listEl.innerHTML = '<p class="loading-text">Error loading playlists.</p>';
  }
}

async function openPlaylist(playlistId, name) {
  $('playlist-list').classList.add('hidden');
  $('playlist-tracks').classList.remove('hidden');
  $('playlist-tracks-title').textContent = name;
  $('playlist-tracks-list').innerHTML = '<p class="loading-text">Loading tracks...</p>';
  $('playlist-import-status').classList.add('hidden');

  try {
    const res = await fetch(`/api/playlist-tracks?playlistId=${playlistId}&visitorId=${spotifyVisitorId}`);
    if (!res.ok) {
      $('playlist-tracks-list').innerHTML = '<p class="loading-text">Failed to load tracks.</p>';
      return;
    }
    loadedPlaylistTracks = await res.json();

    if (loadedPlaylistTracks.length === 0) {
      $('playlist-tracks-list').innerHTML = '<p class="loading-text">This playlist appears to be empty.</p>';
      return;
    }

    $('playlist-tracks-list').innerHTML = loadedPlaylistTracks.map((t, i) =>
      `<div class="search-item" data-index="${i}">
        <img src="${t.albumArt || ''}" alt="" />
        <div class="search-item-info">
          <div class="name">${escapeHtml(t.name)}</div>
          <div class="artist">${escapeHtml(t.artist)}</div>
        </div>
        <button class="add-btn" title="Add song">+</button>
      </div>`
    ).join('');

    document.querySelectorAll('#playlist-tracks-list .add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.closest('.search-item').dataset.index);
        socket.emit('add-song', { roomCode, song: loadedPlaylistTracks[idx] });
        btn.textContent = '✓';
        btn.disabled = true;
      });
    });
  } catch {
    $('playlist-tracks-list').innerHTML = '<p class="loading-text">Error loading tracks.</p>';
  }
}

$('btn-back-playlists').addEventListener('click', () => {
  $('playlist-tracks').classList.add('hidden');
  $('playlist-list').classList.remove('hidden');
});

$('btn-add-all-playlist').addEventListener('click', () => {
  const status = $('playlist-import-status');
  let added = 0;
  loadedPlaylistTracks.forEach(track => {
    socket.emit('add-song', { roomCode, song: track });
    added++;
  });
  status.classList.remove('hidden');
  status.classList.add('success');
  status.textContent = `Added ${added} songs from playlist!`;

  document.querySelectorAll('#playlist-tracks-list .add-btn').forEach(btn => {
    btn.textContent = '✓';
    btn.disabled = true;
  });
});

// ─── Game Controls ───────────────────────────────────────────────
// Mode selection
$('mode-turns').addEventListener('click', () => {
  selectedMode = 'take-turns';
  $('mode-turns').classList.add('active');
  $('mode-buzzer').classList.remove('active');
  $('mode-challenge').classList.remove('active');
  $('challenge-picker').classList.add('hidden');
  selectedChallengeTarget = null;
  if (currentRoom) updateLobby(currentRoom);
});

$('mode-buzzer').addEventListener('click', () => {
  selectedMode = 'buzzer';
  $('mode-buzzer').classList.add('active');
  $('mode-turns').classList.remove('active');
  $('mode-challenge').classList.remove('active');
  $('challenge-picker').classList.add('hidden');
  selectedChallengeTarget = null;
  if (currentRoom) updateLobby(currentRoom);
});

$('mode-challenge').addEventListener('click', () => {
  selectedMode = 'challenge';
  $('mode-challenge').classList.add('active');
  $('mode-turns').classList.remove('active');
  $('mode-buzzer').classList.remove('active');
  $('challenge-picker').classList.remove('hidden');
  if (currentRoom) updateLobby(currentRoom);
});

$('btn-start-game').addEventListener('click', () => {
  socket.emit('start-game', {
    roomCode,
    mode: selectedMode,
    challengeTargetIndex: selectedChallengeTarget,
  });
});

$('btn-guess').addEventListener('click', submitGuess);
$('input-guess-song').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('input-guess-artist').focus();
});
$('input-guess-artist').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGuess();
});

function submitGuess() {
  const guessSong = $('input-guess-song').value.trim();
  const guessArtist = $('input-guess-artist').value.trim();
  if (!guessSong && !guessArtist) return;
  socket.emit('submit-guess', { roomCode, guessSong, guessArtist });
}

$('btn-extend').addEventListener('click', () => {
  socket.emit('extend-time', { roomCode });
});

$('btn-skip').addEventListener('click', () => {
  socket.emit('skip-round', { roomCode });
});

// Judge controls (challenge mode)
$('btn-judge-correct').addEventListener('click', () => {
  socket.emit('judge-correct', { roomCode });
});
$('btn-judge-skip').addEventListener('click', () => {
  socket.emit('skip-round', { roomCode });
});
$('btn-judge-end').addEventListener('click', () => {
  socket.emit('end-game', { roomCode });
});

$('btn-next-round').addEventListener('click', () => {
  $('btn-next-round').classList.add('hidden');
  socket.emit('next-round', { roomCode });
});

$('btn-end-game').addEventListener('click', () => {
  socket.emit('end-game', { roomCode });
});

$('btn-play-again').addEventListener('click', () => {
  socket.emit('reset-game', { roomCode, keepSongs: true });
});

$('btn-start-over').addEventListener('click', () => {
  socket.emit('reset-game', { roomCode, keepSongs: false });
});

// ─── Scoreboard ──────────────────────────────────────────────────
function updateScoreboard(room) {
  const html = room.players
    .map(
      (p, i) =>
        `<div class="score-row ${i === room.guesserIndex ? 'guesser' : ''}">
          <span>${i === room.guesserIndex ? '🎧 ' : ''}${p.name}</span>
          <span class="score-value">${p.score}</span>
        </div>`
    )
    .join('');
  $('game-scoreboard').innerHTML = html;
}

// ─── Timer ───────────────────────────────────────────────────────
function startTimer(seconds) {
  stopTimer();
  timerSeconds = seconds;
  updateTimerDisplay();

  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) stopTimer();
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  const bar = $('timer-bar');
  const text = $('timer-text');
  if (!bar || !text) return;

  const pct = (timerSeconds / 30) * 100;
  bar.style.width = pct + '%';
  text.textContent = timerSeconds + 's';

  if (timerSeconds <= 10) bar.classList.add('low');
  else bar.classList.remove('low');
}

// ─── Helpers ─────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
