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
let selectedMode = 'round-robin';
let selectedChallengeTarget = null;
let isMusicPlayer = false;

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
    // Clean URL
    window.history.replaceState({}, '', '/');
  } else {
    spotifyVisitorId = localStorage.getItem('spotifyVisitorId');
  }

  // If we came back from Spotify auth with a room code, auto-rejoin
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

      // If not connected to Spotify, prompt login
      if (!spotifyVisitorId) {
        localStorage.setItem('pendingIsHost', '1');
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
    // Non-host player returning from Spotify auth — rejoin existing room
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
    // Host returning from Spotify auth — create room
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

  // Players list
  const playersHtml = room.players
    .map(
      (p) =>
        `<div class="player-item">
          <span>${p.name}${p.id === socket.id ? ' (you)' : ''}</span>
          ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
          ${p.id === room.musicPlayerId ? '<span class="host-badge" style="background:var(--green)">🎵 DJ</span>' : ''}
        </div>`
    )
    .join('');
  $('lobby-players').innerHTML = playersHtml;

  // Song count & playlist display
  $('song-count').textContent = room.songCount;
  updatePlaylist(room.songs || []);

  // Show DJ connect prompt for non-host desktop players when no music player assigned
  if (!isHost && isDesktop && !room.musicPlayerId && !spotifyVisitorId) {
    $('dj-connect-prompt').classList.remove('hidden');
  } else {
    $('dj-connect-prompt').classList.add('hidden');
  }

  // Host controls
  if (isHost) {
    $('lobby-host-controls').classList.remove('hidden');
    const canStart = room.songCount >= 2 &&
      (selectedMode === 'round-robin' || selectedChallengeTarget !== null);
    $('btn-start-game').disabled = !canStart;
    if (room.songCount < 2) {
      $('btn-start-game').textContent = `Start Game (need ${2 - room.songCount} more songs)`;
    } else if (selectedMode === 'challenge' && selectedChallengeTarget === null) {
      $('btn-start-game').textContent = 'Pick a player to challenge';
    } else {
      $('btn-start-game').textContent = `Start Game (${room.songCount} songs)`;
    }

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

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    $('btn-copy-code').textContent = '✅ Copied!';
    setTimeout(() => ($('btn-copy-code').textContent = '📋 Copy'), 1500);
  });
});

// ─── Spotify ─────────────────────────────────────────────────────
$('btn-connect-spotify').addEventListener('click', () => {
  // Save name so we can rejoin after redirect
  localStorage.setItem('pendingName', myName);
  localStorage.setItem('pendingRoom', roomCode);
  localStorage.setItem('pendingIsHost', isHost ? '1' : '0');
  window.location.href = `/login?roomCode=${roomCode}`;
});

// DJ connect button for non-host desktop players
$('btn-connect-spotify-dj').addEventListener('click', () => {
  localStorage.setItem('pendingName', myName);
  localStorage.setItem('pendingRoom', roomCode);
  localStorage.setItem('pendingIsHost', isHost ? '1' : '0');
  window.location.href = `/login?roomCode=${roomCode}`;
});

async function initSpotify() {
  // Verify the token still works (it gets lost when server restarts)
  if (spotifyVisitorId) {
    const tokenCheck = await fetch(`/api/token/${spotifyVisitorId}`);
    if (!tokenCheck.ok) {
      // Token is gone — need to re-login
      spotifyVisitorId = null;
      localStorage.removeItem('spotifyVisitorId');
      $('spotify-connect-prompt').classList.remove('hidden');
      $('song-search-area').classList.add('hidden');
      return;
    }
  }

  // Show search area, hide connect prompt
  $('spotify-connect-prompt').classList.add('hidden');
  $('song-search-area').classList.remove('hidden');

  // Initialize Spotify Web Playback SDK on desktop browsers
  if (isDesktop) {
    if (window.Spotify) {
      setupSpotifyPlayer();
    } else {
      // Dynamically load the Spotify SDK only when needed
      window.onSpotifyWebPlaybackSDKReady = setupSpotifyPlayer;
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.onerror = () => console.warn('Spotify SDK failed to load — playback may not work on this device');
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
    // Tell the server this player has Spotify playback
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

// ─── Song Search ─────────────────────────────────────────────────
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
    // Token expired or server restarted — need to reconnect
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

  // Add click handlers
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

// ─── Playlist display ────────────────────────────────────────────
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

  // Preview buttons — play 30s Spotify preview via Web Playback SDK
  document.querySelectorAll('.playlist-item .preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uri = btn.dataset.uri;
      togglePreview(uri, btn);
    });
  });

  // Remove buttons
  document.querySelectorAll('.playlist-item .remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('remove-song', { roomCode, songUri: btn.dataset.uri });
    });
  });
}

async function togglePreview(uri, btn) {
  // If already previewing this song, stop it
  if (previewingUri === uri) {
    await pauseSong();
    resetPreviewButtons();
    previewingUri = null;
    return;
  }

  // Stop any current preview
  resetPreviewButtons();

  // Play via Spotify SDK if available
  if (spotifyDeviceId) {
    await playSong(uri);
    previewingUri = uri;
    btn.textContent = '⏸';
    btn.classList.add('previewing');

    // Auto-stop after 15 seconds (it's just a preview)
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

socket.on('game-started', (data) => {
  currentRoom = data;
  showScreen('game');
  updateScoreboard(data);

  // Show challenge banner if in challenge mode
  if (data.gameMode === 'challenge' && data.challengeName) {
    $('challenge-banner').classList.remove('hidden');
    $('challenge-target-name').textContent = data.challengeName;
    // In challenge mode, hide host skip/end buttons (judges use inline buttons)
    $('game-host-controls').classList.add('hidden');
  } else {
    $('challenge-banner').classList.add('hidden');
    if (isHost) $('game-host-controls').classList.remove('hidden');
  }
});

socket.on('challenge-switch', (data) => {
  // New player is being challenged
  $('challenge-banner').classList.remove('hidden');
  $('challenge-target-name').textContent = data.challengeName;
  $('round-result').classList.add('hidden');
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  updateScoreboard(data.room);
});

socket.on('new-round', async (data) => {
  const { round, totalSongs, guesserName, isGuesser, songUri, song, room, gameMode } = data;
  currentRoom = room;

  $('game-round-info').textContent = `Round ${round} / ${totalSongs}`;
  updateScoreboard(room);

  // Reset visibility
  $('guesser-badge').classList.remove('hidden');
  $('guesser-name').textContent = guesserName;
  $('round-result').classList.add('hidden');
  $('guess-feedback').classList.add('hidden');

  const isChallengeMode = gameMode === 'challenge' || (room && room.gameMode === 'challenge');

  if (isGuesser && isChallengeMode) {
    // Challenge mode: guesser just listens & says answer out loud (no timer, no extend)
    $('song-reveal').classList.add('hidden');
    $('guess-area').classList.remove('hidden');
    $('input-guess-song').classList.add('hidden');
    $('input-guess-artist').classList.add('hidden');
    $('btn-guess').classList.add('hidden');
    $('btn-extend').classList.add('hidden');
    $('penalty-info').classList.add('hidden');
    $('guess-area').querySelector('.guess-prompt').textContent = 'Listen and say your answer out loud! 🎤';
    // No timer in challenge mode — hide the timer display
    stopTimer();
    $('timer-bar').style.display = 'none';
  } else if (isGuesser) {
    // Round-robin mode: guesser types their answer
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
    // I can see what's playing (non-guesser)
    $('guess-area').classList.add('hidden');
    $('song-reveal').classList.remove('hidden');
    if (song) {
      $('reveal-album-art').src = song.albumArt || '';
      $('reveal-song-name').textContent = song.name;
      $('reveal-song-artist').textContent = song.artist;
    }

    // In challenge mode, show judge controls to non-guessers
    if (isChallengeMode) {
      $('judge-controls').classList.remove('hidden');
      $('hint-text-default').classList.add('hidden');
    } else {
      $('judge-controls').classList.add('hidden');
      $('hint-text-default').classList.remove('hidden');
    }
  }

  // Music player plays the song on Spotify (can be any desktop player, not just host)
  if (isMusicPlayer && songUri) {
    await playSong(songUri);
  }
});

socket.on('guess-result', (data) => {
  if (data.correct) {
    stopTimer();
    // Show result to everyone
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
    // Wrong guess — only the guesser sees this
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

// Judge marked correct (challenge mode)
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

// Time's up!
socket.on('time-up', (data) => {
  stopTimer();
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('judge-controls').classList.add('hidden');
  $('round-result').classList.remove('hidden');
  $('result-content').innerHTML = '<h2 style="color: var(--danger)">⏰ Time\'s up!</h2>';
  $('result-album-art').src = data.song.albumArt || '';
  $('result-song-info').textContent = `${data.song.name} — ${data.song.artist}`;
  if (isHost) $('btn-next-round').classList.remove('hidden');
  if (isMusicPlayer) pauseSong();
});

// Extension confirmed
socket.on('time-extended', (data) => {
  currentExtensions = data.extensions;
  timerSeconds = 60;
  startTimer(60);
  $('penalty-info').classList.remove('hidden');
  $('penalty-info').textContent = `Penalty: -${data.penalty} pts from your score this round`;
});

socket.on('round-skipped', (data) => {
  stopTimer();
  $('guess-area').classList.add('hidden');
  $('song-reveal').classList.add('hidden');
  $('judge-controls').classList.add('hidden');
  $('round-result').classList.remove('hidden');
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

// Game reset (back to lobby)
socket.on('game-reset', (room) => {
  currentRoom = room;
  updateLobby(room);
  showScreen('lobby');
});

// ─── Tab switching (Search / Paste List) ─────────────────────────
function switchTab(activeTab) {
  ['tab-search', 'tab-bulk', 'tab-playlist'].forEach(id => $( id).classList.remove('active'));
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

// ─── Bulk paste: add many songs at once ──────────────────────────
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
    // Try to search Spotify for each line
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

  if (notFound.length === 0) {
    status.classList.add('success');
    status.textContent = `All ${found} songs added!`;
  } else {
    status.classList.add('success');
    status.innerHTML = `Added ${found} songs.` +
      (notFound.length > 0 ? `<br>Could not find: ${notFound.join(', ')}` : '');
  }

  $('input-bulk').value = '';
});

// ─── Playlist import ─────────────────────────────────────────────
let playlistsLoaded = false;
let loadedPlaylistTracks = [];

async function loadPlaylists() {
  if (playlistsLoaded) return;

  const listEl = $('playlist-list');
  listEl.innerHTML = '<p class="loading-text">Loading your playlists...</p>';

  try {
    const res = await fetch(`/api/playlists?visitorId=${spotifyVisitorId}`);
    console.log('Playlists response status:', res.status);

    if (!res.ok) {
      // Need to reconnect Spotify with new permissions
      playlistsLoaded = false;
      listEl.innerHTML =
        '<div style="text-align:center; padding: 16px;">' +
        '<p class="loading-text">Could not load playlists. You may need to reconnect Spotify with playlist permissions.</p>' +
        '<button id="btn-reconnect-spotify" class="btn btn-spotify" style="margin-top:10px;">Reconnect Spotify</button>' +
        '</div>';
      const reconnBtn = document.getElementById('btn-reconnect-spotify');
      if (reconnBtn) {
        reconnBtn.addEventListener('click', () => {
          localStorage.setItem('pendingRoom', roomCode);
          localStorage.setItem('pendingName', myName);
          // Clear old visitor ID so we get a fresh token with new scopes
          localStorage.removeItem('spotifyVisitorId');
          spotifyVisitorId = null;
          window.location.href = `/login?roomCode=${roomCode}`;
        });
      }
      return;
    }
    const playlists = await res.json();
    console.log('Playlists loaded:', playlists.length);
    playlistsLoaded = true;

    if (playlists.length === 0) {
      listEl.innerHTML = '<p class="loading-text">No playlists found in your Spotify account.</p>';
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

    document.querySelectorAll('.playlist-card').forEach(card => {
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
    console.log('Fetching tracks for playlist:', playlistId);
    const res = await fetch(`/api/playlist-tracks?playlistId=${playlistId}&visitorId=${spotifyVisitorId}`);
    console.log('Playlist tracks response status:', res.status);
    if (!res.ok) {
      const errData = await res.text();
      console.error('Playlist tracks error:', errData);
      $('playlist-tracks-list').innerHTML = '<p class="loading-text">Failed to load tracks.</p>';
      return;
    }
    loadedPlaylistTracks = await res.json();
    console.log('Loaded playlist tracks:', loadedPlaylistTracks.length);

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

    // Single song add buttons
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

  // Mark all buttons as added
  document.querySelectorAll('#playlist-tracks-list .add-btn').forEach(btn => {
    btn.textContent = '✓';
    btn.disabled = true;
  });
});

// ─── Game Controls ───────────────────────────────────────────────
// Mode selection
$('mode-robin').addEventListener('click', () => {
  selectedMode = 'round-robin';
  $('mode-robin').classList.add('active');
  $('mode-challenge').classList.remove('active');
  $('challenge-picker').classList.add('hidden');
  selectedChallengeTarget = null;
  if (currentRoom) updateLobby(currentRoom);
});

$('mode-challenge').addEventListener('click', () => {
  selectedMode = 'challenge';
  $('mode-challenge').classList.add('active');
  $('mode-robin').classList.remove('active');
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

// Extend time button
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
    if (timerSeconds <= 0) {
      stopTimer();
    }
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

  if (timerSeconds <= 10) {
    bar.classList.add('low');
  } else {
    bar.classList.remove('low');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
