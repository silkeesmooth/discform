// app.js — UI only. All analysis math lives in metrics.js / rating.js.
import * as db from './db.js';
import { METRICS, GROUPS, GROUP_INFO, VIEW_INFO, GRADE_BANDS, BASELINE_PROFILES } from './benchmarks.js';
import { computeMetrics, mirrorFrames, eventDeltas } from './metrics.js';
import { rate, profileFromMetrics } from './rating.js';
import { extractFrames, drawSkeleton, nearestFrameIndex, interpFrame } from './pose.js';

const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const scoreColor = s => s >= 80 ? 'var(--good)' : s >= 55 ? 'var(--mid)' : 'var(--bad)';

// "No reference" sentinel: score against the built-in general-form baseline
// instead of a pro/custom profile. resolveProfile always returns something
// scoreable, so feedback works even with zero saved profiles or a deleted ref.
const NO_REF = '__none__';
function resolveProfile(id, hand, profiles) {
  if (id && id !== NO_REF) {
    const p = profiles.find(x => x.id === id);
    if (p) return p;
  }
  return BASELINE_PROFILES[hand];
}

let objectUrls = [];
function freeUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
function blobUrl(blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; }

// Per-page cleanup for listeners that outlive the view's DOM (window/document
// level, rAF loops). Views register with onTeardown; runTeardown fires on
// every route change AND at the top of views that re-render themselves.
let pageTeardown = [];
const onTeardown = fn => pageTeardown.push(fn);
function runTeardown() { pageTeardown.forEach(fn => { try { fn(); } catch { /* already gone */ } }); pageTeardown = []; }

// ---------- tooltips ----------
// Any element with data-tip gets a rich, positioned tooltip on hover, keyboard
// focus, or tap. data-tip-title is an optional bold heading; the body supports
// newlines, and lines shaped "Label · text" render the label in the accent.
const tipEl = (() => {
  const el = document.createElement('div');
  el.className = 'tooltip'; el.setAttribute('role', 'tooltip'); el.hidden = true;
  document.body.appendChild(el);
  return el;
})();
let tipAnchor = null;

function buildTipBody(text) {
  return text.split('\n').map(line => {
    const i = line.indexOf(' · ');
    if (i > 0 && i < 22) return `<span class="tl"><b>${esc(line.slice(0, i))}</b>${esc(line.slice(i + 3))}</span>`;
    return `<span class="tl">${esc(line)}</span>`;
  }).join('');
}
function showTip(target) {
  const body = target.getAttribute('data-tip');
  if (!body) return;
  const title = target.getAttribute('data-tip-title');
  tipEl.innerHTML = (title ? `<span class="tt-title">${esc(title)}</span>` : '') + buildTipBody(body);
  tipEl.hidden = false;
  tipAnchor = target;
  positionTip(target);
}
function positionTip(target) {
  const r = target.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  const margin = 8;
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(margin, Math.min(left, innerWidth - tr.width - margin));
  let top = r.top - tr.height - 10;
  let place = 'top';
  if (top < margin) { top = r.bottom + 10; place = 'bottom'; }
  tipEl.style.left = `${left + scrollX}px`;
  tipEl.style.top = `${top + scrollY}px`;
  tipEl.dataset.place = place;
  const arrow = Math.max(14, Math.min(r.left + r.width / 2 - left, tr.width - 14));
  tipEl.style.setProperty('--arrow', `${arrow}px`);
}
function hideTip() { tipEl.hidden = true; tipAnchor = null; }

document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (t && t !== tipAnchor) showTip(t);
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('[data-tip]');
  if (t && t === tipAnchor && !t.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', e => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t);
});
document.addEventListener('focusout', e => {
  if (e.target.closest('[data-tip]') === tipAnchor) hideTip();
});
// Tap-to-toggle for touch / mouse click on the info affordance.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) { if (tipAnchor) hideTip(); return; }
  if (t === tipAnchor) hideTip(); else showTip(t);
});
addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', () => { if (tipAnchor) positionTip(tipAnchor); }, true);
addEventListener('resize', hideTip);

// A small ⓘ affordance that carries a tooltip. `extra` lets callers add classes.
function infoDot(title, body, extra = '') {
  return `<span class="infodot ${extra}" tabindex="0" role="button" aria-label="${esc(title)} details"
    data-tip-title="${esc(title)}" data-tip="${esc(body)}">i</span>`;
}
// The canonical teaching blurb for a metric, reused by table, guide, and cues.
function metricTip(key) {
  const d = METRICS[key];
  return `${d.desc}\nHow · ${d.how}\nWhy · ${d.why}\nDrill · ${d.drill}`;
}

// ---------- shared renderers ----------
function stampHtml(rating, small = false) {
  if (!rating || rating.overall == null) {
    return `<div class="stamp ${small ? 'small' : ''}" title="Not analyzed"><span class="overall muted">·</span></div>`;
  }
  return `<div class="stamp ${small ? 'small' : ''}" title="${esc(rating.word)}">
    <span class="grade">${esc(rating.grade)}</span>
    <span class="overall">${rating.overall}</span>
  </div>`;
}
function flightNumsHtml(stamp) {
  return `<div class="flightnums">${GROUPS.map(g => {
    const gi = GROUP_INFO[g];
    const val = stamp[g];
    const tip = `${gi.text}\n${val == null ? 'Not measurable from this camera angle.' : 'Score ' + val + ' / 100.'}`;
    return `<div class="fn" tabindex="0" data-tip-title="${g} · ${esc(gi.label)}" data-tip="${esc(tip)}">
      <b style="color:${val == null ? 'var(--sage)' : scoreColor(val)}">${val ?? '–'}</b><span>${g}</span></div>`;
  }).join('')}</div>`;
}

// ---------- router ----------
async function route() {
  freeUrls();
  hideTip();
  runTeardown();
  const hash = location.hash || '#/library';
  const [, page, arg, arg2] = hash.split('/');
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.tab === (page === 'throw' ? 'library' : page)));
  try {
    if (page === 'library') await renderLibrary();
    else if (page === 'throw') await renderThrow(arg);
    else if (page === 'compare') await renderCompare(arg, arg2);
    else if (page === 'progress') await renderProgress();
    else if (page === 'guide') await renderGuide(arg);
    else if (page === 'settings') await renderSettings();
    else location.hash = '#/library';
  } catch (err) {
    view.innerHTML = `<div class="notice warn"><b>Something broke rendering this page.</b><br>${esc(err.message)}</div>`;
    console.error(err);
  }
}
window.addEventListener('hashchange', route);

// ---------- library ----------
async function renderLibrary() {
  const [throws, analyses, profiles] = await Promise.all([db.listThrows(), db.listAnalyses(), db.listProfiles()]);
  const aMap = new Map(analyses.map(a => [a.throwId, a]));
  throws.sort((a, b) => b.createdAt - a.createdAt);

  let cards = '';
  for (const t of throws) {
    const an = aMap.get(t.id);
    let rating = null;
    if (an) rating = rate(an.metrics, resolveProfile(an.ratedAgainst, t.hand, profiles));
    const thumbStyle = t.thumb ? `style="background-image:url(${blobUrl(t.thumb)})"` : '';
    cards += `<button class="throw-card" data-id="${t.id}">
      <span class="thumb" ${thumbStyle}><span class="tag">${t.hand === 'backhand' ? 'BH' : 'FH'} · ${t.view === 'side' ? 'side' : 'face'}</span></span>
      <span class="meta">
        <span><span class="name">${esc(t.label || 'Untitled throw')}</span><br>
        <span class="date muted mono">${fmtDate(t.createdAt)}${t.outcome?.dist ? ` · ${t.outcome.dist} ft` : ''}</span></span>
        ${stampHtml(rating, true)}
      </span>
    </button>`;
  }

  view.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:18px">
      <h1>Library</h1>
      <button class="btn" id="addThrow">+ Upload throw</button>
    </div>
    ${throws.length ? `<div class="grid">${cards}</div>` : `
      <div class="empty">
        <div class="disc-art">🥏</div>
        <h2>No throws on record</h2>
        <p>Film a throw and upload it here. Full body in frame, phone steady.<br>
        Trim close to the throw. Clips up to 60 seconds work.</p>
        <button class="btn" id="addThrowEmpty">Upload your first throw</button>
      </div>`}
  `;
  const openPicker = () => $('#filePicker').click();
  $('#addThrow')?.addEventListener('click', openPicker);
  $('#addThrowEmpty')?.addEventListener('click', openPicker);
  view.querySelectorAll('.throw-card').forEach(c =>
    c.addEventListener('click', () => location.hash = '#/throw/' + c.dataset.id));
}

// ---------- upload flow ----------
function segValue(id) { return $(id).querySelector('.on').dataset.v; }
document.addEventListener('click', e => {
  const seg = e.target.closest('.seg');
  if (seg && e.target.matches('button[data-v]')) {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target));
  }
});

$('#filePicker').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) { alert('Video is over 200 MB. Trim the clip first.'); return; }
  const dlg = $('#uploadDialog');
  dlg.returnValue = '';
  dlg.showModal();
  $('#upCancel').onclick = () => dlg.close('cancel');
  $('#uploadForm').onsubmit = async ev => {
    ev.preventDefault();
    const settings = db.getSettings();
    const thumb = await makeThumb(file).catch(() => null);
    const rec = {
      id: 'thr-' + Date.now(),
      createdAt: Date.now(),
      label: $('#upLabel').value.trim(),
      hand: segValue('#upHand'),
      view: segValue('#upView'),
      handedness: settings.handedness,
      outcome: { dist: $('#upDist').value ? Number($('#upDist').value) : null },
      videoBlob: file,
      thumb,
    };
    await db.saveThrow(rec);
    dlg.close('saved');
    location.hash = '#/throw/' + rec.id; // hashchange listener renders the view
  };
});

function makeThumb(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = () => { v.currentTime = Math.min(v.duration * 0.4, v.duration - 0.05); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const scale = 360 / v.videoWidth;
      c.width = 360; c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(v.src); b ? resolve(b) : reject(new Error('thumb failed')); }, 'image/jpeg', 0.7);
    };
    v.onerror = () => { URL.revokeObjectURL(v.src); reject(new Error('Could not read video')); };
  });
}

// ---------- video player plumbing (shared: throw view + compare) ----------
const ANALYSIS_FPS = 15;
const FRAME_STEP = 1 / ANALYSIS_FPS;
const fmtT = s => `${(s ?? 0).toFixed(2)}s`;

// The five throw events, in throw order. key maps to events[key+'T'] /
// events[key+'Idx'] and overrides[key+'Idx'] in metrics.js.
const EVENT_DEFS = [
  ['firstStep', 'First step'],
  ['plant', 'X-step plant'],
  ['reachback', 'Reachback'],
  ['brace', 'Brace'],
  ['release', 'Release'],
];

// Event-detection generation. Bump when detector semantics change so
// analyses saved by older versions get their events recomputed from the
// stored frames (cheap, pure math, no pose re-extraction), preserving any
// manual marks. v2: ordered chain, backward-extension reachback, crossing
// x-step. v3: position-based throw direction. v4: forward-speed release
// (excludes wrap-around) + learned calibration applied to auto events.
const EVENTS_VER = 4;

// Per-hand learned calibration (see metrics.eventDeltas). Cached in memory;
// db is the source of truth. `stamp` marks the model version so a throw whose
// auto events predate the current model knows to recompute.
const calibFor = hand => db.getCalibration()?.[hand] || null;
const calibStamp = () => db.getCalibration()?.stamp || 0;

// Rebuild the calibration model from EVERY manual correction the user has made
// across all throws. Deterministic (plain mean, order-independent) so running
// it repeatedly is stable and never double-counts. Only writes (bumping the
// stamp) when the numbers actually change, to avoid needless re-derivation.
// Returns true if the model changed.
async function trainCalibration() {
  const [throws, analyses] = await Promise.all([db.listThrows(), db.listAnalyses()]);
  const tMap = new Map(throws.map(t => [t.id, t]));
  const acc = { backhand: {}, forehand: {} };
  for (const a of analyses) {
    const t = tMap.get(a.throwId);
    if (!t || !a.manualEvents) continue;
    const d = eventDeltas(a.frames, t.view, a.manualEvents);
    if (!d) continue;
    for (const key of Object.keys(d)) {
      const slot = (acc[t.hand][key] ||= { sum: 0, n: 0 });
      slot.sum += d[key]; slot.n++;
    }
  }
  const model = { backhand: {}, forehand: {} };
  for (const hand of ['backhand', 'forehand']) {
    for (const key of Object.keys(acc[hand])) {
      const s = acc[hand][key];
      model[hand][key] = { d: s.sum / s.n, n: s.n };
    }
  }
  const prev = db.getCalibration();
  if (sameCalibration(prev, model)) return false;
  model.stamp = Date.now();
  db.saveCalibration(model);
  return true;
}

function sameCalibration(a, b) {
  if (!a) return false;
  for (const hand of ['backhand', 'forehand']) {
    const ka = Object.keys(a[hand] || {}), kb = Object.keys(b[hand] || {});
    if (ka.length !== kb.length) return false;
    for (const key of kb) {
      const x = a[hand]?.[key], y = b[hand][key];
      if (!x || x.n !== y.n || Math.abs(x.d - y.d) > 1e-6) return false;
    }
  }
  return true;
}

// Count corrections the model was trained on, for the Settings status line.
function calibrationSummary() {
  const c = db.getCalibration();
  const out = { backhand: 0, forehand: 0 };
  if (!c) return out;
  for (const hand of ['backhand', 'forehand']) {
    out[hand] = Math.max(0, ...Object.values(c[hand] || {}).map(v => v.n), 0);
  }
  return out;
}

async function upgradeAnalysis(t, analysis) {
  if (!analysis) return analysis;
  const stamp = calibStamp();
  if (analysis.eventsVer === EVENTS_VER && analysis.calibStamp === stamp) return analysis;
  const { metrics, events, error } = computeMetrics(analysis.frames, t.view, analysis.manualEvents || {}, calibFor(t.hand));
  if (error) return analysis;
  analysis.metrics = metrics;
  analysis.events = events;
  analysis.eventsVer = EVENTS_VER;
  analysis.calibStamp = stamp;
  await db.saveAnalysis(analysis);
  return analysis;
}

// Paint the skeleton into the region the video pixels actually occupy
// (letterbox-aware), at devicePixelRatio, interpolating between tracked
// frames so the overlay stays glued to the body between 15 fps samples.
//
// Frame accuracy: while playing, vid.currentTime is the playback CLOCK and
// runs slightly ahead of the frame actually on screen. The skeleton must be
// drawn at the presented frame's mediaTime (from requestVideoFrameCallback),
// and event-driven repaints must not interleave clock-timed paints with it.
function attachOverlay(vid, overlay, getFrames, { flipX = false, color = '#4EC3F0', onFrame = null } = {}) {
  const hasRVFC = typeof vid.requestVideoFrameCallback === 'function';
  function paint(atT) {
    if (!vid.videoWidth || !vid.clientWidth) return;
    const dpr = devicePixelRatio || 1;
    const W = Math.round(vid.clientWidth * dpr), H = Math.round(vid.clientHeight * dpr);
    if (overlay.width !== W) overlay.width = W;
    if (overlay.height !== H) overlay.height = H;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (onFrame) onFrame();
    const frames = getFrames();
    if (!frames) return;
    const s = Math.min(W / vid.videoWidth, H / vid.videoHeight);
    const rect = { x: (W - vid.videoWidth * s) / 2, y: (H - vid.videoHeight * s) / 2, w: vid.videoWidth * s, h: vid.videoHeight * s };
    drawSkeleton(ctx, interpFrame(frames, atT ?? vid.currentTime), rect, { flipX, color, scale: dpr });
  }
  let playing = false;
  const loop = (_now, meta) => {
    if (!playing) return;
    paint(meta ? meta.mediaTime : undefined);
    if (hasRVFC) vid.requestVideoFrameCallback(loop);
    else requestAnimationFrame(() => loop());
  };
  const startLoop = () => {
    if (hasRVFC) vid.requestVideoFrameCallback(loop);
    else requestAnimationFrame(() => loop());
  };
  // After a paused seek, repaint immediately, then refine to the exact
  // presented frame once the browser reports it.
  const paintPresented = () => {
    paint();
    if (hasRVFC) vid.requestVideoFrameCallback((_n, meta) => { if (!playing) paint(meta.mediaTime); });
  };
  vid.addEventListener('play', () => { playing = true; startLoop(); });
  vid.addEventListener('pause', () => { playing = false; paintPresented(); });
  vid.addEventListener('ended', () => { playing = false; paintPresented(); });
  vid.addEventListener('seeked', () => { if (!playing) paintPresented(); });
  ['loadeddata', 'timeupdate'].forEach(ev => vid.addEventListener(ev, () => { if (!playing) paint(); }));
  const onResize = () => { if (!playing) paint(); };
  addEventListener('resize', onResize);
  onTeardown(() => { playing = false; removeEventListener('resize', onResize); });
  return paint;
}

// Some recordings (notably MediaRecorder/screen-capture webm) report
// duration = Infinity until the browser is forced to the end of the stream —
// and some never report it at all. Try the force-to-end trick once, and let
// callers fall back to the tracked-frame timeline via effDuration.
function ensureDuration(v) {
  if (isFinite(v.duration) && v.duration > 0) return Promise.resolve();
  return new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); v.currentTime = 0; res(); };
    v.addEventListener('seeked', done);
    v.currentTime = 1e7;
  });
}
// Usable duration even when the container lies: fall back to the end of the
// pose-tracked timeline, then to whatever the browser has buffered.
function effDuration(v, frames) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  if (frames?.length) return frames[frames.length - 1].t + FRAME_STEP;
  try { if (v.buffered.length) return v.buffered.end(v.buffered.length - 1); } catch { /* no buffer yet */ }
  return 0;
}

function stepBy(vid, dir, frames) {
  vid.pause();
  const d = effDuration(vid, frames);
  if (!d) return;
  vid.currentTime = Math.max(0, Math.min(d - 0.001, vid.currentTime + dir * FRAME_STEP));
}

const speedSegHtml = id => `<div class="seg speed" id="${id}" role="radiogroup" aria-label="Playback speed">
  <button type="button" data-v="0.25" title="Quarter speed">¼×</button>
  <button type="button" data-v="0.5" title="Half speed">½×</button>
  <button type="button" data-v="1" class="on" title="Full speed">1×</button>
</div>`;
function wireSpeed(segEl, vids) {
  segEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) vids.forEach(v => { v.playbackRate = Number(b.dataset.v); });
  });
}

// Click / drag scrubbing on a .timeline element → onFrac(0..1).
function wireTimeline(el, onFrac) {
  let down = false;
  const frac = e => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', e => {
    down = true;
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    onFrac(frac(e));
  });
  el.addEventListener('pointermove', e => { if (down) onFrac(frac(e)); });
  el.addEventListener('pointerup', () => { down = false; });
  el.addEventListener('pointercancel', () => { down = false; });
}

// Space = play/pause, ←/→ = frame step. Skipped while a control has focus.
function wireKeys({ toggle, step }) {
  const onKey = e => {
    if (e.target.closest('button, a, input, select, textarea, [tabindex]')) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  };
  document.addEventListener('keydown', onKey);
  onTeardown(() => document.removeEventListener('keydown', onKey));
}

const playerControlsHtml = () => `
  <button class="pbtn" id="playBtn" title="Play / pause (space)">▶</button>
  <button class="pbtn" id="stepBack" title="One frame back (←)">‹</button>
  <button class="pbtn" id="stepFwd" title="One frame forward (→)">›</button>
  ${speedSegHtml('speedSeg')}`;

const timelineHtml = () => `<div class="timeline" id="tl">
  <div class="track"></div><i class="fill" id="tlFill"></i><div id="tlMarks"></div>
</div>`;

// ---------- throw detail ----------
async function renderThrow(id) {
  runTeardown(); // this view re-renders itself in place (promote/delete-ref)
  const t = await db.getThrow(id);
  if (!t) { view.innerHTML = `<div class="notice warn">Throw not found. It may have been deleted.</div>`; return; }
  let analysis = await upgradeAnalysis(t, await db.getAnalysis(id));
  const profiles = (await db.listProfiles()).filter(p => p.hand === t.hand);
  let profileId = analysis?.ratedAgainst || NO_REF;

  view.innerHTML = `
    <a href="#/library" class="mono muted" style="text-decoration:none;font-size:12px">← Library</a>
    <div class="row" style="align-items:baseline;justify-content:space-between;margin:6px 0 16px">
      <div>
        <div class="titlerow" id="titleWrap"></div>
        <span class="mono muted" style="font-size:12px">
          ${t.hand.toUpperCase()} · ${t.view === 'side' ? 'SIDE-ON' : 'FACE-ON'} · ${t.handedness === 'L' ? 'LEFTY' : 'RIGHTY'} · ${fmtDate(t.createdAt)}
          ${t.outcome?.dist ? ` · ${t.outcome.dist} FT` : ''}
        </span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:nowrap">
        <a class="btn ghost" href="#/compare/${t.id}" style="text-decoration:none">⇄ Compare</a>
        <button class="btn danger" id="delThrow">Delete</button>
      </div>
    </div>`;

  // Inline rename: click the title (or the ✎) to edit the throw's name in
  // place; Enter or Save persists, Escape or Cancel reverts. Library, meta line
  // and Compare captions all read the label from the DB, so they update too.
  function renderTitle() {
    $('#titleWrap').innerHTML = `
      <h1 id="throwTitle" title="Click to rename">${esc(t.label || 'Untitled throw')}</h1>
      <button class="iconbtn" id="renameThrow" title="Rename throw" aria-label="Rename throw">✎</button>`;
    $('#renameThrow').onclick = startRename;
    $('#throwTitle').onclick = startRename;
  }
  function startRename() {
    $('#titleWrap').innerHTML = `
      <input id="titleInput" class="title-input" maxlength="60" placeholder="Untitled throw">
      <button class="btn" id="titleSave">Save</button>
      <button class="btn ghost" id="titleCancel">Cancel</button>`;
    const inp = $('#titleInput');
    inp.value = t.label || '';
    inp.focus(); inp.select();
    const done = async save => {
      if (save) { t.label = inp.value.trim(); await db.saveThrow(t); }
      renderTitle();
    };
    $('#titleSave').onclick = () => done(true);
    $('#titleCancel').onclick = () => done(false);
    inp.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
  }
  renderTitle();

  view.insertAdjacentHTML('beforeend', `
    <div class="row throwrow">
      <div class="vidcol">
        <div class="player">
          <video id="vid" playsinline></video>
          <canvas class="overlay" id="overlay"></canvas>
        </div>
        ${timelineHtml()}
        <div class="pcontrols">
          ${playerControlsHtml()}
          <span class="mono muted tcur" id="timeLabel"></span>
        </div>
        <div class="events" id="events"></div>
        <p class="muted evhint" id="evHint"></p>
      </div>
      <div class="grow respane" id="resultPane"></div>
    </div>
  `);
  $('#delThrow').onclick = async () => {
    if (confirm('Delete this throw and its analysis? The video will be removed from local storage.')) {
      await db.deleteThrow(id);
      location.hash = '#/library';
    }
  };

  const vid = $('#vid');
  const overlay = $('#overlay');
  vid.src = blobUrl(t.videoBlob);
  const flipX = t.handedness === 'L';

  const tlFill = $('#tlFill'), timeLabel = $('#timeLabel');
  const dur = () => effDuration(vid, analysis?.frames);
  const updateTl = () => {
    const d = dur();
    if (!d) return;
    tlFill.style.width = `${Math.min(100, (vid.currentTime / d) * 100)}%`;
    timeLabel.textContent = `${fmtT(vid.currentTime)} / ${fmtT(d)}`;
  };
  const paint = attachOverlay(vid, overlay, () => analysis?.frames, { flipX, onFrame: updateTl });

  const playBtn = $('#playBtn');
  const togglePlay = () => { vid.paused ? vid.play() : vid.pause(); };
  playBtn.onclick = togglePlay;
  vid.addEventListener('click', togglePlay);
  vid.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
  vid.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  $('#stepBack').onclick = () => stepBy(vid, -1, analysis?.frames);
  $('#stepFwd').onclick = () => stepBy(vid, 1, analysis?.frames);
  wireSpeed($('#speedSeg'), [vid]);
  wireKeys({ toggle: togglePlay, step: d => stepBy(vid, d, analysis?.frames) });
  wireTimeline($('#tl'), frac => {
    vid.pause();
    const d = dur();
    if (d) vid.currentTime = frac * d;
  });
  vid.addEventListener('loadedmetadata', async () => { await ensureDuration(vid); updateTl(); renderMarks(); });

  // Event markers on the timeline (auto-detected or user-corrected).
  function renderMarks() {
    const box = $('#tlMarks');
    if (!box) return;
    box.innerHTML = '';
    const ev = analysis?.events;
    const d = dur();
    if (!ev || !d) return;
    box.innerHTML = EVENT_DEFS
      .map(([key, label]) => [key, ev[key + 'T'], label])
      .filter(([, tt]) => tt != null)
      .map(([key, tt, label]) => `<span class="mark ${key}" style="left:${((tt / d) * 100).toFixed(2)}%"
        data-tip-title="${label}" data-tip="${fmtT(tt)} · ${ev.manual?.[key] ? 'set by you' : 'auto-detected'}"></span>`).join('');
  }

  // Event chips + mark-here correction controls under the video.
  function renderEventUI() {
    const box = $('#events'), hint = $('#evHint');
    box.innerHTML = '';
    hint.textContent = '';
    if (!analysis) return;
    const ev = analysis.events || {};
    const chips = EVENT_DEFS
      .map(([key, label]) => [key, ev[key + 'T'], label])
      .filter(([, tt]) => tt != null)
      .map(([key, tt, label]) => `<button class="evchip mark-${key}" data-t="${tt}">${label} · ${fmtT(tt)}${ev.manual?.[key] ? ' <i>manual</i>' : ''}</button>`)
      .join('');
    box.innerHTML = `
      ${chips}
      <span class="evsep" aria-hidden="true"></span>
      <select id="markSel" class="marksel" title="Event to mark">
        ${EVENT_DEFS.map(([key, label]) => `<option value="${key}" ${key === 'release' ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <button class="evmark" id="markBtn" title="Move the selected event to the current frame">Mark at this frame</button>
      ${analysis.manualEvents ? `<button class="evmark" id="resetEv" title="Discard manual marks and re-detect all events">↺ Re-detect</button>` : ''}
    `;
    hint.innerHTML = `Marker on the wrong frame? Step to the right one, pick the event, click Mark. Scores update instantly.`;
    box.querySelectorAll('.evchip').forEach(b => {
      b.onclick = () => { vid.pause(); vid.currentTime = Number(b.dataset.t); };
    });
    $('#markBtn').onclick = () => {
      const key = $('#markSel').value;
      applyOverrides({ ...(analysis.manualEvents || {}), [key + 'Idx']: nearestFrameIndex(analysis.frames, vid.currentTime) });
    };
    const r = $('#resetEv');
    if (r) r.onclick = () => applyOverrides(null);
  }

  // Recompute metrics with user-corrected (or reset) event frames, persist,
  // then LEARN: retrain the per-hand model from every correction (including
  // this one) and re-derive so the other auto events shift toward where this
  // user's marks land. Manual events always win over the learned nudge.
  async function applyOverrides(overrides) {
    analysis.manualEvents = overrides;
    await saveDerived(overrides);
    await trainCalibration();
    await saveDerived(overrides); // re-derive with the freshly learned model
    renderEventUI(); renderMarks(); renderPane();
  }
  async function saveDerived(overrides) {
    const { metrics, events, error } = computeMetrics(analysis.frames, t.view, overrides || {}, calibFor(t.hand));
    if (error) { alert(error); return; }
    analysis.metrics = metrics;
    analysis.events = events;
    analysis.eventsVer = EVENTS_VER;
    analysis.calibStamp = calibStamp();
    await db.saveAnalysis(analysis);
  }

  function renderPane() {
    const pane = $('#resultPane');

    if (!analysis) {
      pane.innerHTML = `
        <div class="card">
          <h2>Not analyzed yet</h2>
          <p class="muted" style="font-size:13px">
            Pose tracking runs in this browser. Your video never leaves this machine.
          </p>
          <details class="more">
            <summary>More</summary>
            <p>The first run downloads the pose model (about 5 MB), then the browser caches it.
            Tracking samples 15 frames per second and takes roughly the length of the clip.</p>
          </details>
          <button class="btn" id="runAnalysis" style="margin-top:12px">Analyze this throw</button>
          <div class="progressbar" style="margin-top:14px;display:none" id="pbWrap"><i id="pb"></i></div>
          <p class="mono muted" id="pbLabel" style="font-size:11px"></p>
        </div>`;
      $('#runAnalysis').onclick = async () => {
        const btn = $('#runAnalysis');
        btn.disabled = true;
        $('#pbWrap').style.display = 'block';
        $('#pbLabel').textContent = 'Loading pose model…';
        try {
          let raw = await extractFrames(vid, {
            fps: ANALYSIS_FPS,
            onProgress: p => { $('#pb').style.width = (p * 100).toFixed(0) + '%'; $('#pbLabel').textContent = `Tracking body… ${(p * 100).toFixed(0)}%`; },
          });
          if (t.handedness === 'L') raw = mirrorFrames(raw);
          const { metrics, events, error } = computeMetrics(raw, t.view, {}, calibFor(t.hand));
          if (error) throw new Error(error);
          analysis = {
            throwId: t.id, frames: raw, metrics, events,
            ratedAgainst: profileId, analyzedAt: Date.now(),
            eventsVer: EVENTS_VER, calibStamp: calibStamp(),
          };
          await db.saveAnalysis(analysis);
          vid.currentTime = events.releaseT || 0;
          paint();
          renderPane(); renderEventUI(); renderMarks();
        } catch (err) {
          btn.disabled = false;
          $('#pbLabel').textContent = '';
          pane.insertAdjacentHTML('beforeend', `<div class="notice warn" style="margin-top:12px">${esc(err.message)}</div>`);
        }
      };
      return;
    }

    const profile = resolveProfile(profileId, t.hand, profiles);
    const rating = rate(analysis.metrics, profile);
    const canDelete = !profile.baseline && !profile.id.startsWith('seed-');

    const rows = Object.entries(rating.perMetric).map(([key, m]) => {
    const def = METRICS[key];
    const val = key.endsWith('Ms') ? m.value.toFixed(0) : m.value.toFixed(1);
    const tgt = key.endsWith('Ms') ? m.target.toFixed(0) : m.target.toFixed(1);
    return `<tr>
      <td><span class="metric-name">${esc(def.label)} ${infoDot(def.label, metricTip(key))}</span></td>
      <td class="mono">${val}<span class="muted"> / ${tgt} ${esc(def.unit)}</span></td>
      <td><div class="bar"><i style="width:${m.score}%;background:${scoreColor(m.score)}"></i></div></td>
      <td class="scorenum" style="color:${scoreColor(m.score)}">${m.score}</td>
    </tr>`;
  }).join('');

  pane.innerHTML = `
    <div class="card">
      <div class="stamp-row">
        ${stampHtml(rating)}
        <div>
          <h2 style="margin-bottom:2px">${esc(rating.word)}</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12px">${profile.baseline ? 'Your fundamentals, no pro comparison' : 'vs ' + esc(profile.name)}</p>
          ${flightNumsHtml(rating.stamp)}
        </div>
      </div>

      <label class="field" style="margin-top:16px"><span>Score against</span>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:nowrap">
          <select id="profileSel" style="flex:1">
            <option value="${NO_REF}" ${profile.baseline ? 'selected' : ''}>No reference: score my fundamentals</option>
            ${profiles.length ? `<optgroup label="Compare to a reference">${profiles.map(p => `<option value="${p.id}" ${!profile.baseline && p.id === profile.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
          </select>
          ${canDelete ? `<button class="btn danger" id="delRef" title="Delete this reference profile" style="flex:none;padding:9px 12px">Delete ref</button>` : ''}
        </div>
      </label>
      ${profile.baseline ? `<div class="notice" style="font-size:12px">Scored against general good-form fundamentals, not a specific player.
        <details class="more"><summary>More</summary><p>Ranges are wide on purpose. This measures your form, not a pro chase. Pick a reference above for a direct comparison.</p></details></div>` : ''}
      ${profile.approx ? `<div class="notice" style="font-size:12px">This reference uses approximate targets, not motion-capture data.
        <details class="more"><summary>More</summary><p>Targets are modeled on public form breakdowns of the player. For a real comparison, analyze footage of the player (or your own best throw) and use Promote to reference.</p></details></div>` : ''}

      <table class="metrics" style="margin-top:12px">
        <thead><tr><th>Metric</th><th>You / target</th><th></th><th>Score</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      ${rating.cues.length ? `<h2 style="margin-top:18px">What to fix first</h2>` +
        rating.cues.map(c => `<div class="cue">
          <b>${esc(c.label)} · ${c.score}</b>
          <a class="cue-guide mono" href="#/guide/${c.key}">learn ›</a>
          <p>${esc(c.text)}</p>
          <p class="drill"><span>Drill</span>${esc(METRICS[c.key].drill)}</p>
        </div>`).join('')
        : `<p class="muted" style="margin-top:16px">Nothing scoring under 70. Keep stacking reps and watch Progress for drift.</p>`}

      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="promoteRef">Promote to reference profile</button>
        <button class="btn ghost" id="reanalyze">Re-analyze</button>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px">
        Only ${t.view === 'side' ? 'side-on' : 'face-on'} metrics are scored from this camera angle. The rest are excluded, not guessed.
      </p>
    </div>`;

    $('#profileSel').onchange = async e => {
      profileId = e.target.value;
      analysis.ratedAgainst = profileId;
      await db.saveAnalysis(analysis);
      renderPane();
    };
    $('#promoteRef').onclick = async () => {
      const name = prompt('Name this reference profile (e.g. "My best drive"):', `${t.label || 'Reference'} (${t.hand})`);
      if (!name) return;
      const base = profiles.find(p => p.id.startsWith('seed-')) || BASELINE_PROFILES[t.hand];
      await db.saveProfile(profileFromMetrics(analysis.metrics, base, name, t.hand));
      alert('Saved. It now appears in the "Score against" list for ' + t.hand + ' throws.');
      renderThrow(t.id); // full re-render: profile list changed
    };
    if (canDelete) $('#delRef').onclick = async () => {
      if (!confirm(`Delete the reference “${profile.name}”? This can't be undone. Throws scored against it fall back to “No reference”.`)) return;
      await db.deleteProfile(profile.id);
      if (analysis.ratedAgainst === profile.id) { analysis.ratedAgainst = NO_REF; await db.saveAnalysis(analysis); }
      renderThrow(t.id);
    };
    $('#reanalyze').onclick = async () => {
      if (!confirm('Discard this analysis and re-run pose tracking?')) return;
      await db.deleteAnalysis(t.id);
      analysis = null;
      renderPane(); renderEventUI(); renderMarks(); paint();
    };
  }

  renderPane();
  renderEventUI();
  renderMarks();
}

// A short value for a metric, with its symbol (compact for the dumbbell).
function fmtMetricShort(key, v) {
  if (key.endsWith('Ms')) return `${Math.round(v)}ms`;
  if (key.endsWith('Deg')) return `${v.toFixed(0)}°`;
  return `${v.toFixed(2)}×`;
}

// Similarity/difference visual: every metric measurable in BOTH throws, each
// plotted in tolerance-units from that hand's ideal (center line). Two throws
// with the same tendency land their dots together; diverging form pulls them
// apart. Normalizing per-hand-ideal keeps it fair even across hands. Rows are
// sorted biggest-gap first so differences surface immediately.
function comparisonCard(A, anA, B, anB) {
  const mA = anA.metrics || {}, mB = anB.metrics || {};
  const baseA = BASELINE_PROFILES[A.hand].ranges, baseB = BASELINE_PROFILES[B.hand].ranges;
  const shared = Object.keys(METRICS).filter(k =>
    mA[k] != null && mB[k] != null && baseA[k] && baseB[k]);

  if (!shared.length) {
    return `<div class="card cmpviz"><h2>How these throws compare</h2>
      <p class="muted" style="font-size:13px">These clips are filmed from different camera angles, so they share no directly comparable metrics. Film both from the same angle (side-on or face-on) to line up the numbers.</p></div>`;
  }

  const z = (v, base) => Math.max(-3, Math.min(3, (v - base.target) / base.tol));
  const pos = zz => ((zz + 3) / 6) * 100;
  const rows = shared.map(k => {
    const zA = z(mA[k], baseA[k]), zB = z(mB[k], baseB[k]);
    const dz = Math.abs(zA - zB);
    const tag = dz < 0.75 ? ['Similar', 'good'] : dz < 1.5 ? ['Close', 'mid'] : ['Differs', 'bad'];
    return { k, zA, zB, dz, tag };
  }).sort((x, y) => y.dz - x.dz);

  const rowHtml = r => {
    const pA = pos(r.zA), pB = pos(r.zB);
    const lo = Math.min(pA, pB), hi = Math.max(pA, pB);
    return `<div class="cmprow">
      <div class="cmplabel">${esc(METRICS[r.k].label)} <span class="cmptag ${r.tag[1]}">${r.tag[0]}</span></div>
      <div class="cmptrack">
        <span class="cmpmid" title="ideal"></span>
        <span class="cmpconn ${r.tag[1]}" style="left:${lo}%;width:${hi - lo}%"></span>
        <span class="cmpdot a" style="left:${pA}%"></span>
        <span class="cmpdot b" style="left:${pB}%"></span>
      </div>
      <div class="cmpvals"><b class="a">${fmtMetricShort(r.k, mA[r.k])}</b><span class="muted">vs</span><b class="b">${fmtMetricShort(r.k, mB[r.k])}</b></div>
    </div>`;
  };

  const head = rows.length >= 2
    ? `<p class="cmphead">Most alike on <b>${esc(METRICS[rows[rows.length - 1].k].label)}</b>. Biggest gap on <b>${esc(METRICS[rows[0].k].label)}</b>.</p>`
    : '';

  return `<div class="card cmpviz">
    <h2>How these throws compare</h2>
    ${head}
    <div class="cmplegend">
      <span><i class="cmpdot a"></i>${esc(A.label || 'Throw A')}</span>
      <span><i class="cmpdot b"></i>${esc(B.label || 'Throw B')}</span>
      <span class="muted">center line = ideal for that hand · closer dots = more alike</span>
    </div>
    ${rows.map(rowHtml).join('')}
  </div>`;
}

// ---------- compare ----------
// Two throws side by side on ONE clock, aligned so u = 0 is the moment of
// release in both clips. Play/scrub/step controls drive both videos; A is
// the master clock and B gets nudged whenever it drifts >50 ms.
async function renderCompare(aId, bId) {
  runTeardown();
  const [throws, analyses] = await Promise.all([db.listThrows(), db.listAnalyses()]);
  const anMap = new Map(analyses.map(a => [a.throwId, a]));
  const analyzed = throws
    .filter(t => anMap.get(t.id)?.events?.releaseT != null)
    .sort((x, y) => y.createdAt - x.createdAt);

  if (analyzed.length < 2) {
    view.innerHTML = `<h1>Compare</h1>
      <div class="empty"><div class="disc-art">⇄</div><h2>Need two analyzed throws</h2>
      <p>Compare plays two throws side by side, time-locked at the release.<br>
      Analyze at least two throws in the <a href="#/library">Library</a>, then come back.</p></div>`;
    return;
  }

  const A = analyzed.find(t => t.id === aId) || analyzed[0];
  const B = analyzed.find(t => t.id === bId && t.id !== A.id) || analyzed.find(t => t.id !== A.id);
  const anA = anMap.get(A.id), anB = anMap.get(B.id);
  await Promise.all([upgradeAnalysis(A, anA), upgradeAnalysis(B, anB)]);

  const optLabel = t => `${t.label || 'Untitled'} · ${t.hand === 'backhand' ? 'BH' : 'FH'} ${t.view === 'side' ? 'side' : 'face'} · ${fmtDate(t.createdAt)}`;
  const sel = (id, cur) => `<select id="${id}">${analyzed.map(t =>
    `<option value="${t.id}" ${t.id === cur.id ? 'selected' : ''}>${esc(optLabel(t))}</option>`).join('')}</select>`;
  const cell = (t, an, side, vidId, cvId, color) => `
    <div class="ccell">
      <div class="player">
        <video id="${vidId}" playsinline muted></video>
        <canvas class="overlay" id="${cvId}"></canvas>
      </div>
      <div class="ccap"><span class="dot" style="background:${color}"></span>
        <b>${esc(t.label || 'Untitled')}</b>
        <span class="mono muted">${t.hand === 'backhand' ? 'BH' : 'FH'} · ${t.view === 'side' ? 'side-on' : 'face-on'} · release at ${fmtT(an.events.releaseT)}</span>
      </div>
      <div class="cedit">
        <div class="timeline mini" id="tl_${side}">
          <div class="track"></div><i class="fill" id="tlFill_${side}"></i><div id="tlMarks_${side}"></div>
        </div>
        <div class="pcontrols mini">
          <button class="pbtn" id="sb_${side}" title="This clip one frame back">‹</button>
          <button class="pbtn" id="sf_${side}" title="This clip one frame forward">›</button>
          <select class="marksel" id="msel_${side}" title="Event to mark on this clip">
            ${EVENT_DEFS.map(([key, label]) => `<option value="${key}" ${key === 'release' ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <button class="evmark" id="mbtn_${side}" title="Move the selected event to this clip's current frame">Mark</button>
          ${an.manualEvents ? `<button class="evmark" id="mreset_${side}" title="Re-detect all events for this clip">↺</button>` : ''}
          <span class="mono muted tcur" id="tlab_${side}"></span>
        </div>
      </div>
    </div>`;

  view.innerHTML = `
    <h1>Compare</h1>
    <p class="muted" style="font-size:13px;max-width:78ch">
      Two throws, one clock. 0.00 s is the release in both clips. Both start just before the first step.
    </p>
    <details class="more" style="margin:0 0 12px">
      <summary>How sync and editing work</summary>
      <p>Alignment uses each throw's release timestamp, including manual marks. The strip under
      each clip edits that clip: scrub or frame-step it on its own, pick an event, click Mark.
      Marks save to the throw and the view re-syncs on release right away. Any shared control
      locks both clips back together. The nudge shifts clip B a frame at a time without changing
      any marks.</p>
    </details>
    <div class="row cmp-selects">
      <label class="field grow"><span>Throw A <i class="cdot" style="background:var(--iceA)"></i></span>${sel('selA', A)}</label>
      <button class="pbtn" id="swapAB" title="Swap A and B" style="align-self:center;margin-top:8px">⇄</button>
      <label class="field grow"><span>Throw B <i class="cdot" style="background:var(--iceB)"></i></span>${sel('selB', B)}</label>
    </div>
    <div class="cgrid">
      ${cell(A, anA, 'a', 'vidA', 'cvA', 'var(--iceA)')}
      ${cell(B, anB, 'b', 'vidB', 'cvB', 'var(--iceB)')}
    </div>
    <div class="card cbar">
      <div class="pcontrols">
        ${playerControlsHtml()}
        <span id="jumpChips"></span>
        <span class="nudge mono" title="Shift clip B against clip A, one frame at a time">
          <button class="pbtn" id="nudgeBack" title="Clip B one frame earlier">B‹</button>
          <span id="nudgeLabel" class="muted">sync 0f</span>
          <button class="pbtn" id="nudgeFwd" title="Clip B one frame later">B›</button>
        </span>
        <span class="mono muted tcur" id="timeLabel"></span>
      </div>
      ${timelineHtml()}
    </div>
    ${comparisonCard(A, anA, B, anB)}`;

  $('#selA').onchange = e => { location.hash = `#/compare/${e.target.value}/${B.id}`; };
  $('#selB').onchange = e => { location.hash = `#/compare/${A.id}/${e.target.value}`; };
  $('#swapAB').onclick = () => { location.hash = `#/compare/${B.id}/${A.id}`; };

  const va = $('#vidA'), vb = $('#vidB');
  va.src = blobUrl(A.videoBlob);
  vb.src = blobUrl(B.videoBlob);
  attachOverlay(va, $('#cvA'), () => anA.frames, { flipX: A.handedness === 'L' });
  attachOverlay(vb, $('#cvB'), () => anB.frames, { flipX: B.handedness === 'L', color: '#1F6FD0' });
  const relA = anA.events.releaseT, relB = anB.events.releaseT;

  await Promise.all([va, vb].map(v => new Promise(res => {
    if (v.readyState >= 1) res();
    else v.addEventListener('loadedmetadata', res, { once: true });
  })));
  if (!document.body.contains(va)) return; // user navigated away mid-load
  await Promise.all([ensureDuration(va), ensureDuration(vb)]);

  // Earliest occurrence of an event across both clips, in release-relative time.
  const uEvent = key => {
    const us = [[anA, relA], [anB, relB]]
      .map(([an, rel]) => an.events[key + 'T'] != null ? an.events[key + 'T'] - rel : null)
      .filter(u => u != null);
    return us.length ? Math.min(...us) : null;
  };
  // Auto-trim: the shared window starts just before the first step instead of
  // at the raw start of the longer clip. Falls back to full length for
  // standstill throws with no detected step.
  const rawMin = -Math.min(relA, relB);
  const uStep = uEvent('firstStep');
  const uMin = uStep != null ? Math.max(rawMin, uStep - 0.25) : rawMin;
  const uMax = Math.min(effDuration(va, anA.frames) - relA, effDuration(vb, anB.frames) - relB);
  const span = Math.max(uMax - uMin, 0.001);
  const curU = () => va.currentTime - relA;
  const fmtU = u => `${u >= 0 ? '+' : '−'}${Math.abs(u).toFixed(2)}s vs release`;
  // Manual sync nudge: shifts clip B against clip A in whole frames, for when
  // one clip's release mark is a hair off.
  let bNudge = 0;
  const bOff = () => bNudge * FRAME_STEP;

  const tlFill = $('#tlFill'), timeLabel = $('#timeLabel'), playBtn = $('#playBtn');
  function updateBar() {
    const u = Math.max(uMin, Math.min(uMax, curU()));
    tlFill.style.width = `${((u - uMin) / span) * 100}%`;
    timeLabel.textContent = fmtU(u);
  }
  function setU(u) {
    u = Math.max(uMin, Math.min(uMax, u));
    va.currentTime = relA + u;
    vb.currentTime = relB + u + bOff();
    updateBar();
  }
  function pauseBoth() { va.pause(); vb.pause(); }
  function playBoth() {
    if (curU() >= uMax - 0.03) setU(uMin); // at the end: replay the shared window
    va.play(); vb.play();
  }
  const toggle = () => { va.paused ? playBoth() : pauseBoth(); };

  playBtn.onclick = toggle;
  [va, vb].forEach(v => v.addEventListener('click', toggle));
  // Drift lock. Driven by rAF for smoothness, but ALSO by 'timeupdate' so the
  // pair stays locked even when the tab is throttled and rAF barely fires.
  let syncRaf;
  const syncCheck = () => {
    cancelAnimationFrame(syncRaf);
    if (va.paused) return;
    const desired = va.currentTime - relA + relB + bOff();
    if (Math.abs(vb.currentTime - desired) > 0.05 && !vb.seeking) vb.currentTime = desired;
    if (curU() >= uMax - 0.02) { pauseBoth(); setU(uMax); return; }
    updateBar();
    syncRaf = requestAnimationFrame(syncCheck);
  };
  va.addEventListener('play', () => { playBtn.textContent = '❚❚'; syncCheck(); });
  va.addEventListener('timeupdate', () => { if (!va.paused) syncCheck(); });
  va.addEventListener('pause', () => { playBtn.textContent = '▶'; cancelAnimationFrame(syncRaf); vb.pause(); updateBar(); });
  va.addEventListener('ended', pauseBoth);
  vb.addEventListener('ended', pauseBoth);
  onTeardown(() => cancelAnimationFrame(syncRaf));

  wireSpeed($('#speedSeg'), [va, vb]);
  $('#stepBack').onclick = () => { pauseBoth(); setU(curU() - FRAME_STEP); };
  $('#stepFwd').onclick = () => { pauseBoth(); setU(curU() + FRAME_STEP); };
  wireKeys({ toggle, step: d => { pauseBoth(); setU(curU() + d * FRAME_STEP); } });
  wireTimeline($('#tl'), frac => { pauseBoth(); setU(uMin + frac * span); });

  // Jump chips and timeline markers for every detected event.
  const eventUs = EVENT_DEFS
    .map(([key, label]) => [key, label, key === 'release' ? 0 : uEvent(key)])
    .filter(([, , u]) => u != null && u >= uMin && u <= uMax);
  $('#jumpChips').innerHTML = eventUs
    .map(([key, label, u]) => `<button class="evchip mark-${key}" data-u="${u}">${label}</button>`).join('');
  view.querySelectorAll('#jumpChips .evchip').forEach(b => {
    b.onclick = () => { pauseBoth(); setU(Number(b.dataset.u)); };
  });
  $('#tlMarks').innerHTML = eventUs
    .map(([key, label, u]) => `<span class="mark ${key}" style="left:${(((u - uMin) / span) * 100).toFixed(2)}%"
      data-tip-title="${label}" data-tip="${fmtU(u)}"></span>`).join('');

  const nudgeLabel = $('#nudgeLabel');
  const applyNudge = d => {
    bNudge += d;
    nudgeLabel.textContent = `sync ${bNudge > 0 ? '+' : ''}${bNudge}f`;
    setU(curU()); // re-seek clip B with the new offset
  };
  $('#nudgeBack').onclick = () => applyNudge(-1);
  $('#nudgeFwd').onclick = () => applyNudge(1);

  // Per-clip edit strip: scrub/step ONE clip and re-mark its events without
  // leaving compare. Editing pauses both; saving a mark persists it to the
  // throw's analysis and re-renders this view, re-synced on release. Shared
  // controls always re-lock the pair.
  function wireCell(side, t, an, v) {
    const frames = an.frames;
    const cellDur = () => effDuration(v, frames);
    const fill = $(`#tlFill_${side}`), lab = $(`#tlab_${side}`), marks = $(`#tlMarks_${side}`);
    const update = () => {
      const d = cellDur();
      if (!d) return;
      fill.style.width = `${Math.min(100, (v.currentTime / d) * 100)}%`;
      lab.textContent = fmtT(v.currentTime);
    };
    ['timeupdate', 'seeked', 'loadedmetadata'].forEach(ev => v.addEventListener(ev, update));
    update();
    const d = cellDur();
    if (d) {
      marks.innerHTML = EVENT_DEFS
        .map(([key, label]) => [key, an.events[key + 'T'], label])
        .filter(([, tt]) => tt != null)
        .map(([key, tt, label]) => `<span class="mark ${key}" style="left:${((tt / d) * 100).toFixed(2)}%"
          data-tip-title="${label}" data-tip="${fmtT(tt)} · ${an.events.manual?.[key] ? 'set by you' : 'auto-detected'}"></span>`).join('');
    }
    wireTimeline($(`#tl_${side}`), frac => {
      pauseBoth();
      const dd = cellDur();
      if (dd) v.currentTime = frac * dd;
    });
    $(`#sb_${side}`).onclick = () => { pauseBoth(); stepBy(v, -1, frames); };
    $(`#sf_${side}`).onclick = () => { pauseBoth(); stepBy(v, 1, frames); };
    const save = async overrides => {
      an.manualEvents = overrides;
      const derive = () => {
        const { metrics, events, error } = computeMetrics(frames, t.view, overrides || {}, calibFor(t.hand));
        if (error) { alert(error); return false; }
        an.metrics = metrics; an.events = events;
        an.eventsVer = EVENTS_VER; an.calibStamp = calibStamp();
        return true;
      };
      if (!derive()) return;
      await db.saveAnalysis(an);
      await trainCalibration(); // learn from this correction (and all others)
      derive(); await db.saveAnalysis(an);
      renderCompare(A.id, B.id); // fresh window and markers, re-synced on release
    };
    $(`#mbtn_${side}`).onclick = () => {
      pauseBoth();
      const key = $(`#msel_${side}`).value;
      save({ ...(an.manualEvents || {}), [key + 'Idx']: nearestFrameIndex(frames, v.currentTime) });
    };
    const rst = $(`#mreset_${side}`);
    if (rst) rst.onclick = () => save(null);
  }
  wireCell('a', A, anA, va);
  wireCell('b', B, anB, vb);

  setU(0); // open on the release, lined up
}

// ---------- progress ----------
async function renderProgress() {
  const [throws, analyses, profiles] = await Promise.all([db.listThrows(), db.listAnalyses(), db.listProfiles()]);
  const tMap = new Map(throws.map(t => [t.id, t]));
  const points = { backhand: [], forehand: [] };
  for (const a of analyses) {
    const t = tMap.get(a.throwId);
    if (!t) continue;
    const r = rate(a.metrics, resolveProfile(a.ratedAgainst, t.hand, profiles));
    if (r.overall != null) points[t.hand].push({ x: t.createdAt, y: r.overall, label: t.label });
  }
  points.backhand.sort((a, b) => a.x - b.x);
  points.forehand.sort((a, b) => a.x - b.x);
  const total = points.backhand.length + points.forehand.length;

  view.innerHTML = `
    <h1>Progress</h1>
    <p class="muted" style="font-size:13px">Overall form score per analyzed throw, over time.
      <span style="color:var(--drive)">● backhand</span> &nbsp;
      <span style="color:var(--mid)">● forehand</span></p>
    ${total < 2
      ? `<div class="empty"><div class="disc-art">📈</div><h2>Not enough data yet</h2><p>Analyze at least two throws and the trend lines appear here.</p></div>`
      : `<div class="card"><canvas class="chart" id="chart"></canvas></div>`}
  `;
  if (total >= 2) drawChart($('#chart'), points);
}

function drawChart(canvas, points) {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth * dpr, H = 260 * dpr;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const pad = { l: 34 * dpr, r: 12 * dpr, t: 12 * dpr, b: 24 * dpr };
  const all = [...points.backhand, ...points.forehand];
  const xMin = Math.min(...all.map(p => p.x)), xMax = Math.max(...all.map(p => p.x));
  const xSpan = Math.max(xMax - xMin, 1);
  const xTo = x => pad.l + ((x - xMin) / xSpan) * (W - pad.l - pad.r);
  const yTo = y => pad.t + (1 - y / 100) * (H - pad.t - pad.b);

  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.fillStyle = '#64809C'; ctx.strokeStyle = '#D3E2EF'; ctx.lineWidth = 1;
  for (const g of [0, 25, 50, 75, 100]) {
    ctx.beginPath(); ctx.moveTo(pad.l, yTo(g)); ctx.lineTo(W - pad.r, yTo(g)); ctx.stroke();
    ctx.fillText(String(g), 6 * dpr, yTo(g) + 3 * dpr);
  }
  const series = [['backhand', '#2379CE'], ['forehand', '#E8A93C']];
  for (const [hand, color] of series) {
    const pts = points[hand];
    if (!pts.length) continue;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(xTo(p.x), yTo(p.y)) : ctx.moveTo(xTo(p.x), yTo(p.y)));
    if (pts.length > 1) ctx.stroke();
    for (const p of pts) { ctx.beginPath(); ctx.arc(xTo(p.x), yTo(p.y), 3.5 * dpr, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.fillStyle = '#64809C';
  ctx.fillText(fmtDate(xMin), pad.l, H - 8 * dpr);
  const endLabel = fmtDate(xMax);
  ctx.fillText(endLabel, W - pad.r - ctx.measureText(endLabel).width, H - 8 * dpr);
}

// ---------- guide ----------
function fmtRangeVal(key, v) {
  const n = key.endsWith('Ms') ? Math.round(v) : (key === 'reachbackRatio' ? v.toFixed(2) : v.toFixed(0));
  return `${n}${METRICS[key].unit.startsWith('×') ? '' : ''}`;
}
async function renderGuide(focusKey) {
  const profiles = await db.listProfiles();
  const seeds = profiles.filter(p => p.id.startsWith('seed-'));

  const viewBadge = v => `<span class="viewbadge ${v}" data-tip-title="${esc(VIEW_INFO[v].label)}" data-tip="${esc(VIEW_INFO[v].text)}" tabindex="0">${v === 'side' ? 'SIDE-ON' : 'FACE-ON'}</span>`;

  const rangeLine = key => {
    const parts = seeds.filter(p => p.ranges[key]).map(p => {
      const r = p.ranges[key];
      const hand = p.hand === 'backhand' ? 'BH' : 'FH';
      return `<span class="rng"><b>${fmtRangeVal(key, r.target)}${esc(METRICS[key].unit)}</b> ± ${fmtRangeVal(key, r.tol)} <span class="muted mono">${hand}</span></span>`;
    });
    return parts.length ? `<div class="targets"><span class="tlabel mono">Reference target</span>${parts.join('')}</div>` : '';
  };

  const metricCard = key => {
    const d = METRICS[key];
    return `<div class="guide-metric" id="m-${key}">
      <div class="gm-head">
        <h3>${esc(d.label)}</h3>
        ${viewBadge(d.view)}
        <span class="wpill mono" data-tip-title="Metric weight" data-tip="Higher-weighted metrics move your overall score more. This one is weighted ${d.weight}× in the average." tabindex="0">${d.weight}×</span>
      </div>
      <p class="gm-desc">${esc(d.desc)}</p>
      <div class="gm-facet"><span>How it's measured</span><p>${esc(d.how)}</p></div>
      <div class="gm-facet"><span>Why it matters</span><p>${esc(d.why)}</p></div>
      <div class="gm-facet drill"><span>Drill</span><p>${esc(d.drill)}</p></div>
      ${rangeLine(key)}
    </div>`;
  };

  const groupSection = g => {
    const gi = GROUP_INFO[g];
    const keys = Object.keys(METRICS).filter(k => METRICS[k].group === g);
    return `<section class="guide-group">
      <div class="gg-head"><span class="gg-badge">${g}</span><div><h2>${esc(gi.label)}</h2><p class="muted">${esc(gi.text)}</p></div></div>
      ${keys.map(metricCard).join('')}
    </section>`;
  };

  view.innerHTML = `
    <h1>Metric guide</h1>
    <p class="muted" style="font-size:14px;max-width:70ch">
      What every number means, how it's pulled from your video, and a drill to move it.
      Pose tracking runs in your browser. No video leaves the machine.
    </p>

    <div class="card guide-how">
      <h2>How scoring works</h2>
      <ul class="ticks">
        <li>Each metric scores <b>100</b> at the reference target and <b>50</b> one “tolerance” away, on a smooth bell curve. Small misses barely dent you. Wild misses tank the score.</li>
        <li>You choose what to score against: <b>No reference</b> uses general good-form fundamentals and is always available, or pick a saved reference for a direct comparison.</li>
        <li>Your <b>overall</b> is a weighted average of every metric measurable from that clip's camera angle. Metrics from the other angle are <b>excluded, never guessed</b>.</li>
        <li>The four <b>flight-stamp</b> numbers group those metrics into ${GROUPS.map(g => `<b>${g}</b>`).join(', ')}.</li>
      </ul>
    </div>

    <div class="card guide-how" style="margin-top:16px">
      <h2>Reading the grade</h2>
      <div class="gradebands">
        ${GRADE_BANDS.map(b => `<div class="gband"><span class="gg-badge">${b.grade}</span><b class="mono">${b.min}+</b><span>${esc(b.word)}</span></div>`).join('')}
      </div>
    </div>

    <div class="card guide-how" style="margin-top:16px">
      <h2>Camera angles</h2>
      <p class="muted" style="font-size:13px">Tag the angle when you upload. The app only scores what is physically visible from it. Film both over time for full coverage.</p>
      <div class="angle-grid">
        ${['side', 'face'].map(v => `<div class="angle-card"><span class="viewbadge ${v}">${v === 'side' ? 'SIDE-ON' : 'FACE-ON'}</span><p>${esc(VIEW_INFO[v].text)}</p></div>`).join('')}
      </div>
    </div>

    <div class="guide-groups">
      ${GROUPS.map(groupSection).join('')}
    </div>

    <div class="card guide-how" style="margin-top:8px">
      <h2>Filming for clean numbers</h2>
      <ul class="ticks">
        <li>Full body in frame the entire throw; phone steady on a tripod or leaned against something.</li>
        <li>Trim close to the throw. Hard cap is 60 s.</li>
        <li>Left-handed? Set it in <a href="#/settings">Settings</a> <b>before</b> uploading so throws are mirrored and comparable.</li>
        <li>Numbers are a <b>training signal</b>, not ground truth. A 74 vs 78 means nothing; a 55 brace three sessions running means something.</li>
      </ul>
    </div>
  `;

  if (focusKey && METRICS[focusKey]) {
    const el = document.getElementById('m-' + focusKey);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  }
}

// ---------- settings ----------
async function renderSettings() {
  const s = db.getSettings();
  const profiles = await db.listProfiles();
  const custom = profiles.filter(p => !p.id.startsWith('seed-'));
  const seeded = profiles.filter(p => p.id.startsWith('seed-'));

  const refRow = (p, deletable) => `<div class="refrow">
    <div><span class="name">${esc(p.name)}</span>
      <span class="reftag mono">${p.hand === 'backhand' ? 'BH' : 'FH'}${p.approx ? ' · approx' : deletable ? ' · yours' : ''}</span></div>
    ${deletable ? `<button class="btn danger" data-del="${esc(p.id)}" style="padding:7px 11px">Delete</button>`
      : `<span class="muted mono" style="font-size:10px">built-in</span>`}
  </div>`;

  view.innerHTML = `
    <h1>Settings</h1>
    <div class="card" style="max-width:560px">
      <label class="field"><span>Throwing hand</span>
        <div class="seg" id="setHand">
          <button type="button" data-v="R" class="${s.handedness === 'R' ? 'on' : ''}">Right</button>
          <button type="button" data-v="L" class="${s.handedness === 'L' ? 'on' : ''}">Left</button>
        </div>
      </label>
      <p class="muted" style="font-size:12px">Left-handed throws are mirrored before analysis so all metrics stay comparable. Applies to throws uploaded after the change.</p>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px">
      <h2>Reference profiles</h2>
      <p class="muted" style="font-size:13px">References are optional. Every throw can always be scored against <b>No reference</b> (general fundamentals).</p>
      <details class="more"><summary>More</summary><p>Use a reference when you want a direct comparison. Promote any analyzed throw to a reference from its results page and it appears here.</p></details>
      <div class="reflist">
        ${custom.length ? custom.map(p => refRow(p, true)).join('') : `<p class="muted" style="font-size:12px;margin:6px 0">No saved references yet. You are scoring against your own fundamentals.</p>`}
        ${seeded.map(p => refRow(p, false)).join('')}
      </div>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px">
      <h2>Auto-marking</h2>
      <p class="muted" style="font-size:13px">Every time you correct a mark, the detector learns from it. Future auto-marks for that hand shift toward where you place yours.</p>
      <details class="more"><summary>More</summary><p>Corrections are averaged per hand in a normalized throw timeline, so what it learns transfers across throws of different tempo. Manual marks always override the learned guess. Nothing here leaves your browser.</p></details>
      <div class="learnstat" id="learnStat"></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn ghost" id="relearn">Relearn from all my edits</button>
        <button class="btn danger" id="resetLearn">Reset learning</button>
      </div>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px">
      <h2>Data</h2>
      <p class="muted" style="font-size:13px">All data stays in this browser. Nothing is uploaded anywhere.</p>
      <details class="more"><summary>More</summary><p>Videos, skeleton data, and scores live in this browser's IndexedDB. Clearing site data erases them, so treat original clips as the master copy.</p></details>
      <p class="mono muted" style="font-size:11px" id="storageLine">Measuring storage…</p>
    </div>`;
  $('#setHand').addEventListener('click', e => {
    if (e.target.dataset.v) db.saveSettings({ ...db.getSettings(), handedness: e.target.dataset.v });
  });

  function paintLearnStat() {
    const c = calibrationSummary();
    const label = (hand, n) => n
      ? `<div class="lrow"><b>${hand}</b><span>learned from ${n} correction${n === 1 ? '' : 's'}</span></div>`
      : `<div class="lrow muted"><b>${hand}</b><span>no corrections yet</span></div>`;
    $('#learnStat').innerHTML = label('Backhand', c.backhand) + label('Forehand', c.forehand);
  }
  paintLearnStat();
  // Re-derive every analyzed throw against the current model (eager version of
  // the lazy per-open recompute) so a relearn/reset propagates immediately.
  async function rederiveAll() {
    const [throws, analyses] = await Promise.all([db.listThrows(), db.listAnalyses()]);
    const tMap = new Map(throws.map(t => [t.id, t]));
    for (const a of analyses) {
      const t = tMap.get(a.throwId);
      if (t) await upgradeAnalysis(t, a);
    }
  }
  $('#relearn').onclick = async () => {
    const btn = $('#relearn'); btn.disabled = true; btn.textContent = 'Learning…';
    await trainCalibration();
    await rederiveAll();
    paintLearnStat();
    btn.disabled = false; btn.textContent = 'Relearn from all my edits';
  };
  $('#resetLearn').onclick = async () => {
    if (!confirm('Reset everything the detector has learned from your edits? Your manual marks on each throw stay; only the learned bias for future auto-marks is cleared.')) return;
    db.clearCalibration();
    await rederiveAll();
    paintLearnStat();
  };
  view.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    const p = custom.find(x => x.id === btn.dataset.del);
    if (!p || !confirm(`Delete the reference “${p.name}”? This can't be undone. Throws scored against it fall back to “No reference”.`)) return;
    await db.deleteProfile(p.id);
    renderSettings();
  }));
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      const line = $('#storageLine');
      if (line) line.textContent = `Using ${(usage / 1048576).toFixed(1)} MB of ~${(quota / 1073741824).toFixed(1)} GB available.`;
    });
  }
}

// ---------- boot ----------
(async () => {
  await db.seedProfilesIfEmpty();
  // Learn from any corrections already on this machine before first render, so
  // existing throws show calibrated auto events immediately.
  await trainCalibration().catch(() => {});
  route();
})();
