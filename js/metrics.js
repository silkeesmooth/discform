// metrics.js — pure biomechanics. Input: landmark timeline. Output: metrics.
// NO imports, NO DOM, NO MediaPipe. Unit-testable in Node.
//
// Frame shape: { t: seconds, lm: Float32Array|Array of 33*4 [x,y,z,vis] }
// Coordinates are MediaPipe-normalized: x,y in [0,1], y grows DOWNWARD.
// INVARIANT: all math assumes a RIGHT-HANDED thrower. Call mirrorFrames()
// first for left-handers (swaps L/R landmarks and flips x).

// MediaPipe Pose landmark indices
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

const SWAP_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

export function pt(frame, idx) {
  const o = idx * 4;
  return { x: frame.lm[o], y: frame.lm[o + 1], z: frame.lm[o + 2], vis: frame.lm[o + 3] };
}

export function mirrorFrames(frames) {
  return frames.map(f => {
    const lm = Array.from(f.lm);
    for (let i = 0; i < 33; i++) lm[i * 4] = 1 - lm[i * 4]; // flip x
    for (const [a, b] of SWAP_PAIRS) {
      for (let k = 0; k < 4; k++) {
        const t = lm[a * 4 + k]; lm[a * 4 + k] = lm[b * 4 + k]; lm[b * 4 + k] = t;
      }
    }
    return { t: f.t, lm };
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const deg = r => r * 180 / Math.PI;

// Angle of the line a→b in the image plane, degrees.
export function lineAngleDeg(a, b) {
  return deg(Math.atan2(b.y - a.y, b.x - a.x));
}

// Interior angle at vertex b of a-b-c, degrees (0..180).
export function jointAngleDeg(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (m === 0) return 180;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot / m))));
}

// Unwrap an angle series so it doesn't jump across ±180.
export function unwrapDeg(series) {
  const out = [series[0]];
  for (let i = 1; i < series.length; i++) {
    let d = series[i] - series[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out.push(out[i - 1] + d);
  }
  return out;
}

// Central-difference derivative of series vs times. Ends use one-sided.
export function derivative(series, times) {
  const n = series.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    const dt = times[i1] - times[i0];
    out[i] = dt > 0 ? (series[i1] - series[i0]) / dt : 0;
  }
  return out;
}

// Simple moving-average smoother (window = odd count).
export function smooth(series, win = 3) {
  const half = Math.floor(win / 2);
  return series.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j++) { s += series[j]; c++; }
    return s / c;
  });
}

export function argmax(series, from = 0, to = series.length) {
  let bi = from, bv = -Infinity;
  for (let i = from; i < to; i++) if (series[i] > bv) { bv = series[i]; bi = i; }
  return bi;
}

// ---- Event detection -------------------------------------------------------

// Release ≈ frame of peak throwing-wrist speed WHILE MOVING TOWARD THE TARGET.
// Both hands accelerate the wrist maximally at the hit, but immediately after
// the disc leaves, the arm wraps back around the body — often faster than the
// whip itself. A plain speed peak then lands in that wrap-around (a frame or
// several late, inside the follow-through), which cascaded every downstream
// event wrong. Masking to forward (toward-target) motion drops the wrap-around
// and keeps the true release.
export function findRelease(frames) {
  const times = frames.map(f => f.t);
  const n = frames.length;
  const vx = new Array(n).fill(0), sp = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = pt(frames[i - 1], LM.R_WRIST), b = pt(frames[i], LM.R_WRIST);
    // A wrist the model can barely see, or a gap where detection dropped
    // frames, produces garbage velocity — skip those.
    if (a.vis < 0.5 || b.vis < 0.5) continue;
    const dt = frames[i].t - frames[i - 1].t;
    if (dt <= 0 || dt > 0.25) continue;
    vx[i] = (b.x - a.x) / dt;
    sp[i] = dist(a, b) / dt;
  }
  const spSm = smooth(sp, 3), vxSm = smooth(vx, 3);
  // Rough target direction from wrist POSITION vs hips at the raw speed peak
  // (robust even if that peak is the wrap-around: the hand is still on the
  // target side of the body there).
  const rawPeak = argmax(spSm);
  const wp = pt(frames[rawPeak], LM.R_WRIST);
  const hp = mid(pt(frames[rawPeak], LM.L_HIP), pt(frames[rawPeak], LM.R_HIP));
  let dir = Math.sign(wp.x - hp.x);
  if (!dir) dir = Math.sign(pt(frames[n - 1], LM.R_WRIST).x - pt(frames[0], LM.R_WRIST).x) || 1;
  // Peak speed among frames whose wrist is travelling toward the target.
  const delivery = spSm.map((s, i) => vxSm[i] * dir > 0 ? s : 0);
  let idx = argmax(delivery);
  if (delivery[idx] <= 0) idx = rawPeak; // no forward motion detected: fall back
  return { idx, t: times[idx], speedSeries: spSm };
}

// Nearest tracked-frame index to a time (local; metrics.js stays import-free).
function nearestTimeIdx(frames, t) {
  if (t <= frames[0].t) return 0;
  const hiLast = frames.length - 1;
  if (t >= frames[hiLast].t) return hiLast;
  let lo = 0, hi = hiLast;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m; else hi = m; }
  return Math.abs(frames[lo].t - t) < Math.abs(frames[hi].t - t) ? lo : hi;
}

// How much to trust a learned correction built from n samples: 0 with none,
// rising toward (capped) 0.85 so a couple of edits nudge and many edits lean in
// hard, but auto-detection is never fully overridden by the learned bias.
export function calibWeight(n) { return n > 0 ? Math.min(0.85, n / (n + 3)) : 0; }

// Throw direction: which side the target is on. +1 = +x.
// NOT derived from single-frame wrist velocity: if release detection lands a
// frame late, the wrist is already wrapping back around the body and its
// instantaneous direction is REVERSED, which flipped every direction-dependent
// event (reachback showed up in front of the target). At peak hand speed the
// wrist is extended out to the target side of the body for both backhand and
// forehand, so position relative to the hips is the robust signal; net wrist
// travel over the quarter second into release is the fallback when the wrist
// is near the body's midline.
export function throwDirAt(frames, releaseIdx) {
  const f = frames[releaseIdx];
  const w = pt(f, LM.R_WRIST);
  const hips = mid(pt(f, LM.L_HIP), pt(f, LM.R_HIP));
  const offset = w.x - hips.x;
  if (Math.abs(offset) > 0.04) return Math.sign(offset);
  let i = releaseIdx;
  while (i > 0 && f.t - frames[i - 1].t <= 0.25) i--;
  return Math.sign(w.x - pt(frames[i], LM.R_WRIST).x) || 1;
}

// Reachback = deepest point of the backswing: the frame (before release) where
// the throwing wrist is farthest BEHIND the shoulders along the throw
// direction. Raw wrist-to-off-shoulder distance is NOT enough: a wrist fully
// extended toward the target is also far from that shoulder, which used to
// drag the detected reachback up against the release on real footage.
export function findReachback(frames, releaseIdx) {
  const dir = throwDirAt(frames, releaseIdx);
  let bi = 0, bv = -Infinity;
  for (let i = 0; i <= releaseIdx; i++) {
    const w = pt(frames[i], LM.R_WRIST);
    if (w.vis < 0.5) continue;
    const sh = mid(pt(frames[i], LM.L_SHOULDER), pt(frames[i], LM.R_SHOULDER));
    const back = (sh.x - w.x) * dir;
    if (back > bv) { bv = back; bi = i; }
  }
  return { idx: bi, t: frames[bi].t, dist: dist(pt(frames[bi], LM.R_WRIST), pt(frames[bi], LM.L_SHOULDER)) };
}

// ---- Footwork events -------------------------------------------------------
// All are heuristics on 2D ankle motion. They are markers and jump points,
// not scored metrics, and every one can be corrected by hand in the UI.

// Speed series of one landmark, visibility- and gap-gated like findRelease.
function landmarkSpeeds(frames, idx) {
  return frames.map((f, i) => {
    if (i === 0) return 0;
    const a = pt(frames[i - 1], idx), b = pt(f, idx);
    if (a.vis < 0.5 || b.vis < 0.5) return 0;
    const dt = f.t - frames[i - 1].t;
    if (dt <= 0 || dt > 0.25) return 0;
    return dist(a, b) / dt;
  });
}

// First step: first sustained foot movement before endIdx (run-up start).
// Prefers movement with a component TOWARD the target; falls back to any
// sustained motion so odd camera angles still get a mark. Null for
// standstill throws, which is correct: there is no step.
export function findFirstStep(frames, endIdx, throwDir = 0) {
  const l = smooth(landmarkSpeeds(frames, LM.L_ANKLE), 3);
  const r = smooth(landmarkSpeeds(frames, LM.R_ANKLE), 3);
  const thr = 0.15; // normalized units/s; jitter of a planted foot stays well under this
  const towardTarget = i => {
    if (!throwDir) return true;
    const j = Math.min(frames.length - 1, i + 2);
    const dl = (pt(frames[j], LM.L_ANKLE).x - pt(frames[i], LM.L_ANKLE).x) * throwDir;
    const dr = (pt(frames[j], LM.R_ANKLE).x - pt(frames[i], LM.R_ANKLE).x) * throwDir;
    return dl > 0 || dr > 0;
  };
  for (const requireDir of [true, false]) {
    for (let i = 1; i < endIdx; i++) {
      if (Math.max(l[i], r[i]) > thr && Math.max(l[i + 1] ?? 0, r[i + 1] ?? 0) > thr
          && (!requireDir || towardTarget(i))) {
        return { idx: i, t: frames[i].t };
      }
    }
  }
  return null;
}

// Last "landing" of a foot before endIdx: speed falls back below thrLow after
// having exceeded thrHigh (i.e. the foot swung, then stopped = it planted).
function lastLanding(speedSm, endIdx) {
  const thrHigh = 0.25, thrLow = 0.12;
  let armed = false, last = null;
  for (let i = 1; i <= endIdx; i++) {
    if (speedSm[i] > thrHigh) armed = true;
    else if (armed && speedSm[i] < thrLow) { last = i; armed = false; }
  }
  return last;
}

// X-step plant and brace, ordered around the reachback:
//   plant  = the X-STEP itself: the last frame at/before reachback where the
//            ankles CROSS in x (feet crossing over). Falls back to the
//            trailing foot's last landing before reachback if the crossing
//            isn't visible from this angle.
//   brace  = the lead foot's last landing before release, never earlier than
//            the reachback (front foot strikes as/after the arm loads).
// Lead foot = ankle displaced toward the throw direction at release, same
// rule the brace-knee metric uses. Guarantees plant ≤ reachback ≤ brace.
export function findFootwork(frames, releaseIdx, reachbackIdx) {
  const throwDir = throwDirAt(frames, releaseIdx);
  const fRel = frames[releaseIdx];
  const hipMid = mid(pt(fRel, LM.L_HIP), pt(fRel, LM.R_HIP));
  const lLead = (pt(fRel, LM.L_ANKLE).x - hipMid.x) * throwDir;
  const rLead = (pt(fRel, LM.R_ANKLE).x - hipMid.x) * throwDir;
  const leadLm = lLead >= rLead ? LM.L_ANKLE : LM.R_ANKLE;
  const trailLm = leadLm === LM.L_ANKLE ? LM.R_ANKLE : LM.L_ANKLE;

  let braceI = lastLanding(smooth(landmarkSpeeds(frames, leadLm), 3), releaseIdx);
  if (braceI != null) braceI = Math.max(braceI, reachbackIdx);

  let plantI = null;
  for (let i = 1; i <= reachbackIdx; i++) {
    const a0 = pt(frames[i - 1], LM.L_ANKLE), b0 = pt(frames[i - 1], LM.R_ANKLE);
    const a1 = pt(frames[i], LM.L_ANKLE), b1 = pt(frames[i], LM.R_ANKLE);
    if (Math.min(a0.vis, b0.vis, a1.vis, b1.vis) < 0.5) continue;
    const d0 = a0.x - b0.x, d1 = a1.x - b1.x;
    if ((d0 > 0) !== (d1 > 0) && Math.abs(d1 - d0) > 0.003) plantI = i;
  }
  if (plantI == null) {
    plantI = lastLanding(smooth(landmarkSpeeds(frames, trailLm), 3), reachbackIdx);
  }

  return {
    brace: braceI != null ? { idx: braceI, t: frames[braceI].t } : null,
    plant: plantI != null ? { idx: plantI, t: frames[plantI].t } : null,
  };
}

// ---- Metric computation ----------------------------------------------------
// view: 'side' | 'face'. Only metrics valid for that view are returned.
// overrides: optional user-corrected event frames, any of
//   { firstStepIdx, plantIdx, reachbackIdx, braceIdx, releaseIdx }
// (detection is ±1 frame at best; let humans fix it). Overridden events are
// clamped into range and kept at/before release.
// calibration: optional per-hand learned model (see eventDeltas) that nudges
//   the AUTO-detected events toward where this user's manual corrections
//   historically land. Overridden events ignore it (the user is truth). With
//   no model, behavior is identical to before — learning never regresses the
//   default. { plant:{d,n}, reachback:{d,n}, brace:{d,n}, release:{d,n} }
//   where d is a normalized-phase delta (interior) or frame offset (release).
// Returns { metrics: {key: value}, events: {…Idx, …T, manual: {…}} }
export function computeMetrics(frames, view, overrides = {}, calibration = null) {
  if (!frames || frames.length < 8) {
    return { metrics: {}, events: {}, error: 'Too few frames with a detected body. Re-film with the full body in frame.' };
  }
  const times = frames.map(f => f.t);
  const clampIdx = i => Math.max(0, Math.min(frames.length - 1, i));
  const cal = calibration || {};

  let release;
  if (Number.isInteger(overrides.releaseIdx)) {
    const idx = clampIdx(overrides.releaseIdx);
    release = { idx, t: times[idx] };
  } else {
    let idx = findRelease(frames).idx;
    if (cal.release && cal.release.n) idx = clampIdx(Math.round(idx + calibWeight(cal.release.n) * cal.release.d));
    release = { idx, t: times[idx] };
  }

  // Normalization anchor for interior calibration: the run-up phase from first
  // step (or clip start when there's no step) to release. Anchoring on first
  // step — the most reliable event — makes the learned nudge tempo- and
  // trim-invariant. Computed once here from the auto first step.
  const dir0 = throwDirAt(frames, release.idx);
  const anchorStep = findFirstStep(frames, release.idx, dir0);
  const startT = anchorStep ? anchorStep.t : frames[0].t;
  const phase = release.t - startT;
  const nudge = (key, idx) => {
    const c = cal[key];
    if (!c || !c.n || phase <= 0) return idx;
    const frac = (frames[idx].t - startT) / phase;
    return clampIdx(nearestTimeIdx(frames, startT + (frac + calibWeight(c.n) * c.d) * phase));
  };

  let reach;
  if (Number.isInteger(overrides.reachbackIdx)) {
    const idx = Math.min(clampIdx(overrides.reachbackIdx), release.idx);
    reach = { idx, t: times[idx], dist: dist(pt(frames[idx], LM.R_WRIST), pt(frames[idx], LM.L_SHOULDER)) };
  } else {
    const idx = Math.min(nudge('reachback', findReachback(frames, release.idx).idx), release.idx);
    reach = { idx, t: times[idx], dist: dist(pt(frames[idx], LM.R_WRIST), pt(frames[idx], LM.L_SHOULDER)) };
  }

  // Footwork markers (not scored; jump points, compare trim, manual-fixable).
  // Auto detections are ORDERED by construction:
  //   first step < x-step plant ≤ reachback ≤ brace ≤ release.
  // Manual overrides are the user's call and only clamp to release.
  const footwork = findFootwork(frames, release.idx, reach.idx);
  const pickIdx = (overrideIdx, auto, key) =>
    Number.isInteger(overrideIdx) ? Math.min(clampIdx(overrideIdx), release.idx)
      : (auto ? (key ? nudge(key, auto.idx) : auto.idx) : null);
  let plantI = pickIdx(overrides.plantIdx, footwork.plant, 'plant');
  let braceI = pickIdx(overrides.braceIdx, footwork.brace, 'brace');
  const stepSearchEnd = plantI ?? reach.idx;
  let firstStepI = pickIdx(overrides.firstStepIdx, findFirstStep(frames, stepSearchEnd, dir0));

  // Re-enforce non-decreasing order after calibration nudges. Manual events
  // are floors the user set; auto events only get pushed forward to respect
  // them, never past release.
  const chain = [
    ['firstStep', firstStepI, Number.isInteger(overrides.firstStepIdx)],
    ['plant', plantI, Number.isInteger(overrides.plantIdx)],
    ['reachback', reach.idx, Number.isInteger(overrides.reachbackIdx)],
    ['brace', braceI, Number.isInteger(overrides.braceIdx)],
  ];
  let floor = -1;
  for (const link of chain) {
    if (link[1] == null) continue;
    if (!link[2] && link[1] < floor) link[1] = floor;
    floor = Math.max(floor, link[1]);
  }
  firstStepI = chain[0][1]; plantI = chain[1][1];
  if (chain[2][1] !== reach.idx) { reach.idx = chain[2][1]; reach.t = times[reach.idx]; }
  braceI = chain[3][1];

  const metrics = {};
  const events = {
    firstStepIdx: firstStepI, firstStepT: firstStepI != null ? times[firstStepI] : null,
    plantIdx: plantI, plantT: plantI != null ? times[plantI] : null,
    reachbackIdx: reach.idx, reachbackT: reach.t,
    braceIdx: braceI, braceT: braceI != null ? times[braceI] : null,
    releaseIdx: release.idx, releaseT: release.t,
    manual: {
      firstStep: Number.isInteger(overrides.firstStepIdx),
      plant: Number.isInteger(overrides.plantIdx),
      reachback: Number.isInteger(overrides.reachbackIdx),
      brace: Number.isInteger(overrides.braceIdx),
      release: Number.isInteger(overrides.releaseIdx),
    },
  };

  const shoulderAngles = unwrapDeg(frames.map(f => lineAngleDeg(pt(f, LM.L_SHOULDER), pt(f, LM.R_SHOULDER))));
  const hipAngles = unwrapDeg(frames.map(f => lineAngleDeg(pt(f, LM.L_HIP), pt(f, LM.R_HIP))));

  if (view === 'face') {
    // X-factor: max |shoulder-line − hip-line| between reachback and release.
    let xf = 0;
    for (let i = reach.idx; i <= release.idx; i++) {
      xf = Math.max(xf, Math.abs(shoulderAngles[i] - hipAngles[i]));
    }
    metrics.xFactorDeg = Math.min(xf, 120); // clamp pose-jitter blowups

    // Sequencing: t(peak |hip angular velocity|) vs t(peak |shoulder angular velocity|)
    // in the delivery window. Positive lag = hips peak first.
    const hipVel = smooth(derivative(hipAngles, times).map(Math.abs), 3);
    const shVel = smooth(derivative(shoulderAngles, times).map(Math.abs), 3);
    const from = reach.idx;
    const to = Math.min(frames.length, release.idx + 2);
    const hipPeak = argmax(hipVel, from, to);
    const shPeak = argmax(shVel, from, to);
    metrics.sequencingLagMs = (times[shPeak] - times[hipPeak]) * 1000;
  }

  if (view === 'side') {
    const shoulderWidthAtRelease = Math.max(
      dist(pt(frames[release.idx], LM.L_SHOULDER), pt(frames[release.idx], LM.R_SHOULDER)),
      // side-on shoulder width collapses; use torso length as stable scale
      dist(mid(pt(frames[release.idx], LM.L_SHOULDER), pt(frames[release.idx], LM.R_SHOULDER)),
           mid(pt(frames[release.idx], LM.L_HIP), pt(frames[release.idx], LM.R_HIP))) * 0.85
    );
    metrics.reachbackRatio = shoulderWidthAtRelease > 0 ? reach.dist / shoulderWidthAtRelease : 0;

    const fRel = frames[release.idx];
    const shMid = mid(pt(fRel, LM.L_SHOULDER), pt(fRel, LM.R_SHOULDER));
    const hipMid = mid(pt(fRel, LM.L_HIP), pt(fRel, LM.R_HIP));
    // Lean from vertical: atan2 of horizontal offset over vertical span (y grows down).
    metrics.postureLeanDeg = Math.abs(deg(Math.atan2(shMid.x - hipMid.x, hipMid.y - shMid.y)));

    // Front (braced) leg = the leg displaced toward the target, using the
    // same robust direction signal as the event detectors (throwDirAt) rather
    // than guessing from body labeling (unreliable in side view).
    const throwDir = throwDirAt(frames, release.idx);
    const lKnee = jointAngleDeg(pt(fRel, LM.L_HIP), pt(fRel, LM.L_KNEE), pt(fRel, LM.L_ANKLE));
    const rKnee = jointAngleDeg(pt(fRel, LM.R_HIP), pt(fRel, LM.R_KNEE), pt(fRel, LM.R_ANKLE));
    const lLead = (pt(fRel, LM.L_ANKLE).x - hipMid.x) * throwDir;
    const rLead = (pt(fRel, LM.R_ANKLE).x - hipMid.x) * throwDir;
    metrics.braceKneeDeg = lLead >= rLead ? lKnee : rKnee;

    metrics.elbowReleaseDeg = jointAngleDeg(pt(fRel, LM.R_SHOULDER), pt(fRel, LM.R_ELBOW), pt(fRel, LM.R_WRIST));

    // Follow-through: how long shoulder line keeps rotating (>25% of its
    // release-frame angular speed) after release.
    const shVel = smooth(derivative(shoulderAngles, times).map(Math.abs), 3);
    const thresh = Math.max(shVel[release.idx] * 0.25, 20); // deg/s floor
    let ftEnd = release.idx;
    while (ftEnd < frames.length - 1 && shVel[ftEnd + 1] > thresh) ftEnd++;
    metrics.followThroughMs = (times[ftEnd] - times[release.idx]) * 1000;

    metrics.tempoMs = (release.t - reach.t) * 1000;
  }

  return { metrics, events };
}

// ---- Learning from manual corrections --------------------------------------
// Given a throw's frames and the user's manual event indices, measure how far
// the PURE auto-detector (no overrides, no calibration) missed each corrected
// event. Interior events return a normalized-phase delta (fraction of the
// first-step→release run-up), so it transfers across throws of different tempo
// and trim; release returns a plain frame offset. app.js averages these across
// every corrected throw into the per-hand calibration model that computeMetrics
// consumes. Returns e.g. { reachback: -0.08, release: 2 } or null.
export function eventDeltas(frames, view, manualEvents) {
  if (!frames || frames.length < 8 || !manualEvents) return null;
  const raw = computeMetrics(frames, view, {}, null).events;
  if (!raw || raw.releaseIdx == null) return null;
  const startT = raw.firstStepT != null ? raw.firstStepT : frames[0].t;
  const phase = raw.releaseT - startT;
  const out = {};
  for (const key of ['plant', 'reachback', 'brace']) {
    const mi = manualEvents[key + 'Idx'];
    if (Number.isInteger(mi) && raw[key + 'T'] != null && phase > 0) {
      out[key] = (frames[mi].t - raw[key + 'T']) / phase;
    }
  }
  if (Number.isInteger(manualEvents.releaseIdx)) {
    out.release = manualEvents.releaseIdx - raw.releaseIdx;
  }
  return out;
}
