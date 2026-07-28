/* =============================================================================
 *  研修音声レコーダー（画面まわり）
 *  純ロジックは lib.js（ファイル名・時刻表記・形式選択・無音判定）にある。
 *
 *  取得は getDisplayMedia のタブ音声共有のみ。保護された再生は仕様上こちらへ
 *  無音として届くため、その場合は無音警告で「録れていない」ことが分かる。
 * ========================================================================== */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];
const SILENCE_WINDOW_MS = 15000;   // この時間ずっと無音なら知らせる
const TICK_MS = 250;               // レベル計測と表示の更新間隔

const state = {
  stream: null,        // getDisplayMedia のストリーム（映像トラックを含む）
  recorder: null,
  chunks: [],
  mime: '',
  startedAt: 0,        // 録音開始時刻
  pausedTotal: 0,      // 一時停止していた合計ms
  pausedAt: 0,
  markers: [],         // { ms, note }
  levels: [],          // { t, level }
  peak: 0,
  warnedSilence: false,
  audioCtx: null,
  analyser: null,
  wakeLock: null,
  timer: null,
  savedCount: 0,
};

const $ = sel => document.querySelector(sel);

/* ── 経過時間 ────────────────────────────────────────────────────────────── */

function elapsedMs() {
  if (!state.startedAt) return 0;
  const pausedNow = state.pausedAt ? Date.now() - state.pausedAt : 0;
  return Date.now() - state.startedAt - state.pausedTotal - pausedNow;
}

/* ── 録音の開始・停止 ────────────────────────────────────────────────────── */

async function start() {
  if (state.recorder) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('この環境ではタブ音声を取得できません（https のページで、パソコンのChromeをお使いください）', 'err');
    return;
  }
  const mime = pickMimeType(MIME_CANDIDATES, t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mime) { toast('この環境では録音形式が選べません（MediaRecorder 非対応）', 'err'); return; }

  let stream;
  try {
    // 音声だけ欲しいが、タブ音声の共有は「画面共有」の一部として提供されるため
    // video も要求する必要がある（映像は記録しない）。
    // マイク（getUserMedia）は一切使わない。録るのは共有されたタブが鳴らす音だけ。
    // selfBrowserSurface: 'exclude' で、このレコーダー自身のタブを選択候補から外す
    // （選ぶと当然無音になり、無音警告の原因が分かりにくいため）。非対応環境では無視される。
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude',
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') toast('共有がキャンセルされました', 'warn');
    else toast('タブの共有を開始できませんでした：' + (e && e.message ? e.message : e), 'err');
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach(t => t.stop());
    toast('音声が共有されていません。共有ダイアログで「タブの音声も共有する」にチェックを入れてください', 'err');
    return;
  }

  state.stream = stream;
  state.mime = mime;
  state.chunks = [];
  state.markers = [];
  state.levels = [];
  state.peak = 0;
  state.warnedSilence = false;
  state.pausedTotal = 0;
  state.pausedAt = 0;
  state.savedCount = 0;

  // 記録するのは音声だけ。映像トラックは共有セッションの維持に必要なので止めない。
  const audioOnly = new MediaStream(audioTracks);
  const bps = Number($('#bitrate').value);
  state.recorder = new MediaRecorder(audioOnly, { mimeType: mime, audioBitsPerSecond: bps });
  state.recorder.ondataavailable = e => { if (e.data && e.data.size) state.chunks.push(e.data); };
  state.recorder.onerror = e => toast('録音でエラーが起きました：' + (e.error && e.error.message ? e.error.message : e), 'err');

  // 共有をブラウザ側の「共有を停止」で終わらせた場合や、対象タブを閉じた場合
  audioTracks[0].addEventListener('ended', () => {
    if (state.recorder) { toast('共有が終了したため録音を停止しました', 'warn'); stop(); }
  });

  // タブ以外（画面全体・ウィンドウ）を共有していると、他のアプリの音も混ざる。
  // 録音は止めず、混ざりうることだけ知らせる。
  const videoTrack = stream.getVideoTracks()[0];
  const surface = videoTrack && videoTrack.getSettings ? videoTrack.getSettings().displaySurface : undefined;
  const note = shareSurfaceNote(surface);
  $('#surface-note').hidden = !note;
  if (note) $('#surface-note').textContent = note;

  setupMeter(audioOnly);
  await requestWakeLock();

  state.recorder.start(1000);   // 1秒ごとに小分けで受け取り、長時間でも失いにくくする
  state.startedAt = Date.now();
  state.timer = setInterval(tick, TICK_MS);
  render();
  toast('録音を開始しました。研修の再生を始めてください', 'ok');
}

async function stop() {
  if (!state.recorder) return;
  const rec = state.recorder;
  const done = new Promise(res => { rec.onstop = res; });
  try { rec.stop(); } catch (_) {}
  await done;

  clearInterval(state.timer);
  state.timer = null;
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  teardownMeter();
  releaseWakeLock();

  const blob = new Blob(state.chunks, { type: state.mime });
  state.recorder = null;
  state.stream = null;
  $('#surface-note').hidden = true;
  render();

  if (!blob.size) { toast('録音データが空でした（音声が共有されていない可能性があります）', 'err'); return; }
  saveRecording(blob, elapsedMs());
}

function togglePause() {
  const rec = state.recorder;
  if (!rec) return;
  if (rec.state === 'recording') {
    rec.pause();
    state.pausedAt = Date.now();
    toast('一時停止しました', 'warn');
  } else if (rec.state === 'paused') {
    rec.resume();
    state.pausedTotal += Date.now() - state.pausedAt;
    state.pausedAt = 0;
    toast('録音を再開しました', 'ok');
  }
  render();
}

/** 録音を続けたまま、ここまでの分を保存する（長時間録音の保険）。 */
function saveSoFar() {
  if (!state.chunks.length) { toast('まだ保存できるデータがありません', 'warn'); return; }
  saveRecording(new Blob(state.chunks, { type: state.mime }), elapsedMs(), true);
}

function saveRecording(blob, ms, partial) {
  const ext = extForMime(state.mime);
  const title = $('#title').value + (partial ? '_途中' + (++state.savedCount) : '');
  const name = audioFileName(title, new Date(), ext);
  saveBlob(blob, name);
  if (state.markers.length) {
    const text = buildMarkerText($('#title').value, state.markers, new Date());
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), markerFileName(name));
  }
  toast((partial ? 'ここまでを保存しました：' : '保存しました：') + name
    + '（' + formatDuration(ms) + '・' + formatBytes(blob.size) + '）', 'ok');
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ── しおり ──────────────────────────────────────────────────────────────── */

function addMarker() {
  if (!state.recorder) { toast('録音中だけ使えます', 'warn'); return; }
  const ms = elapsedMs();
  const note = ($('#marker-note').value || '').trim();
  state.markers.push({ ms, note });
  $('#marker-note').value = '';
  renderMarkers();
  toast(formatTimecode(ms) + ' にしおりを付けました', 'ok');
}

function renderMarkers() {
  const list = $('#markers');
  list.innerHTML = '';
  state.markers.slice().sort((a, b) => a.ms - b.ms).forEach(m => {
    const li = document.createElement('li');
    const time = document.createElement('b');
    time.textContent = formatTimecode(m.ms);
    const note = document.createElement('span');
    note.textContent = m.note || '（メモなし）';
    li.append(time, note);
    list.appendChild(li);
  });
  $('#markers-panel').hidden = state.markers.length === 0;
}

/* ── レベル計測と無音検知 ────────────────────────────────────────────────── */

function setupMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 1024;
    source.connect(state.analyser);   // 出力へはつながない（ハウリングを避ける）
  } catch (e) {
    state.analyser = null;   // 計測できなくても録音自体は続ける
  }
}

function teardownMeter() {
  try { if (state.audioCtx) state.audioCtx.close(); } catch (_) {}
  state.audioCtx = null;
  state.analyser = null;
}

function currentLevel() {
  if (!state.analyser) return 0;
  const buf = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
  return peak;
}

function tick() {
  const rec = state.recorder;
  if (!rec) return;
  const ms = elapsedMs();

  if (rec.state === 'recording') {
    const level = currentLevel();
    state.peak = Math.max(state.peak, level);
    state.levels.push({ t: ms, level });
    if (state.levels.length > 4000) state.levels.splice(0, 2000);   // 直近だけ持てば足りる

    if (!state.warnedSilence && shouldWarnSilence(state.levels, SILENCE_WINDOW_MS)) {
      state.warnedSilence = true;
      $('#silence').hidden = false;
    }
    if (state.warnedSilence && level > 0.01) {
      state.warnedSilence = false;
      $('#silence').hidden = true;
    }

    const limitMin = Number($('#limit').value);
    if (limitMin > 0 && ms >= limitMin * 60000) {
      toast('設定した上限（' + limitMin + '分）に達したため停止します', 'warn');
      stop();
      return;
    }
  }
  render();
}

/* ── 画面 ────────────────────────────────────────────────────────────────── */

function render() {
  const rec = state.recorder;
  const recording = !!rec;
  const paused = recording && rec.state === 'paused';
  const ms = elapsedMs();

  $('#time').textContent = formatDuration(ms);
  $('#size').textContent = recording
    ? '約 ' + formatBytes(estimateBytes(ms, Number($('#bitrate').value)))
    : '—';
  const level = recording && !paused ? currentLevel() : 0;
  $('#level-bar').style.width = Math.min(100, Math.round(level * 140)) + '%';
  $('#peak').textContent = state.peak > 0 ? '最大 ' + Math.round(state.peak * 100) + '%' : '—';

  $('#start').disabled = recording;
  $('#stop').disabled = !recording;
  $('#pause').disabled = !recording;
  $('#pause').textContent = paused ? '再開' : '一時停止';
  $('#save-partial').disabled = !recording || !state.chunks.length;
  $('#mark').disabled = !recording;
  $('#bitrate').disabled = recording;
  $('#status').textContent = !recording ? '待機中'
    : paused ? '一時停止中' : '録音中（' + state.mime.replace(/;.*$/, '') + '）';
  $('#status').className = 'status ' + (!recording ? '' : paused ? 'warn' : 'rec');
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || 'ok');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

/* ── 画面のスリープ抑止 ──────────────────────────────────────────────────── */

async function requestWakeLock() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* 非対応・拒否でも録音は続ける */ }
}
function releaseWakeLock() {
  try { if (state.wakeLock) state.wakeLock.release(); } catch (_) {}
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.recorder && !state.wakeLock) requestWakeLock();
});

/* ── 起動 ────────────────────────────────────────────────────────────────── */

function init() {
  $('#start').addEventListener('click', start);
  $('#stop').addEventListener('click', stop);
  $('#pause').addEventListener('click', togglePause);
  $('#save-partial').addEventListener('click', saveSoFar);
  $('#mark').addEventListener('click', addMarker);
  $('#marker-note').addEventListener('keydown', e => { if (e.key === 'Enter') addMarker(); });

  // 録音中に閉じられると全部失われるので確認する
  window.addEventListener('beforeunload', e => {
    if (state.recorder) { e.preventDefault(); e.returnValue = ''; }
  });

  if (location.protocol === 'file:') {
    toast('file:// で開いています。タブ音声の取得が拒否される場合は、公開ページ（https）から使ってください', 'warn');
  }
  render();
  renderMarkers();
}

document.addEventListener('DOMContentLoaded', init);
