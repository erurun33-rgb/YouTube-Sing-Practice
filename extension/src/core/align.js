// Line / character alignment used when lyrics are replaced (paste, caption import, LRC) so that
// marks, handwriting and memos follow their line even if the new text differs slightly
// (spacing, punctuation, full/half width, a changed character) or lines were added/removed.

// Comparison key: NFKC (full/half width), lower case, no whitespace / punctuation / symbols.
export function lineKey(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const a = Array.from(s);
  if (a.length < 2) return a.length ? [a[0]] : [];
  const out = [];
  for (let i = 0; i < a.length - 1; i++) out.push(a[i] + a[i + 1]);
  return out;
}

// Dice coefficient on character bigrams of the keys (0..1).
export function similarity(a, b) {
  const ka = lineKey(a), kb = lineKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const A = bigrams(ka), B = bigrams(kb);
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) {
    const c = counts.get(g);
    if (c) { hit++; counts.set(g, c - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

// For each new line, the index of the old line it corresponds to (or -1). Order is preserved:
// 1) longest common subsequence on identical keys, 2) remaining lines paired with the most
// similar unmatched old line between their matched neighbours (similarity >= threshold).
export function alignLines(oldTexts, newTexts, { threshold = 0.6 } = {}) {
  const ok = oldTexts.map(lineKey), nk = newTexts.map(lineKey);
  const n = ok.length, m = nk.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ok[i] && ok[i] === nk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Array(m).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ok[i] && ok[i] === nk[j]) { map[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const used = new Set(map.filter((x) => x >= 0));
  let prev = -1;
  for (let j = 0; j < m; j++) {
    if (map[j] >= 0) { prev = map[j]; continue; }
    let next = n;
    for (let k = j + 1; k < m; k++) if (map[k] >= 0) { next = map[k]; break; }
    let best = -1, bestScore = threshold;
    for (let i = prev + 1; i < next; i++) {
      if (used.has(i)) continue;
      const s = similarity(oldTexts[i], newTexts[j]);
      if (s >= bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) { map[j] = best; used.add(best); prev = best; }
  }
  return map;
}

// Character mapping old index -> new index (or -1), via LCS on normalised characters.
export function charMap(oldText, newText) {
  const a = Array.from(oldText), b = Array.from(newText);
  const na = a.map((c) => c.normalize('NFKC').toLowerCase());
  const nb = b.map((c) => c.normalize('NFKC').toLowerCase());
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Array(a.length).fill(-1);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (na[i] === nb[j]) { map[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

// Move marks to the new text. A mark whose first character disappeared is dropped; its end is
// clamped to the last surviving character of the range.
export function remapMarks(marks, oldText, newText) {
  if (oldText === newText) return marks;
  const map = charMap(oldText, newText);
  const out = [];
  for (const m of marks) {
    const from = map[m.from];
    if (from == null || from < 0) continue;
    let to = from;
    for (let i = m.to; i >= m.from; i--) if (map[i] >= 0) { to = map[i]; break; }
    out.push({ ...m, from, to: Math.max(from, to) });
  }
  return out;
}
