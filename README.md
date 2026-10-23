# DISCFORM: local throw analysis lab

Analyze your disc golf form from video, entirely on your own machine. Upload
backhand and forehand clips, get pose-tracked biomechanics, a 0-100 rating with
a four-number "flight stamp" (**PWR** power · **SEQ** sequencing · **POS**
posture · **REL** release), coaching cues on what to fix first, and a progress
chart across sessions.

## Run it

```bash
cd discform
./start.sh        # macOS / Linux   (Windows: start.bat)
```

Then open **http://localhost:8437**. No install, no build step.
(The launcher is just Python's built-in web server. Module scripts can't load
from `file://`, which is the only reason a server is needed.)

**First analysis needs internet once** to fetch the MediaPipe pose model
(~5 MB from Google's CDN). The browser caches it after that. Your videos and
data never leave the machine. Everything is stored in the browser's IndexedDB.

## How to film for good results

- Full body in frame the entire throw, phone steady (tripod or leaning phone).
- Trim clips close to the throw. Hard cap: 60 s.
- **Side-on** (camera perpendicular to the throw) scores: reachback, posture,
  front-leg brace, elbow at release, follow-through, tempo.
- **Face-on / from behind** scores: hip-shoulder separation (the coil) and
  hips-lead timing.
- Tag the camera angle when uploading. The app only scores metrics that are
  physically measurable from that angle. It refuses to guess the rest.
- Left-handed? Set it in Settings *before* uploading. Throws are mirrored so
  all metrics stay comparable.

## Reviewing a throw

The player has slow motion (¼× / ½×), one-frame stepping (or ←/→, space to
play/pause), and a scrub timeline with markers for five events: **first step**,
**x-step plant**, **reachback**, **brace**, and **release**. The skeleton
overlay is interpolated between tracked frames so it stays glued to the body
during playback.

**Fixing wrong timestamps:** event detection is ±1 frame at best, and footwork
events are heuristics. If a marker is off, frame-step to the true moment, pick
the event, and click **Mark at this frame**. All metrics and scores recompute
instantly from the corrected frame, and the chip is tagged `manual`.
**↺ Re-detect** goes back to automatic. Marks persist per throw and are shared
everywhere that throw appears (throw page and Compare, both directions).

## It learns from your corrections

Every mark you fix teaches the detector. Corrections are averaged per hand in a
normalized throw timeline (so what it learns transfers across throws of
different tempo), and future **auto**-marks for that hand shift toward where you
place yours. Your manual marks always override the learned guess; with no
corrections yet, detection is unchanged. See **Settings → Auto-marking** for
what it has learned, a **Relearn from all my edits** button, and **Reset
learning** (which clears only the learned bias, never your per-throw marks).
Everything stays in your browser.

## Compare (side-by-side, release-synced)

The **Compare** tab plays any two analyzed throws on one clock, aligned so
**0.00 s is the moment of release in both clips**. Reachbacks, braces, and
follow-throughs line up around the hit. The shared window is auto-trimmed to
start just before the first step. Play, scrub, slow-mo, and frame-step drive
both videos together, and a drift lock keeps them within ~50 ms. Event buttons
jump both clips to first step, x-step plant, reachback, brace, or release.

Sync uses each throw's release timestamp, including manual marks. If the clips
still look a hair off, the **B‹ / B›** nudge shifts clip B against clip A one
frame at a time.

Both clips are editable in place: the strip under each clip scrubs and
frame-steps that clip on its own, and **Mark** moves any of the five events to
its current frame. Marks save to the throw and the view re-syncs on release
immediately. Any shared control locks the pair back together.

## The pro comparison: read this

The seeded profiles ("Simon Lizotte, backhand (approx.)", "Eagle McMahon,
forehand (approx.)") encode **approximate target ranges** assembled from public
form-analysis commentary. They represent *the shape of that player's form*, not
motion-capture data, and they're labeled `approx: true` in the UI and code.

For a real comparison: get side-on/face-on footage of the pro (or your own best
throw), upload it like any other throw, analyze it, then **Promote to
reference**. That extracts an actual measured profile, and every future throw
can be scored against it. Reference profiles and your throws are the same data
shape by design, so comparison is one code path.

## Topology

```
index.html ── css/app.css
    └── js/app.js          UI, router, views          (DOM only, no math)
          ├── js/db.js     IndexedDB: throws / analyses / profiles / settings
          ├── js/pose.js   MediaPipe wrapper: video → landmark timeline  ⚠ see below
          ├── js/metrics.js  PURE: landmarks → biomechanics + events  ✅ unit-tested
          ├── js/rating.js   PURE: metrics + profile → scores/cues  ✅ unit-tested
          └── js/benchmarks.js  PURE DATA: metric registry, seeds, cue library
```

Invariants the code enforces:

- Every metric declares which camera view it's valid for. Wrong-view metrics
  are never computed (tested).
- All biomechanics assume a right-handed thrower. Lefties are mirrored at the
  boundary (tested).
- Pose timestamps fed to MediaPipe are strictly monotonic. Video seeks are
  single-flight (race-guarded promise per seek), and frame times come from the
  browser's presented-frame callback when available.

## Verified vs. unverified

- ✅ `metrics.js`, `rating.js`, `benchmarks.js`: 45 offline unit tests against
  synthetic landmark timelines with hand-computed ground truth
  (`node test/metrics.test.mjs`).
- ⚠ `pose.js` (MediaPipe load + video seek loop) was written defensively but
  needs a browser and network to run. If analysis hangs or misdetects,
  `pose.js` is the seam to inspect first.

## Honest limits

- 2D pose from one phone camera is noisy. Scores are a *training signal* for
  trends and glaring flaws, not ground truth. A 74 vs a 78 means nothing; a
  55 brace score three sessions running means something.
- Release detection is peak wrist speed *while moving toward the target*
  (gated on wrist visibility and detection gaps), which drops the faster
  wrap-around after the disc leaves your hand, but it's still ±1 frame at
  15 fps. Footwork events (first step, x-step plant, brace) are ankle-motion
  heuristics. That's what the manual **Mark at this frame** correction, and the
  learning that follows from it, are for.
- Browser IndexedDB is the only copy of your videos here. Keep originals.
