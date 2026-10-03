// "歌詞" tab of the panel (Phase 2): paste lyrics, tap-sync timing, display settings,
// line editor (marks / handwriting / loop / checkpoint / memo) and the mark palette editor.
// View only: all changes go through `actions`; UI-only state (selection, open sections) lives here.

import { formatTime } from '../core/geometry.js';
import { chars, lyricsText, markSymbol, lineTokens } from '../core/lyrics.js';
import { MARK_COLORS } from '../core/settings.js';

export const LYRICS_TAB_CSS = `
.ly-lines { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.ly-row { display: grid; grid-template-columns: 52px 1fr; gap: 4px; align-items: center; padding: 3px 4px;
  border-radius: 4px; background: #26262b; cursor: pointer; }
.ly-row.sel { outline: 1px solid #1a73e8; background: #1d2a3f; }
.ly-row.cur { border-left: 3px solid #ffd60a; }
.ly-row.tapnext { background: #3b2350; outline: 1px solid #b267e6; }
.ly-chars .ins { font-size: 14px; padding: 14px 1px 2px; opacity: .95; }
.type-row button.place { min-width: 44px; padding: 2px 4px; font-size: 11px; }
.ly-row .time { font-variant-numeric: tabular-nums; color: #8ab4f8; font-size: 11px; }
.ly-row .time.none { color: #777; }
.ly-row .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ly-edit { background: #1f1f24; border: 1px solid #444; border-radius: 6px; padding: 6px; margin-top: 6px; }
.ly-chars { display: flex; flex-wrap: wrap; gap: 1px; font-size: 18px; margin: 4px 0 6px; user-select: none; }
.ly-chars .c { position: relative; padding: 14px 2px 2px; border-radius: 3px; cursor: pointer; min-width: 14px; text-align: center; }
.ly-chars .c.on { background: #1a73e8; }
.ly-chars .c .m { position: absolute; top: 0; left: 50%; transform: translateX(-50%); font-size: 11px; white-space: nowrap; }
.palette { display: flex; flex-wrap: wrap; gap: 3px; }
.palette button { min-width: 28px; }
.mk-list { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.mk-row { display: flex; gap: 4px; align-items: center; font-size: 11px; }
.mk-row input { flex: 1; }
.types { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
.type-row { display: flex; gap: 3px; align-items: center; }
.type-row input.sym { width: 38px; text-align: center; }
.type-row input.nm { flex: 1; }
.type-row select { width: 58px; }
textarea.paste { width: 100%; min-height: 140px; font: inherit; color: #eee; background: #1b1b1f; border: 1px solid #444; border-radius: 4px; padding: 4px; }
.ly-sticky { position: sticky; top: 37px; z-index: 1; background: rgba(20,20,24,.98); padding: 2px 0; }
.ly-sticky:empty { display: none; }
.loopbar { display: flex; align-items: center; gap: 6px; background: #12324f; border: 1px solid #1a73e8; border-radius: 6px; padding: 4px 6px; margin-top: 4px; }
.loopbar .t { flex: 1; font-variant-numeric: tabular-nums; }
.imp { background: #1f262d; border: 1px solid #3d5a73; border-radius: 6px; padding: 6px; margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.imp h4 { margin: 2px 0; font-size: 12px; color: #9ecbff; }
.imp .track { display: flex; align-items: center; gap: 6px; }
.imp .track span { flex: 1; }
.rec { background: #3a1d1d; border: 1px solid #c0392b; border-radius: 6px; padding: 6px; margin-top: 6px; }
.rec .now { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; font-weight: 700; }
.tap { background: #2a1f33; border: 1px solid #7b3fa0; border-radius: 6px; padding: 6px; margin-top: 6px; }
.tap .big { width: 100%; font-size: 16px; padding: 10px; margin: 4px 0; }
.tap .nexttxt { font-size: 14px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
input.small { width: 100%; }
`;

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export function createLyricsTab({ actions }) {
  const root = el('div', { class: 'ly-tab' });
  let lyrics = null;
  let markTypes = [];
  let status = null;
  // UI-only state
  let pasting = false;
  let showTypes = false;
  let importing = false; // import / export box open
  let selFrom = -1; // selected line range (indexes)
  let selTo = -1;
  let charSel = null; // { from, to } inside the first selected line
  let dragStart = -1;
  let lastKey = '';

  const btn = (text, onclick, extra = {}) => el('button', { text, onclick, ...extra });
  const selectedLine = () => (lyrics && selFrom >= 0 ? lyrics.lines[selFrom] : null);

  function selectLine(i, extend) {
    if (extend && selFrom >= 0) selTo = i;
    else { selFrom = i; selTo = i; }
    charSel = null;
    force();
  }

  function force() { lastKey = ''; render(); }

  function renderToolbar() {
    const d = lyrics.display;
    return el('div', {}, [
      el('div', { class: 'row' }, [
        btn(lyrics.lines.length ? '歌詞を編集' : '＋ 歌詞を貼り付け', () => { pasting = !pasting; force(); }, { class: 'primary' }),
        lyrics.lines.length ? btn('タップ合わせ', () => actions.lyricsTapStart(Math.max(0, selFrom)), { title: '選択行（なければ先頭）から、歌い出しごとにタップして時刻を入れます' }) : null,
        btn('取り込み・書き出し', () => { importing = !importing; force(); }, { class: importing ? 'on' : '', title: 'YouTube字幕・LRCファイルから取り込み／LRCで書き出し' }),
        lyrics.lines.length ? btn(d.visible ? '表示ON' : '表示OFF', () => actions.lyricsDisplay({ visible: !d.visible }), { class: d.visible ? 'on' : '' }) : null,
      ]),
      lyrics.lines.length ? el('div', { class: 'row' }, [
        btn(d.position === 'bottom' ? '位置:下' : '位置:上', () => actions.lyricsDisplay({ position: d.position === 'bottom' ? 'top' : 'bottom' })),
        btn('文字−', () => actions.lyricsDisplay({ size: d.size - 0.1 })),
        btn('文字+', () => actions.lyricsDisplay({ size: d.size + 0.1 })),
        btn('次の行', () => actions.lyricsDisplay({ showNext: !d.showNext }), { class: d.showNext ? 'on' : '' }),
        btn('YT字幕を隠す', () => actions.lyricsDisplay({ hideYouTubeCaptions: !d.hideYouTubeCaptions }), { class: d.hideYouTubeCaptions ? 'on' : '' }),
      ]) : null,
      lyrics.lines.length ? el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: '全体ずらし' }),
        btn('-0.1', () => actions.lyricsOffset(-0.1)),
        el('span', { class: 'tval', text: `${lyrics.offset >= 0 ? '+' : ''}${lyrics.offset.toFixed(1)}s` }),
        btn('+0.1', () => actions.lyricsOffset(0.1)),
      ]) : null,
    ]);
  }

  function renderPaste() {
    const ta = el('textarea', { class: 'paste', placeholder: '歌詞を貼り付け（1行＝画面に出す1行。空行は無視）' });
    ta.value = lyricsText(lyrics);
    return el('div', {}, [
      ta,
      el('div', { class: 'row' }, [
        btn('保存', () => { actions.lyricsSetText(ta.value); pasting = false; selFrom = selTo = -1; force(); }, { class: 'primary' }),
        btn('取消', () => { pasting = false; force(); }),
      ]),
      el('div', { class: 'muted', text: '同じ文の行は、時刻や記号をそのまま引き継ぎます。' }),
    ]);
  }

  function langLabel(t) {
    const names = { ja: '日本語', en: '英語', ko: '韓国語', 'zh-Hans': '中国語(簡体)', 'zh-Hant': '中国語(繁体)' };
    return `${names[t.lang] || t.lang}${t.auto ? '（自動生成）' : ''}`;
  }

  function renderImport() {
    const caps = status?.captions || [];
    const file = el('input', { type: 'file', accept: '.lrc,.txt,text/plain', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (f) actions.lyricsImportLrc(await f.text());
      file.value = '';
    });
    return el('div', { class: 'imp' }, [
      el('h4', { text: 'YouTubeの字幕から' }),
      ...(caps.length
        ? caps.map((t) => el('div', { class: 'track' }, [
          el('span', { text: `${langLabel(t)}　${t.count}行` }),
          btn('取り込む', () => actions.lyricsImportTrack(t.key), { class: 'primary', title: '字幕の文と時刻で歌詞を作ります' }),
          btn('時刻だけ使う', () => actions.lyricsTimesFromTrack(t.key), { disabled: !lyrics.lines.length, title: '貼り付けた歌詞の文はそのままで、字幕の時刻だけを各行に入れます（自動生成字幕でもOK）' }),
        ]))
        : [el('div', { class: 'muted', text: 'YouTubeの字幕（CC）をONにすると、ここに取り込める字幕が出ます。出ない場合は「再生しながら記録」を使ってください。' })]),
      el('div', { class: 'row' }, [
        btn('再生しながら記録', () => actions.lyricsRecordStart(), { title: '画面に出るYouTube字幕を、再生しながら時刻ごと記録します（倍速再生でもOK）', disabled: !!status?.recording }),
      ]),
      el('div', { class: 'muted', text: '自動生成の字幕は文字の精度が低いことがあります。その場合は、正しい歌詞を貼り付けてから「時刻だけ使う」がおすすめです。' }),
      el('h4', { text: '映像の中の歌詞から時刻を取る' }),
      el('div', { class: 'muted', text: '動画に歌詞の文字が映っている場合：先に歌詞を貼り付け、歌詞が出る範囲を囲んで再生すると、文字が切り替わった時刻を上の行から順に入れます（選択中の行があればその行から）。' }),
      el('div', { class: 'row' }, [
        btn('範囲を指定して開始', () => actions.lyricsFrameStart(Math.max(0, selFrom), false), { disabled: !lyrics.lines.length || !!status?.frameRec }),
        status?.region ? btn('前回の範囲で開始', () => actions.lyricsFrameStart(Math.max(0, selFrom), true), { disabled: !lyrics.lines.length || !!status?.frameRec }) : null,
      ]),
      el('h4', { text: 'LRCファイル' }),
      el('div', { class: 'row' }, [
        file,
        btn('LRCを開く', () => file.click()),
        btn('LRCで書き出し', () => actions.lyricsExportLrc(), { disabled: !lyrics.lines.length, title: '時刻付きの歌詞を .lrc で保存（記号・手書きは含まれません）' }),
      ]),
      el('div', { class: 'muted', text: 'LRCの中身を「歌詞を貼り付け」欄に貼っても、時刻付きで読み込めます。' }),
    ]);
  }

  function renderRecording() {
    const r = status?.recording;
    if (!r) return null;
    return el('div', { class: 'rec' }, [
      el('div', { class: 'muted', text: `● 字幕を記録中　${r.count}行` }),
      el('div', { class: 'now', text: r.current || '（字幕待ち）' }),
      el('div', { class: 'row' }, [
        btn('記録を終えて取り込む', () => actions.lyricsRecordStop(true), { class: 'primary' }),
        lyrics.lines.length ? btn('時刻だけ使う', () => actions.lyricsRecordStop('times'), { title: '貼り付けた歌詞の文はそのままで、記録した字幕の時刻だけを入れます' }) : null,
        btn('やめる', () => actions.lyricsRecordStop(false)),
      ]),
    ]);
  }

  function renderFrameRec() {
    const f = status?.frameRec;
    if (!f) return null;
    return el('div', { class: 'rec' }, [
      el('div', { class: 'muted', text: `● 映像の歌詞を検出中　切り替わり ${f.detected} か所（歌詞 ${lyrics.lines.length - f.from} 行ぶん）` }),
      el('div', { class: 'muted', text: '歌詞の最後まで再生したら「終了して時刻を入れる」。倍速再生でもOK' }),
      el('div', { class: 'row' }, [
        btn('終了して時刻を入れる', () => actions.lyricsFrameStop(true), { class: 'primary' }),
        btn('やめる', () => actions.lyricsFrameStop(false)),
      ]),
    ]);
  }

  function renderLoopBar() {
    const l = status?.loop;
    if (!l || !l.enabled || l.a == null || l.b == null) return null;
    return el('div', { class: 'loopbar' }, [
      el('span', { class: 't', text: `🔁 ループ中 ${formatTime(l.a)}–${formatTime(l.b)}` }),
      btn('解除', () => actions.toggleLoop(), { class: 'primary', title: 'ループをやめる（A/Bは残ります）' }),
    ]);
  }

  function renderTap() {
    const i = status.tap.index;
    const line = lyrics.lines[i];
    return el('div', { class: 'tap' }, [
      el('div', { class: 'muted', text: `タップ合わせ中 ${Math.min(i + 1, lyrics.lines.length)}/${lyrics.lines.length}（Enterキーでも可）` }),
      el('div', { class: 'nexttxt', text: line ? `次: ${line.text}` : '最後まで入力しました' }),
      line ? btn('TAP（歌い出し）', () => actions.lyricsTap(), { class: 'primary big' }) : null,
      el('div', { class: 'row' }, [btn('1つ戻す', () => actions.lyricsTapUndo()), btn('終了', () => actions.lyricsTapStop())]),
    ]);
  }

  function renderEditor() {
    const line = selectedLine();
    if (!line) return null;
    const multi = selTo !== selFrom;
    const [lo, hi] = selFrom <= selTo ? [selFrom, selTo] : [selTo, selFrom];
    const cs = chars(line.text);
    // Ruby marks sit above the middle of their range; 'before' marks are inserted inline.
    const markAt = new Map();
    for (const m of line.marks) {
      if (markSymbol(m, markTypes).placement === 'before') continue;
      const mid = Math.floor((m.from + m.to) / 2);
      markAt.set(mid, [...(markAt.get(mid) || []), m]);
    }
    const charEls = lineTokens(line, markTypes).map((tk) => {
      if (tk.kind === 'ins') {
        const s = el('span', { class: 'ins', text: tk.sym.symbol, title: tk.sym.name });
        s.style.color = tk.sym.color;
        return s;
      }
      const i = tk.i;
      const on = charSel && i >= Math.min(charSel.from, charSel.to) && i <= Math.max(charSel.from, charSel.to);
      const e = el('span', { class: `c${on ? ' on' : ''}`, 'data-i': String(i) }, [tk.c]);
      for (const m of markAt.get(i) || []) {
        const sym = markSymbol(m, markTypes);
        const s = el('span', { class: 'm', text: sym.symbol });
        s.style.color = sym.color;
        e.append(s);
      }
      e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); dragStart = i; charSel = { from: i, to: i }; force(); });
      e.addEventListener('pointerenter', (ev) => { if (dragStart >= 0 && (ev.buttons & 1)) { charSel = { from: dragStart, to: i }; force(); } });
      return e;
    });
    const hasSel = !!charSel;
    const from = hasSel ? Math.min(charSel.from, charSel.to) : -1;
    const to = hasSel ? Math.max(charSel.from, charSel.to) : -1;
    return el('div', { class: 'ly-edit' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: multi ? `${hi - lo + 1}行を選択中` : `行 ${selFrom + 1}` }),
        btn(line.t == null ? '今の時刻にする' : formatTime(line.t + lyrics.offset), () => actions.lyricsSetNow(line.id), { title: '今の再生位置をこの行の歌い出しにする' }),
        line.t != null ? btn('-0.1', () => actions.lyricsNudge(line.id, -0.1)) : null,
        line.t != null ? btn('+0.1', () => actions.lyricsNudge(line.id, 0.1)) : null,
        line.t != null ? btn('×時刻', () => actions.lyricsClearTime(line.id), { title: '時刻を消す' }) : null,
      ]),
      el('div', { class: 'row' }, [
        btn(multi ? '選択行をループ' : 'この行をループ', () => actions.lyricsLoopLines(lo, hi)),
        btn('要確認に追加', () => actions.lyricsCheckpoint(line.id)),
        btn('この行に手書き', () => actions.lyricsLineInk(line.id), { title: 'この歌詞の行に貼り付く手書き（行が表示されている間だけ出ます）。映像の位置に書くときは「注釈」タブの「＋ 手書き」' }),
        line.ink.length ? btn('手書き消去', () => actions.lyricsClearInk(line.id)) : null,
      ]),
      multi ? null : el('div', { class: 'muted', text: '文字をなぞって選び、記号を押すと付きます（V ＿ ／ ｜ などは選んだ最初の文字の前に入ります）' }),
      multi ? null : el('div', { class: 'ly-chars' }, charEls),
      multi ? null : el('div', { class: 'palette' }, markTypes.map((t) => {
        const b = btn(t.symbol, () => { if (hasSel) { actions.lyricsAddMark(line.id, from, to, t); charSel = null; } }, { title: t.name, disabled: !hasSel });
        b.style.color = t.color;
        return b;
      })),
      multi || !line.marks.length ? null : el('div', { class: 'mk-list' }, line.marks.map((m) => {
        const sym = markSymbol(m, markTypes);
        const label = `${sym.symbol} ${cs.slice(m.from, m.to + 1).join('')}`;
        return el('div', { class: 'mk-row' }, [
          el('span', { text: label, style: `color:${sym.color}` }),
          el('input', { class: 'small', value: m.note, placeholder: 'メモ', onchange: (e) => actions.lyricsUpdateMark(line.id, m.id, { note: e.target.value }) }),
          btn('×', () => actions.lyricsRemoveMark(line.id, m.id), { class: 'del', title: 'この記号を削除' }),
        ]);
      })),
      multi ? null : el('input', { class: 'small', value: line.memo, placeholder: 'この行のメモ', onchange: (e) => actions.lyricsMemo(line.id, e.target.value) }),
    ]);
  }

  function renderTypes() {
    return el('div', {}, [
      btn(showTypes ? '記号の編集を閉じる' : '記号を編集', () => { showTypes = !showTypes; force(); }),
      showTypes ? el('div', { class: 'types' }, [
        ...markTypes.map((t) => el('div', { class: 'type-row' }, [
          el('input', { class: 'sym', value: t.symbol, maxlength: '3', onchange: (e) => actions.markTypeUpdate(t.id, { symbol: e.target.value }) }),
          el('input', { class: 'nm', value: t.name, placeholder: '名前', onchange: (e) => actions.markTypeUpdate(t.id, { name: e.target.value }) }),
          el('select', { onchange: (e) => actions.markTypeUpdate(t.id, { color: e.target.value }) },
            MARK_COLORS.map((c) => {
              const o = el('option', { value: c, text: '■', selected: c === t.color });
              o.style.color = c;
              return o;
            })),
          btn(t.placement === 'before' ? '前に挿入' : 'ルビ', () => actions.markTypeUpdate(t.id, { placement: t.placement === 'before' ? 'ruby' : 'before' }),
            { class: 'place', title: '表示方法：文字の上（ルビ）／文字の前に挿入' }),
          btn('×', () => actions.markTypeRemove(t.id), { class: 'del', title: '記号の種類を削除（付けた記号は残ります）' }),
        ])),
        btn('＋ 記号を追加', () => actions.markTypeAdd({ symbol: '★', name: '新しい記号' })),
      ]) : null,
    ]);
  }

  function renderList() {
    const cur = status?.lyricsCurrent ?? -1;
    const tapIdx = status?.tap ? status.tap.index : -1;
    const [lo, hi] = selFrom <= selTo ? [selFrom, selTo] : [selTo, selFrom];
    return el('div', { class: 'ly-lines' }, lyrics.lines.map((l, i) => {
      const cls = `ly-row${i >= lo && i <= hi && lo >= 0 && tapIdx < 0 ? ' sel' : ''}${i === cur ? ' cur' : ''}${i === tapIdx ? ' tapnext' : ''}`;
      const row = el('div', { class: cls, 'data-i': String(i) }, [
        el('span', {
          class: `time${l.t == null ? ' none' : ''}`,
          text: l.t == null ? '--:--' : formatTime(l.t + lyrics.offset),
          title: l.t == null ? '' : 'この行から再生',
          onclick: (e) => { if (l.t != null) { e.stopPropagation(); actions.lyricsSeekLine(l.id); } },
        }),
        el('span', { class: 'txt', text: `${l.marks.length ? '♦ ' : ''}${l.ink.length ? '✎ ' : ''}${l.text}` }),
      ]);
      row.addEventListener('click', (e) => selectLine(i, e.shiftKey));
      return row;
    }));
  }

  // Don't rebuild while the user is typing in one of our inputs (e.g. the current line changes
  // during playback); re-render once focus leaves.
  function typing() {
    const a = root.getRootNode().activeElement;
    return !!a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }
  root.addEventListener('focusout', () => setTimeout(render, 0));

  function render() {
    if (!lyrics || typing()) return;
    const key = JSON.stringify([
      lyrics, markTypes.length, markTypes.map((t) => t.id + t.symbol + t.color + t.name + t.placement).join(),
      // While pasting, playback state must not rebuild the textarea / its buttons.
      pasting ? null : status?.tap, pasting ? null : status?.lyricsCurrent, pasting, showTypes, selFrom, selTo, charSel,
      status?.loop ? [status.loop.a, status.loop.b, status.loop.enabled] : null,
      importing, status?.captions, status?.recording, status?.frameRec, status?.lyricsMsg, !!status?.region,
    ]);
    if (key === lastKey) return;
    lastKey = key;
    if (selFrom >= lyrics.lines.length) selFrom = selTo = -1;
    const parts = [renderToolbar()];
    if (status?.recording || status?.frameRec) parts.push(el('div', { class: 'ly-sticky' }, [renderRecording(), renderFrameRec()]));
    if (status?.lyricsMsg) parts.push(el('div', { class: 'loopbar', text: status.lyricsMsg }));
    if (importing) parts.push(renderImport());
    if (pasting || !lyrics.lines.length) {
      if (!lyrics.lines.length && !pasting) {
        parts.push(el('div', { class: 'muted', text: '歌詞を貼り付けて、タップで歌い出しの時刻を合わせます。YouTube字幕やLRCファイルからの取り込みは「取り込み・書き出し」から。歌詞はこのPCにだけ保存されます。' }));
      } else parts.push(renderPaste());
    } else {
      // Pinned under the tab bar so they never scroll away: active loop (with 解除) and the TAP box.
      const sticky = el('div', { class: 'ly-sticky' }, [renderLoopBar(), status?.tap ? renderTap() : null]);
      parts.push(sticky);
      if (!status?.tap) parts.push(renderEditor()); // editor hidden while tap-syncing: the list follows the taps
      parts.push(renderList());
    }
    parts.push(el('div', { style: 'margin-top:8px' }, [renderTypes()]));
    root.replaceChildren(...parts.filter(Boolean));
    followLine();
  }

  // Keep the line being sung (or the next line to tap) visible in the panel's scroll area,
  // only when that line changes so manual scrolling is not fought on every render.
  let followed = -1;
  let lastInteract = 0;
  const FOLLOW_PAUSE_MS = 8000;
  // Pause following for a while after the user touches the lyrics tab, so the thing they just
  // clicked (e.g. the loop button) is not scrolled away. Tap-sync always follows.
  for (const type of ['pointerdown', 'wheel']) root.addEventListener(type, () => { lastInteract = Date.now(); }, { passive: true });
  function followLine() {
    const target = status?.tap ? status.tap.index : (status?.lyricsCurrent ?? -1);
    if (target < 0 || target === followed) return;
    if (!status?.tap && Date.now() - lastInteract < FOLLOW_PAUSE_MS) return;
    followed = target;
    const row = root.querySelector(`.ly-row[data-i="${target}"]`);
    const sc = root.closest('.panel');
    if (!row || !sc) return;
    const r = row.getBoundingClientRect();
    const c = sc.getBoundingClientRect();
    if (r.top < c.top + 60 || r.bottom > c.bottom - 20) sc.scrollTop += r.top - c.top - c.height / 3;
  }

  window.addEventListener('pointerup', () => { dragStart = -1; });

  return {
    el: root,
    css: LYRICS_TAB_CSS,
    set(nextLyrics, nextMarkTypes) { lyrics = nextLyrics; markTypes = nextMarkTypes; render(); },
    setStatus(s) { status = s; render(); },
    selectLine(i) { selectLine(i, false); },
  };
}
