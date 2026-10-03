// Global (not per-video) settings: the lyric mark palette, editable by the user.
import { newId } from './ids.js';
import { isContextInvalidated } from './runtime.js';

export const SETTINGS_KEY = 'ysp:v1:settings';
export const MARK_COLORS = ['#ffd60a', '#64d2ff', '#ff6b6b', '#bbbbbb', '#7ee787', '#d2a8ff', '#ffa657', '#ffffff'];

export const SETTINGS_VERSION = 2;
// placement: 'ruby'   = shown above the characters
//            'before' = inserted inline just before the first selected character
export const PLACEMENTS = ['ruby', 'before'];

export const DEFAULT_MARK_TYPES = [
  { id: 'scoop', symbol: '↗', name: 'しゃくり', color: '#ffd60a', placement: 'ruby' },
  { id: 'break', symbol: '／', name: '区切り', color: '#64d2ff', placement: 'before' },
  { id: 'accent', symbol: '＾', name: 'アクセント', color: '#ff6b6b', placement: 'ruby' },
  { id: 'bar', symbol: '｜', name: '小節区切り', color: '#bbbbbb', placement: 'before' },
  { id: 'long', symbol: '→', name: 'ロングトーン', color: '#7ee787', placement: 'ruby' },
  { id: 'vibrato', symbol: '～', name: 'ビブラート', color: '#d2a8ff', placement: 'ruby' },
  { id: 'fade', symbol: '＞', name: 'フェードアウト', color: '#ffa657', placement: 'ruby' },
  { id: 'breath', symbol: 'V', name: 'ブレス', color: '#64d2ff', placement: 'before' },
  { id: 'rest', symbol: '_', name: '休符', color: '#bbbbbb', placement: 'before' },
];
// Default types added in each settings version (merged into existing palettes on upgrade).
const ADDED_IN = { 2: ['breath', 'rest'] };

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizeType(t) {
  if (!t) return null;
  const symbol = str(t.symbol, 4).trim();
  if (!symbol) return null;
  const def = DEFAULT_MARK_TYPES.find((d) => d.id === t.id);
  const placement = PLACEMENTS.includes(t.placement) ? t.placement : (def ? def.placement : 'ruby');
  return { id: str(t.id, 40) || newId(), symbol, name: str(t.name, 30), color: str(t.color, 20) || MARK_COLORS[0], placement };
}

// Returns { settings, migrated } so the caller can persist an upgraded palette once.
export function migrateSettings(raw) {
  const version = raw && Number.isInteger(raw.version) ? raw.version : 1;
  const types = raw && Array.isArray(raw.markTypes) ? raw.markTypes.map(normalizeType).filter(Boolean) : null;
  if (!types) return { settings: { version: SETTINGS_VERSION, markTypes: DEFAULT_MARK_TYPES.map((t) => ({ ...t })) }, migrated: false };
  const markTypes = [...types];
  for (let v = version + 1; v <= SETTINGS_VERSION; v++) {
    for (const id of ADDED_IN[v] || []) {
      if (!markTypes.some((t) => t.id === id)) markTypes.push({ ...DEFAULT_MARK_TYPES.find((d) => d.id === id) });
    }
  }
  return { settings: { version: SETTINGS_VERSION, markTypes }, migrated: version < SETTINGS_VERSION };
}

export function normalizeSettings(raw) {
  return migrateSettings(raw).settings;
}

export function addMarkType(s, { symbol, name = '', color = MARK_COLORS[0], placement = 'ruby' }) {
  const t = normalizeType({ symbol, name, color, placement });
  return t ? { ...s, markTypes: [...s.markTypes, t] } : s;
}

export function updateMarkType(s, id, patch) {
  return { ...s, markTypes: s.markTypes.map((t) => (t.id === id ? (normalizeType({ ...t, ...patch }) || t) : t)) };
}

export function removeMarkType(s, id) {
  return { ...s, markTypes: s.markTypes.filter((t) => t.id !== id) };
}

export class SettingsStore {
  constructor({ area, logger, onContextLost = null, isInvalidated = isContextInvalidated }) {
    this.area = area;
    this.logger = logger;
    this.onContextLost = onContextLost;
    this.isInvalidated = isInvalidated;
    this.readable = true;
  }

  _failed(what, e) {
    if (this.isInvalidated(e)) {
      this.logger?.warn(`${what}: extension was updated or reloaded; reload this tab`);
      this.onContextLost?.();
    } else {
      this.logger?.error(what, e);
    }
  }

  async load() {
    try {
      const res = await this.area.get(SETTINGS_KEY);
      this.readable = true;
      const { settings, migrated } = migrateSettings(res ? res[SETTINGS_KEY] : null);
      if (migrated) await this.save(settings);
      return settings;
    } catch (e) {
      this.readable = false; // don't overwrite the user's palette with defaults later
      this._failed('settings load failed', e);
      return normalizeSettings(null);
    }
  }

  async save(s) {
    if (!this.readable) {
      this.logger?.warn('not saving settings: stored settings could not be read');
      return;
    }
    try {
      await this.area.set({ [SETTINGS_KEY]: s });
    } catch (e) {
      this._failed('settings save failed', e);
    }
  }
}
