/**
 * 配布用の単一HTMLを組み立てる。
 *
 *   node build_html.js
 *
 * src/index.html のプレースホルダに自作スクリプトを埋め込み、
 * 依存ファイルの無い index.html を出力する。外部ライブラリは使っていない。
 */
const fs   = require('fs');
const path = require('path');

const root = __dirname;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const lib = read('src/lib.js').replace(/if \(typeof module[\s\S]*$/, '');   // Node向けのexportは外す
const app = read('src/app.js');

// </script> と解釈されうる文字列だけ避ける
const escapeForScriptText = s => s.replace(/<\/script/gi, '<\\/script');

let html = read('src/index.html')
  .replace('/*__LIB__*/', () => escapeForScriptText(lib))
  .replace('/*__APP__*/', () => escapeForScriptText(app));

['__LIB__', '__APP__'].forEach(k => {
  if (html.includes(k)) throw new Error('プレースホルダが残っています: ' + k);
});

const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
console.log('作成: ' + out + '（' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB）');
