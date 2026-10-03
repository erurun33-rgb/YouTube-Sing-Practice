// Backup / restore of everything this extension keeps in chrome.storage.local (`ysp:v1:*`).
// Pure helpers; the content script does the storage I/O and the file download/upload.

import { KEY_PREFIX, normalize, isEmpty } from './store.js';
import { INK_FRAME_VERSION, LYRIC_INK_MAX_WIDTH } from './lyrics.js';
import { normalizeStroke } from './ids.js';
import { SETTINGS_KEY, SETTINGS_VERSION, migrateSettings } from './settings.js';

export const BACKUP_FORMAT = 'ysp-backup';
export const BACKUP_VERSION = 1;
const DATA_PREFIX = 'ysp:v1:';

function isDataKey(k) {
  return typeof k === 'string' && k.startsWith(DATA_PREFIX);
}

export function summarize(items) {
  const keys = Object.keys(items);
  return {
    videos: keys.filter((k) => k.startsWith(KEY_PREFIX)).length,
    settings: keys.includes(SETTINGS_KEY),
  };
}

// `all` is the result of storage.get(null). Only our own data keys are exported.
export function buildBackup(all, { appVersion = '', now = new Date() } = {}) {
  const items = {};
  for (const [k, v] of Object.entries(all || {})) if (isDataKey(k)) items[k] = v;
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: appVersion, exportedAt: now.toISOString(), items };
}

export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ysp-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// True when normalization keeps every value the backup holds: each field that normalize()
// outputs must be missing in the original (a default is filled in) or equal to it, and arrays
// must keep every entry. So a wrong type (`marks: "x"`, `pitchSemitones: "broken"`), an
// out-of-range value or a dropped entry all fail, while data the extension itself wrote passes.
function lossless(raw, norm, skip = () => false) {
  if (raw === undefined) return true;
  if (Array.isArray(norm)) {
    return Array.isArray(raw) && raw.length === norm.length && norm.every((n, i) => lossless(raw[i], n, skip));
  }
  if (isObj(norm)) {
    return isObj(raw) && Object.keys(norm).every((k) => skip(k, raw) || lossless(raw[k], norm[k], skip));
  }
  return Object.is(raw, norm);
}

// Fields that legitimately change when an older record is read: the schema number, and lyric
// handwriting stored in the old line frame (inkFrame < current), whose points are converted.
function skipMigrated(key, raw) {
  if (key === 'schema') return true;
  if (key === 'inkFrame') return true;
  // Old-frame ink is converted (checked separately against stroke normalization).
  return key === 'ink' && raw.inkFrame !== INK_FRAME_VERSION && Array.isArray(raw.ink);
}

// A stored practice record, as PracticeStore writes it. The original value is written as is, so
// it must survive normalization completely: a record that is even partly broken would otherwise
// replace the user's existing record with less data.
export function isValidVideoRecord(v, id) {
  if (!isObj(v) || v.videoId !== id) return false;
  if (!['loops', 'checkpoints', 'annotations'].every((k) => Array.isArray(v[k]))) return false;
  if (v.lyrics !== undefined && !(isObj(v.lyrics) && Array.isArray(v.lyrics.lines))) return false;
  try {
    const n = normalize(v, id);
    if (isEmpty(n)) return false;
    // Old-frame lyric ink: its points are converted on read, so compare each stroke against the
    // stroke normalization alone (before the frame conversion): every stroke, point and value
    // must survive.
    const lines = v.lyrics ? v.lyrics.lines : [];
    // Only the known frames: current, or old (1 / missing, written before inkFrame v2). Anything
    // else would be treated as old on read and its points moved.
    if (!lines.every((l) => !isObj(l) || [undefined, 1, INK_FRAME_VERSION].includes(l.inkFrame))) return false;
    const inkKept = lines.every((l) => !isObj(l) || l.inkFrame === INK_FRAME_VERSION || !Array.isArray(l.ink)
      || lossless(l.ink, l.ink.map((st) => normalizeStroke(st, LYRIC_INK_MAX_WIDTH))));
    return inkKept && lossless(v, n, skipMigrated);
  } catch {
    return false;
  }
}

export function isValidSettings(v) {
  if (!isObj(v) || !Array.isArray(v.markTypes)) return false;
  // Normalize as the current version so the mark types a migration would add can't hide dropped
  // ones; every original entry and value must be kept.
  try {
    const { markTypes } = migrateSettings({ ...v, version: SETTINGS_VERSION }).settings;
    return lossless(v.markTypes, markTypes);
  } catch {
    return false;
  }
}

// Validates a backup file's text and returns { items, summary, skipped }. Entries that could not
// be restored are left out (never written); the user is told how many. Throws with a message for the user.
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('バックアップファイルを読み取れません（JSONではありません）');
  }
  if (!obj || obj.format !== BACKUP_FORMAT || !isObj(obj.items)) {
    throw new Error('この拡張のバックアップファイルではありません');
  }
  if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) {
    throw new Error('新しい版で作られたバックアップです。拡張を更新してから読み込んでください');
  }
  const items = {};
  let skipped = 0;
  for (const [k, v] of Object.entries(obj.items)) {
    if (k.startsWith(KEY_PREFIX)) {
      const id = k.slice(KEY_PREFIX.length);
      if (/^[A-Za-z0-9_-]{11}$/.test(id) && isValidVideoRecord(v, id)) items[k] = v; // original kept, nothing dropped
      else skipped++;
    } else if (k === SETTINGS_KEY) {
      if (isValidSettings(v)) items[k] = v;
      else skipped++;
    }
    // Other keys are not ours to restore: ignored.
  }
  const summary = summarize(items);
  if (!summary.videos && !summary.settings) {
    throw new Error(skipped ? 'バックアップの中身が壊れているため読み込めません' : 'バックアップに読み込めるデータがありません');
  }
  return { items, summary, skipped, exportedAt: obj.exportedAt || null };
}
