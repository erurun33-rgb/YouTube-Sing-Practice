// Bootstrap: wires YouTube tracking, audio engine, A/B loop, per-video storage, global settings,
// the annotation overlay (incl. lyrics track) and the floating panel. Core modules (core/*, dsp/*) stay UI-free.

import { createLogger } from '../core/logger.js';
import { YouTubeWatcher, isAdShowing } from '../core/youtube.js';
import { AudioEngine } from '../core/audio-engine.js';
import { AbLoopController, NUDGE_STEP } from '../core/ab-loop.js';
import { clampSemitones } from '../dsp/pitch-shifter.js';
import * as S from '../core/store.js';
import * as L from '../core/lyrics.js';
import * as T from '../core/settings.js';
import * as C from '../core/captions.js';
import * as TM from '../core/timing.js';
import * as B from '../core/backup.js';
import { extensionAlive } from '../core/runtime.js';
import { AnnotationOverlay } from '../ui/overlay.js';
import { createPanel } from '../ui/panel.js';

const METRICS_LOG_INTERVAL_MS = 60_000;
const ANN_VISIBLE_KEY = 'ysp:annotationsVisible';

export function start() {
  if (window.__yspStarted) return;
  window.__yspStarted = true;

  const logger = createLogger();
  const params = new URLSearchParams(location.search);
  const engine = new AudioEngine({
    logger,
    workletUrl: chrome.runtime.getURL('src/worklet/pitch-processor.js'),
    // ?ysp_fallback=1 forces the ScriptProcessor path (to test the fallback on purpose).
    forceFallback: params.get('ysp_fallback') === '1',
    // ?ysp_noactivation=1 simulates a page without user activation (headless browsers grant it).
    simulateNoActivation: params.get('ysp_noactivation') === '1',
  });
  const store = new S.PracticeStore({ area: chrome.storage.local, logger, onContextLost: () => contextLost() });
  const settingsStore = new T.SettingsStore({ area: chrome.storage.local, logger, onContextLost: () => contextLost() });
  let lost = false;
  const timers = [];
  let settings = T.normalizeSettings(null);
  let tap = null; // { index } while tap-syncing lyrics
  // Caption tracks the YouTube player downloaded (captions-hook.js), per videoId:
  // Map<videoId, Map<key, { key, lang, auto, lines }>>
  const captionTracks = new Map();
  let recording = null; // { state, timer } while recording on-screen captions
  let frameRec = null; // { detector, timer, from, detected } while detecting burned-in lyric changes
  let lyricsMsg = null; // { text, at } short result message shown in the lyrics tab
  const say = (text) => { lyricsMsg = { text, at: Date.now() }; render(); };

  let video = null;
  let player = null;
  let videoId = null;
  let data = null;
  let annotationsVisible = readBool(ANN_VISIBLE_KEY, true);
  let rafId = 0;

  const ab = new AbLoopController({ logger, isAdShowing: () => isAdShowing(), onChange: () => onLoopChanged() });
  const overlay = new AnnotationOverlay({
    logger,
    onMoveText: (id, x, y) => mutate((d) => S.updateAnnotation(d, id, { x, y })),
    onEditText: (id) => actions.editText(id),
  });

  // ---- data flow: every change goes through setData -> storage + views ----
  function setData(next, { persist = true } = {}) {
    const prev = data;
    const title = currentTitle();
    data = title && next.title !== title ? { ...next, title } : next;
    if (persist && data.videoId) store.save(data);
    if (!prev || prev.checkpoints !== data.checkpoints || prev.annotations !== data.annotations || prev.lyrics !== data.lyrics) panel.renderData(data);
    if (!prev || prev.annotations !== data.annotations) {
      overlay.setAnnotations(data.annotations);
      refreshOverlay();
    }
    if (!prev || prev.lyrics !== data.lyrics) renderLyrics();
    render();
  }

  function renderLyrics() {
    if (!data) return;
    overlay.lyricsView.set(data.lyrics, settings.markTypes);
    panel.renderLyrics(data.lyrics, settings.markTypes);
    syncCaptionHiding();
    refreshOverlay();
  }

  function setSettings(next) {
    settings = next;
    settingsStore.save(settings);
    renderLyrics();
  }

  function mutateLyrics(fn) {
    if (data) setData(S.updateLyrics(data, fn));
  }

  // Hide YouTube's own captions while our lyrics are shown (CSS class on the player only;
  // the user's YouTube caption setting is not touched).
  function syncCaptionHiding() {
    ensureCaptionStyle();
    const ly = data?.lyrics;
    const hide = !recording && !!(ly && ly.display.visible && ly.display.hideYouTubeCaptions && ly.lines.length);
    player?.classList.toggle('ysp-hide-cc', hide);
  }

  function mutate(fn) {
    if (!data) return null;
    const r = fn(data);
    if (r && r.data) { setData(r.data); return r.item; }
    setData(r);
    return null;
  }

  function onLoopChanged() {
    const l = ab.state;
    const cur = data?.loops[0];
    const same = cur ? (cur.a === l.a && cur.b === l.b && cur.enabled === l.enabled) : (l.a == null || l.b == null);
    if (data && !same) setData(S.setLoop(data, l));
    else render();
  }

  async function setKey(n) {
    const st = await engine.setSemitones(clampSemitones(n));
    if (data && data.pitchSemitones !== st) setData(S.setPitch(data, st));
  }

  // ---- video lifecycle ----
  const onSeeking = () => engine.reset();
  const onPlay = () => { engine.resumeIfNeeded(); startFrames(); syncEditable(); };
  const onPause = () => { refreshOverlay(); syncEditable(); };
  const onTime = () => refreshOverlay();
  const onEmptied = () => { engine.reset(); logger.debug('media emptied/loadstart'); };
  const onRate = () => logger.info('playbackRate', video?.playbackRate);
  const videoEvents = { seeking: onSeeking, seeked: onTime, play: onPlay, pause: onPause, timeupdate: onTime,
    emptied: onEmptied, loadstart: onEmptied, ratechange: onRate };

  function bindVideo(v) {
    if (video === v) return;
    if (video) for (const [k, f] of Object.entries(videoEvents)) video.removeEventListener(k, f);
    video = v;
    if (v) for (const [k, f] of Object.entries(videoEvents)) v.addEventListener(k, f);
    engine.setVideo(v);
    ab.attach(v);
    player = v ? (v.closest('#movie_player') || v.closest('.html5-video-player') || v.parentElement) : null;
    if (player) {
      overlay.mount(player, v);
      panel.mount(player);
      syncCaptionHiding();
    }
    if (v && !v.paused) startFrames();
  }

  async function loadVideo(id) {
    await store.flush();
    // Start from an empty record immediately so nothing of the previous video leaks into this one.
    data = null;
    ab.clear();
    setData(S.createEmpty(id), { persist: false });
    if (engine.semitones !== 0) await engine.setSemitones(0).catch((e) => logger.error(e));
    const loaded = await store.load(id);
    if (id !== videoId) return; // navigated away meanwhile
    setData(loaded, { persist: false });
    const l = loaded.loops[0];
    if (l) ab.restore({ a: l.a, b: l.b, enabled: l.enabled });
    if (loaded.pitchSemitones) {
      await engine.setSemitones(loaded.pitchSemitones).catch((e) => logger.error('restore key failed', e));
    }
    logger.info('practice data loaded', {
      videoId: id, key: loaded.pitchSemitones, loops: loaded.loops.length,
      checkpoints: loaded.checkpoints.length, annotations: loaded.annotations.length,
    });
    render();
  }

  // ---- overlay frame loop (only while playing) ----
  function refreshOverlay() {
    if (!video) return;
    overlay.update(video.currentTime, { hidden: isAdShowing() });
  }

  function startFrames() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!video || video.paused) return;
      refreshOverlay();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function syncEditable() {
    const s = panel.state;
    overlay.setEditable(!!video && video.paused && s.open && s.tab === 'annotations');
  }

  // A key restored from storage can only start audio after the first click/keypress on the page.
  const onGesture = () => {
    engine.markUserGesture();
    if (!engine.pendingGesture) return;
    engine.applyPending().then(render).catch((e) => logger.error('apply pending key failed', e));
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  // Tap-sync: Enter taps while active (hooked in key-guard.js before YouTube sees the key).
  function setTap(next) {
    tap = next;
    window.__yspKeyHook = tap ? (e) => {
      if (e.type !== 'keydown' || e.repeat) return e.key === 'Enter';
      if (e.key !== 'Enter') return false;
      actions.lyricsTap();
      return true;
    } : null;
    render();
  }

  const withErrors = (fn) => async (...args) => {
    try { await fn(...args); } catch (e) { logger.error('action failed', e); engine.error = e; }
    render();
  };

  const actions = {
    setKey: withErrors((n) => setKey(n)),
    stepKey: withErrors((d) => setKey(engine.semitones + d)),
    toggleEnabled: withErrors(() => engine.setEnabled(!engine.enabled)),
    setA: withErrors(() => video && ab.setA(video.currentTime)),
    setB: withErrors(() => video && ab.setB(video.currentTime)),
    nudge: withErrors((which, dir) => ab.nudge(which, Math.sign(dir) * NUDGE_STEP)),
    toggleLoop: withErrors(() => ab.setEnabled(!ab.state.enabled)),
    clearLoop: withErrors(() => ab.clear()),
    seek: withErrors((t, { pause = false } = {}) => {
      if (!video) return;
      video.currentTime = Math.max(0, t);
      if (pause) video.pause(); else video.play().catch(() => {});
      refreshOverlay();
    }),
    addCheckpoint: withErrors((label) => video && mutate((d) => S.addCheckpoint(d, video.currentTime, label))),
    updateCheckpoint: withErrors((id, patch) => mutate((d) => S.updateCheckpoint(d, id, patch))),
    removeCheckpoint: withErrors((id) => mutate((d) => S.removeCheckpoint(d, id))),
    addText: withErrors(async () => {
      if (!video || overlay.busy) return;
      video.pause();
      const at = video.currentTime;
      panel.setSuspended(true);
      const r = await overlay.placeText().finally(() => panel.setSuspended(false));
      if (r) mutate((d) => S.addTextAnnotation(d, { at, ...r }));
    }),
    editText: withErrors(async (id) => {
      const a = data?.annotations.find((x) => x.id === id && x.type === 'text');
      if (!a || overlay.busy) return;
      video?.pause();
      panel.setSuspended(true);
      const r = await overlay.placeText(a).finally(() => panel.setSuspended(false));
      if (r) mutate((d) => S.updateAnnotation(d, id, { text: r.text, color: r.color }));
    }),
    addInk: withErrors(async () => {
      if (!video || overlay.busy) return;
      video.pause();
      const at = video.currentTime;
      panel.setSuspended(true);
      const strokes = await overlay.drawInk().finally(() => panel.setSuspended(false));
      if (strokes) mutate((d) => S.addInkAnnotation(d, { at, strokes }));
    }),
    updateAnnotation: withErrors((id, patch) => mutate((d) => S.updateAnnotation(d, id, patch))),
    removeAnnotation: withErrors((id) => mutate((d) => S.removeAnnotation(d, id))),
    toggleAnnotations: withErrors(() => {
      annotationsVisible = !annotationsVisible;
      writeBool(ANN_VISIBLE_KEY, annotationsVisible);
      overlay.setVisible(annotationsVisible);
      refreshOverlay();
    }),
    panelChanged: () => { syncEditable(); render(); },

    // ---- lyrics (Phase 2) ----
    lyricsSetText: withErrors((text) => mutateLyrics((ly) => L.applyLyricsText(ly, text))),
    lyricsDisplay: withErrors((patch) => mutateLyrics((ly) => L.setDisplay(ly, patch))),
    lyricsOffset: withErrors((delta) => mutateLyrics((ly) => L.setOffset(ly, ly.offset + delta))),
    lyricsSeekLine: withErrors((id) => {
      const l = data?.lyrics.lines.find((x) => x.id === id);
      if (l && l.t != null) actions.seek(l.t + data.lyrics.offset);
    }),
    lyricsSetNow: withErrors((id) => video && mutateLyrics((ly) => L.setLineTime(ly, id, video.currentTime))),
    lyricsNudge: withErrors((id, d) => mutateLyrics((ly) => L.nudgeLineTime(ly, id, d))),
    lyricsClearTime: withErrors((id) => mutateLyrics((ly) => L.setLineTime(ly, id, null))),
    lyricsMemo: withErrors((id, memo) => mutateLyrics((ly) => L.setLineMemo(ly, id, memo))),
    lyricsAddMark: withErrors((id, from, to, type) => mutateLyrics((ly) =>
      L.addMark(ly, id, { from, to, typeId: type.id, symbol: type.symbol, placement: type.placement }).lyrics)),
    lyricsUpdateMark: withErrors((id, markId, patch) => mutateLyrics((ly) => L.updateMark(ly, id, markId, patch))),
    lyricsRemoveMark: withErrors((id, markId) => mutateLyrics((ly) => L.removeMark(ly, id, markId))),
    lyricsClearInk: withErrors((id) => mutateLyrics((ly) => L.setLineInk(ly, id, []))),
    lyricsLineInk: withErrors(async (id) => {
      const line = data?.lyrics.lines.find((x) => x.id === id);
      if (!video || !line || overlay.busy) return;
      video.pause();
      const lv = overlay.lyricsView;
      lv.forcedLineId = id;
      lv.editingLineId = id;
      lv.invalidate();
      refreshOverlay();
      panel.setSuspended(true);
      try {
        const strokes = await overlay.drawInk({
          frame: () => lv.currentBoxRect(overlay.host), initial: line.ink, widthRatio: 0.02, allowEmpty: true,
        });
        if (strokes) mutateLyrics((ly) => L.setLineInk(ly, id, strokes));
      } finally {
        lv.forcedLineId = null;
        lv.editingLineId = null;
        lv.invalidate();
        panel.setSuspended(false);
        refreshOverlay();
      }
    }),
    lyricsLoopLines: withErrors((i, j) => {
      const r = data && L.linesRange(data.lyrics, i, j);
      if (!r) throw new Error('時刻が入っていない行はループできません');
      ab.restore({ a: r.a, b: r.b, enabled: true });
      actions.seek(r.a);
    }),
    lyricsCheckpoint: withErrors((id) => {
      const l = data?.lyrics.lines.find((x) => x.id === id);
      if (!l) return;
      const t = l.t != null ? l.t + data.lyrics.offset : video?.currentTime ?? 0;
      const label = l.text.length > 14 ? `${l.text.slice(0, 14)}…` : l.text;
      mutate((d) => S.addCheckpoint(d, t, label));
    }),
    lyricsTapStart: withErrors((index) => {
      if (!video || !data?.lyrics.lines.length) return;
      setTap({ index: Math.min(index, data.lyrics.lines.length - 1) });
      video.play().catch(() => {});
    }),
    lyricsTap: withErrors(() => {
      if (!tap || !video || !data) return;
      if (tap.index >= data.lyrics.lines.length) return;
      mutateLyrics((ly) => L.tapLine(ly, tap.index, video.currentTime));
      setTap({ index: tap.index + 1 });
    }),
    lyricsTapUndo: withErrors(() => {
      if (!tap || tap.index === 0) return;
      const i = tap.index - 1;
      mutateLyrics((ly) => L.setLineTime(ly, ly.lines[i].id, null));
      setTap({ index: i });
      const prev = data.lyrics.lines[i - 1];
      if (prev?.t != null && video) video.currentTime = Math.max(0, prev.t + data.lyrics.offset - 1);
    }),
    lyricsTapStop: withErrors(() => setTap(null)),

    // ---- lyrics import / export ----
    lyricsImportTrack: withErrors((key) => {
      const tr = captionTracks.get(videoId)?.get(key);
      if (!tr || !tr.lines.length) throw new Error('この字幕には取り込める行がありません');
      if (!confirmReplace()) return;
      mutateLyrics((ly) => L.setTimedLines(ly, tr.lines));
      logger.info('lyrics imported from captions', { lang: tr.lang, auto: tr.auto, lines: tr.lines.length });
    }),
    lyricsRecordStart: withErrors(() => {
      if (!video || recording) return;
      if (tap) setTap(null);
      recording = { state: C.emptyRecording(), timer: 0 };
      syncCaptionHiding(); // show YouTube's captions while recording them
      recording.timer = setInterval(() => {
        if (!video || video.paused) return;
        const text = [...document.querySelectorAll('.ytp-caption-segment')].map((n) => n.textContent).join(' ');
        recording.state = C.recordSample(recording.state, video.currentTime, text);
        render();
      }, 150);
      video.play().catch(() => {});
      render();
    }),
    lyricsRecordStop: withErrors((save) => {
      if (!recording) return;
      clearInterval(recording.timer);
      const lines = C.finishRecording(recording.state);
      recording = null;
      syncCaptionHiding();
      if (save) {
        if (!lines.length) throw new Error('字幕を記録できませんでした（YouTubeの字幕がONか確認してください）');
        if (save === 'times') applyCaptionTimes(lines);
        else if (confirmReplace()) mutateLyrics((ly) => L.setTimedLines(ly, lines));
      }
      render();
    }),
    // B: keep the user's lyrics text, take only the timing from a caption track.
    lyricsTimesFromTrack: withErrors((key) => {
      const tr = captionTracks.get(videoId)?.get(key);
      if (tr) applyCaptionTimes(tr.lines);
    }),
    // A: detect when burned-in lyrics change inside a region of the picture.
    lyricsFrameStart: withErrors(async (from, reuse) => {
      if (!video || frameRec || !data?.lyrics.lines.length) return;
      if (tap) setTap(null);
      let region = reuse ? data.lyrics.region : null;
      if (!region) {
        video.pause();
        panel.setSuspended(true);
        region = await overlay.selectRegion(data.lyrics.region).finally(() => panel.setSuspended(false));
        if (!region) return;
        mutateLyrics((ly) => L.setRegion(ly, region));
        region = data.lyrics.region;
      }
      startFrameDetection(region, Math.max(0, from || 0));
    }),
    lyricsFrameStop: withErrors((save) => {
      if (!frameRec) return;
      clearInterval(frameRec.timer);
      const { detector, from } = frameRec;
      frameRec = null;
      render();
      if (!save) return;
      const times = detector.times();
      if (!times.length) throw new Error('歌詞の切り替わりを検出できませんでした（範囲や再生区間を確認してください）');
      let assigned = 0;
      mutateLyrics((ly) => {
        const r = TM.assignSequential(ly.lines, times.map((t) => Math.round((t - ly.offset) * 100) / 100), from);
        assigned = r.assigned;
        return { ...ly, lines: r.lines };
      });
      say(`映像から ${times.length} か所の切り替わりを検出し、${from + 1}行目から ${assigned} 行に時刻を入れました`);
    }),
    lyricsImportLrc: withErrors((text) => {
      const lines = C.parseLrc(text);
      if (!lines.length) throw new Error('LRCとして読み取れる行がありません');
      if (!confirmReplace()) return;
      mutateLyrics((ly) => L.setTimedLines(ly, lines));
    }),
    lyricsExportLrc: withErrors(() => {
      if (!data?.lyrics.lines.length) return;
      const title = currentTitle() || videoId;
      downloadText(C.toLrc(data.lyrics, { title }), `${title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.lrc`, 'text/plain;charset=utf-8');
    }),

    // ---- backup of all practice data + settings ----
    backupExport: withErrors(async () => {
      await store.flush();
      const all = await chrome.storage.local.get(null);
      const backup = B.buildBackup(all, { appVersion: chrome.runtime.getManifest().version });
      const { videos } = B.summarize(backup.items);
      downloadText(JSON.stringify(backup), B.backupFileName(), 'application/json');
      logger.info('backup exported', { videos });
    }),
    backupImport: withErrors(async (text) => {
      let parsed;
      try { parsed = B.parseBackup(text); } catch (e) { window.alert(e.message); return; }
      const { items, summary, skipped } = parsed;
      const msg = `バックアップを読み込みます（動画 ${summary.videos} 件${summary.settings ? '・記号の設定' : ''}）。\n`
        + (skipped ? `壊れていて読み込めない ${skipped} 件は読み込みません（今のデータはそのまま残ります）。\n` : '')
        + '同じ動画のデータは、バックアップの内容で置き換わります。バックアップに無い動画はそのまま残ります。よろしいですか？';
      if (!window.confirm(msg)) return;
      await store.flush();
      await chrome.storage.local.set(items);
      logger.info('backup imported', summary);
      settings = await settingsStore.load();
      if (videoId) await loadVideo(videoId);
      renderLyrics();
      window.alert(`読み込みました（動画 ${summary.videos} 件）。`);
    }),

    // ---- mark palette (global settings) ----
    markTypeAdd: withErrors((t) => setSettings(T.addMarkType(settings, t))),
    markTypeUpdate: withErrors((id, patch) => setSettings(T.updateMarkType(settings, id, patch))),
    markTypeRemove: withErrors((id) => setSettings(T.removeMarkType(settings, id))),
    copyLog: withErrors(async () => {
      const text = `${logger.dump()}\n\nSTATUS ${JSON.stringify(snapshot(), null, 2)}`;
      await navigator.clipboard.writeText(text);
      logger.info('log copied to clipboard');
    }),
  };

  const panel = createPanel({ actions });
  overlay.setVisible(annotationsVisible);

  function downloadText(text, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function snapshot() {
    return {
      videoId,
      currentTime: video ? video.currentTime : null,
      playbackRate: video ? video.playbackRate : null,
      paused: video ? video.paused : null,
      audio: engine.status(),
      loop: { ...ab.state, loops: ab.loops },
      annotationsVisible,
      counts: data ? { checkpoints: data.checkpoints.length, annotations: data.annotations.length, lyrics: data.lyrics.lines.length } : null,
      tap,
      captions: [...(captionTracks.get(videoId)?.values() || [])].map((t) => ({ key: t.key, lang: t.lang, auto: t.auto, count: t.lines.length })),
      recording: recording ? { count: recording.state.lines.length, current: recording.state.current } : null,
      frameRec: frameRec ? { detected: frameRec.detected, samples: frameRec.detector.count, from: frameRec.from } : null,
      lyricsMsg: lyricsMsg && Date.now() - lyricsMsg.at < 10000 ? lyricsMsg.text : null,
      region: data?.lyrics.region || null,
      lyricsCurrent: data && video ? L.currentLineIndex(data.lyrics, video.currentTime) : -1,
      panel: panel.state,
      peakHz: engine.attached ? engine.peakFrequency() : null,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  }

  function render() {
    panel.renderStatus(snapshot());
  }

  const watcher = new YouTubeWatcher({
    logger,
    onChange: ({ videoId: id, video: v, prevVideoId }) => {
      videoId = id;
      bindVideo(v);
      panel.setVisible(!!id && !!v);
      overlay.host.style.display = id && v ? '' : 'none';
      if (!id) overlay.cancelSession();
      if (id && id !== prevVideoId) {
        overlay.cancelSession();
        if (tap) setTap(null);
        if (recording) actions.lyricsRecordStop(false);
        if (frameRec) actions.lyricsFrameStop(false);
        loadVideo(id).catch((e) => logger.error('load failed', e));
      }
      render();
    },
  });
  settingsStore.load().then((s) => { settings = s; renderLyrics(); });
  watcher.start();

  timers.push(setInterval(() => {
    if (!extensionAlive()) { contextLost(); return; }
    render(); overlay.layout(); if (player) panel.mount(player);
  }, 1000));
  window.addEventListener('pagehide', () => { store.flush(); });
  timers.push(setInterval(() => {
    const s = snapshot();
    logger.info('metrics', { heapMB: s.heapMB, mode: s.audio.mode, processing: s.audio.processing, stats: s.audio.stats, loops: s.loop.loops });
  }, METRICS_LOG_INTERVAL_MS));

  // The extension was reloaded/updated while this tab stayed open: this copy of the script can
  // no longer save anything. Stop background work and tell the user to reload the tab.
  // Audio keeps working as it is (the Web Audio graph does not depend on the extension runtime).
  // Caption responses captured by captions-hook.js (page MAIN world).
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.source !== 'ysp-timedtext' || typeof m.body !== 'string') return;
    let url;
    try { url = new URL(m.url, location.href); } catch { return; }
    const vid = url.searchParams.get('v');
    if (!vid) return;
    const lines = C.parseTimedText(m.body);
    if (!lines.length) return;
    const lang = url.searchParams.get('lang') || url.searchParams.get('tlang') || '?';
    const auto = url.searchParams.get('kind') === 'asr';
    const key = `${lang}${auto ? ':auto' : ''}`;
    if (!captionTracks.has(vid)) captionTracks.set(vid, new Map());
    captionTracks.get(vid).set(key, { key, lang, auto, lines });
    logger.info('caption track captured', { videoId: vid, key, lines: lines.length });
    render();
  });

  function applyCaptionTimes(capLines) {
    if (!data?.lyrics.lines.length) throw new Error('先に歌詞を貼り付けてください（時刻だけを使うため）');
    const times = TM.timesFromCaptions(data.lyrics.lines.map((l) => l.text), capLines);
    const n = times.filter((t) => t != null).length;
    if (!n) throw new Error('字幕と歌詞の文字が一致しませんでした');
    mutateLyrics((ly) => L.applyTimes(ly, times));
    say(`字幕の時刻を ${n}/${times.length} 行に入れました（合わなかった行はそのまま）`);
  }

  // Sample the lyric region ~10x per second while playing; the detector keeps only one edge map per screen.
  function startFrameDetection(region, from) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('映像がまだ読み込まれていません');
    const W = 160;
    const H = Math.max(12, Math.min(64, Math.round((W * region.h * vh) / (region.w * vw))));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    frameRec = { detector: new TM.TextChangeDetector(), from, detected: 0, timer: 0 };
    let lastT = -1;
    frameRec.timer = setInterval(() => {
      if (!frameRec || !video || video.paused || video.seeking) return;
      const t = video.currentTime;
      if (Math.abs(t - lastT) < 0.05) return;
      lastT = t;
      try {
        ctx.drawImage(video, region.x * vw, region.y * vh, region.w * vw, region.h * vh, 0, 0, W, H);
        const img = ctx.getImageData(0, 0, W, H);
        const f = TM.edgeFeatures(TM.toGray(img.data, W, H), W, H);
        frameRec.detector.push({ t, bits: f.bits, energy: f.energy });
      } catch (e) {
        clearInterval(frameRec.timer);
        frameRec = null;
        logger.error('frame read failed', e);
        say('この動画の映像は読み取れませんでした');
        return;
      }
      if (frameRec.detector.count % 10 === 0) {
        frameRec.detected = frameRec.detector.times().length;
        render();
      }
    }, 100);
    video.play().catch(() => {});
    render();
  }

  function confirmReplace() {
    if (!data?.lyrics.lines.length) return true;
    // eslint-disable-next-line no-alert
    return window.confirm('今の歌詞を置き換えます。同じ文の行の記号・手書き・メモは引き継ぎます。よろしいですか？');
  }

  function contextLost() {
    if (lost) return;
    lost = true;
    timers.forEach(clearInterval);
    watcher.stop();
    if (tap) setTap(null);
    overlay.cancelSession();
    panel.setNotice('拡張機能が更新されました。このタブを再読み込み（F5）してください。再読み込みするまで変更は保存されません。');
    logger.warn('extension context lost; waiting for tab reload');
  }

  logger.info('YSP started', { version: chrome.runtime.getManifest().version });
}

function ensureCaptionStyle() {
  if (document.getElementById('ysp-caption-style')) return;
  const st = document.createElement('style');
  st.id = 'ysp-caption-style';
  st.textContent = '.ysp-hide-cc .ytp-caption-window-container, .ysp-hide-cc .caption-window { display: none !important; }';
  (document.head || document.documentElement).append(st);
}

function currentTitle() {
  return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
}

function readBool(k, d) {
  try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; }
}

function writeBool(k, v) {
  try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ }
}
