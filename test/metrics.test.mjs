// Offline verification of the pure layers. Run: node test/metrics.test.mjs
import {
  LM, mirrorFrames, lineAngleDeg, jointAngleDeg, unwrapDeg, derivative,
  findRelease, findReachback, computeMetrics, eventDeltas, pt,
} from '../js/metrics.js';
import { scoreMetric, rate, profileFromMetrics } from '../js/rating.js';
import { SEED_PROFILES, METRICS } from '../js/benchmarks.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.error('FAIL  ' + msg); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (got ${a.toFixed(3)}, want ${b}±${eps})`); }

// ---- helpers to build synthetic frames ----
function blankLm() {
  const lm = new Array(33 * 4).fill(0);
  for (let i = 0; i < 33; i++) lm[i * 4 + 3] = 1; // vis
  return lm;
}
function set(lm, idx, x, y) { lm[idx * 4] = x; lm[idx * 4 + 1] = y; }

// ---- geometry primitives ----
{
  console.log('geometry:');
  near(lineAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }), 0, 1e-9, 'horizontal line = 0°');
  near(lineAngleDeg({ x: 0, y: 0 }, { x: 0, y: 1 }), 90, 1e-9, 'downward line = 90° (y-down)');
  near(jointAngleDeg({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90, 1e-9, 'right-angle joint = 90°');
  near(jointAngleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180, 1e-9, 'straight joint = 180°');
  const uw = unwrapDeg([170, -175, -160]);
  near(uw[1], 185, 1e-9, 'unwrap crosses +180 without a jump');
  const d = derivative([0, 10, 20], [0, 1, 2]);
  near(d[1], 10, 1e-9, 'central-difference derivative');
}

// ---- mirroring invariant ----
{
  console.log('handedness mirror:');
  const lm = blankLm();
  set(lm, LM.L_WRIST, 0.2, 0.5);
  set(lm, LM.R_WRIST, 0.9, 0.5);
  const [m] = mirrorFrames([{ t: 0, lm }]);
  near(pt(m, LM.R_WRIST).x, 0.8, 1e-9, 'left wrist becomes right wrist, x flipped');
  near(pt(m, LM.L_WRIST).x, 0.1, 1e-9, 'right wrist becomes left wrist, x flipped');
}

// ---- synthetic side-view throw ----
// 30 frames @ 30fps. Wrist arcs back (frames 0..12), whips forward with peak
// speed at frame 20, decelerates. Front (left) knee ~160° at release.
function sideThrow() {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    const t = i / 30;
    const lm = blankLm();
    // torso: shoulders above hips, slight forward lean at release
    const lean = i >= 18 ? 0.04 : 0.0;
    set(lm, LM.L_SHOULDER, 0.50 + lean, 0.30); set(lm, LM.R_SHOULDER, 0.52 + lean, 0.30);
    set(lm, LM.L_HIP, 0.50, 0.55); set(lm, LM.R_HIP, 0.52, 0.55);
    // wrist path: far back at frame 10 (reachback), snaps forward, fastest 19→20
    let wx;
    if (i <= 10) wx = 0.5 - i * 0.03;            // drifting back to 0.20
    else if (i <= 18) wx = 0.20 + (i - 10) * 0.02; // slow pull to 0.36
    else if (i <= 21) wx = 0.36 + (i - 18) * 0.12; // whip: 0.36→0.72
    else wx = 0.72 + (i - 21) * 0.01;            // decel
    set(lm, LM.R_WRIST, wx, 0.35);
    set(lm, LM.R_ELBOW, (wx + 0.52 + lean) / 2, 0.33);
    // legs: left leg planted forward, ~160° knee; right trailing, bent 120°
    set(lm, LM.L_HIP, 0.50, 0.55);
    set(lm, LM.L_KNEE, 0.585, 0.72);
    set(lm, LM.L_ANKLE, 0.63, 0.90);
    set(lm, LM.R_KNEE, 0.45, 0.70); set(lm, LM.R_ANKLE, 0.38, 0.82);
    frames.push({ t, lm });
  }
  return frames;
}

{
  console.log('side-view event detection + metrics:');
  const frames = sideThrow();
  const rel = findRelease(frames);
  ok(rel.idx >= 19 && rel.idx <= 21, `release at peak wrist speed (idx ${rel.idx})`);
  const reach = findReachback(frames, rel.idx);
  ok(reach.idx >= 9 && reach.idx <= 11, `reachback at max wrist extension (idx ${reach.idx})`);

  const { metrics, events } = computeMetrics(frames, 'side');
  ok(events.releaseIdx === rel.idx, 'events wired through');
  // ground truth: L knee angle from the fixed coords
  const truthKnee = jointAngleDeg({ x: 0.50, y: 0.55 }, { x: 0.585, y: 0.72 }, { x: 0.63, y: 0.90 });
  near(metrics.braceKneeDeg, truthKnee, 0.5, 'brace knee matches hand-computed angle');
  ok(metrics.reachbackRatio > 0.5, `reachback ratio positive & scaled (${metrics.reachbackRatio.toFixed(2)})`);
  ok(metrics.postureLeanDeg > 3 && metrics.postureLeanDeg < 30, `posture lean plausible (${metrics.postureLeanDeg.toFixed(1)}°)`);
  ok(metrics.tempoMs > 200 && metrics.tempoMs < 800, `tempo in window (${metrics.tempoMs.toFixed(0)}ms)`);
  ok(metrics.xFactorDeg === undefined, 'INVARIANT: no face-view metrics from a side video');
}

// ---- synthetic x-step throw: full footwork + wrist extending far forward ----
// The wrist ends up FARTHER from the off shoulder at release (0.85 vs 0.46)
// than at the deepest reachback (0.30 vs 0.46) — the case where a naive
// max-distance reachback detector snaps to the release frame.
function xstepThrow() {
  const frames = [];
  const lerp = (t, a, b, x0, x1) => t <= a ? x0 : t >= b ? x1 : x0 + (x1 - x0) * (t - a) / (b - a);
  for (let i = 0; i <= 33; i++) {
    const t = i / 15;
    const lm = blankLm();
    set(lm, LM.L_SHOULDER, 0.46, 0.35); set(lm, LM.R_SHOULDER, 0.54, 0.35);
    set(lm, LM.L_HIP, 0.47, 0.55); set(lm, LM.R_HIP, 0.53, 0.55);
    // wrist: back to 0.30 by t=1.0, hold, then whip far forward to 0.85
    let wx;
    if (t <= 1.0) wx = 0.5 - 0.2 * t;
    else if (t <= 1.2) wx = 0.30;
    else if (t <= 1.93) wx = 0.30 + 0.55 * Math.pow((t - 1.2) / 0.73, 2);
    else wx = 0.85 + 0.01 * (t - 1.93);
    set(lm, LM.R_WRIST, wx, 0.38);
    set(lm, LM.R_ELBOW, (wx + 0.54) / 2, 0.36);
    set(lm, LM.L_WRIST, 0.40, 0.40); set(lm, LM.L_ELBOW, 0.43, 0.37);
    // footwork: trailing (R) foot swings 0.56→0.40 over t 0.30..0.75, crossing
    // the lead ankle (0.44) at t≈0.64; lead (L) foot strides 0.44→0.62 over
    // t 0.90..1.35 and plants (the brace)
    const rAnk = lerp(t, 0.30, 0.75, 0.56, 0.40);
    const lAnk = lerp(t, 0.90, 1.35, 0.44, 0.62);
    set(lm, LM.L_ANKLE, lAnk, 0.92); set(lm, LM.R_ANKLE, rAnk, 0.92);
    set(lm, LM.L_KNEE, (lAnk + 0.47) / 2, 0.75); set(lm, LM.R_KNEE, (rAnk + 0.53) / 2, 0.74);
    frames.push({ t, lm });
  }
  return frames;
}

{
  console.log('event ordering (x-step throw):');
  const { events } = computeMetrics(xstepThrow(), 'side');
  ok(events.firstStepT != null && events.plantT != null && events.braceT != null, 'all footwork events detected');
  ok(events.releaseT > 1.7, `release near the whip end (${events.releaseT?.toFixed(2)}s)`);
  ok(events.reachbackT >= 0.9 && events.reachbackT <= 1.25,
    `reachback at deepest backswing, NOT at release (${events.reachbackT?.toFixed(2)}s)`);
  near(events.plantT, 0.64, 0.2, 'x-step plant at the ankle crossing');
  near(events.firstStepT, 0.4, 0.25, 'first step at run-up start');
  ok(events.firstStepT < events.plantT, 'ORDER: first step before x-step');
  ok(events.plantT <= events.reachbackT, 'ORDER: x-step at/before reachback');
  ok(events.reachbackT <= events.braceT, 'ORDER: reachback at/before brace');
  ok(events.braceT <= events.releaseT, 'ORDER: brace at/before release');
}

// ---- wrap-around regression: release must be the HIT, not the follow-through
// The arm wraps back around the body after the disc leaves, often FASTER than
// the whip itself. A plain peak-speed release lands in that wrap-around (late,
// in the follow-through), cascading every downstream event wrong. Release must
// come from peak speed WHILE MOVING TOWARD THE TARGET.
function wrapAroundThrow() {
  const frames = [];
  for (let i = 0; i <= 25; i++) {
    const t = i / 15;
    const lm = blankLm();
    set(lm, LM.L_SHOULDER, 0.46, 0.35); set(lm, LM.R_SHOULDER, 0.54, 0.35);
    set(lm, LM.L_HIP, 0.47, 0.55); set(lm, LM.R_HIP, 0.53, 0.55);
    // reach back to 0.30 by f8, hold, ACCELERATING whip f12..19 (peak forward
    // speed at f19 = the hit), then a faster backward wrap-around f20..22.
    let wx;
    if (i <= 8) wx = 0.50 - 0.025 * i;          // 0.50 → 0.30
    else if (i <= 11) wx = 0.30;                // hold deepest
    else if (i <= 19) wx = 0.30 + 0.0086 * (i - 11) * (i - 11); // accel to ~0.85
    else if (i === 20) wx = 0.72;              // wrap begins (backward)
    else if (i === 21) wx = 0.55;              // fastest frame overall, backward
    else wx = 0.52;
    set(lm, LM.R_WRIST, wx, 0.38);
    set(lm, LM.R_ELBOW, (wx + 0.54) / 2, 0.36);
    set(lm, LM.L_WRIST, 0.40, 0.40); set(lm, LM.L_ELBOW, 0.43, 0.37);
    set(lm, LM.L_ANKLE, 0.44, 0.92); set(lm, LM.R_ANKLE, 0.56, 0.92);
    set(lm, LM.L_KNEE, 0.46, 0.75); set(lm, LM.R_KNEE, 0.54, 0.74);
    frames.push({ t, lm });
  }
  return frames;
}

{
  console.log('wrap-around release (forward-motion peak):');
  const frames = wrapAroundThrow();
  // The wrap-around (f21) is the fastest frame overall; a naive detector picks it.
  const rawSpeed = frames.map((f, i) => i ? Math.abs(f.lm[LM.R_WRIST*4] - frames[i-1].lm[LM.R_WRIST*4]) : 0);
  const naive = rawSpeed.indexOf(Math.max(...rawSpeed));
  ok(naive >= 20, `naive peak-speed would pick the wrap-around (idx ${naive})`);
  const rel = findRelease(frames);
  ok(rel.idx >= 17 && rel.idx <= 20, `release is the whip/hit, not the wrap (idx ${rel.idx})`);
  const { events } = computeMetrics(frames, 'side');
  const wristAtReach = frames[events.reachbackIdx].lm[LM.R_WRIST * 4];
  ok(wristAtReach < 0.40, `reachback wrist is BEHIND the body (x=${wristAtReach.toFixed(2)})`);
  ok(events.reachbackT < events.releaseT, 'reachback strictly before release');
}

// ---- learning: calibration nudges auto events toward the user's marks ------
{
  console.log('calibration learning:');
  const frames = xstepThrow();
  const raw = computeMetrics(frames, 'side', {}, null).events;

  // User consistently marks reachback 3 frames EARLIER than the detector.
  const target = raw.reachbackIdx - 3;
  const d = eventDeltas(frames, 'side', { reachbackIdx: target });
  ok(d.reachback < 0, `measured delta is negative — detector was late (${d.reachback.toFixed(3)})`);

  // A model built from that correction (n high → strong weight) must pull the
  // auto reachback toward the user's frame, reducing the error.
  const model = { reachback: { d: d.reachback, n: 10 } };
  const cal = computeMetrics(frames, 'side', {}, model).events;
  ok(cal.reachbackIdx < raw.reachbackIdx, `learned reachback moved earlier (${raw.reachbackIdx} → ${cal.reachbackIdx})`);
  ok(Math.abs(cal.reachbackIdx - target) < Math.abs(raw.reachbackIdx - target),
    `learned reachback is closer to the user's mark (err ${Math.abs(raw.reachbackIdx-target)} → ${Math.abs(cal.reachbackIdx-target)})`);

  // Release calibration is a frame offset.
  const dr = eventDeltas(frames, 'side', { releaseIdx: raw.releaseIdx + 2 });
  ok(dr.release === 2, `release delta is a frame offset (${dr.release})`);
  const relModel = { release: { d: 2, n: 10 } };
  const calRel = computeMetrics(frames, 'side', {}, relModel).events;
  ok(calRel.releaseIdx > raw.releaseIdx, `learned release shifted later (${raw.releaseIdx} → ${calRel.releaseIdx})`);

  // No model → identical to before (learning never regresses the default).
  const none = computeMetrics(frames, 'side', {}, null).events;
  ok(none.reachbackIdx === raw.reachbackIdx && none.releaseIdx === raw.releaseIdx, 'null calibration is a no-op');

  // A manual override still wins over any learned nudge.
  const ov = computeMetrics(frames, 'side', { reachbackIdx: raw.reachbackIdx + 1 }, model).events;
  ok(ov.reachbackIdx === raw.reachbackIdx + 1, 'manual override beats the learned nudge');
}

// ---- synthetic face-view throw: hips lead shoulders by 3 frames (100ms) ----
function faceThrow() {
  const frames = [];
  const rot = i => Math.min(1, Math.max(0, i));
  for (let i = 0; i < 30; i++) {
    const t = i / 30;
    const lm = blankLm();
    // hips rotate frames 10→16, shoulders 13→19 (3-frame lag), 60° sweep each.
    const hp = rot((i - 10) / 6) * 60 * Math.PI / 180;
    const sp = rot((i - 13) / 6) * 60 * Math.PI / 180;
    const c = { x: 0.5, y: 0.55 }, cs = { x: 0.5, y: 0.30 }, r = 0.12;
    set(lm, LM.L_HIP, c.x - r * Math.cos(hp), c.y - r * Math.sin(hp) * 0.3);
    set(lm, LM.R_HIP, c.x + r * Math.cos(hp), c.y + r * Math.sin(hp) * 0.3);
    set(lm, LM.L_SHOULDER, cs.x - r * Math.cos(sp), cs.y - r * Math.sin(sp) * 0.3);
    set(lm, LM.R_SHOULDER, cs.x + r * Math.cos(sp), cs.y + r * Math.sin(sp) * 0.3);
    // wrist: fastest at frame 20 so release lands after both rotations
    let wx = i <= 15 ? 0.75 : 0.75 - (i - 15) * (i <= 21 ? 0.06 : 0.005);
    set(lm, LM.R_WRIST, wx, 0.35);
    set(lm, LM.L_ANKLE, 0.45, 0.9); set(lm, LM.R_ANKLE, 0.55, 0.9);
    set(lm, LM.L_KNEE, 0.46, 0.72); set(lm, LM.R_KNEE, 0.54, 0.72);
    frames.push({ t, lm });
  }
  return frames;
}

{
  console.log('face-view sequencing + coil:');
  const { metrics } = computeMetrics(faceThrow(), 'face');
  ok(metrics.sequencingLagMs > 40 && metrics.sequencingLagMs < 180,
    `hips detected leading shoulders (lag ${metrics.sequencingLagMs.toFixed(0)}ms, truth ≈100ms)`);
  ok(metrics.xFactorDeg > 10, `x-factor registers separation (${metrics.xFactorDeg.toFixed(1)}°)`);
  ok(metrics.braceKneeDeg === undefined, 'INVARIANT: no side-view metrics from a face video');
}

// ---- rating layer ----
{
  console.log('rating:');
  ok(scoreMetric(50, { target: 50, tol: 15 }) === 100, 'exact target = 100');
  ok(scoreMetric(65, { target: 50, tol: 15 }) === 50, 'target+tol = 50');
  ok(scoreMetric(95, { target: 50, tol: 15 }) < 5, 'far miss ≈ 0');

  const profile = SEED_PROFILES[0];
  const perfect = {};
  for (const [k, r] of Object.entries(profile.ranges)) perfect[k] = r.target;
  const rPerfect = rate(perfect, profile);
  ok(rPerfect.overall === 100 && rPerfect.grade === 'S', 'perfect metrics → 100 / S');
  ok(rPerfect.cues.length === 0, 'no cues at 100');

  const flawed = { ...perfect, braceKneeDeg: 120, sequencingLagMs: -60 };
  const rFlawed = rate(flawed, profile);
  ok(rFlawed.overall < rPerfect.overall, 'flaws lower overall');
  ok(rFlawed.cues.some(c => c.key === 'braceKneeDeg'), 'collapsing brace produces a cue');
  const seqCue = rFlawed.cues.find(c => c.key === 'sequencingLagMs');
  ok(seqCue && seqCue.text.includes('Arm-first'), 'negative lag → arm-first cue (direction correct)');
  ok(rFlawed.stamp.POS < rPerfect.stamp.POS, 'POS stamp drops with brace flaw');

  const ref = profileFromMetrics(perfect, profile, 'My reference', 'backhand');
  ok(ref.ranges.braceKneeDeg.target === perfect.braceKneeDeg && ref.approx === false,
    'promote-to-reference builds a comparable profile');

  // Every metric key referenced by seed profiles must exist in the registry.
  for (const p of SEED_PROFILES) {
    for (const k of Object.keys(p.ranges)) ok(!!METRICS[k], `profile '${p.id}' key '${k}' registered`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
