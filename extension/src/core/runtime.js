// Extension runtime health. After the extension is reloaded/updated, content scripts already
// running in open tabs keep executing but lose access to chrome.* ("Extension context
// invalidated"). They must stop touching storage and ask the user to reload the tab.

export function extensionAlive() {
  try {
    return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

export function isContextInvalidated(e) {
  return !extensionAlive() || /Extension context invalidated/i.test(String(e && (e.message || e)));
}
