// Runs at document_start (before YouTube's scripts) so this window-level capture listener is
// registered first. While the user types in one of our inputs (inside our shadow DOM), key
// events are stopped here so YouTube shortcuts (k/j/l/space/0-9/f/m...) do not fire.
// Enter / Escape / Tab still propagate: our own handlers use them.
(() => {
  const HOSTS = new Set(['ysp-panel-host', 'ysp-overlay-host']);
  const PASS = new Set(['Enter', 'Escape', 'Tab']);
  const guard = (e) => {
    // Hook installed by the extension while a mode needs a key (e.g. lyrics tap-sync uses Enter).
    const hook = window.__yspKeyHook;
    if (hook && hook(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (PASS.has(e.key)) return;
    const path = e.composedPath();
    const target = path[0];
    if (!target || !(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (path.some((n) => n && HOSTS.has(n.id))) e.stopImmediatePropagation();
  };
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, guard, true);
})();
