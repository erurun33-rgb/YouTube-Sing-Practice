// Runs in the page's MAIN world at document_start. When the YouTube player downloads a caption
// track (/api/timedtext) — i.e. the user turns CC on — a copy of the response is handed to the
// extension's isolated world with window.postMessage. The player's own request is untouched
// (we only read the response), so this works with whatever tokens YouTube requires.
(() => {
  if (window.__yspCaptionHook) return;
  window.__yspCaptionHook = true;
  const MSG = 'ysp-timedtext';
  const isTimedText = (url) => typeof url === 'string' && url.includes('/api/timedtext');
  const post = (url, body) => {
    try {
      if (typeof body === 'string' && body.length > 0 && body.length < 5_000_000) {
        window.postMessage({ source: MSG, url: String(url), body }, window.location.origin);
      }
    } catch { /* never break the player */ }
  };

  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (isTimedText(url)) {
          p.then((res) => res.clone().text()).then((t) => post(url, t)).catch(() => {});
        }
      } catch { /* ignore */ }
      return p;
    };
  } catch { /* ignore */ }

  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      try { this.__yspUrl = String(url); } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      try {
        if (isTimedText(this.__yspUrl)) {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              const body = rt === '' || rt === 'text' ? this.responseText
                : rt === 'json' ? JSON.stringify(this.response) : null;
              if (body) post(this.__yspUrl, body);
            } catch { /* ignore */ }
          });
        }
      } catch { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch { /* ignore */ }
})();
