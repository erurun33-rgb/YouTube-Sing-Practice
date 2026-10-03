// Classic content script (MV3 content scripts cannot be ES modules).
// Loads the real entry point as an ES module from the extension package; it still
// runs in this isolated world and keeps chrome.* access.
(async () => {
  try {
    const mod = await import(chrome.runtime.getURL('src/content/main.js'));
    mod.start();
  } catch (e) {
    console.error('[YSP] failed to start', e);
  }
})();
