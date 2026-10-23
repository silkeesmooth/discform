// benchmarks.js — metric definitions + seeded reference profiles.
// PURE DATA. No imports. Safe to unit test in Node.
//
// HONESTY NOTE: seeded profiles are approximations assembled from public
// form-analysis commentary of Simon Lizotte (backhand) and Eagle McMahon
// (forehand). They are NOT motion-capture data. Every seeded profile is
// marked approx:true and the UI says so. You can replace them with real
// profiles extracted from footage via "Promote to reference" in the app.

// ---- Metric registry -------------------------------------------------------
// view: which camera angle makes the metric physically meaningful.
//   'side' = camera perpendicular to throw line
//   'face' = camera on the throw line (facing thrower's chest or back)
// unit is for display only. Higher `weight` = bigger share of overall score.
// group maps each metric onto one of the four "stamp" numbers:
//   PWR (power generation) | SEQ (kinetic chain timing) | POS (posture/balance) | REL (release)
// Each metric also carries teaching copy used by the Guide page and tooltips:
//   how   — how it is measured from the pose landmarks, in plain language
//   why   — why it matters for distance/accuracy (what improving it buys you)
//   drill — a concrete practice drill to move the number
export const METRICS = {
  xFactorDeg: {
    label: 'Hip-shoulder separation', unit: '°', view: 'face', group: 'PWR', weight: 1.4,
    desc: 'Max angle between shoulder line and hip line during the windup. The coil that stores power.',
    how: 'Filmed face-on, the app tracks your shoulder line and hip line every frame and takes the largest angle between them from reachback to release.',
    why: 'The gap between a closed chest and open hips is stored elastic energy, like winding a spring. More usable separation is more free distance for the same effort.',
    drill: 'Coil-and-hold reps: reach back, turn the hips toward the target while the chest stays closed a beat longer, feel the stretch across your torso, then fire. 3×10 at half power.',
  },
  sequencingLagMs: {
    label: 'Hips-lead timing', unit: 'ms', view: 'face', group: 'SEQ', weight: 1.3,
    desc: 'How long peak hip rotation speed precedes peak shoulder rotation speed. Positive = hips fire first (correct chain).',
    how: 'Face-on, the app finds the frame where your hips rotate fastest and the frame where your shoulders rotate fastest, and reports the gap. Positive means the hips peaked first.',
    why: 'Distance flows ground-up: legs → hips → chest → arm → hand. If the arm leads, you throw with a fraction of your body and hang the rest of the chain out to dry.',
    drill: 'Whip drill: start every throw by planting and opening the hips while the throwing arm stays passive and trailing. Let the arm get slung through, never pushed.',
  },
  reachbackRatio: {
    label: 'Reachback extension', unit: '× shoulder width', view: 'side', group: 'PWR', weight: 1.0,
    desc: 'Max distance from throwing wrist to off shoulder, in shoulder-widths. Long, relaxed reachback = longer power path.',
    how: 'Side-on, the app finds your deepest reachback (the frame where the wrist is farthest behind your shoulders) and measures the wrist-to-lead-shoulder distance there, divided by your torso size so it compares fairly across body types and camera distances.',
    why: 'A long, relaxed reachback lengthens the runway the disc accelerates over. More room to build speed without extra muscle.',
    drill: 'Reach to a target: set a marker behind you and touch the disc toward it every rep. Keep the arm loose. A tense, muscled reach does not count.',
  },
  postureLeanDeg: {
    label: 'Posture at release', unit: '°', view: 'side', group: 'POS', weight: 1.1,
    desc: 'Torso lean from vertical at release. Slight athletic lean is good; falling backward or hunching is not.',
    how: 'Side-on, the app measures how far your torso (the shoulders-to-hips line) tilts away from vertical at the release frame.',
    why: 'Good posture keeps the disc on the plane you aimed and your weight moving forward. Falling back flips the disc over and leaks power up and out of the shot.',
    drill: 'Nose-over-knee check: film standstills and pause at release. Your head should stack over the front knee, spine long, with a small athletic forward tilt, not leaning away from the target.',
  },
  braceKneeDeg: {
    label: 'Front-leg brace', unit: '°', view: 'side', group: 'POS', weight: 1.3,
    desc: 'Front knee angle at release. A firm, extending front leg converts run-up momentum into spin.',
    how: 'Side-on, the app measures the front-knee angle at release (180° = straight). It identifies the front leg from the direction your wrist is travelling, so it is correct for either hand.',
    why: 'The brace is the wall your momentum hits. A firm, extending front leg converts run-up speed into disc spin; a collapsing knee dumps that energy into the ground.',
    drill: 'Standstill posting: throw from a stationary stagger stance and feel the front leg firm up and straighten as you hit. If the knee caves, drop the power until it holds, then build back.',
  },
  elbowReleaseDeg: {
    label: 'Elbow at release', unit: '°', view: 'side', group: 'REL', weight: 1.0,
    desc: 'Elbow angle at the moment of release. Whip comes from late extension, not a locked arm.',
    how: 'Side-on, the app measures the shoulder-elbow-wrist angle at the release frame (180° = a fully straight arm).',
    why: 'The whip is your forearm extending late and fast. Straightening the arm early spends the whip before the hit; staying locked means it never fired at all.',
    drill: 'Towel drill: snap a folded towel at a target and feel the late forearm extension. Carry that timing into throws: extend through the hit, not before it.',
  },
  followThroughMs: {
    label: 'Follow-through', unit: 'ms', view: 'side', group: 'REL', weight: 0.7,
    desc: 'How long rotation continues after release. Cutting it short means you decelerated before the hit.',
    how: 'Side-on, the app measures how long your shoulders keep rotating after release before slowing below a quarter of their release-frame speed.',
    why: 'You cannot brake at the exact instant of release. A short follow-through means you were already decelerating before the disc left. A full finish is the fingerprint of accelerating through the hit.',
    drill: 'Let it spin you: finish every throw by letting the momentum rotate you all the way around onto the back foot. Never freeze or pose the finish.',
  },
  tempoMs: {
    label: 'Windup tempo', unit: 'ms', view: 'side', group: 'SEQ', weight: 0.6,
    desc: 'Reachback-to-release duration. Smooth and unhurried beats fast and early.',
    how: 'Side-on, the app measures the time from your deepest reachback to release.',
    why: 'A rushed windup fires the arm before the body is loaded. Smooth-then-explosive lets the stretch reflex do free work for you.',
    drill: '“One… and-two” rhythm: a slow, patient reachback (one) and a fast snap through the hit (two). Most amateurs are the opposite: fast back, decelerating through.',
  },
};

export const GROUPS = ['PWR', 'SEQ', 'POS', 'REL'];

// What each flight-stamp number rolls up. Used by the Guide and tooltips.
export const GROUP_INFO = {
  PWR: { label: 'Power', text: 'How much energy your body generates and stores before the throw: the coil and the length of your power runway.' },
  SEQ: { label: 'Sequencing', text: 'The timing of the kinetic chain: whether power flows ground-up (legs, hips, chest, arm) or leaks out early.' },
  POS: { label: 'Posture', text: 'Balance and structure through the hit: a stable, braced frame for the arm to whip against.' },
  REL: { label: 'Release', text: 'What happens as the disc leaves: the late-extension whip and following all the way through the shot.' },
};

// The two camera angles and what each can physically measure.
export const VIEW_INFO = {
  side: { label: 'Side-on', text: 'Camera perpendicular to your throw line (filming your side). Scores reachback, posture, front-leg brace, elbow at release, follow-through, and tempo.' },
  face: { label: 'Face-on / behind', text: 'Camera on your throw line (facing your chest or your back). Scores the coil (hip-shoulder separation) and hips-lead timing.' },
};

// ---- Seeded reference profiles --------------------------------------------
// target: ideal value. tol: deviation at which the metric score halves.
// Ranges are deliberately tolerant — they encode "the shape of good form",
// not one human's exact numbers.
export const SEED_PROFILES = [
  {
    id: 'seed-lizotte-bh',
    name: 'Simon Lizotte, backhand (approx.)',
    hand: 'backhand',
    approx: true,
    note: 'Approximate targets modeled on public breakdowns of Lizotte\u2019s form: huge relaxed reachback, pronounced coil, hard front-side brace, full follow-through.',
    ranges: {
      xFactorDeg:      { target: 50,  tol: 15 },
      sequencingLagMs: { target: 70,  tol: 50 },
      reachbackRatio:  { target: 1.9, tol: 0.45 },
      postureLeanDeg:  { target: 14,  tol: 10 },
      braceKneeDeg:    { target: 162, tol: 14 },
      elbowReleaseDeg: { target: 150, tol: 22 },
      followThroughMs: { target: 420, tol: 180 },
      tempoMs:         { target: 650, tol: 250 },
    },
  },
  {
    id: 'seed-mcmahon-fh',
    name: 'Eagle McMahon, forehand (approx.)',
    hand: 'forehand',
    approx: true,
    note: 'Approximate targets modeled on public breakdowns of McMahon\u2019s forehand: compact arm, elbow leading, stable wrist, strong lower-body drive with an upright finish.',
    ranges: {
      xFactorDeg:      { target: 35,  tol: 15 },
      sequencingLagMs: { target: 60,  tol: 45 },
      reachbackRatio:  { target: 1.1, tol: 0.35 }, // forehand backswing is compact
      postureLeanDeg:  { target: 10,  tol: 9 },
      braceKneeDeg:    { target: 158, tol: 15 },
      elbowReleaseDeg: { target: 125, tol: 20 },  // arm still slightly bent, extending through
      followThroughMs: { target: 300, tol: 150 },
      tempoMs:         { target: 500, tol: 220 },
    },
  },
];

// ---- "No reference" baseline ----------------------------------------------
// Always-available targets for general good form, per hand — NOT a specific
// player. Selected as "No reference" in the app so you always get feedback,
// even with zero saved profiles, and so your progress isn't tied to chasing a
// pro. Tolerances are deliberately wide: this is a training signal, not a mold.
// baseline:true marks these as built-in and undeletable.
export const BASELINE_PROFILES = {
  backhand: {
    id: '__none__', name: 'No reference (general form)', hand: 'backhand',
    approx: false, baseline: true,
    note: 'Scored against general good-form fundamentals for a backhand, not a specific player. Wide, forgiving ranges meant to flag real flaws, not nitpick.',
    ranges: {
      xFactorDeg:      { target: 45,  tol: 18 },
      sequencingLagMs: { target: 60,  tol: 55 },
      reachbackRatio:  { target: 1.7, tol: 0.5 },
      postureLeanDeg:  { target: 12,  tol: 12 },
      braceKneeDeg:    { target: 160, tol: 18 },
      elbowReleaseDeg: { target: 145, tol: 25 },
      followThroughMs: { target: 400, tol: 200 },
      tempoMs:         { target: 620, tol: 280 },
    },
  },
  forehand: {
    id: '__none__', name: 'No reference (general form)', hand: 'forehand',
    approx: false, baseline: true,
    note: 'Scored against general good-form fundamentals for a forehand, not a specific player. Wide, forgiving ranges meant to flag real flaws, not nitpick.',
    ranges: {
      xFactorDeg:      { target: 32,  tol: 16 },
      sequencingLagMs: { target: 55,  tol: 50 },
      reachbackRatio:  { target: 1.1, tol: 0.4 },
      postureLeanDeg:  { target: 9,   tol: 10 },
      braceKneeDeg:    { target: 156, tol: 18 },
      elbowReleaseDeg: { target: 125, tol: 24 },
      followThroughMs: { target: 290, tol: 170 },
      tempoMs:         { target: 490, tol: 240 },
    },
  },
};

// ---- Coaching cue library --------------------------------------------------
// Chosen when a metric scores low. {low, high} = value below/above target band.
export const CUES = {
  xFactorDeg: {
    low:  'Your shoulders and hips are turning together, so you\u2019re losing the coil. Let the hips open toward the target while the shoulders stay closed a beat longer.',
    high: 'You\u2019re over-rotating past your hips. Big coil is only useful if you can time the unwind; shorten it until the sequence is clean.',
  },
  sequencingLagMs: {
    low:  'Arm-first throw: shoulders are firing before (or with) the hips. Start the move from the ground. Plant, hips, then let the upper body get dragged through.',
    high: 'Hips fire so early the upper body disconnects. Tighten the gap so the chain stays loaded.',
  },
  reachbackRatio: {
    low:  'Reachback is short. Reach long and loose. A straight, relaxed power path is where easy distance lives.',
    high: 'You\u2019re over-reaching and likely locking the arm. Extension should feel long, not strained.',
  },
  postureLeanDeg: {
    low:  'You\u2019re standing bolt upright at release. A slight athletic lean keeps the disc on plane and your weight moving forward.',
    high: 'Excessive lean at release. You\u2019re falling out of the shot. Get the head closer to over the front knee.',
  },
  braceKneeDeg: {
    low:  'Front knee is collapsing at release. The brace is the wall that turns run-up speed into spin. Firm it up and post on that leg.',
    high: 'Front leg is locked stiff before the hit; land slightly flexed, then extend through release.',
  },
  elbowReleaseDeg: {
    low:  'Elbow is still deeply bent at release. The whip never finished. Let the forearm extend late and fast through the hit.',
    high: 'Arm is fully locked at release, which usually means it straightened early and killed the whip. Stay bent longer, extend later.',
  },
  followThroughMs: {
    low:  'You\u2019re braking immediately after release. Deceleration starts before you think it does. Let the body rotate all the way through.',
    high: 'Follow-through is fine. Extra spin adds nothing, but it is not hurting you.',
  },
  tempoMs: {
    low:  'Everything is rushed. Slow the windup; the throw only needs to be fast for the last tenth of a second.',
    high: 'Windup stalls. Long pauses leak the stretch reflex. Keep the motion continuous.',
  },
};

export const GRADE_BANDS = [
  { min: 90, grade: 'S', word: 'Tour-caliber move' },
  { min: 80, grade: 'A', word: 'Strong form' },
  { min: 68, grade: 'B', word: 'Solid, fixable gaps' },
  { min: 55, grade: 'C', word: 'Fundamentals forming' },
  { min: 0,  grade: 'D', word: 'Rebuild the base' },
];
