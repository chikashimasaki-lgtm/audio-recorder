/**
 * 研修音声レコーダー 純ロジック検証（依存なし）
 *
 *   npm test        （= node tests/verify.js）
 *
 * ブラウザ側と同じ src/lib.js を読み込んで動かす。
 * 録音そのもの（getDisplayMedia / MediaRecorder）は利用者の操作が要るため自動化できない。
 * ここで固定するのは、その周りで静かに間違いやすい部分（ファイル名・時刻表記・
 * 形式選択・無音判定）。
 */
const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'lib.js'));

let pass = 0, fail = 0;
const eq = (a, b, label) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + '\n     期待: ' + y + '\n     実際: ' + x); }
};

console.log('\n【1】時間の表記');
{
  eq(L.formatDuration(0), '0:00', '0秒');
  eq(L.formatDuration(5_000), '0:05', '5秒');
  eq(L.formatDuration(65_000), '1:05', '1分5秒は h を出さない');
  eq(L.formatDuration(3_600_000), '1:00:00', '1時間ちょうど');
  eq(L.formatDuration(3_725_000), '1:02:05', '1時間2分5秒');
  eq(L.formatDuration(10_800_000), '3:00:00', '3時間の研修でも桁が壊れない');
  eq(L.formatDuration(-5), '0:00', '負の値は0扱い');
  eq(L.formatDuration(null), '0:00', '未設定は0扱い');
  eq(L.formatDuration(999), '0:00', '1秒未満は切り捨て');
}
{
  eq(L.formatTimecode(5_000), '00:00:05', 'しおりは固定幅（頭出しのため桁を揃える）');
  eq(L.formatTimecode(3_725_000), '01:02:05', '1時間超も同じ幅');
  eq(L.formatTimecode(0), '00:00:00', '開始位置');
}

console.log('\n【2】サイズの表記と見積もり');
{
  eq(L.formatBytes(0), '0 B', '0バイト');
  eq(L.formatBytes(1023), '1023 B', '1KB未満');
  eq(L.formatBytes(1024), '1.0 KB', '1KB');
  eq(L.formatBytes(1024 * 1024 * 2.5), '2.5 MB', 'MB');
  eq(L.formatBytes(1024 ** 3 * 1.25), '1.25 GB', 'GB（長時間録音でここまで行きうる）');
  eq(L.formatBytes(-1), '-', '不正な値');
}
{
  // 128kbps で1時間 ≒ 57.6MB。開始前の目安表示に使う
  eq(L.estimateBytes(3_600_000, 128_000), 57_600_000, '128kbpsで1時間');
  eq(L.formatBytes(L.estimateBytes(10_800_000, 128_000)), '164.8 MB', '3時間でも現実的な大きさ');
  eq(L.estimateBytes(0, 128_000), 0, '0秒なら0');
  eq(L.estimateBytes(1000, 0), 0, 'ビットレート0なら0（0除算しない）');
}

console.log('\n【3】録音形式の選択');
{
  const only = allowed => (t => allowed.some(a => t.indexOf(a) === 0));
  const CAND = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  eq(L.pickMimeType(CAND, only(['audio/webm'])), 'audio/webm;codecs=opus', 'Chrome想定：webm/opus を選ぶ');
  eq(L.pickMimeType(CAND, only(['audio/mp4'])), 'audio/mp4;codecs=mp4a.40.2', 'Safari想定：mp4/aac を選ぶ');
  eq(L.pickMimeType(CAND, only(['audio/ogg'])), 'audio/ogg;codecs=opus', 'oggしか通らない環境');
  eq(L.pickMimeType(CAND, () => false), null, 'どれも使えなければ null（呼び出し側で断る）');
  eq(L.pickMimeType(CAND, () => { throw new Error('判定不能'); }), null, '判定が例外を投げても落ちない');
  eq(L.pickMimeType([], () => true), null, '候補が無ければ null');
  eq(L.pickMimeType(CAND, null), null, '判定関数が無ければ null（MediaRecorder非対応環境）');
}
{
  eq(L.extForMime('audio/webm;codecs=opus'), '.webm', 'webm');
  eq(L.extForMime('audio/mp4;codecs=mp4a.40.2'), '.m4a', 'mp4系は .m4a（iPhoneに渡しやすい）');
  eq(L.extForMime('audio/ogg;codecs=opus'), '.ogg', 'ogg');
  eq(L.extForMime('audio/mpeg'), '.mp3', 'mpeg');
  eq(L.extForMime(''), '.webm', '不明なら既定');
}

console.log('\n【4】ファイル名');
{
  const d = new Date(2026, 6, 28, 9, 5);
  eq(L.stamp(d), '20260728_0905', '日時は0埋めして時系列に並ぶ形にする');
  eq(L.audioFileName('第390回 生成AI実践セミナー', d, '.webm'),
     '第390回 生成AI実践セミナー_20260728_0905.webm', '題名＋日時＋拡張子');
  eq(L.audioFileName('', d, '.webm'), '録音_20260728_0905.webm', '題名が空なら既定名');
  eq(L.audioFileName('   ', d, '.m4a'), '録音_20260728_0905.m4a', '空白だけでも既定名');
  eq(L.audioFileName('a/b:c*d?', d, '.webm'), 'a_b_c_d__20260728_0905.webm', '使えない文字を置き換える');
  eq(L.audioFileName('改行\n入り', d, '.webm'), '改行_入り_20260728_0905.webm', '改行も使えない文字として置き換える');
  eq(L.audioFileName('あ'.repeat(200), d, '.webm').length, 80 + '_20260728_0905.webm'.length, '長すぎる題名は切り詰める');
  eq(L.markerFileName('録音_20260728_0905.webm'), '録音_20260728_0905_しおり.txt', 'しおりは音声と同じ名前で対にする');
  eq(L.markerFileName('名前に.ドット.のある.m4a'), '名前に.ドット.のある_しおり.txt', '途中のドットは残す');
}

console.log('\n【5】しおりの書き出し');
{
  const d = new Date(2026, 6, 28, 9, 5);
  const text = L.buildMarkerText('生成AIセミナー', [
    { ms: 3_725_000, note: 'リスク管理の話' },
    { ms: 65_000, note: 'プロンプトの実演' },
    { ms: 5_000, note: '' },
  ], d);
  const lines = text.split('\n');
  eq(lines[0], '生成AIセミナー　しおり', '1行目は題名');
  eq(lines[1], '記録日時: 2026/07/28 09:05', '2行目は記録日時');
  eq(lines.slice(3, 6), [
    '00:00:05\t',
    '00:01:05\tプロンプトの実演',
    '01:02:05\tリスク管理の話',
  ], '時刻の昇順に並べ、時刻とメモをタブで区切る');
  eq(L.buildMarkerText('', [], d).indexOf('（しおりはありません）') > 0, true, 'しおりが無いときも空ファイルにしない');
  eq(L.buildMarkerText('題', [{ ms: 1000, note: 'a\nb' }], d).split('\n')[3], '00:00:01\ta b', 'メモの改行は潰す（1行1しおりを崩さない）');
}

console.log('\n【6】無音の検知');
{
  const silent = (from, to, step) => {
    const out = [];
    for (let t = from; t <= to; t += step) out.push({ t, level: 0 });
    return out;
  };
  eq(L.shouldWarnSilence([], 15000), false, '記録が無ければ判定しない');
  eq(L.shouldWarnSilence(silent(0, 10000, 1000), 15000), false, '15秒経つまでは警告しない');
  eq(L.shouldWarnSilence(silent(0, 15000, 1000), 15000), true, '15秒ずっと無音なら警告');
  eq(L.shouldWarnSilence(silent(0, 30000, 1000), 15000), true, 'その後も無音なら警告し続ける');

  const withSound = silent(0, 30000, 1000);
  withSound[25].level = 0.5;   // 25秒地点で音が入った
  eq(L.shouldWarnSilence(withSound, 15000), false, '直近15秒に音があれば警告しない');

  const stopped = silent(0, 60000, 1000);
  stopped[10].level = 0.5;     // 10秒地点だけ音があり、その後は無音
  eq(L.shouldWarnSilence(stopped, 15000), true, '途中で音が止まったら警告する（再生停止に気づける）');

  const tiny = silent(0, 20000, 1000).map(s => ({ t: s.t, level: 0.005 }));
  eq(L.shouldWarnSilence(tiny, 15000), true, 'ノイズ程度の微小レベルは無音とみなす');
  eq(L.shouldWarnSilence(tiny, 15000, 0.001), false, 'しきい値は呼び出し側で変えられる');
}

console.log('\n【7】共有の種類と注意表示');
{
  eq(L.shareSurfaceNote('browser'), null, 'タブ共有なら注意は出さない（狙いどおりの状態）');
  eq(typeof L.shareSurfaceNote('monitor'), 'string', '画面全体なら注意を出す');
  eq(typeof L.shareSurfaceNote('window'), 'string', 'ウィンドウ共有でも注意を出す');
  eq(L.shareSurfaceNote(undefined), null, '値が取れない環境では何も言わない');
  eq(L.shareSurfaceNote(''), null, '空文字も同様');
  eq(L.shareSurfaceNote('BROWSER'), null, '大文字小文字は問わない');
  eq(/マイクは使っていない/.test(L.shareSurfaceNote('monitor')), true, '注意文でもマイク不使用に触れる');
  eq(/他の音/.test(L.shareSurfaceNote('monitor')), true, '何が混ざるのかを具体的に書く');
}

console.log('\n【8】配線（ブラウザで動かせない分の静的検査）');
{
  const fs = require('fs');
  const appSrc  = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const tplSrc  = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

  // app.js が触る要素IDが、雛形HTMLに実在するか。
  // ここがずれると画面が黙って反応しなくなる（実機でしか気づけない種類の事故）。
  const usedIds = [...new Set([...appSrc.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))].sort();
  const definedIds = new Set([...tplSrc.matchAll(/\sid="([\w-]+)"/g)].map(m => m[1]));
  const missing = usedIds.filter(id => !definedIds.has(id));
  eq(missing, [], 'app.js が参照する要素IDがすべてHTMLに存在する（' + usedIds.length + '個）');

  // lib.js の関数を app.js が呼んでいる箇所が、実際にエクスポートされているか
  const libFns = Object.keys(L);
  const calledFromApp = libFns.filter(fn => new RegExp('[^\\w.]' + fn + '\\s*\\(').test(appSrc));
  eq(calledFromApp.length > 0, true, 'app.js が lib.js の関数を使っている');
  eq(calledFromApp.filter(fn => typeof L[fn] !== 'function'), [], '呼んでいる関数がすべて実装されている');

  // 配布物が最新のソースから作られているか（src を直して build を忘れる事故を防ぐ）
  const built = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const strip = s => s.replace(/if \(typeof module[\s\S]*$/, '').replace(/<\/script/gi, '<\\/script');
  eq(built.includes(strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib.js'), 'utf8')).trim()), true,
    'index.html に最新の lib.js が入っている');
  eq(built.includes(strip(appSrc).trim()), true, 'index.html に最新の app.js が入っている');
  eq(/__LIB__|__APP__/.test(built), false, 'プレースホルダが残っていない');

  // 録音まわりの前提が壊れていないか（実装の意図を固定する）
  eq(/getDisplayMedia/.test(appSrc), true, '取得はタブ音声共有（getDisplayMedia）のみ');
  // 呼び出しだけを見る（コメントで getUserMedia に言及すること自体は妨げない）
  eq(/getUserMedia\s*\(/.test(appSrc), false, '**マイクを使わない**（getUserMedia を呼ばない＝周囲の音は入らない）');
  eq(/m3u8|\.mpd|widevine|clearkey|decrypt/i.test(appSrc), false, '保護されたストリームを取りに行く実装は無い');
  eq(/new MediaStream\(audioTracks\)/.test(appSrc), true, '録音するのは音声トラックだけ（映像は記録しない）');
  eq(/selfBrowserSurface/.test(appSrc), true, '自分のタブを共有候補から外している');
  eq(/マイクを使いません/.test(tplSrc), true, '画面にマイク不使用を明記している');
  // 既定の音質。講義の音声なので 64kbps を標準にしている（3時間で約82MB）
  const selected = (tplSrc.match(/<option value="(\d+)"\s+selected>/) || [])[1];
  eq(selected, '64000', '音質の既定は 64 kbps');
  const rates = [...tplSrc.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1]));
  eq(rates, [32000, 48000, 64000, 96000, 128000], '選べるビットレート（低い順）');
  eq(/channelCount: 1/.test(appSrc), true, 'モノラルを要求している（同じビットレートなら音質が保たれる）');

  // 画面に出す目安サイズが、実際の計算と食い違っていないこと（表示だけ直して計算を忘れる事故を防ぐ）
  const threeHours = 10_800_000;
  [[32000, '約41MB'], [48000, '約62MB'], [64000, '約82MB'], [96000, '約124MB'], [128000, '約165MB']]
    .forEach(([bps, label]) => {
      const actual = '約' + Math.round(L.estimateBytes(threeHours, bps) / 1024 / 1024) + 'MB';
      eq(actual, label, bps / 1000 + 'kbps の3時間の目安が表示と一致');
      eq(tplSrc.includes(label), true, bps / 1000 + 'kbps の選択肢に目安が書いてある');
    });
  eq(/画面全体ではありません/.test(tplSrc), true, '使い方で共有の種類（タブ／画面全体ではない）を案内している');
}

console.log('\n' + '─'.repeat(62));
console.log(fail === 0 ? `全 ${pass} 項目 合格` : `${pass} 合格 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
