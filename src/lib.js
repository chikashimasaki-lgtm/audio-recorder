/* =============================================================================
 *  純ロジック（DOM・ブラウザAPIに触らない部分）
 *  ブラウザからも Node のテストからも同じコードを使う。
 * ========================================================================== */

/** 表示用のバイト数。 */
function formatBytes(n) {
  if (!isFinite(n) || n < 0) return '-';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 経過時間を h:mm:ss にする。1時間未満は m:ss。
 * しおりの表示と書き出しに使うので、桁を揃えて頭出ししやすくする。
 */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = v => String(v).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/** しおり書き出し用の固定幅表記（0:05 も 00:00:05 に揃える）。 */
function formatTimecode(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const pad = v => String(v).padStart(2, '0');
  return pad(Math.floor(total / 3600)) + ':' + pad(Math.floor((total % 3600) / 60)) + ':' + pad(total % 60);
}

/** 録音時間とビットレートから推定サイズ。開始前に「どれくらいの大きさになるか」を示す。 */
function estimateBytes(ms, bitsPerSecond) {
  const sec = Math.max(0, Number(ms) || 0) / 1000;
  const bps = Math.max(0, Number(bitsPerSecond) || 0);
  return Math.round(sec * bps / 8);
}

/**
 * 使える録音形式を選ぶ。
 * Chrome は webm/opus、Safari は mp4/aac しか受け付けないなど環境差があるため、
 * 候補を順に試して最初に通ったものを使う。判定関数は注入してテストできるようにする。
 * @param {string[]} candidates 優先順の候補
 * @param {function(string): boolean} isSupported MediaRecorder.isTypeSupported 相当
 * @return {string|null} 使える形式。1つも無ければ null
 */
function pickMimeType(candidates, isSupported) {
  if (typeof isSupported !== 'function') return null;
  for (const type of (candidates || [])) {
    try { if (isSupported(type)) return type; } catch (_) { /* 判定自体が投げる環境もある */ }
  }
  return null;
}

/** MIMEから保存時の拡張子。iPhoneに渡すことを考え mp4 系は .m4a にする。 */
function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('mp4') >= 0 || m.indexOf('aac') >= 0) return '.m4a';
  if (m.indexOf('ogg') >= 0) return '.ogg';
  if (m.indexOf('mpeg') >= 0) return '.mp3';
  return '.webm';
}

/** 日時を yyyyMMdd_HHmm に。ファイル名の並び順が時系列になるようにする。 */
function stamp(date) {
  const d = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
  const pad = v => String(v).padStart(2, '0');
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
       + '_' + pad(d.getHours()) + pad(d.getMinutes());
}

/**
 * 保存するファイル名。題名が空なら既定名を使う。
 * ファイル名に使えない文字は置き換える（題名は利用者が自由に入力する）。
 */
function audioFileName(title, date, ext) {
  const base = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '録音';
  return base + '_' + stamp(date) + (ext || '.webm');
}

/** 音声ファイルと対になるしおりのファイル名（拡張子だけ .txt に差し替える）。 */
function markerFileName(audioName) {
  return String(audioName || '録音').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '_しおり.txt';
}

/**
 * しおりをテキストにする。頭出しに使うので、時刻は固定幅で先頭に置く。
 * @param {string} title
 * @param {{ms:number, note:string}[]} markers
 * @param {Date} [date]
 */
function buildMarkerText(title, markers, date) {
  const list = (markers || []).slice().sort((a, b) => (a.ms || 0) - (b.ms || 0));
  const head = [
    (String(title || '').trim() || '録音') + '　しおり',
    '記録日時: ' + stamp(date).replace('_', ' ').replace(/(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})/, '$1/$2/$3 $4:$5'),
    '',
  ];
  if (!list.length) return head.concat(['（しおりはありません）', '']).join('\n');
  const body = list.map(m => formatTimecode(m.ms) + '\t' + String(m.note == null ? '' : m.note).replace(/[\r\n]+/g, ' ').trim());
  return head.concat(body, ['']).join('\n');
}

/**
 * 共有の種類に応じた注意文。
 *
 * このアプリはマイクを使わないので、周囲の音（話し声・生活音）はどの場合も入らない。
 * ただし「画面全体」や「ウィンドウ」を共有すると、そのパソコンが鳴らす他の音
 * （通知音など）が混ざりうる。タブを選んでいればそのタブの音だけになる。
 *
 * @param {string|undefined} displaySurface 映像トラックの displaySurface
 * @return {string|null} 出すべき注意文。不要なら null
 */
function shareSurfaceNote(displaySurface) {
  const s = String(displaySurface == null ? '' : displaySurface).toLowerCase();
  if (s === 'monitor' || s === 'window') {
    return '画面全体（またはウィンドウ）を共有しています。このパソコンが鳴らす他の音（通知音など）も一緒に録音されます。'
         + '研修のタブだけを選び直すと確実です。※マイクは使っていないので、周囲の話し声は入りません。';
  }
  return null;   // タブ（browser）と、値が取れない環境では何も言わない
}

/**
 * 無音が続いていないか判定する。
 *
 * タブ共有の際に「タブの音声も共有する」のチェックを忘れると、録音は動いているのに
 * 何も入っていない状態で何十分も進んでしまう。保護された再生でも同じことが起きる。
 * 一定時間内に一度も音が入らなければ知らせるための判定。
 *
 * @param {{t:number, level:number}[]} samples 計測履歴（t=経過ms, level=0〜1）
 * @param {number} windowMs この時間ぶん音が無ければ警告
 * @param {number} [threshold] これを超えたら「音がある」とみなす
 * @return {boolean} 警告すべきなら true
 */
function shouldWarnSilence(samples, windowMs, threshold) {
  const th = (threshold == null) ? 0.01 : threshold;
  const list = samples || [];
  if (!list.length) return false;
  const last = list[list.length - 1].t;
  if (last < windowMs) return false;                 // まだ判定できるだけ経っていない
  // 直近 windowMs の範囲に音があったかを見る（開始直後の無音だけで鳴らさない）
  return !list.some(s => s.t >= last - windowMs && s.level > th);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatBytes, formatDuration, formatTimecode, estimateBytes,
    pickMimeType, extForMime, stamp, audioFileName, markerFileName,
    buildMarkerText, shouldWarnSilence, shareSurfaceNote,
  };
}
