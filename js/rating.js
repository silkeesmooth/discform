// rating.js — pure scoring. metrics + profile → scores/stamp/grade/cues.
// NO DOM, NO storage. Unit-testable in Node.
import { METRICS, GROUPS, CUES, GRADE_BANDS } from './benchmarks.js';

// Gaussian falloff: 100 at target, 50 at ±tol, → 0 beyond.
export function scoreMetric(value, { target, tol }) {
  if (value == null || !isFinite(value) || tol <= 0) return null;
  const z = (value - target) / tol;
  return Math.round(100 * Math.pow(0.5, z * z));
}

// rate(metrics, profile) →
// { perMetric: {key:{value,score,target,tol,dir}}, stamp:{PWR,SEQ,POS,REL}, overall, grade, word, cues:[] }
export function rate(metrics, profile) {
  const perMetric = {};
  const groupAcc = Object.fromEntries(GROUPS.map(g => [g, { w: 0, s: 0 }]));
  let totW = 0, totS = 0;

  for (const [key, def] of Object.entries(METRICS)) {
    const range = profile.ranges[key];
    const value = metrics[key];
    if (!range || value == null) continue;
    const score = scoreMetric(value, range);
    if (score == null) continue;
    const dir = value < range.target ? 'low' : 'high';
    perMetric[key] = { value, score, target: range.target, tol: range.tol, dir, group: def.group };
    groupAcc[def.group].w += def.weight;
    groupAcc[def.group].s += score * def.weight;
    totW += def.weight;
    totS += score * def.weight;
  }

  const stamp = {};
  for (const g of GROUPS) {
    stamp[g] = groupAcc[g].w > 0 ? Math.round(groupAcc[g].s / groupAcc[g].w) : null;
  }
  const overall = totW > 0 ? Math.round(totS / totW) : null;
  const band = overall == null ? null : GRADE_BANDS.find(b => overall >= b.min);

  // Cues: worst three metrics scoring under 70, outside the tolerance band.
  const cues = Object.entries(perMetric)
    .filter(([, m]) => m.score < 70)
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, 3)
    .map(([key, m]) => ({
      key,
      label: METRICS[key].label,
      score: m.score,
      text: (CUES[key] && CUES[key][m.dir]) || 'Off target. Compare against the reference profile.',
    }));

  return {
    perMetric,
    stamp,
    overall,
    grade: band ? band.grade : '—',
    word: band ? band.word : 'Not enough scored metrics',
    cues,
  };
}

// Build a reference profile from an analyzed throw's metrics (the
// "promote to reference" path — same shape as seeded profiles).
// Tolerances borrowed from a base profile so scoring stays comparable.
export function profileFromMetrics(metrics, baseProfile, name, hand) {
  const ranges = {};
  for (const [key, base] of Object.entries(baseProfile.ranges)) {
    if (metrics[key] != null && isFinite(metrics[key])) {
      ranges[key] = { target: metrics[key], tol: base.tol };
    }
  }
  return { id: 'ref-' + Date.now(), name, hand, approx: false, note: 'Extracted from your reference footage.', ranges };
}
