// Phase 1 floating UI inside the YouTube player (works in normal / theater / fullscreen).
// Tabs: 練習 (key + A/B) / 要確認 (checkpoints) / 注釈 (text + handwriting).
// Pure view: every user action is forwarded to `actions`; state comes in via render*().

import { formatTime } from '../core/geometry.js';
import { CHECKPOINT_LABELS, DEFAULT_LEAD, DEFAULT_HOLD } from '../core/store.js';
import { createLyricsTab } from './lyrics-tab.js';

const POS_KEY = 'ysp:panelPos';
const TAB_KEY = 'ysp:panelTab';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: absolute; left: 12px; top: 12px; font: 12px/1.4 system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif; color: #eee; }
.launcher { width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,.5);
  background: rgba(20,20,24,.75); color: #fff; font-size: 16px; cursor: pointer; position: relative; opacity: .75; }
.launcher:hover, .launcher.open { opacity: 1; }
.badge { position: absolute; right: -6px; bottom: -4px; background: #1a73e8; color: #fff; font-size: 10px;
  border-radius: 8px; padding: 0 4px; line-height: 14px; }
.panel { margin-top: 6px; width: 320px; max-height: var(--maxh, 420px); overflow: auto; background: rgba(20,20,24,.94);
  border: 1px solid #555; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 2px; padding: 4px; border-bottom: 1px solid #444; cursor: move; position: sticky; top: 0; background: rgba(20,20,24,.98); z-index: 1; }
.tab { flex: 1; background: transparent; border: none; color: #bbb; padding: 5px 0; border-radius: 4px; cursor: pointer; font: inherit; }
.tab.on { background: #333; color: #fff; font-weight: 700; }
.body { padding: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 6px; }
.lbl { width: 30px; color: #aaa; }
button { font: inherit; color: #eee; background: #333; border: 1px solid #666; border-radius: 4px; padding: 3px 7px; cursor: pointer; }
button:hover { background: #444; }
button.on { background: #1a73e8; border-color: #1a73e8; }
button.primary { background: #c2185b; border-color: #c2185b; }
button.chip { border-radius: 12px; padding: 2px 8px; }
.val { min-width: 34px; text-align: center; font-weight: 700; font-size: 15px; }
.tval { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
.note { color: #ffd60a; font-size: 11px; }
.muted { color: #999; font-size: 11px; }
.list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.item { display: grid; grid-template-columns: auto 1fr auto; gap: 4px; align-items: center; background: #26262b; border-radius: 6px; padding: 4px; }
.item .time { font-variant-numeric: tabular-nums; color: #8ab4f8; background: transparent; border: none; padding: 2px 4px; text-decoration: underline; }
.item .fields { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.item input { font: inherit; color: #eee; background: #1b1b1f; border: 1px solid #444; border-radius: 3px; padding: 2px 4px; width: 100%; }
.item .del { color: #ff8a80; }
.item .sub { display: flex; gap: 4px; align-items: center; color: #aaa; font-size: 11px; }
.item .sub input { width: 44px; }
.preview { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { border-top: 1px solid #444; padding: 4px 8px; color: #999; font-size: 11px; display: flex; justify-content: space-between; gap: 6px; }
.notice { background: #5c2b00; color: #ffd8a8; border-bottom: 1px solid #a85a00; padding: 6px 8px; font-size: 12px; line-height: 1.4; }
.notice[hidden] { display: none; }
.metrics { font: 10px/1.35 ui-monospace, monospace; color: #aaa; white-space: pre; padding: 0 8px 6px; }
.err { color: #ff8a80; }
.backup { border-top: 1px solid #444; margin-top: 8px; padding-top: 6px; }
`;

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export function createPanel({ actions }) {
  const host = el('div', { id: 'ysp-panel-host' });
  Object.assign(host.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', zIndex: '80' });
  const root = host.attachShadow({ mode: 'open' });
  const lyricsTab = createLyricsTab({ actions });
  root.append(el('style', { text: CSS + lyricsTab.css }));

  // Keep the player from reacting to our clicks and keys (play/pause, fullscreen, shortcuts).
  for (const type of ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'pointerdown', 'contextmenu', 'wheel']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  let tab = lsGet(TAB_KEY, 'practice');
  let open = false;
  let data = null;
  let status = null;
  let showDebug = false;
  let visible = true;
  let suspended = false;

  const btn = (text, onclick, extra = {}) => el('button', { text, onclick, ...extra });

  // ---- 練習 tab ----
  const keyVal = el('span', { class: 'val', text: '0' });
  const procBtn = btn('加工ON', () => actions.toggleEnabled(), { title: 'OFFで加工なしの通常音声' });
  const pendingNote = el('div', { class: 'note', text: '' });
  const aVal = el('span', { class: 'tval', text: '-' });
  const bVal = el('span', { class: 'tval', text: '-' });
  const loopBtn = btn('Loop OFF', () => actions.toggleLoop());
  const backupFile = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', 'data-backup': 'file' });
  backupFile.addEventListener('change', async () => {
    const f = backupFile.files && backupFile.files[0];
    if (f) actions.backupImport(await f.text());
    backupFile.value = '';
  });
  const practice = el('div', {}, [
    el('div', { class: 'row' }, [
      el('span', { class: 'lbl', text: 'キー' }),
      btn('−', () => actions.stepKey(-1), { title: '半音下げる' }), keyVal, btn('+', () => actions.stepKey(1), { title: '半音上げる' }),
      btn('0', () => actions.setKey(0), { title: '原曲キーに戻す' }), procBtn,
    ]),
    pendingNote,
    el('div', { class: 'row' }, [
      el('span', { class: 'lbl', text: 'A' }), btn('Set', () => actions.setA(), { 'data-ab': 'a' }),
      btn('-0.1', () => actions.nudge('a', -1)), aVal, btn('+0.1', () => actions.nudge('a', 1)),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'lbl', text: 'B' }), btn('Set', () => actions.setB(), { 'data-ab': 'b' }),
      btn('-0.1', () => actions.nudge('b', -1)), bVal, btn('+0.1', () => actions.nudge('b', 1)),
    ]),
    el('div', { class: 'row' }, [el('span', { class: 'lbl', text: '' }), loopBtn, btn('Clear', () => actions.clearLoop())]),
    backupFile,
    el('div', { class: 'backup' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: '全データ' }),
        btn('バックアップを保存', () => actions.backupExport(), { 'data-backup': 'export', title: '全動画の練習データと記号の設定をファイルに保存' }),
        btn('読み込む', () => backupFile.click(), { 'data-backup': 'import', title: '保存したバックアップファイルから戻す' }),
      ]),
      el('div', { class: 'muted', text: 'データはこのPCのChromeの中だけに保存されます。PCの移行や拡張の入れ直しの前に保存してください。' }),
    ]),
  ]);

  // ---- 要確認 tab ----
  const cpList = el('div', { class: 'list' });
  const checkpoints = el('div', {}, [
    el('div', { class: 'row' }, [btn('＋ 今の位置を登録', () => actions.addCheckpoint(''), { class: 'primary' })]),
    el('div', { class: 'row' }, CHECKPOINT_LABELS.map((l) => btn(l, () => actions.addCheckpoint(l), { class: 'chip', title: `「${l}」で登録` }))),
    cpList,
  ]);

  // ---- 注釈 tab ----
  const showBtn = btn('表示ON', () => actions.toggleAnnotations());
  const anList = el('div', { class: 'list' });
  const annotations = el('div', {}, [
    el('div', { class: 'row' }, [
      btn('＋ テキスト', () => actions.addText(), { class: 'primary' }),
      btn('＋ 手書き', () => actions.addInk(), { class: 'primary' }),
      showBtn,
    ]),
    el('div', { class: 'muted', text: '注釈は「映像の位置と時間」に付きます（歌詞の手書きは「歌詞の行」に付き、その行が出ている間だけ表示）。一時停止中は動画上の文字をドラッグで移動、ダブルクリックで編集できます' }),
    anList,
  ]);

  const bodies = { practice, checkpoints, annotations, lyrics: lyricsTab.el };
  const tabs = [['practice', '練習'], ['lyrics', '歌詞'], ['checkpoints', '要確認'], ['annotations', '注釈']].map(([id, label]) =>
    el('button', { class: 'tab', text: label, 'data-tab': id, onclick: () => setTab(id) }));
  const body = el('div', { class: 'body' });
  const statusLeft = el('span', { text: '' });
  const debugBtn = el('button', { text: '詳細', onclick: () => { showDebug = !showDebug; renderStatus(); }, style: 'padding:0 5px' });
  const copyBtn = el('button', { text: 'ログ', onclick: () => actions.copyLog(), title: 'ログをコピー', style: 'padding:0 5px' });
  const metrics = el('div', { class: 'metrics' });
  const head = el('div', { class: 'head' }, tabs);
  const notice = el('div', { class: 'notice', hidden: '' });
  const panel = el('div', { class: 'panel', hidden: '' }, [head, notice, body, el('div', { class: 'status' }, [statusLeft, el('span', {}, [copyBtn, debugBtn])]), metrics]);
  const badge = el('span', { class: 'badge', text: '' });
  const launcher = el('button', { class: 'launcher', text: '♪', title: '歌練習パネル', onclick: () => setOpen(!open) }, [badge]);
  const wrap = el('div', { class: 'wrap' }, [launcher, panel]);
  root.append(wrap);

  // Drag the panel by its tab bar; position is remembered.
  const pos = lsGet(POS_KEY, null);
  if (pos) { wrap.style.left = `${pos.left}px`; wrap.style.top = `${pos.top}px`; }
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tab')) return;
    const sx = e.clientX, sy = e.clientY;
    const l0 = wrap.offsetLeft, t0 = wrap.offsetTop;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { wrap.style.left = `${Math.max(0, l0 + ev.clientX - sx)}px`; wrap.style.top = `${Math.max(0, t0 + ev.clientY - sy)}px`; };
    const up = () => {
      head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up);
      lsSet(POS_KEY, { left: wrap.offsetLeft, top: wrap.offsetTop });
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  function setOpen(v) {
    open = !!v;
    panel.hidden = !open;
    launcher.classList.toggle('open', open);
    actions.panelChanged?.({ open, tab });
  }

  function setTab(id, notify = true) {
    tab = bodies[id] ? id : 'practice';
    lsSet(TAB_KEY, tab);
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    body.replaceChildren(bodies[tab]);
    if (notify) actions.panelChanged?.({ open, tab });
  }

  function numInput(value, onchange, title) {
    return el('input', { type: 'number', step: '0.5', min: '0', value: String(value), title, onchange: (e) => onchange(Number(e.target.value)) });
  }

  function renderLists() {
    if (!data) return;
    cpList.replaceChildren(...(data.checkpoints.length ? data.checkpoints.map((c) => el('div', { class: 'item', 'data-id': c.id }, [
      el('button', { class: 'time', text: formatTime(c.t), title: 'この位置へジャンプ', onclick: () => actions.seek(c.t) }),
      el('div', { class: 'fields' }, [
        el('input', { value: c.label, placeholder: 'ラベル', list: 'ysp-labels', onchange: (e) => actions.updateCheckpoint(c.id, { label: e.target.value }) }),
        el('input', { value: c.note, placeholder: 'メモ', onchange: (e) => actions.updateCheckpoint(c.id, { note: e.target.value }) }),
      ]),
      btn('×', () => actions.removeCheckpoint(c.id), { class: 'del', title: '削除' }),
    ])) : [el('div', { class: 'muted', text: 'まだありません。苦手な所で「＋」かラベルを押して登録します。' })]));

    // Video annotations and handwriting attached to lyric lines, merged in time order.
    const off = data.lyrics.offset;
    const lineInk = data.lyrics.lines.filter((l) => l.ink.length).map((l) => ({ kind: 'lyric', line: l, time: l.t == null ? Infinity : l.t + off }));
    const items = [...data.annotations.map((a) => ({ kind: 'ann', a, time: a.at })), ...lineInk].sort((x, y) => x.time - y.time);
    anList.replaceChildren(...(items.length ? items.map((it) => (it.kind === 'lyric' ? el('div', { class: 'item lyric-ink', 'data-line': it.line.id }, [
      it.line.t == null
        ? el('span', { class: 'time', text: '--:--' })
        : el('button', { class: 'time', text: formatTime(it.time), title: 'この行へジャンプ', onclick: () => actions.lyricsSeekLine(it.line.id) }),
      el('div', { class: 'fields' }, [
        el('div', { class: 'preview', text: `✎ 歌詞「${it.line.text}」（${it.line.ink.length}本）` }),
        el('div', { class: 'sub' }, [btn('編集', () => actions.lyricsLineInk(it.line.id), { title: 'この行の手書きを編集' }), '歌詞の行に付いた手書き']),
      ]),
      btn('×', () => actions.lyricsClearInk(it.line.id), { class: 'del', title: 'この行の手書きを削除' }),
    ]) : ((a) => el('div', { class: 'item', 'data-id': a.id }, [
      el('button', { class: 'time', text: formatTime(a.at), title: '表示開始位置へジャンプ', onclick: () => actions.seek(a.from, { pause: true }) }),
      el('div', { class: 'fields' }, [
        a.type === 'text'
          ? el('input', { value: a.text, onchange: (e) => actions.updateAnnotation(a.id, { text: e.target.value }) })
          : el('div', { class: 'preview', text: `✎ 手書き（${a.strokes.length}本）` }),
        el('div', { class: 'sub' }, [
          '前', numInput(+(a.at - a.from).toFixed(1), (v) => actions.updateAnnotation(a.id, { lead: v }), `何秒前から表示（既定${DEFAULT_LEAD}）`),
          '後', numInput(+(a.to - a.at).toFixed(1), (v) => actions.updateAnnotation(a.id, { hold: v }), `何秒後まで表示（既定${DEFAULT_HOLD}）`),
          '秒',
        ]),
      ]),
      btn('×', () => actions.removeAnnotation(a.id), { class: 'del', title: '削除' }),
    ]))(it.a))) : [el('div', { class: 'muted', text: 'まだありません。止めたい場面で「＋ テキスト」か「＋ 手書き」。' })]));
  }

  function renderStatus() {
    if (!status) return;
    const a = status.audio;
    keyVal.textContent = a.semitones > 0 ? `+${a.semitones}` : String(a.semitones);
    procBtn.textContent = a.enabled ? '加工ON' : '加工OFF';
    procBtn.classList.toggle('on', a.enabled);
    pendingNote.textContent = a.pendingGesture ? 'キーは画面をクリックすると適用されます（ブラウザの制限）' : '';
    const l = status.loop;
    aVal.textContent = l.a == null ? '-' : formatTime(l.a);
    bVal.textContent = l.b == null ? '-' : formatTime(l.b);
    loopBtn.textContent = l.enabled ? 'Loop ON' : 'Loop OFF';
    loopBtn.classList.toggle('on', l.enabled);
    showBtn.textContent = status.annotationsVisible ? '表示ON' : '表示OFF';
    showBtn.classList.toggle('on', status.annotationsVisible);
    if (notice.hidden) {
      badge.textContent = a.semitones ? (a.semitones > 0 ? `+${a.semitones}` : String(a.semitones)) : '';
      badge.hidden = !a.semitones;
    }
    statusLeft.textContent = a.error ? `⚠ ${a.error}` : `${a.processing ? `キー変更中・遅延${a.dspLatencyMs}ms` : '原音'}${status.saved === false ? '・未保存' : ''}`;
    statusLeft.className = a.error ? 'err' : '';
    const st = a.stats || {};
    metrics.textContent = showDebug ? [
      `videoId ${status.videoId ?? '-'}  x${status.playbackRate ?? '-'}`,
      `audio ${a.mode}/${a.ctxState} out ${a.outputLatencyMs ?? '-'}ms`,
      `blocks act ${st.activeBlocks ?? '-'} idle ${st.idleBlocks ?? '-'} byp ${st.bypassBlocks ?? '-'} resets ${st.resets ?? '-'}`,
      `loops ${l.loops}  heap ${status.heapMB ?? '-'}MB`,
    ].join('\n') : '';
    lyricsTab.setStatus(status);
    host.setAttribute('data-ysp-status', JSON.stringify(status));
  }

  const labels = el('datalist', { id: 'ysp-labels' }, CHECKPOINT_LABELS.map((l) => el('option', { value: l })));
  root.append(labels);
  setTab(tab, false);

  return {
    host,
    mount(player) {
      if (player && host.parentNode !== player) player.append(host);
      const h = player?.getBoundingClientRect().height || 480;
      wrap.style.setProperty('--maxh', `${Math.max(160, h - 70)}px`);
    },
    setVisible(v) { visible = !!v; host.style.display = visible && !suspended ? '' : 'none'; },
    // Hidden while placing/drawing an annotation so the whole picture is usable.
    // Persistent warning at the top of the panel (e.g. extension updated → reload the tab).
    setNotice(text) {
      notice.textContent = text || '';
      notice.hidden = !text;
      if (text) { badge.textContent = '!'; badge.hidden = false; badge.style.background = '#d93025'; setOpen(true); }
    },
    setSuspended(v) { suspended = !!v; host.style.display = visible && !suspended ? '' : 'none'; },
    setOpen,
    setTab,
    get state() { return { open, tab }; },
    renderData(d) { data = d; renderLists(); },
    renderLyrics(lyrics, markTypes) { lyricsTab.set(lyrics, markTypes); },
    renderStatus(s) { status = s; renderStatus(); },
  };
}
