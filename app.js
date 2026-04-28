let audio, canvas, ctx, analyser, dataArray, animationId;
let audioContext, source, bassFilter, midFilter, trebleFilter;
let playlist = [];
let currentIndex = -1;
let isShuffle = false;
let repeatMode = 0; // 0=off, 1=all, 2=one
let lastBeatTime = 0;
let waveformCanvas, waveformCtx;
let audioBuffer = null;
let vuLeds = [];
let currentBlobUrl = null; // Tracks current audio blob

document.addEventListener('DOMContentLoaded', () => {
  init();
  registerServiceWorker();
});

function init() {
  audio = document.getElementById('audio');
  // ADD THESE 5 LINES RIGHT HERE
  const savedVol = localStorage.getItem('jmf_volume');
  if (savedVol !== null) {
    audio.volume = savedVol;
    document.getElementById('volume').value = savedVol;
  }
  
  canvas = document.getElementById('visualizer');
  ctx = canvas.getContext('2d');
  waveformCanvas = document.getElementById('waveform');
  waveformCtx = waveformCanvas.getContext('2d');
  vuLeds = document.querySelectorAll('.vu-led');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  setupAudio();
  setupEventListeners();
  loadPlaylist();
}

function resizeCanvas() {
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  const rect = canvas.parentElement.getBoundingClientRect();

  // Set display size
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  // Set actual size in memory
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);

  // Scale context to match
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
}

function setupAudio() {
  if (audioContext) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;

  source = audioContext.createMediaElementSource(audio);
  source.connect(analyser);
  analyser.connect(audioContext.destination);

  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

function setupEventListeners() {
  document.getElementById('play').addEventListener('click', togglePlay);
  document.getElementById('prev').addEventListener('click', prevSong);
  document.getElementById('next').addEventListener('click', nextSong);
  document.getElementById('shuffle').addEventListener('click', toggleShuffle);
  document.getElementById('repeat').addEventListener('click', toggleRepeat);
  document.getElementById('eq-toggle').addEventListener('click', toggleEQ);
  document.getElementById('eq-close').addEventListener('click', toggleEQ);
  document.getElementById('eq-reset').addEventListener('click', resetEQ);

  // REPLACE YOUR OLD document.getElementById('volume') LISTENER WITH THIS
  document.getElementById('volume').addEventListener('input', (e) => {
    audio.volume = e.target.value;
    localStorage.setItem('jmf_volume', e.target.value);
    
    const icon = document.querySelector('.volume-wrap span');
    if (e.target.value == 0) icon.textContent = '🔇';
    else if (e.target.value < 0.5) icon.textContent = '🔉';
    else icon.textContent = '🔊';
  });


  document.getElementById('seek').addEventListener('input', (e) => {
    const percent = e.target.value / 100;
    audio.currentTime = percent * audio.duration;
  });

  waveformCanvas.addEventListener('click', (e) => {
    const rect = waveformCanvas.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audio.currentTime = percent * audio.duration;
  });

  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('ended', () => {
    if (isRepeating) {
      audio.currentTime = 0;
      audio.play();
    } else if (currentSongIndex < songs.length - 1) {
      nextSong();
    } else {
      currentSongIndex = 0;
      loadSong(0);
      audio.pause();
      document.getElementById('play').textContent = '▶';
      
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
      }
    }
  });
  
  audio.addEventListener('play', () => {
  document.getElementById('cover').classList.add('playing');
  document.getElementById('play').textContent = '⏸';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
});
audio.addEventListener('pause', () => {
  document.getElementById('cover').classList.remove('playing');
  document.getElementById('play').textContent = '▶';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
});
  document.getElementById('add-files').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('add-folder').addEventListener('click', () => {
    document.getElementById('folder-input').click();
  });
  document.getElementById('clear-playlist').addEventListener('click', clearPlaylist);

  document.getElementById('file-input').addEventListener('change', handleFiles);
  document.getElementById('folder-input').addEventListener('change', handleFiles);

  document.getElementById('bass').addEventListener('input', updateEQ);
  document.getElementById('mid').addEventListener('input', updateEQ);
  document.getElementById('treble').addEventListener('input', updateEQ);

  // Cleanup blob URLs on page close
  window.addEventListener('beforeunload', () => {
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    playlist.forEach(song => {
      if (song.cover?.startsWith('blob:')) URL.revokeObjectURL(song.cover);
    });
  });

  draw();
}

function togglePlay() {
  if (audioContext.state === 'suspended') audioContext.resume();
  if (audio.paused) {
    if (currentIndex === -1 && playlist.length > 0) loadSong(0);
    audio.play();
  } else {
    audio.pause();
  }
}

function updateProgress() {
  const percent = (audio.currentTime / audio.duration) * 100 || 0;
  document.getElementById('seek').value = percent;
  document.getElementById('current-time').textContent = formatTime(audio.currentTime);
  document.getElementById('duration').textContent = formatTime(audio.duration);

  if (waveformCtx && audio.duration) {
    waveformCtx.strokeStyle = 'rgba(236, 72, 153, 0.8)';
    waveformCtx.lineWidth = 2;
    waveformCtx.beginPath();
    waveformCtx.moveTo(percent / 100 * waveformCanvas.width, 0);
    waveformCtx.lineTo(percent / 100 * waveformCanvas.width, waveformCanvas.height);
    waveformCtx.stroke();
  }
}

function formatTime(sec) {
  if (isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function handleFiles(e) {
  const files = Array.from(e.target.files).filter(f => f.type.startsWith('audio/'));
  for (const file of files) {
    await addToPlaylist(file);
  }
  savePlaylist();
  if (currentIndex === -1 && playlist.length > 0) loadSong(0);
  e.target.value = ''; // Reset input so same file can be picked again
}

async function addToPlaylist(file) {
  const id = Date.now() + Math.random();
  const song = {
    id,
    file,
    name: file.name,
    title: file.name.replace(/\.[^/.]+$/, ''),
    artist: 'Unknown Artist',
    cover: null
  };

  await new Promise((resolve) => {
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title) song.title = tag.tags.title;
        if (tag.tags.artist) song.artist = tag.tags.artist;
        if (tag.tags.picture) {
          const { data, format } = tag.tags.picture;
          const byteArray = new Uint8Array(data);
          const blob = new Blob([byteArray], { type: format });
          song.cover = URL.createObjectURL(blob);
        }
        resolve();
      },
      onError: () => resolve()
    });
  });

  playlist.push(song);
  renderPlaylist();
}

function renderPlaylist() {
  const ul = document.getElementById('playlist');
  ul.innerHTML = '';
  playlist.forEach((song, i) => {
    const li = document.createElement('li');
    li.className = i === currentIndex? 'active' : '';
    li.innerHTML = `
      <img src="${song.cover || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22%3E%3Crect fill=%22%238B5CF6%22 width=%2240%22 height=%2240%22/%3E%3C/svg%3E'}" width="40" height="40">
      <div class="song-info">
        <div class="title">${song.title}</div>
        <div class="artist">${song.artist}</div>
      </div>
    `;
    li.addEventListener('click', () => loadSong(i));
    ul.appendChild(li);
  });
  document.getElementById('empty-state').classList.toggle('hide', playlist.length > 0);
}

async function loadSong(index) {
  // Revoke old audio blob
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

  currentIndex = index;
  const song = playlist[index];

  // Create new blob URL for audio
  currentBlobUrl = URL.createObjectURL(song.file);
  audio.src = currentBlobUrl;
  audio.load();

  document.getElementById('song-title').textContent = song.title;
  document.getElementById('song-artist').textContent = song.artist;
  document.getElementById('cover').src = song.cover || document.getElementById('cover').src;

  renderPlaylist();
  await drawWaveform(song.file);

  if (audioContext.state === 'suspended') audioContext.resume();
  audio.play();
   // ADD THIS BLOCK - Media Session for lock screen controls
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: 'JMF Player',
      artwork: [
        { 
          src: song.cover || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22512%22 height=%22512%22%3E%3Crect fill=%22%238B5CF6%22 width=%22512%22 height=%22512%22/%3E%3C/svg%3E', 
          sizes: '512x512', 
          type: 'image/svg+xml' 
        }
      ]
    });

    // Hook up the hardware/OS buttons
    navigator.mediaSession.setActionHandler('play', () => {
      audio.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      audio.pause();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      prevSong();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      nextSong();
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 10), 0);
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 10), audio.duration);
    });
  }
}

function prevSong() {
  if (playlist.length === 0) return;
  
  const newIndex = currentIndex <= 0 ? playlist.length - 1 : currentIndex - 1;
  loadSong(newIndex);
  
  // ADD THESE 4 LINES
  audio.play().catch(err => console.log('Autoplay blocked:', err));
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
}
function nextSong() {
  if (playlist.length === 0) return;
  
  if (isShuffle) {
    loadSong(Math.floor(Math.random() * playlist.length));
  } else {
    const newIndex = currentIndex >= playlist.length - 1 ? 0 : currentIndex + 1;
    loadSong(newIndex);
  }
  
  // ADD THESE 4 LINES
  audio.play().catch(err => console.log('Autoplay blocked:', err));
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
}

function handleSongEnd() {
  if (repeatMode === 2) {
    audio.currentTime = 0;
    audio.play();
  } else if (repeatMode === 1 || currentIndex < playlist.length - 1) {
    nextSong();
  }
}

function toggleShuffle() {
  isShuffle =!isShuffle;
  document.getElementById('shuffle').classList.toggle('active', isShuffle);
}

function toggleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const btn = document.getElementById('repeat');
  btn.classList.toggle('active', repeatMode > 0);
  btn.classList.toggle('one', repeatMode === 2);
}

function clearPlaylist() {
  // Revoke all blob URLs
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  playlist.forEach(song => {
    if (song.cover?.startsWith('blob:')) URL.revokeObjectURL(song.cover);
  });

  playlist = [];
  currentIndex = -1;
  audio.pause();
  audio.src = '';
  renderPlaylist();
  savePlaylist();
}

function toggleEQ() {
  document.getElementById('eq-panel').classList.toggle('hidden');
}

function updateEQ() {
  const bass = document.getElementById('bass').value;
  const mid = document.getElementById('mid').value;
  const treble = document.getElementById('treble').value;

  if (bassFilter) bassFilter.gain.value = bass;
  if (midFilter) midFilter.gain.value = mid;
  if (trebleFilter) trebleFilter.gain.value = treble;

  document.querySelectorAll('.eq-value')[0].textContent = bass + 'dB';
  document.querySelectorAll('.eq-value')[1].textContent = mid + 'dB';
  document.querySelectorAll('.eq-value')[2].textContent = treble + 'dB';
}

function resetEQ() {
  document.getElementById('bass').value = 0;
  document.getElementById('mid').value = 0;
  document.getElementById('treble').value = 0;
  updateEQ();
}

async function drawWaveform(file) {
  if (!waveformCtx) return;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / waveformCanvas.width);
    const amp = waveformCanvas.height / 2;

    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    waveformCtx.fillStyle = 'rgba(139, 92, 246, 0.3)';

    for (let i = 0; i < waveformCanvas.width; i++) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      waveformCtx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
    ctx.close();
  } catch (e) {
    console.log('Waveform error:', e);
  }
}

function draw() {

  ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);

  let bassSum = 0, totalSum = 0;
  const bassRange = Math.floor(dataArray.length * 0.1);
  for (let i = 0; i < dataArray.length; i++) {
    totalSum += dataArray[i];
    if (i < bassRange) bassSum += dataArray[i];
  }
  const bassAvg = bassSum / bassRange / 255;
  const rms = totalSum / dataArray.length / 255;

  const vuLevel = Math.floor(rms * 8);
  vuLeds.forEach((led, i) => {
    led.classList.toggle('active', i < vuLevel);
  });

  const bgBlur = document.querySelector('.bg-blur');
  const seekBar = document.getElementById('seek');

  if (bassAvg > 0.5 && Date.now() - lastBeatTime > 150) {
    if (bgBlur) {
      bgBlur.classList.add('beat');
      setTimeout(() => bgBlur.classList.remove('beat'), 120);
    }
    if (seekBar) {
      seekBar.classList.add('beat');
      setTimeout(() => seekBar.classList.remove('beat'), 100);
    }
    lastBeatTime = Date.now();
  }

  const beatPulse = 1 + bassAvg * 0.3;
  const barCount = dataArray.length;
  const barWidth = canvas.offsetWidth / barCount * 1.8;
  const barGap = 2;
  let x = 0;

  for (let i = 0; i < barCount; i++) {
    const barHeight = (dataArray[i] / 255) * canvas.offsetHeight * beatPulse;

    let color;
    if (i < barCount * 0.15) {
      color = '#DC2626'; // Red
    } else if (i < barCount * 0.4) {
      color = '#F59E0B'; // Gold
    } else {
      color = '#10B981'; // Green
    }

    ctx.fillStyle = color;
    ctx.shadowBlur = 0;
    ctx.fillRect(x, canvas.offsetHeight - barHeight, barWidth - barGap, barHeight);

    x += barWidth;
  }
}

function savePlaylist() {
  localStorage.setItem('jmf_playlist', JSON.stringify(playlist.map(p => ({
    title: p.title,
    artist: p.artist,
    name: p.name
  }))));
}

function loadPlaylist() {
  const saved = localStorage.getItem('jmf_playlist');
  if (saved) {
    // Can't restore File objects, user must re-add
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }
}
