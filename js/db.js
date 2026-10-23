// db.js — IndexedDB persistence. Videos and analyses never leave this machine.
// Stores: throws {id, createdAt, hand, view, handedness, label, outcome, videoBlob, thumb}
//         analyses {throwId, frames, metrics, events, ratedAgainst, rating, analyzedAt}
//         profiles {id, name, hand, approx, note, ranges}
import { SEED_PROFILES } from './benchmarks.js';

const DB_NAME = 'discform';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      const throws = db.createObjectStore('throws', { keyPath: 'id' });
      throws.createIndex('byHand', 'hand');
      throws.createIndex('byDate', 'createdAt');
      db.createObjectStore('analyses', { keyPath: 'throwId' });
      db.createObjectStore('profiles', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOne(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function seedProfilesIfEmpty() {
  const existing = await getAll('profiles');
  const have = new Set(existing.map(p => p.id));
  const db = await open();
  for (const p of SEED_PROFILES) {
    if (!have.has(p.id)) await tx(db, 'profiles', 'readwrite', s => s.put(p));
  }
}

// ---- throws ----
export async function saveThrow(rec) {
  const db = await open();
  await tx(db, 'throws', 'readwrite', s => s.put(rec));
  return rec.id;
}
export const listThrows = () => getAll('throws');
export const getThrow = id => getOne('throws', id);
export async function deleteThrow(id) {
  const db = await open();
  await tx(db, 'throws', 'readwrite', s => s.delete(id));
  await tx(db, 'analyses', 'readwrite', s => s.delete(id));
}

// ---- analyses ----
export async function saveAnalysis(rec) {
  const db = await open();
  await tx(db, 'analyses', 'readwrite', s => s.put(rec));
}
export const getAnalysis = throwId => getOne('analyses', throwId);
export const listAnalyses = () => getAll('analyses');
export async function deleteAnalysis(throwId) {
  const db = await open();
  await tx(db, 'analyses', 'readwrite', s => s.delete(throwId));
}

// ---- profiles ----
export const listProfiles = () => getAll('profiles');
export const getProfile = id => getOne('profiles', id);
export async function saveProfile(p) {
  const db = await open();
  await tx(db, 'profiles', 'readwrite', s => s.put(p));
}
export async function deleteProfile(id) {
  if (id.startsWith('seed-')) return; // seeded profiles stay
  const db = await open();
  await tx(db, 'profiles', 'readwrite', s => s.delete(id));
}

// ---- settings (localStorage — tiny, non-blob) ----
export function getSettings() {
  try { return JSON.parse(localStorage.getItem('discform-settings')) || { handedness: 'R' }; }
  catch { return { handedness: 'R' }; }
}
export function saveSettings(s) {
  localStorage.setItem('discform-settings', JSON.stringify(s));
}

// ---- calibration (localStorage) ----
// Per-hand learned correction for auto event detection, trained from the
// user's manual mark edits. Shape:
//   { stamp, backhand: {reachback:{d,n},…}, forehand: {…} }
// stamp changes whenever the model changes, so analyses can tell when their
// auto events are stale and recompute. Empty until the user corrects marks.
export function getCalibration() {
  try { return JSON.parse(localStorage.getItem('discform-calibration')) || null; }
  catch { return null; }
}
export function saveCalibration(c) {
  localStorage.setItem('discform-calibration', JSON.stringify(c));
}
export function clearCalibration() {
  localStorage.removeItem('discform-calibration');
}
