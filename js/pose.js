// pose.js — THE ONLY SEAM THAT TOUCHES THE NETWORK.
// Loads MediaPipe PoseLandmarker (CDN, cached by the browser after first use)
// and samples a <video> element into a landmark timeline for metrics.js.
//
// UNVERIFIED IN CI: this file could not be executed in the offline build
// sandbox. The seek loop below is written defensively against the classic
// video-seek race (issuing a new seek before 'seeked' fires); if analysis
// hangs or skips frames on your machine, this file is where to look.

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let landmarkerPromise = null;

// MediaPipe VIDEO mode keeps an internal monotonic clock on the shared
// landmarker instance, and that instance lives for the whole page session
// (see landmarkerPromise above). Timestamps must therefore increase across
// videos, not merely within one — so the clock is module-level, not a
// per-call counter. Bug this fixes: a per-call reset made the 2nd analyzed
// video start at ts~0, below the 1st video's tail, throwing
// "Packet timestamp mismatch ... expected 11933001 but received 0".
let poseClock = 0;

export function loadLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    return vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  })().catch(err => {
    landmarkerPromise = null; // allow retry
    throw new Error('Pose model failed to load. First run needs internet to fetch the model (~5 MB); after that the browser caches it. ' + err.message);
  });
  return landmarkerPromise;
}

// Race-guarded seek: resolve only when THIS seek completes.
function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Video seek failed at ' + t.toFixed(2) + 's')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = t;
  });
}

// Seek, then report the timestamp of the frame the browser ACTUALLY presented.
// video.currentTime after a seek is the time we asked for, not necessarily the
// frame shown (browsers snap to source frames) — that mismatch is why event
// timestamps could land visibly off the throw. requestVideoFrameCallback gives
// the presented frame's mediaTime; the timeout covers the already-presented
// case where rVFC never fires again, and browsers without rVFC at all.
function seekAccurate(video, t) {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return seekTo(video, t).then(() => video.currentTime);
  }
  return new Promise((resolve, reject) => {
    let settled = false, timer = null;
    const finish = tt => { if (!settled) { settled = true; clearTimeout(timer); resolve(tt); } };
    video.requestVideoFrameCallback((_, meta) => finish(meta.mediaTime));
    seekTo(video, t).then(
      () => { timer = setTimeout(() => finish(video.currentTime), 150); },
      err => { if (!settled) { settled = true; reject(err); } }
    );
  });
}

// Sample a video into frames [{t, lm: Float32Array(33*4)}].
// INVARIANT: strictly sequential — one seek in flight at a time, and
// timestamps passed to detectForVideo are strictly increasing (MediaPipe
// VIDEO mode requires monotonic timestamps).
export async function extractFrames(video, { fps = 15, onProgress } = {}) {
  const landmarker = await loadLandmarker();
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) throw new Error('Video has no readable duration.');
  if (duration > 60) throw new Error('Clip is over 60s. Trim closer to the throw for accurate event detection.');

  const step = 1 / fps;
  const frames = [];
  const base = poseClock;      // continue after every prior video on this landmarker
  let lastTs = base - 1;
  for (let t = 0; t < duration; t += step) {
    const presented = await seekAccurate(video, Math.min(t, duration - 0.001));
    // Low-fps sources sampled at 15 fps present the same frame twice; a
    // duplicate adds a zero-motion frame at a bogus timestamp — skip it.
    if (frames.length && presented <= frames[frames.length - 1].t + 1e-4) {
      if (onProgress) onProgress(Math.min(1, t / duration));
      continue;
    }
    // Strictly increasing timestamp for detectForVideo, monotonic across the
    // whole session (see poseClock note up top). The per-video offset keeps
    // real ~1/fps gaps so MediaPipe's inter-frame smoothing stays meaningful.
    let ts = base + Math.round(presented * 1000);
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    poseClock = ts + 1;
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks && res.landmarks.length > 0) {
      const lm = new Float32Array(33 * 4);
      res.landmarks[0].forEach((p, i) => {
        lm[i * 4] = p.x; lm[i * 4 + 1] = p.y; lm[i * 4 + 2] = p.z ?? 0;
        lm[i * 4 + 3] = p.visibility ?? 1;
      });
      frames.push({ t: presented, lm });
    }
    if (onProgress) onProgress(Math.min(1, t / duration));
  }
  if (onProgress) onProgress(1);
  return frames;
}

// Skeleton overlay for the review player.
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];

// rect: the region of the canvas the video pixels actually occupy (letterbox-
// aware), in canvas backing-store pixels. scale: devicePixelRatio, so stroke
// widths stay crisp and consistent on hi-dpi screens. flipX: lefty throws are
// stored mirrored for the metrics math, but the video itself isn't — un-flip
// at draw time so the skeleton lands on the body.
export function drawSkeleton(ctx, frame, rect, { color = '#4EC3F0', highlight = null, flipX = false, scale = 1 } = {}) {
  if (!frame) return;
  const X = i => rect.x + (flipX ? 1 - frame.lm[i * 4] : frame.lm[i * 4]) * rect.w;
  const Y = i => rect.y + frame.lm[i * 4 + 1] * rect.h;
  const lw = 3 * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Two passes: a dark halo underneath, then the color — keeps the skeleton
  // readable over bright grass / sky instead of washing out.
  for (const pass of [{ c: 'rgba(6,14,10,0.6)', w: lw + 2.5 * scale }, { c: color, w: lw }]) {
    ctx.strokeStyle = pass.c;
    ctx.lineWidth = pass.w;
    ctx.beginPath();
    for (const [a, b] of BONES) {
      if (frame.lm[a * 4 + 3] < 0.4 || frame.lm[b * 4 + 3] < 0.4) continue;
      ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b));
    }
    ctx.stroke();
  }
  for (let i = 11; i <= 28; i++) {
    if (frame.lm[i * 4 + 3] < 0.4) continue;
    ctx.beginPath();
    ctx.arc(X(i), Y(i), 4 * scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,14,10,0.6)'; ctx.fill();
    ctx.beginPath();
    ctx.arc(X(i), Y(i), 3 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
  if (highlight != null) {
    ctx.fillStyle = '#E15A4F';
    ctx.beginPath();
    ctx.arc(X(highlight), Y(highlight), 6 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Index of the analyzed frame nearest a video time.
export function nearestFrameIndex(frames, t) {
  if (!frames || !frames.length) return -1;
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (frames[m].t < t) lo = m; else hi = m;
  }
  return Math.abs(frames[lo].t - t) < Math.abs(frames[hi].t - t) ? lo : hi;
}

// Nearest analyzed frame to a video time (for overlay sync while scrubbing).
export function nearestFrame(frames, t) {
  const i = nearestFrameIndex(frames, t);
  return i < 0 ? null : frames[i];
}

// Pose at time t, linearly interpolated between the two neighboring analyzed
// frames. The video plays at 30–60 fps but tracking samples at ~15, so the
// nearest-frame overlay visibly jumped/lagged — interpolation keeps the
// skeleton glued to the body. Across detection gaps (>0.3 s) we don't invent
// poses; fall back to the nearest real frame.
export function interpFrame(frames, t) {
  if (!frames || !frames.length) return null;
  if (t <= frames[0].t) return frames[0];
  if (t >= frames[frames.length - 1].t) return frames[frames.length - 1];
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (frames[m].t <= t) lo = m; else hi = m;
  }
  const a = frames[lo], b = frames[hi];
  const span = b.t - a.t;
  if (span <= 0) return a;
  if (span > 0.3) return (t - a.t < b.t - t) ? a : b;
  const u = (t - a.t) / span;
  const lm = new Float32Array(33 * 4);
  for (let i = 0; i < 33 * 4; i += 4) {
    lm[i] = a.lm[i] + (b.lm[i] - a.lm[i]) * u;
    lm[i + 1] = a.lm[i + 1] + (b.lm[i + 1] - a.lm[i + 1]) * u;
    lm[i + 2] = a.lm[i + 2] + (b.lm[i + 2] - a.lm[i + 2]) * u;
    lm[i + 3] = Math.min(a.lm[i + 3], b.lm[i + 3]);
  }
  return { t, lm };
}
