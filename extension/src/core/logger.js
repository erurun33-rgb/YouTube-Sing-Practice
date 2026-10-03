// Debug logger with an in-memory ring buffer (copyable from the debug panel).
const MAX_ENTRIES = 500;

export function createLogger(prefix = '[YSP]') {
  const entries = [];
  let consoleEnabled = false;
  try { consoleEnabled = localStorage.getItem('ysp:debug') === '1'; } catch { /* ignore */ }

  function push(level, args) {
    const text = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
    const entry = { t: new Date().toISOString(), level, text };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    if (consoleEnabled || level === 'error') {
      (console[level] || console.log).call(console, prefix, ...args);
    }
  }

  return {
    debug: (...a) => push('debug', a),
    info: (...a) => push('info', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    entries: () => entries.slice(),
    dump: () => entries.map((e) => `${e.t} ${e.level.toUpperCase()} ${e.text}`).join('\n'),
    setConsole(on) {
      consoleEnabled = !!on;
      try { localStorage.setItem('ysp:debug', on ? '1' : '0'); } catch { /* ignore */ }
    },
    get consoleEnabled() { return consoleEnabled; },
  };
}

function safeJson(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}
