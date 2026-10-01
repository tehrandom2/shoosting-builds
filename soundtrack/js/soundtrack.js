// The soundtrack page: a player, a zip builder, a cover painter and a visualizer that is
// the page's background. tracks.json is written by Tools/soundtrack-site.py at deploy time.
//
// Two rules shape most of this file:
//  - Nothing snaps. Every value the visualizer draws is eased toward its target with an
//    exponential that is independent of frame rate, and "no audio" is a synthetic spectrum
//    the live one crossfades from, so pausing settles instead of dropping to zero.
//  - The analyser sits before the volume stage, so the visuals are identical at any volume,
//    muted included.

const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const ALBUM = "shoosting (Original Game Soundtrack)";
const STORE = "shoosting.ost.";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ small helpers

const pad2 = (n) => String(n).padStart(2, "0");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frameYield = () => new Promise((r) => requestAnimationFrame(() => r()));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  return `${m}:${pad2(Math.floor(sec % 60))}`;
}

function fmtRuntime(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

const fmtMB = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(STORE + key, JSON.stringify(value));
  } catch {}
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $(".js-toast");
  el.textContent = msg;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), ms);
}

function icon(id, cls = "") {
  return `<svg${cls ? ` class="${cls}"` : ""}><use href="#i-${id}"/></svg>`;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ------------------------------------------------------------------ state

const audio = new Audio();
audio.preload = "auto";
const canOgg = !!audio.canPlayType('audio/ogg; codecs="vorbis"');

const S = {
  tracks: [],
  queue: [],
  track: null,
  history: [],
  shuffle: load("shuffle", false),
  repeat: load("repeat", 0), // 0 off, 1 all, 2 one
  filter: "all",
  volume: load("volume", 0.85),
  muted: load("muted", false),
  album: null,
  played: false,
};

// ------------------------------------------------------------------ covers
//
// Every track gets a generated cover, keyed by its seed so it is the same picture on every
// visit and every machine. Tempo picks the palette: the 140s run hot (magenta to orange),
// the 70s run cool (teal to violet). Five motifs, one of which is the 2.0 board's planks.

// Golden-ratio steps through each palette, so neighbours in the list never share a colour
// and tracks that share a motif land far apart on the wheel.
function assignHues(tracks) {
  const PHI = 0.6180339887;
  let fast = 0, slow = 0;
  for (const t of tracks) {
    const isSlow = t.bpm && t.bpm < 100;
    const u = ((isSlow ? slow++ : fast++) * PHI + (isSlow ? 0.2 : 0.05)) % 1;
    t.hue = Math.round(isSlow ? 170 + u * 105 : 288 + u * 112) % 360;
  }
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

const MOTIFS = [
  function rings(g, s, rnd, A) {
    const cx = s * (0.5 + rnd() * 0.35);
    const cy = s * (0.26 + rnd() * 0.24);
    for (let k = 0; k < 12; k++) {
      g.beginPath();
      g.arc(cx, cy, s * (0.045 + k * 0.072), 0, TAU);
      g.lineWidth = k % 4 === 0 ? s * 0.011 : s * 0.0032;
      g.strokeStyle = A(62, 0.08 + 0.5 * (1 - k / 12), k * 5);
      g.stroke();
    }
    const a0 = rnd() * TAU;
    g.save();
    g.shadowColor = A(60, 1);
    g.shadowBlur = s * 0.05;
    g.lineCap = "round";
    for (let j = 0; j < 3; j++) {
      g.beginPath();
      g.arc(cx, cy, s * (0.19 + j * 0.144), a0 + j * 1.3, a0 + j * 1.3 + 0.6 + rnd() * 1.4);
      g.lineWidth = s * (0.018 - j * 0.004);
      g.strokeStyle = A(76 + j * 5, 0.95, j * 14);
      g.stroke();
    }
    g.restore();
  },

  function tracers(g, s, rnd, A) {
    const ang = -(0.35 + rnd() * 0.5);
    const dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
    g.lineCap = "round";
    for (let i = 0; i < 34; i++) {
      const off = (i / 33 - 0.5) * s * 1.5 + (rnd() - 0.5) * s * 0.04;
      const along = (rnd() - 0.3) * s;
      const len = s * (0.2 + rnd() * 0.6);
      const x0 = s / 2 + nx * off + dx * along, y0 = s / 2 + ny * off + dy * along;
      const x1 = x0 + dx * len, y1 = y0 + dy * len;
      const hot = i % 8 === 3;
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, A(60, 0));
      gr.addColorStop(1, hot ? "rgba(255,255,255,.95)" : A(64, 0.3 + rnd() * 0.55, rnd() * 30));
      g.save();
      if (hot) {
        g.shadowColor = A(65, 1);
        g.shadowBlur = s * 0.04;
      }
      g.strokeStyle = gr;
      g.lineWidth = hot ? s * 0.012 : s * (0.003 + rnd() * 0.01);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      if (hot) {
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(x1, y1, s * 0.011, 0, TAU);
        g.fill();
      }
      g.restore();
    }
  },

  function dots(g, s, rnd, A) {
    const n = 12, pad = s * 0.1, step = (s - pad * 2) / (n - 1);
    const f1 = 1 + rnd() * 2.5, f2 = 1 + rnd() * 2.5, p1 = rnd() * 6, p2 = rnd() * 6;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = (Math.sin((x / n) * Math.PI * f1 + p1) * Math.cos((y / n) * Math.PI * f2 + p2) + 1) / 2;
        const hot = v > 0.93;
        g.save();
        if (hot) {
          g.shadowColor = A(65, 1);
          g.shadowBlur = s * 0.04;
        }
        g.fillStyle = hot ? "#fff" : A(55 + v * 25, 0.15 + v * 0.75, v * 30);
        g.beginPath();
        g.arc(pad + x * step, pad * 0.8 + y * step * 0.8, s * (0.003 + v * v * 0.02), 0, TAU);
        g.fill();
        g.restore();
      }
    }
  },

  function planks(g, s, rnd, A) {
    g.globalCompositeOperation = "source-over";
    for (let r = 0; r < 6; r++) {
      const y = s * (0.08 + r * 0.105), hh = s * 0.056;
      let x = -rnd() * s * 0.2;
      while (x < s) {
        const w = s * (0.14 + rnd() * 0.34);
        const lift = rnd() < 0.15 ? -s * 0.012 : 0;
        g.fillStyle = `hsl(28, ${35 + rnd() * 15}%, ${16 + rnd() * 16}%)`;
        rrect(g, x, y + lift, w - s * 0.012, hh, s * 0.01);
        g.fill();
        g.fillStyle = "rgba(255,230,190,.16)";
        g.fillRect(x + s * 0.01, y + lift + s * 0.004, w - s * 0.035, s * 0.004);
        if (rnd() < 0.35) {
          const cx = x + w * (0.2 + rnd() * 0.6);
          g.strokeStyle = "rgba(20,10,5,.6)";
          g.lineWidth = s * 0.003;
          g.beginPath();
          g.moveTo(cx, y + lift);
          g.lineTo(cx + s * (rnd() - 0.5) * 0.03, y + lift + hh * 0.5);
          g.lineTo(cx + s * (rnd() - 0.5) * 0.04, y + lift + hh);
          g.stroke();
        }
        x += w + s * (rnd() < 0.2 ? 0.05 : 0.004);
      }
    }
    g.globalCompositeOperation = "soft-light";
    g.fillStyle = A(55, 0.8);
    g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = "lighter";
    const gr = g.createLinearGradient(0, 0, s * 0.35, s);
    gr.addColorStop(0, A(70, 0.28));
    gr.addColorStop(1, A(50, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  },

  function bullet(g, s, rnd, A) {
    const ang = Math.PI * (0.85 + rnd() * 0.3);
    const bx = s * (0.58 + rnd() * 0.12), by = s * (0.3 + rnd() * 0.12), r = s * (0.08 + rnd() * 0.04);
    for (let k = 16; k >= 1; k--) {
      g.fillStyle = A(55, 0.04 + (0.035 * (16 - k)) / 16, k * 2);
      g.beginPath();
      g.arc(bx + Math.cos(ang) * k * r * 0.55, by + Math.sin(ang) * k * r * 0.55, r * (1 - k * 0.03), 0, TAU);
      g.fill();
    }
    for (let k = 1; k <= 3; k++) {
      g.strokeStyle = A(70, 0.35 / k);
      g.lineWidth = s * 0.004;
      g.beginPath();
      g.arc(bx, by, r * (1.3 + k * 0.6), 0, TAU);
      g.stroke();
    }
    const gr = g.createRadialGradient(bx, by, 0, bx, by, r);
    gr.addColorStop(0, "#fff");
    gr.addColorStop(0.45, A(85, 1, 20));
    gr.addColorStop(1, A(60, 0));
    g.save();
    g.shadowColor = A(60, 1);
    g.shadowBlur = s * 0.08;
    g.fillStyle = gr;
    g.beginPath();
    g.arc(bx, by, r, 0, TAU);
    g.fill();
    g.restore();
  },
];

function fitFont(g, text, weight, family, size, maxWidth) {
  let px = size;
  g.font = `${weight} ${px}px ${family}`;
  while (px > 8 && g.measureText(text).width > maxWidth) {
    px *= 0.94;
    g.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

function paintCover({ hue, seed, motifs, topLeft, topRight, heading, big }, s = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const rnd = mulberry32(seed);
  const A = (l, a = 1, dh = 0, sat = 96) => `hsla(${hue + dh}, ${sat}%, ${l}%, ${a})`;

  let gr = g.createLinearGradient(0, 0, s, s);
  gr.addColorStop(0, A(6, 1, -10, 50));
  gr.addColorStop(1, A(14, 1, 30, 60));
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);

  g.globalCompositeOperation = "lighter";
  const gx = s * (0.35 + rnd() * 0.4), gy = s * (0.2 + rnd() * 0.35);
  gr = g.createRadialGradient(gx, gy, 0, gx, gy, s * 0.75);
  gr.addColorStop(0, A(55, 0.5));
  gr.addColorStop(0.5, A(45, 0.12, 25));
  gr.addColorStop(1, A(40, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);

  for (const m of motifs) {
    g.globalCompositeOperation = "lighter";
    MOTIFS[m](g, s, rnd, A);
  }
  g.globalCompositeOperation = "source-over";

  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.14)";
    g.fillRect(rnd() * s, rnd() * s, 1.3, 1.3);
  }

  gr = g.createLinearGradient(0, s * 0.5, 0, s);
  gr.addColorStop(0, "rgba(0,0,0,0)");
  gr.addColorStop(1, "rgba(0,0,0,.6)");
  g.fillStyle = gr;
  g.fillRect(0, s * 0.5, s, s * 0.5);

  const left = s * 0.068, maxW = s * 0.864;
  if ("letterSpacing" in g) g.letterSpacing = `${s * 0.006}px`;
  g.font = `600 ${s * 0.03}px "JetBrains Mono", monospace`;
  g.textBaseline = "alphabetic";
  g.fillStyle = "rgba(255,255,255,.72)";
  g.textAlign = "left";
  g.fillText(topLeft, left, s * 0.095);
  g.textAlign = "right";
  g.fillStyle = A(80, 0.95);
  g.fillText(topRight, s - left, s * 0.095);
  g.textAlign = "left";

  if ("letterSpacing" in g) g.letterSpacing = `${-s * 0.008}px`;
  const lines = Array.isArray(big) ? big : [big];
  const bigPx = Math.min(...lines.map((l) => fitFont(g, l, 900, "Unbounded, sans-serif", s * (lines.length > 1 ? 0.24 : 0.3), maxW)));
  g.font = `900 ${bigPx}px Unbounded, sans-serif`;
  g.save();
  g.shadowColor = A(60, 0.9);
  g.shadowBlur = s * 0.05;
  g.fillStyle = "#fff";
  let y = s * 0.93;
  for (let i = lines.length - 1; i >= 0; i--) {
    g.fillText(lines[i], left - bigPx * 0.04, y);
    y -= bigPx * 0.86;
  }
  g.restore();

  if ("letterSpacing" in g) g.letterSpacing = `${s * 0.004}px`;
  const hpx = fitFont(g, heading, 700, '"Space Grotesk", sans-serif', s * 0.062, maxW);
  g.font = `700 ${hpx}px "Space Grotesk", sans-serif`;
  g.fillStyle = A(88, 1, 10);
  g.fillText(heading, left, y + bigPx * 0.86 - bigPx * 0.78 - s * 0.03);

  g.strokeStyle = "rgba(255,255,255,.14)";
  g.lineWidth = s * 0.004;
  g.strokeRect(s * 0.03, s * 0.03, s * 0.94, s * 0.94);
  return c;
}

function toUrl(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : canvas.toDataURL("image/jpeg", 0.9)), "image/jpeg", 0.9);
  });
}

async function paintAll() {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('900 64px "Unbounded"'),
        document.fonts.load('700 32px "Space Grotesk"'),
        document.fonts.load('600 16px "JetBrains Mono"'),
      ]),
      sleep(2500),
    ]);
  } catch {}

  const total = S.tracks.reduce((a, t) => a + t.duration, 0);
  S.album.canvas = paintCover({
    hue: 285,
    seed: 1337,
    motifs: [0, 1],
    topLeft: "ORIGINAL GAME SOUNDTRACK",
    topRight: "OST",
    heading: `${S.tracks.length} TRACKS · ${fmtRuntime(total).toUpperCase()}`,
    big: ["SHOO", "STING"],
  });
  S.album.cover = await toUrl(S.album.canvas);
  if (!S.track) showAlbum();

  for (const t of S.tracks) {
    t.canvas = paintCover({
      hue: t.hue,
      seed: Number(t.seed) || hashStr(t.slug),
      motifs: [t.motif],
      topLeft: "SHOOSTING / OST",
      topRight: t.bpm ? `${t.bpm} BPM` : "",
      heading: t.title.toUpperCase(),
      big: pad2(t.index),
    });
    t.cover = await toUrl(t.canvas);
    for (const img of $$(`img[data-cover="${t.slug}"]`)) img.src = t.cover;
    if (S.track === t) renderNow();
    await frameYield();
  }
}

// ------------------------------------------------------------------ audio graph

let actx = null, analyser = null, gainNode = null, freqData = null, timeData = null;

function ensureGraph() {
  if (actx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    actx = new AC();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    gainNode = actx.createGain();
    src.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(actx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    audio.volume = 1;
    V.buildBins(actx.sampleRate);
  } catch (err) {
    console.warn("no analyser; playing without the visualizer", err);
    actx = null;
    analyser = null;
  }
  applyVolume();
}

function applyVolume() {
  const v = S.muted ? 0 : S.volume;
  if (gainNode) gainNode.gain.setTargetAtTime(v * v, actx.currentTime, 0.03);
  else audio.volume = v * v;
  $(".js-mute").classList.toggle("is-muted", S.muted || S.volume === 0);
  const slider = $(".js-volume");
  slider.value = S.volume;
  slider.style.setProperty("--v", `${S.volume * 100}%`);
}

// ------------------------------------------------------------------ playback

function srcOf(t) {
  return canOgg || !t.mp3 ? t.file : t.mp3;
}

function cue(t, play = true) {
  if (S.track && S.track !== t) S.history.push(S.track);
  if (S.history.length > 200) S.history.shift();
  S.track = t;
  audio.src = srcOf(t);
  audio.currentTime = 0;
  renderNow();
  markCurrent();
  setMediaSession(t);
  history.replaceState(null, "", `#${t.slug}`);
  if (play) start();
}

async function start() {
  if (!S.track) return cue(S.queue[0] || S.tracks[0]);
  ensureGraph();
  try {
    if (actx && actx.state === "suspended") await actx.resume();
    await audio.play();
  } catch (err) {
    if (err && err.name === "NotAllowedError") toast("Your browser blocked autoplay - press play");
    else if (err && err.name !== "AbortError") toast(`Could not play ${S.track.title}`);
  }
}

function toggle() {
  if (!S.track) return cue(S.queue[0] || S.tracks[0]);
  if (audio.paused) start();
  else audio.pause();
}

// The game's shuffle rule, folded the way Stages.NextStage folds its draw: pick among
// everything except the current track, so no track ever plays twice in a row.
function shufflePick(q, current) {
  const i = q.indexOf(current);
  if (q.length < 2) return q[0];
  if (i < 0) return q[Math.floor(Math.random() * q.length)];
  const r = Math.floor(Math.random() * (q.length - 1));
  return q[r >= i ? r + 1 : r];
}

function next(auto = false) {
  const q = S.queue.length ? S.queue : S.tracks;
  if (!q.length) return;
  if (auto && S.repeat === 2) {
    audio.currentTime = 0;
    return start();
  }
  if (S.shuffle) return cue(shufflePick(q, S.track));
  let i = q.indexOf(S.track) + 1;
  if (i >= q.length) {
    if (auto && S.repeat === 0) {
      S.ended = true;
      renderNow();
      return;
    }
    i = 0;
  }
  cue(q[i]);
}

function prev() {
  if (audio.currentTime > 3 || !S.track) {
    audio.currentTime = 0;
    return;
  }
  const q = S.queue.length ? S.queue : S.tracks;
  if (S.shuffle && S.history.length) {
    // Walking back must not record the track being left, or Previous would ping-pong.
    const t = S.history.pop();
    S.track = null;
    cue(t);
    return;
  }
  let i = q.indexOf(S.track) - 1;
  if (i < 0) i = q.length - 1;
  cue(q[i]);
}

function seekTo(sec) {
  if (!S.track) return;
  const d = S.track.duration;
  audio.currentTime = clamp(sec, 0, Math.max(0, d - 0.05));
  drawWave();
}

audio.addEventListener("play", () => {
  S.ended = false;
  S.played = true;
  document.body.classList.add("is-playing", "has-played");
  renderNow();
});
audio.addEventListener("pause", () => {
  document.body.classList.remove("is-playing");
  renderNow();
});
audio.addEventListener("ended", () => next(true));
audio.addEventListener("timeupdate", onTime);
audio.addEventListener("loadedmetadata", onTime);
audio.addEventListener("error", () => {
  const t = S.track;
  if (!t) return;
  if (audio.src.endsWith(".ogg") && t.mp3) {
    const at = audio.currentTime;
    audio.src = t.mp3;
    audio.currentTime = at;
    start();
    return;
  }
  toast(`Could not load ${t.title}`);
});

let lastPosUpdate = 0;
function onTime() {
  const t = S.track;
  if (!t) return;
  const d = t.duration;
  $(".js-time").textContent = fmtTime(audio.currentTime);
  $(".js-duration").textContent = fmtTime(d);
  const wave = $(".js-wave");
  wave.setAttribute("aria-valuemax", Math.round(d));
  wave.setAttribute("aria-valuenow", Math.round(audio.currentTime));
  wave.setAttribute("aria-valuetext", `${fmtTime(audio.currentTime)} of ${fmtTime(d)}`);
  const row = t.row;
  if (row) row.style.setProperty("--prog-f", (audio.currentTime / d).toFixed(4));
  if (audio.paused) drawWave();
  const now = performance.now();
  if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && now - lastPosUpdate > 1000 && isFinite(d)) {
    lastPosUpdate = now;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 });
    } catch {}
  }
}

function setMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: "shoosting",
      album: ALBUM,
      artwork: t.cover ? [{ src: t.cover, sizes: "512x512", type: "image/jpeg" }] : [],
    });
  } catch {}
}

if ("mediaSession" in navigator) {
  const set = (a, fn) => {
    try {
      navigator.mediaSession.setActionHandler(a, fn);
    } catch {}
  };
  set("play", () => start());
  set("pause", () => audio.pause());
  set("previoustrack", () => prev());
  set("nexttrack", () => next());
  set("seekto", (e) => seekTo(e.seekTime));
  set("seekbackward", (e) => seekTo(audio.currentTime - (e.seekOffset || 10)));
  set("seekforward", (e) => seekTo(audio.currentTime + (e.seekOffset || 10)));
}

// ------------------------------------------------------------------ rendering

function discsOf(list) {
  const byDate = new Map();
  for (const t of list) {
    const k = t.date || "undated";
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(t);
  }
  return [...byDate.entries()];
}

function niceDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function downloadName(t, ext) {
  return `shoosting - ${pad2(t.index)} ${t.title}.${ext}`;
}

function trackRow(t, i) {
  const mp3 = t.mp3
    ? `<a href="${t.mp3}" download="${esc(downloadName(t, "mp3"))}" title="MP3, ${fmtMB(t.mp3Bytes)} - plays anywhere">${icon("download")}<span>MP3</span></a>`
    : "";
  const ogg = `<a href="${t.file}" download="${esc(downloadName(t, "ogg"))}" title="OGG Vorbis, ${fmtMB(t.bytes)} - the file the game ships">${mp3 ? "" : icon("download")}<span>OGG</span></a>`;
  return `
  <li class="track" data-slug="${t.slug}" style="--i:${i}">
    <div class="track__row">
      <button class="track__hit" type="button" aria-label="Play ${esc(t.title)}"></button>
      <span class="track__num"><span class="n">${pad2(t.index)}</span><span class="eq"><i></i><i></i><i></i><i></i></span>${icon("play")}</span>
      <img class="track__art" data-cover="${t.slug}" ${t.cover ? `src="${t.cover}"` : ""} alt="" width="52" height="52">
      <span class="track__text"><span class="track__title">${esc(t.title)}</span><span class="track__genre">${esc(t.genre)}</span></span>
      <span class="track__bpm">${t.bpm ? `${t.bpm} BPM` : ""}</span>
      <span class="track__time">${fmtTime(t.duration)}</span>
      <span class="dl">${mp3}${ogg}</span>
      <button class="icon-btn js-more" type="button" aria-expanded="false" aria-label="Liner notes for ${esc(t.title)}">${icon("chevron")}</button>
    </div>
    <div class="track__notes"><div>
      <div class="notes">
        ${t.why ? `<p class="notes__label">The thinking</p><p class="notes__why">${esc(t.why)}</p>` : ""}
        <p class="notes__label">The prompt</p>
        <p class="notes__prompt">${esc(t.prompt)}</p>
        <div class="notes__meta">
          ${t.seed ? `<span class="chip">seed <b>${esc(t.seed)}</b></span>` : ""}
          ${t.date ? `<span class="chip">made <b>${esc(t.date)}</b></span>` : ""}
          <span class="chip">${esc((t.model || "").replace(/\s*\(.*\)/, ""))}</span>
          <span class="chip">file <b>${esc(t.slug)}.ogg</b></span>
          <button class="link-btn js-copy" type="button">${icon("link")} Copy link</button>
        </div>
        <canvas class="notes__wave" aria-hidden="true"></canvas>
      </div>
    </div></div>
  </li>`;
}

function renderList() {
  const discs = discsOf(S.queue);
  const host = $(".js-discs");
  if (!S.queue.length) {
    host.innerHTML = `<div class="empty">Nothing at that tempo.</div>`;
    return;
  }
  let i = 0;
  const words = ["one", "two", "three", "four", "five", "six"];
  host.innerHTML = discs
    .map(([date, list], d) => {
      const runtime = list.reduce((a, t) => a + t.duration, 0);
      // A disc is named by a `disc:` line in any of its tracks' licence files.
      const name = (list.find((t) => t.disc) || {}).disc;
      return `
      <section class="disc">
        <header class="disc__head">
          <span class="disc__num">${pad2(d + 1)}</span>
          <span class="disc__label"><b>Disc ${words[d] || d + 1}${name ? ` &middot; ${esc(name)}` : ""}</b><span>${esc(niceDate(date))} &middot; ${list.length} tracks &middot; ${fmtRuntime(runtime)}</span></span>
        </header>
        <ol class="tracks">${list.map((t) => trackRow(t, i++)).join("")}</ol>
      </section>`;
    })
    .join("");
  for (const t of S.tracks) t.row = null;
  for (const li of $$(".track", host)) {
    const t = S.bySlug.get(li.dataset.slug);
    t.row = li;
  }
  markCurrent();
}

function markCurrent() {
  for (const li of $$(".track.is-current")) li.classList.remove("is-current");
  if (S.track && S.track.row) S.track.row.classList.add("is-current");
}

function chipsFor(t) {
  const disc = discsOf(S.tracks).findIndex(([date]) => date === (t.date || "undated")) + 1;
  return [
    t.bpm ? `<span class="chip chip--accent"><b>${t.bpm}</b> BPM</span>` : "",
    `<span class="chip"><b>${fmtTime(t.duration)}</b></span>`,
    `<span class="chip">disc <b>${disc}</b> &middot; track <b>${pad2(t.index)}</b></span>`,
    t.seed ? `<span class="chip">seed <b>${esc(t.seed)}</b></span>` : "",
  ].join("");
}

function showAlbum() {
  const total = S.tracks.reduce((a, t) => a + t.duration, 0);
  if (S.album.cover) {
    $(".js-hero-cover").src = S.album.cover;
    $(".js-dock-cover").src = S.album.cover;
  }
  $(".js-hero-title").textContent = "The whole soundtrack";
  $(".js-hero-genre").textContent = "Brostep, riddim, electro house and dark techno";
  $(".js-hero-chips").innerHTML = [
    `<span class="chip chip--accent"><b>${S.tracks.length}</b> tracks</span>`,
    `<span class="chip"><b>${fmtRuntime(total)}</b></span>`,
    `<span class="chip"><b>${discsOf(S.tracks).length}</b> discs</span>`,
    `<span class="chip">free to <b>download</b></span>`,
  ].join("");
}

function renderNow() {
  const t = S.track;
  const playing = !audio.paused;
  $(".js-state").textContent = !t ? "Ready" : S.ended ? "End of the tracklist" : playing ? "Now playing" : "Paused";
  $(".js-hero-play-label").textContent = !t ? "Play the soundtrack" : playing ? "Pause" : "Play";
  for (const b of [$(".js-play"), $(".js-hero-play")]) b.setAttribute("aria-label", playing ? "Pause" : "Play");
  if (!t) return;
  root.style.setProperty("--h", t.hue);
  V.targetHue = t.hue;
  if (t.cover) {
    $(".js-hero-cover").src = t.cover;
    $(".js-dock-cover").src = t.cover;
  }
  $(".js-hero-title").textContent = t.title;
  $(".js-hero-genre").textContent = t.genre;
  $(".js-hero-chips").innerHTML = chipsFor(t);
  anchors.at = -1e9;
  $(".js-dock-title").textContent = t.title;
  $(".js-dock-sub").textContent = `${pad2(t.index)} · ${t.genre}`;
  const dl = $(".js-dock-download");
  dl.href = t.mp3 || t.file;
  dl.download = downloadName(t, t.mp3 ? "mp3" : "ogg");
  document.title = `${playing ? "▶ " : ""}${t.title} — shoosting OST`;
  drawWave();
}

function renderToggles() {
  const sh = $(".js-shuffle");
  sh.setAttribute("aria-pressed", String(S.shuffle));
  const rp = $(".js-repeat");
  rp.setAttribute("aria-pressed", String(S.repeat > 0));
  rp.classList.toggle("is-one", S.repeat === 2);
  rp.setAttribute("aria-label", ["Repeat: off", "Repeat: all", "Repeat: one"][S.repeat]);
}

function applyFilter(f) {
  S.filter = f;
  const pick = { all: () => true, fast: (t) => (t.bpm || 0) >= 100, slow: (t) => (t.bpm || 0) < 100 }[f];
  S.queue = S.tracks.filter(pick);
  for (const b of $$(".filter")) b.classList.toggle("is-active", b.dataset.filter === f);
  renderList();
}

// ------------------------------------------------------------------ waveform scrubber

const waveCanvas = $(".js-wave-canvas");
const waveCtx = waveCanvas.getContext("2d");
let hoverFrac = -1;

function resample(peaks, n) {
  const out = new Float32Array(n);
  if (!peaks || !peaks.length) return out.fill(0.12);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j]);
    out[i] = m / 99;
  }
  return out;
}

function drawWave() {
  const t = S.track;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = waveCanvas.clientWidth, h = waveCanvas.clientHeight;
  if (!w || !h) return;
  if (waveCanvas.width !== Math.round(w * dpr) || waveCanvas.height !== Math.round(h * dpr)) {
    waveCanvas.width = Math.round(w * dpr);
    waveCanvas.height = Math.round(h * dpr);
  }
  const g = waveCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const bar = 3, gap = 1.5, n = Math.max(8, Math.floor(w / (bar + gap)));
  if (!t) {
    g.fillStyle = "rgba(255,255,255,.12)";
    g.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  if (!t.waveCache || t.waveCache.length !== n) t.waveCache = resample(t.peaks, n);
  const d = t.duration;
  const p = clamp(audio.currentTime / d, 0, 1);
  const hue = V.hue;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, `hsl(${hue - 20}, 96%, 62%)`);
  grad.addColorStop(1, `hsl(${hue + 25}, 100%, 78%)`);
  const px = p * w;
  for (let i = 0; i < n; i++) {
    const x = i * (bar + gap);
    const near = Math.max(0, 1 - Math.abs(x - px) / 40);
    const v = Math.pow(t.waveCache[i], 1.4);
    const bh = Math.max(2, v * (h - 4) * (1 + near * V.kick * 0.25));
    const played = x + bar <= px;
    const hover = hoverFrac >= 0 && x <= hoverFrac * w;
    g.fillStyle = played ? grad : hover ? "rgba(255,255,255,.42)" : "rgba(255,255,255,.2)";
    rrect(g, x, (h - bh) / 2, bar, bh, 1.5);
    g.fill();
  }
  g.fillStyle = "#fff";
  g.shadowColor = `hsl(${hue}, 100%, 65%)`;
  g.shadowBlur = 10 + V.kick * 14;
  g.fillRect(px - 1, 1, 2, h - 2);
  g.shadowBlur = 0;
}

function drawNotesWave(t, canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.floor(w / 3);
  const vals = resample(t.peaks, n);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, `hsla(${t.hue - 20}, 96%, 62%, .9)`);
  grad.addColorStop(1, `hsla(${t.hue + 30}, 100%, 75%, .9)`);
  g.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(vals[i], 1.4), bh = Math.max(1, v * h);
    g.fillRect(i * 3, h - bh, 2, bh);
  }
}

function waveFrac(e) {
  const r = $(".js-wave").getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1);
}

// ------------------------------------------------------------------ the visualizer
//
// Layers, back to front: aurora glows, a liquid spectrum horizon along the bottom (and a
// faint mirror along the top), an oscilloscope ribbon across the middle, drifting dust,
// the frequency ring around the cover, shockwaves and tracer rounds that ricochet off the
// edges of the window on the kick.

const V = {
  cv: $("#stage"),
  g: null,
  w: 0,
  h: 0,
  dpr: 1,
  scale: 1,
  NB: 128,
  NW: 220,
  bars: new Float32Array(128),
  slow: new Float32Array(128),
  wave: new Float32Array(220),
  bins: null,
  prevLow: new Float32Array(16),
  mix: 0,
  bass: 0,
  mid: 0,
  high: 0,
  kick: 0,
  flux: 0,
  fluxAvg: 0,
  lastBeat: -10,
  hue: 285,
  targetHue: 285,
  T: 0,
  px: -1,
  py: -1,
  tracers: [],
  sparks: [],
  shocks: [],
  dust: [],
  frameTimes: [],
  buildBins(rate) {
    const hzPerBin = rate / 2048;
    this.bins = new Float32Array(this.NB);
    for (let i = 0; i < this.NB; i++) {
      const f = 32 * Math.pow(15000 / 32, i / (this.NB - 1));
      this.bins[i] = f / hzPerBin;
    }
  },
};
V.g = V.cv.getContext("2d", { alpha: false });
// The glows are the biggest fills on the page and have no edges worth resolving, so they
// are painted into a canvas an eighth of the size and stretched: a fraction of the fill
// cost, and the bilinear stretch only makes them softer.
V.soft = document.createElement("canvas");
V.sg = V.soft.getContext("2d");
V.SOFT = 8;
V.buildBins(48000);

function resizeStage() {
  const dprMax = window.innerWidth > 1800 ? 1.25 : 1.5;
  V.dpr = Math.min(window.devicePixelRatio || 1, dprMax) * V.scale;
  V.w = window.innerWidth;
  V.h = window.innerHeight;
  V.cv.width = Math.round(V.w * V.dpr);
  V.cv.height = Math.round(V.h * V.dpr);
  V.soft.width = Math.max(2, Math.round(V.w / V.SOFT));
  V.soft.height = Math.max(2, Math.round(V.h / V.SOFT));
  if (!V.dust.length) {
    const n = reduceMotion ? 40 : Math.round(clamp((V.w * V.h) / 14000, 50, 140));
    for (let i = 0; i < n; i++) {
      V.dust.push({ x: Math.random() * V.w, y: Math.random() * V.h, z: 0.15 + Math.random() * 0.85, ph: Math.random() * TAU, vx: 0, vy: 0 });
    }
  }
  titleFont = parseFloat(getComputedStyle($(".title")).fontSize) || 120;
}

function sampleBin(data, fb) {
  const i = Math.floor(fb), f = fb - i;
  const a = data[Math.min(i, data.length - 1)], b = data[Math.min(i + 1, data.length - 1)];
  return (a + (b - a) * f) / 255;
}

function analyse(dt) {
  const live = !!analyser && !audio.paused;
  V.mix += ((live ? 1 : 0) - V.mix) * ease(dt, live ? 4 : 1.6);
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);
  }
  const T = V.T;
  for (let i = 0; i < V.NB; i++) {
    const u = i / V.NB;
    const idle =
      (0.2 + 0.1 * Math.sin(T * 0.8 + i * 0.16) + 0.07 * Math.sin(T * 1.7 - i * 0.07) + 0.05 * Math.sin(T * 0.33 + i * 0.41)) *
        (1 - u * 0.55) +
      V.kick * 0.25 * (1 - u);
    let real = 0;
    if (analyser) real = Math.min(1, Math.pow(sampleBin(freqData, V.bins[i]), 1.25) * (1 + u * 0.7));
    const target = idle * (1 - V.mix) + real * V.mix;
    const cur = V.bars[i];
    V.bars[i] = cur + (target - cur) * (target > cur ? ease(dt, 26) : ease(dt, 6.5));
    V.slow[i] += (V.bars[i] - V.slow[i]) * ease(dt, 2.2);
  }
  for (let j = 0; j < V.NW; j++) {
    const idle = 0.16 * Math.sin(T * 1.6 + j * 0.085) * Math.sin(T * 0.53 + j * 0.021) + 0.05 * Math.sin(T * 3.1 - j * 0.3);
    let real = 0;
    if (analyser) real = (timeData[Math.floor((j / V.NW) * 1024)] - 128) / 128;
    const target = idle * (1 - V.mix) + real * V.mix * 1.4;
    V.wave[j] += (target - V.wave[j]) * ease(dt, 18);
  }
  let b = 0, m = 0, h = 0;
  for (let i = 0; i < 14; i++) b += V.bars[i];
  for (let i = 30; i < 70; i++) m += V.bars[i];
  for (let i = 80; i < 120; i++) h += V.bars[i];
  V.bass += (b / 14 - V.bass) * ease(dt, 10);
  V.mid += (m / 40 - V.mid) * ease(dt, 8);
  V.high += (h / 40 - V.high) * ease(dt, 8);

  // Onsets from spectral flux in the kick's range, against a running average, so a wall of
  // sub bass that never lets up does not read as one endless beat.
  if (live) {
    let flux = 0;
    const lo = Math.max(1, Math.floor(V.bins[0])), hi = Math.min(lo + 10, freqData.length - 1);
    for (let k = lo; k <= hi; k++) {
      const v = freqData[k] / 255;
      const d = v - V.prevLow[k - lo];
      if (d > 0) flux += d;
      V.prevLow[k - lo] = v;
    }
    flux /= hi - lo + 1;
    V.fluxAvg += (flux - V.fluxAvg) * ease(dt, 1.5);
    if (flux > V.fluxAvg * 1.9 + 0.012 && V.T - V.lastBeat > 0.2) beat(clamp(0.35 + flux * 7, 0.35, 1));
  } else if (V.T - V.lastBeat > (60 / 70) * 2) {
    beat(0.22);
  }
  V.kick *= Math.exp(-dt * 5.5);
  V.hue += (((((V.targetHue - V.hue) % 360) + 540) % 360) - 180) * ease(dt, 1.8);
}

let heroRect = { left: 0, top: 0, width: 0, height: 0, bottom: 0 };

function beat(strength) {
  V.kick = Math.max(V.kick, strength);
  V.lastBeat = V.T;
  if (reduceMotion) return;
  const r = heroRect;
  const onScreen = r.bottom > 0 && r.top < V.h && r.width > 0;
  if (onScreen) V.shocks.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width * 0.7, a: 0.35 + strength * 0.5 });
  const n = strength > 0.75 ? 3 : strength > 0.45 ? 2 : Math.random() < 0.6 ? 1 : 0;
  for (let i = 0; i < n && V.tracers.length < 28; i++) spawnTracer(strength, onScreen);
}

function spawnTracer(strength, fromRing) {
  const r = heroRect;
  let x, y, a;
  if (fromRing) {
    a = Math.random() * TAU;
    const rad = r.width * 0.8;
    x = r.left + r.width / 2 + Math.cos(a) * rad;
    y = r.top + r.height / 2 + Math.sin(a) * rad;
  } else {
    const side = Math.floor(Math.random() * 4);
    x = side === 0 ? 0 : side === 1 ? V.w : Math.random() * V.w;
    y = side === 2 ? 0 : side === 3 ? V.h : Math.random() * V.h;
    a = Math.atan2(V.h / 2 - y, V.w / 2 - x) + (Math.random() - 0.5) * 1.2;
  }
  const sp = 650 + strength * 900 + Math.random() * 300;
  V.tracers.push({
    x, y,
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp,
    trail: [],
    maxTrail: Math.round(6 + strength * 10),
    bounces: 1 + (Math.random() < 0.55 ? 1 : 0),
    hue: V.hue + (Math.random() * 50 - 25),
    w: 1.2 + strength * 1.6,
    dead: false,
  });
}

function burst(x, y, nx, ny, hue) {
  for (let i = 0; i < 9; i++) {
    const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 2.2;
    const sp = 120 + Math.random() * 380;
    V.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.4, age: 0, hue });
  }
}

function step(dt) {
  for (const t of V.tracers) {
    t.trail.push(t.x, t.y);
    if (t.trail.length > t.maxTrail * 2) t.trail.splice(0, 2);
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    const out = t.x < 0 || t.x > V.w || t.y < 0 || t.y > V.h;
    if (out) {
      if (t.bounces > 0) {
        t.bounces--;
        let nx = 0, ny = 0;
        if (t.x < 0) { t.x = 0; t.vx = -t.vx; nx = 1; }
        if (t.x > V.w) { t.x = V.w; t.vx = -t.vx; nx = -1; }
        if (t.y < 0) { t.y = 0; t.vy = -t.vy; ny = 1; }
        if (t.y > V.h) { t.y = V.h; t.vy = -t.vy; ny = -1; }
        burst(t.x, t.y, nx, ny, t.hue);
      } else {
        t.dead = true;
      }
    }
  }
  V.tracers = V.tracers.filter((t) => !t.dead);

  for (const s of V.sparks) {
    s.age += dt;
    s.vy += 900 * dt;
    s.vx *= Math.exp(-dt * 2);
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }
  V.sparks = V.sparks.filter((s) => s.age < s.life);

  for (const s of V.shocks) {
    s.r += dt * (380 + s.a * 500);
    s.a -= dt * 0.9;
  }
  V.shocks = V.shocks.filter((s) => s.a > 0);

  const lift = 10 + V.bass * 70;
  for (const d of V.dust) {
    d.y -= lift * d.z * dt;
    d.x += Math.sin(V.T * 0.3 + d.ph) * 8 * d.z * dt;
    if (V.px >= 0) {
      const dx = d.x - V.px, dy = d.y - V.py, dist2 = dx * dx + dy * dy;
      if (dist2 < 16000) {
        const f = (1 - dist2 / 16000) * 260 * dt;
        const dist = Math.sqrt(dist2) || 1;
        d.vx += (dx / dist) * f;
        d.vy += (dy / dist) * f;
      }
    }
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vx *= Math.exp(-dt * 2.5);
    d.vy *= Math.exp(-dt * 2.5);
    if (d.y < -10) { d.y = V.h + 10; d.x = Math.random() * V.w; }
    if (d.x < -10) d.x = V.w + 10;
    if (d.x > V.w + 10) d.x = -10;
  }
}

function draw(sy) {
  const g = V.g, w = V.w, h = V.h, hue = V.hue;
  g.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.fillStyle = "#06060b";
  g.fillRect(0, 0, w, h);

  const scrolled = clamp(sy / h, 0, 1.5);
  const dim = 1 - Math.min(0.4, scrolled * 0.35);

  // aurora, on the soft layer
  const sg = V.sg, k8 = 1 / V.SOFT;
  sg.setTransform(k8, 0, 0, k8, 0, 0);
  sg.globalCompositeOperation = "source-over";
  sg.fillStyle = "#06060b";
  sg.fillRect(0, 0, w, h);
  sg.globalCompositeOperation = "lighter";
  const big = Math.max(w, h);
  for (let k = 0; k < 3; k++) {
    let cx = w * (0.5 + 0.38 * Math.sin(V.T * 0.045 + k * 2.1));
    let cy = h * (0.42 + 0.32 * Math.cos(V.T * 0.037 + k * 1.3));
    if (k === 0 && V.px >= 0) {
      cx += (V.px - cx) * 0.25;
      cy += (V.py - cy) * 0.25;
    }
    const rad = big * (0.5 + 0.08 * k + 0.12 * V.bass);
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const a = (0.12 + 0.2 * V.bass + V.kick * 0.06) * dim;
    gr.addColorStop(0, `hsla(${hue + (k - 1) * 38}, 95%, 52%, ${a})`);
    gr.addColorStop(0.55, `hsla(${hue + (k - 1) * 38 + 20}, 95%, 45%, ${a * 0.35})`);
    gr.addColorStop(1, `hsla(${hue}, 95%, 40%, 0)`);
    sg.fillStyle = gr;
    sg.fillRect(0, 0, w, h);
  }
  horizonFill(sg, w, h, hue, dim);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "low";
  g.drawImage(V.soft, 0, 0, w, h);

  g.globalCompositeOperation = "lighter";
  horizonLines(g, w, h, hue, dim);
  ribbon(g, w, h, hue, sy, dim);
  dust(g, hue, sy, dim);
  ring(g, hue);

  for (const s of V.shocks) {
    g.strokeStyle = `hsla(${hue + 20}, 100%, 72%, ${s.a * 0.5})`;
    g.lineWidth = 1 + s.a * 3;
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, TAU);
    g.stroke();
  }

  tracers(g);

  if (V.kick > 0.55) {
    g.fillStyle = `hsla(${hue}, 100%, 60%, ${(V.kick - 0.55) * 0.07 * dim})`;
    g.fillRect(0, 0, w, h);
  }
}

function smoothPath(g, pts) {
  g.lineTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
    g.quadraticCurveTo(pts[i], pts[i + 1], mx, my);
  }
  g.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
}

function horizonPoints(src, w, baseY, amp, dir) {
  // Mirrored: lows in the middle of the screen, highs out at both edges.
  const half = 64, pts = [];
  for (let i = -half; i <= half; i++) {
    const idx = Math.min(src.length - 1, Math.floor(Math.abs(i) * 1.7));
    const v = Math.pow(src[idx], 1.3);
    pts.push(((i + half) / (half * 2)) * w, baseY - dir * v * amp);
  }
  return pts;
}

const HORIZON_LAYERS = [
  ["slow", 45, 0.2],
  ["bars", 0, 0.34],
];

function horizonFill(g, w, h, hue, dim) {
  const amp = h * 0.3;
  for (const [key, dh, alpha] of HORIZON_LAYERS) {
    const pts = horizonPoints(V[key], w, h + 2, amp, 1);
    const gr = g.createLinearGradient(0, h - amp, 0, h);
    gr.addColorStop(0, `hsla(${hue + dh}, 100%, 60%, 0)`);
    gr.addColorStop(1, `hsla(${hue + dh}, 100%, 58%, ${alpha * dim})`);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, h + 2);
    smoothPath(g, pts);
    g.lineTo(w, h + 2);
    g.closePath();
    g.fill();
  }
  const top = horizonPoints(V.slow, w, -2, h * 0.14, -1);
  const gr = g.createLinearGradient(0, 0, 0, h * 0.14);
  gr.addColorStop(0, `hsla(${hue - 30}, 100%, 60%, ${0.14 * dim})`);
  gr.addColorStop(1, `hsla(${hue - 30}, 100%, 60%, 0)`);
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(0, -2);
  smoothPath(g, top);
  g.lineTo(w, -2);
  g.closePath();
  g.fill();
}

function horizonLines(g, w, h, hue, dim) {
  const amp = h * 0.3;
  g.lineWidth = 1.4;
  for (const [key, dh, alpha] of HORIZON_LAYERS) {
    const pts = horizonPoints(V[key], w, h + 2, amp, 1);
    g.strokeStyle = `hsla(${hue + dh + 15}, 100%, 78%, ${alpha * 1.4 * dim})`;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    smoothPath(g, pts);
    g.stroke();
  }
}

function ribbon(g, w, h, hue, sy, dim) {
  const y0 = titleRect.height ? titleRect.top + titleRect.height * 0.52 : h * 0.3 - sy;
  if (y0 < -h * 0.3 || y0 > h * 1.3) return;
  const amp = h * (0.05 + V.bass * 0.09 + V.kick * 0.03);
  const n = V.NW;
  for (let layer = 2; layer >= 0; layer--) {
    g.beginPath();
    for (let j = 0; j < n; j++) {
      const u = j / (n - 1);
      const win = Math.pow(Math.sin(Math.PI * u), 1.6);
      const v = V.wave[(j + layer * 7) % n];
      const x = u * w, y = y0 + layer * 4 + v * amp * win * (1 - layer * 0.18);
      if (j === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    if (layer === 0) {
      g.strokeStyle = `hsla(${hue}, 100%, 65%, ${0.12 * dim})`;
      g.lineWidth = 7;
      g.stroke();
    }
    g.strokeStyle = `hsla(${hue + layer * 28}, 100%, ${72 - layer * 6}%, ${(0.55 - layer * 0.15) * dim})`;
    g.lineWidth = 1.5;
    g.stroke();
  }
}

function dust(g, hue, sy, dim) {
  // Four depth bands, one fill each: near motes are bigger, brighter and bluer-shifted.
  const pulse = 1 + V.kick * 0.9 + V.high * 0.8;
  for (let band = 0; band < 4; band++) {
    const z = 0.15 + (band + 0.5) * 0.2125;
    g.beginPath();
    for (const d of V.dust) {
      if (Math.min(3, Math.floor((d.z - 0.15) / 0.2125)) !== band) continue;
      let y = (d.y - sy * d.z * 0.25) % (V.h + 20);
      if (y < -10) y += V.h + 20;
      const size = 0.5 + d.z * 1.5 * pulse;
      g.moveTo(d.x + size, y);
      g.arc(d.x, y, size, 0, TAU);
    }
    g.fillStyle = `hsla(${hue + 40 * z}, 100%, ${70 + z * 20}%, ${(0.12 + z * 0.5) * dim})`;
    g.fill();
  }
}

function ring(g, hue) {
  const r = heroRect;
  if (!r.width || r.bottom < -r.width || r.top > V.h + r.width) return;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, size = r.width;
  const r0 = size * 0.76;
  const N = 90;
  const vis = clamp(1 - Math.max(0, -r.top) / (r.height * 1.4), 0, 1);
  if (vis <= 0) return;

  // liquid body
  g.beginPath();
  const pts = [];
  for (let i = 0; i <= N * 2; i++) {
    const side = i <= N ? i : N * 2 - i;
    const v = V.slow[Math.min(V.NB - 1, Math.floor(side * 1.3))];
    const a = -Math.PI / 2 + (i / (N * 2)) * TAU;
    const rad = r0 - 8 + v * size * 0.16 + V.kick * 6;
    pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  g.moveTo(pts[0], pts[1]);
  smoothPath(g, pts);
  g.closePath();
  g.fillStyle = `hsla(${hue}, 100%, 60%, ${(0.05 + V.bass * 0.08) * vis})`;
  g.fill();
  g.strokeStyle = `hsla(${hue + 20}, 100%, 75%, ${0.3 * vis})`;
  g.lineWidth = 1.2;
  g.stroke();

  // dashed orbit, as short arcs in one path: setLineDash is slow on a software canvas
  const ro = r0 - 18, dashes = 72, spin = (V.T * 18) / ro;
  g.strokeStyle = `rgba(255,255,255,${0.2 * vis})`;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < dashes; i++) {
    const a = (i / dashes) * TAU + spin;
    g.moveTo(cx + Math.cos(a) * ro, cy + Math.sin(a) * ro);
    g.arc(cx, cy, ro, a, a + 2 / ro);
  }
  g.stroke();

  // bars, in six hue buckets so each pass is a handful of strokes rather than hundreds
  g.lineCap = "round";
  const BUCKETS = 3;
  for (const [lw, light, alpha] of [
    [7, 60, 0.1],
    [2.4, 74, 0.92],
  ]) {
    g.lineWidth = lw;
    for (let b = 0; b < BUCKETS; b++) {
      g.beginPath();
      for (let i = Math.floor((b * N) / BUCKETS); i < Math.floor(((b + 1) * N) / BUCKETS); i++) {
        const v = V.bars[Math.min(V.NB - 1, Math.floor(i * 1.3))];
        const len = 3 + Math.pow(v, 1.4) * size * 0.27 * (1 + V.kick * 0.2);
        for (const sgn of [1, -1]) {
          const a = -Math.PI / 2 + sgn * ((i + 0.5) / N) * Math.PI;
          const ca = Math.cos(a), sa = Math.sin(a);
          g.moveTo(cx + ca * r0, cy + sa * r0);
          g.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
        }
      }
      g.strokeStyle = `hsla(${hue - 20 + (b / (BUCKETS - 1)) * 60}, 100%, ${light}%, ${alpha * vis})`;
      g.stroke();
    }
  }

  // outer satellites, in four brightness bands so it is four fills rather than sixty-four
  const R = r0 + size * 0.46;
  for (let band = 0; band < 4; band++) {
    g.beginPath();
    for (let i = 0; i < 64; i++) {
      const v = V.slow[(i * 2) % V.NB];
      if (Math.min(3, Math.floor(v * 4)) !== band) continue;
      const a = (i / 64) * TAU + V.T * 0.05;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R, rad = 0.8 + v * 2.2;
      g.moveTo(x + rad, y);
      g.arc(x, y, rad, 0, TAU);
    }
    g.fillStyle = `hsla(${hue + 30}, 100%, 80%, ${(0.1 + band * 0.18) * vis})`;
    g.fill();
  }
}

function tracers(g) {
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const t of V.tracers) {
    const tr = t.trail;
    const n = tr.length / 2;
    if (n < 1) continue;
    const tx = tr[0], ty = tr[1];
    g.beginPath();
    g.moveTo(tx, ty);
    for (let i = 1; i < n; i++) g.lineTo(tr[i * 2], tr[i * 2 + 1]);
    g.lineTo(t.x, t.y);
    const glow = g.createLinearGradient(tx, ty, t.x, t.y);
    glow.addColorStop(0, `hsla(${t.hue}, 100%, 65%, 0)`);
    glow.addColorStop(1, `hsla(${t.hue}, 100%, 65%, .16)`);
    g.strokeStyle = glow;
    g.lineWidth = t.w * 4;
    g.stroke();
    const core = g.createLinearGradient(tx, ty, t.x, t.y);
    core.addColorStop(0, `hsla(${t.hue + 15}, 100%, 70%, 0)`);
    core.addColorStop(1, `hsla(${t.hue + 15}, 100%, 92%, .95)`);
    g.strokeStyle = core;
    g.lineWidth = t.w;
    g.stroke();
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(t.x, t.y, t.w * 1.1, 0, TAU);
    g.fill();
  }
  for (const s of V.sparks) {
    const u = 1 - s.age / s.life;
    g.strokeStyle = `hsla(${s.hue + 20}, 100%, 75%, ${u})`;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(s.x, s.y);
    g.lineTo(s.x - s.vx * 0.025, s.y - s.vy * 0.025);
    g.stroke();
  }
}

// ------------------------------------------------------------------ the title is an equaliser

let titleFont = 120;
let letters = [];

function buildTitle() {
  const host = $(".js-title");
  host.innerHTML = "SHOOSTING".split("").map((c) => `<span>${c}</span>`).join("");
  letters = $$("span", host);
}

function driveTitle() {
  const n = letters.length;
  for (let k = 0; k < n; k++) {
    const a = 3 + Math.floor((k * 100) / n), b = 3 + Math.floor(((k + 1) * 100) / n);
    let s = 0;
    for (let i = a; i < b; i++) s += V.bars[i];
    let e = Math.pow(s / (b - a), 1.3) * 1.35;
    if (k < 3) e += V.kick * 0.3;
    e = clamp(e, 0, 1);
    const el = letters[k];
    if (reduceMotion) {
      el.style.setProperty("--e", (e * 0.5).toFixed(3));
      continue;
    }
    el.style.transform = `translate3d(0, ${(-e * titleFont * 0.09).toFixed(2)}px, 0) scaleY(${(1 + e * 0.16).toFixed(3)})`;
    el.style.setProperty("--e", e.toFixed(3));
  }
}

// ------------------------------------------------------------------ the frame

let last = 0;
let scrollYNow = 0;
const heroCover = $(".js-hero-cover");
const titleEl = $(".title");
let titleRect = { top: 0, height: 0 };
const anchors = { at: -1e9, cover: { left: 0, top: 0, width: 0, height: 0 }, title: { top: 0, height: 0 } };

// Measured at most twice a second, and straight away on resize or when the hero's text
// changes; a scroll alone never needs a new measurement.
function measureAnchors(now = performance.now()) {
  const sy = window.scrollY;
  const c = heroCover.getBoundingClientRect();
  const t = titleEl.getBoundingClientRect();
  anchors.cover = { left: c.left, top: c.top + sy, width: c.width, height: c.height };
  anchors.title = { top: t.top + sy, height: t.height };
  anchors.at = now;
}
// Custom properties inherit, so setting these on the root would restyle the whole
// tracklist sixty times a second. Only the hero and the dock read them.
const beatTargets = [$(".hero"), $(".dock")];

function frame(now) {
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  const work0 = performance.now();
  V.T += dt;

  // Where the cover and the title are, from positions measured against the document and
  // the current scroll. Reading layout every frame would force a style flush after the
  // previous frame's writes, which costs Firefox several milliseconds a frame.
  scrollYNow = window.scrollY;
  if (now - anchors.at > 500) measureAnchors(now);
  heroRect = {
    left: anchors.cover.left,
    top: anchors.cover.top - scrollYNow,
    width: anchors.cover.width,
    height: anchors.cover.height,
    bottom: anchors.cover.top + anchors.cover.height - scrollYNow,
  };
  titleRect = { top: anchors.title.top - scrollYNow, height: anchors.title.height };

  analyse(dt);
  step(dt);
  draw(scrollYNow);
  driveTitle();
  const kick = V.kick.toFixed(3), bass = V.bass.toFixed(3);
  for (const el of beatTargets) {
    el.style.setProperty("--kick", kick);
    el.style.setProperty("--bass", bass);
  }
  if (S.track && !audio.paused) drawWave();

  adapt(performance.now() - work0);
  requestAnimationFrame(frame);
}

// Smooth beats sharp. If this machine cannot draw a frame well inside its budget, render
// the stage at a lower resolution rather than drop frames; the glows are soft enough not
// to show it. This measures the frame's own work, not the gap between frames: a hidden or
// occluded window is throttled to a frame a second, and that is not a slow machine.
const stats = { work: 0, frames: 0 };
function adapt(ms) {
  stats.work += (ms - stats.work) * 0.05;
  stats.frames++;
  if (stats.frames < 60) return; // the first second compiles shaders and paints covers
  V.frameTimes.push(ms);
  if (V.frameTimes.length < 90) return;
  const avg = V.frameTimes.reduce((a, b) => a + b, 0) / V.frameTimes.length;
  V.frameTimes.length = 0;
  // Two slow windows in a row to step down, three quick ones to step back up: one hiccup
  // (a tab switch, a cover being painted) should not cost the rest of the visit.
  stats.slow = avg > 9 ? (stats.slow || 0) + 1 : 0;
  stats.quick = avg < 4 ? (stats.quick || 0) + 1 : 0;
  if (stats.slow >= 2 && V.scale > 0.5) {
    V.scale = Math.max(0.5, V.scale * 0.8);
    stats.slow = 0;
    resizeStage();
  } else if (stats.quick >= 3 && V.scale < 1) {
    V.scale = Math.min(1, V.scale / 0.8);
    stats.quick = 0;
    resizeStage();
  }
  stats.last = avg;
}

if (new URLSearchParams(location.search).has("debug")) window.__ost = { S, V, stats, audio };

// ------------------------------------------------------------------ download everything

let zipping = null;

async function downloadAll(format) {
  if (zipping) {
    zipping.abort();
    return;
  }
  const btn = $(".js-download-all");
  const label = $(".pill__label", btn);
  const list = S.tracks;
  const useMp3 = format === "mp3";
  const total = list.reduce((a, t) => a + (useMp3 ? t.mp3Bytes : t.bytes), 0);
  const ctrl = new AbortController();
  zipping = ctrl;
  btn.classList.add("is-busy");
  btn.classList.remove("is-done");
  label.textContent = "Loading…";

  try {
    const { Zip, ZipPassThrough, strToU8 } = await import(FFLATE);
    const chunks = [];
    let zipErr = null;
    const zip = new Zip((err, data) => {
      if (err) zipErr = err;
      else chunks.push(data);
    });
    const dir = `${ALBUM}/`;
    const add = (name, bytes) => {
      const f = new ZipPassThrough(dir + name);
      zip.add(f);
      f.push(bytes, true);
    };
    const readme = [
      ALBUM,
      "=".repeat(ALBUM.length),
      "",
      ...list.map((t) => `${pad2(t.index)}  ${t.title.padEnd(22)} ${fmtTime(t.duration).padStart(5)}   ${t.bpm || ""} BPM   ${t.genre}`),
      "",
      "Generated locally with ACE-Step 1.5 (Apache 2.0 model weights) from text prompts.",
      "No samples, no reference audio, no third-party recordings. Each track's prompt and seed",
      "are in the liner notes folder.",
      "",
      `From ${location.origin}${location.pathname}`,
      "",
    ].join("\r\n");
    add("README.txt", strToU8(readme));
    if (S.album.canvas) add("cover.jpg", await canvasBytes(S.album.canvas));

    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      label.textContent = `Packing ${i + 1}/${list.length}`;
      const url = useMp3 ? t.mp3 : t.file;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`${t.title}: HTTP ${res.status}`);
      const f = new ZipPassThrough(`${dir}${pad2(t.index)} - ${t.title}.${useMp3 ? "mp3" : "ogg"}`);
      zip.add(f);
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          f.push(value);
          done += value.length;
          btn.style.setProperty("--p", (done / total).toFixed(4));
        }
        f.push(new Uint8Array(0), true);
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        f.push(buf, true);
        done += buf.length;
        btn.style.setProperty("--p", (done / total).toFixed(4));
      }
      add(`liner notes/${pad2(t.index)} - ${t.title}.txt`, strToU8(linerNotes(t)));
      if (t.canvas) add(`covers/${pad2(t.index)} - ${t.title}.jpg`, await canvasBytes(t.canvas));
      if (zipErr) throw zipErr;
    }
    zip.end();
    if (zipErr) throw zipErr;

    const blob = new Blob(chunks, { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shoosting-soundtrack-${useMp3 ? "mp3" : "ogg"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    btn.classList.add("is-done");
    label.textContent = "Saved";
    btn.querySelector(".pill__icon use").setAttribute("href", "#i-check");
    toast(`Zipped ${list.length} tracks, ${fmtMB(blob.size)}`);
  } catch (err) {
    if (err && err.name === "AbortError") {
      label.textContent = "Cancelled";
    } else {
      console.error(err);
      label.textContent = "Download all";
      toast("The zip could not be built - every track can still be downloaded on its own", 5000);
    }
  } finally {
    zipping = null;
    btn.classList.remove("is-busy");
    setTimeout(() => {
      if (zipping) return;
      btn.style.setProperty("--p", 0);
      label.textContent = "Download all";
      btn.classList.remove("is-done");
      btn.querySelector(".pill__icon use").setAttribute("href", "#i-download");
    }, 4000);
  }
}

function linerNotes(t) {
  return [
    `${pad2(t.index)}  ${t.title}`,
    "",
    `prompt:  ${t.prompt}`,
    `seed:    ${t.seed}`,
    `model:   ${t.model}`,
    `date:    ${t.date}`,
    `licence: ${t.licence}`,
    "",
  ].join("\r\n");
}

function canvasBytes(canvas) {
  return new Promise((resolve) =>
    canvas.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(0)), "image/jpeg", 0.92)
  );
}

function setupDownloadMenu() {
  const btn = $(".js-download-all");
  const hasMp3 = S.tracks.every((t) => t.mp3);
  const ogg = S.tracks.reduce((a, t) => a + t.bytes, 0);
  const mp3 = hasMp3 ? S.tracks.reduce((a, t) => a + t.mp3Bytes, 0) : 0;
  $(".js-total-size").textContent = hasMp3 ? `zip` : fmtMB(ogg);
  if (!hasMp3) {
    btn.addEventListener("click", () => downloadAll("ogg"));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "dl-wrap";
  btn.replaceWith(wrap);
  wrap.appendChild(btn);
  const menu = document.createElement("div");
  menu.className = "pill__menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <button type="button" role="menuitem" data-format="mp3"><b>MP3</b><small>Plays on anything. 192 kbps, tagged.</small><code>${fmtMB(mp3)}</code></button>
    <button type="button" role="menuitem" data-format="ogg"><b>OGG Vorbis</b><small>The exact files the game ships.</small><code>${fmtMB(ogg)}</code></button>`;
  wrap.appendChild(menu);
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (zipping) return downloadAll();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button").focus();
  });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-format]");
    if (!b) return;
    close();
    downloadAll(b.dataset.format);
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    }
  });
}

// ------------------------------------------------------------------ wiring

function wire() {
  $(".js-play").addEventListener("click", toggle);
  $(".js-hero-play").addEventListener("click", toggle);
  $(".js-hero-play-btn").addEventListener("click", toggle);
  $(".js-next").addEventListener("click", () => next());
  $(".js-prev").addEventListener("click", prev);
  $(".js-shuffle").addEventListener("click", () => {
    S.shuffle = !S.shuffle;
    save("shuffle", S.shuffle);
    renderToggles();
    toast(S.shuffle ? "Shuffle on - never the same track twice in a row" : "Shuffle off");
  });
  $(".js-repeat").addEventListener("click", () => {
    S.repeat = (S.repeat + 1) % 3;
    save("repeat", S.repeat);
    renderToggles();
    toast(["Repeat off", "Repeat the tracklist", "Repeat this track"][S.repeat]);
  });
  $(".js-shuffle-play").addEventListener("click", () => {
    S.shuffle = true;
    save("shuffle", true);
    renderToggles();
    cue(shufflePick(S.queue.length ? S.queue : S.tracks, S.track));
  });
  $(".js-mute").addEventListener("click", () => {
    S.muted = !S.muted;
    if (!S.muted && S.volume === 0) S.volume = 0.6;
    save("muted", S.muted);
    applyVolume();
  });
  $(".js-volume").addEventListener("input", (e) => {
    S.volume = Number(e.target.value);
    S.muted = false;
    save("volume", S.volume);
    save("muted", false);
    applyVolume();
  });

  $(".js-discs").addEventListener("click", (e) => {
    const li = e.target.closest(".track");
    if (!li) return;
    const t = S.bySlug.get(li.dataset.slug);
    if (e.target.closest(".js-more")) {
      const open = li.classList.toggle("is-open");
      e.target.closest(".js-more").setAttribute("aria-expanded", String(open));
      if (open) requestAnimationFrame(() => drawNotesWave(t, $(".notes__wave", li)));
      return;
    }
    if (e.target.closest(".js-copy")) {
      const url = `${location.origin}${location.pathname}#${t.slug}`;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => toast("Link copied"))
        .catch(() => toast(url, 5000));
      return;
    }
    if (e.target.closest(".dl")) return;
    if (e.target.closest(".track__hit")) {
      if (S.track === t) toggle();
      else cue(t);
    }
  });

  for (const b of $$(".filter")) b.addEventListener("click", () => applyFilter(b.dataset.filter));

  const wave = $(".js-wave");
  const hover = $(".js-wave-hover");
  let dragging = false;
  wave.addEventListener("pointerdown", (e) => {
    if (!S.track) return;
    dragging = true;
    wave.setPointerCapture(e.pointerId);
    seekTo(waveFrac(e) * (S.track.duration));
  });
  wave.addEventListener("pointermove", (e) => {
    const f = waveFrac(e);
    hoverFrac = f;
    const d = S.track ? S.track.duration : 0;
    hover.textContent = fmtTime(f * d);
    hover.style.left = `${f * 100}%`;
    if (dragging) seekTo(f * d);
    else drawWave();
  });
  wave.addEventListener("pointerup", () => (dragging = false));
  wave.addEventListener("pointercancel", () => (dragging = false));
  wave.addEventListener("pointerleave", () => {
    hoverFrac = -1;
    drawWave();
  });
  wave.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      seekTo(audio.currentTime + (e.key === "ArrowLeft" ? -5 : 5));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    const onControl = tag === "BUTTON" || tag === "A";
    if (e.key === " " && !onControl) {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (onControl && !e.shiftKey) return;
      e.preventDefault();
      const fwd = e.key === "ArrowRight";
      if (e.shiftKey) fwd ? next() : prev();
      else seekTo(audio.currentTime + (fwd ? 5 : -5));
    } else if (e.key === "s" || e.key === "S") $(".js-shuffle").click();
    else if (e.key === "r" || e.key === "R") $(".js-repeat").click();
    else if (e.key === "m" || e.key === "M") $(".js-mute").click();
  });

  const tilt = $(".js-tilt");
  if (!reduceMotion) {
    tilt.addEventListener("pointermove", (e) => {
      const r = tilt.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      heroCover.style.setProperty("--rx", `${(-y * 14).toFixed(2)}deg`);
      heroCover.style.setProperty("--ry", `${(x * 14).toFixed(2)}deg`);
    });
    tilt.addEventListener("pointerleave", () => {
      heroCover.style.setProperty("--rx", "0deg");
      heroCover.style.setProperty("--ry", "0deg");
    });
  }

  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") {
      V.px = e.clientX;
      V.py = e.clientY;
    }
  }, { passive: true });
  document.addEventListener("pointerleave", () => (V.px = V.py = -1));

  const topbar = $(".topbar");
  window.addEventListener("scroll", () => topbar.classList.toggle("is-scrolled", window.scrollY > 20), { passive: true });
  window.addEventListener("resize", () => {
    resizeStage();
    anchors.at = -1e9;
    drawWave();
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  buildTitle();
  resizeStage();
  wire();
  renderToggles();
  applyVolume();
  requestAnimationFrame(frame);

  let manifest;
  try {
    const res = await fetch("tracks.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    $(".js-discs").innerHTML = `<div class="empty">The soundtrack is not staged on this copy of the site.<br>Run <code>python Tools/soundtrack-site.py site/soundtrack</code> and reload.</div>`;
    $(".js-hero-title").textContent = "No tracks yet";
    return;
  }

  S.tracks = manifest.tracks.map((t, i) => ({ ...t, index: t.index || i + 1 }));
  S.bySlug = new Map(S.tracks.map((t) => [t.slug, t]));
  assignHues(S.tracks);
  for (const t of S.tracks) t.motif = (t.index * 2) % MOTIFS.length;
  S.album = {};
  S.queue = S.tracks.slice();

  const total = S.tracks.reduce((a, t) => a + t.duration, 0);
  const ogg = S.tracks.reduce((a, t) => a + t.bytes, 0);
  const mp3 = S.tracks.reduce((a, t) => a + (t.mp3Bytes || 0), 0);
  $(".js-kicker").innerHTML = `<span class="kicker__dot"></span>Original game soundtrack<span class="kicker__more"> <b>·</b> ${S.tracks.length} tracks <b>·</b> ${fmtRuntime(total)}</span>`;
  if (matchMedia("(pointer: coarse)").matches) $(".js-dock-sub").textContent = "Pick a track to start";
  $(".js-summary").textContent = `${S.tracks.length} tracks · ${fmtRuntime(total)} · ${fmtMB(ogg)} OGG${mp3 ? ` · ${fmtMB(mp3)} MP3` : ""}`;

  if (!canOgg && !S.tracks.some((t) => t.mp3)) {
    const note = document.createElement("p");
    note.className = "notice";
    note.textContent = "This browser cannot play Ogg Vorbis (Safari before version 17). Every track still downloads; to listen here, try Chrome, Firefox, Edge or a newer Safari.";
    $(".tracklist__head").after(note);
  }

  setupDownloadMenu();
  applyFilter("all");
  showAlbum();

  const fromHash = S.bySlug.get(decodeURIComponent(location.hash.slice(1)));
  if (fromHash) {
    cue(fromHash, false);
    requestAnimationFrame(() => fromHash.row && fromHash.row.scrollIntoView({ block: "center" }));
  }

  paintAll();
}

boot();
