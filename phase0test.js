// اختبار تركيبي (ليس صور حقيقية): يفحص منطق analyzeHeadCover وحده على مشاهد مبسّطة.
const MM = require(require('path').join(__dirname,'mirror_core.js')).SanadMirror;
const W = 480, H = 640;
function mk(hijab, hairShow, bg) {
  const d = new Uint8ClampedArray(W * H * 4);
  const set = (x, y, c) => { const i = (y * W + x) * 4; d[i] = c[0]; d[i+1] = c[1]; d[i+2] = c[2]; d[i+3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, bg);
  const ell = (cx, cy, rx, ry, c) => { for (let y = Math.max(0, cy-ry); y < Math.min(H, cy+ry); y++) for (let x = Math.max(0, cx-rx); x < Math.min(W, cx+rx); x++) { const a=(x-cx)/rx,b=(y-cy)/ry; if (a*a+b*b<=1) set(x,y,c); } };
  ell(240, 250, 100, 125, hijab);                 // الحجاب حول الرأس
  for (let y = 330; y < H; y++) for (let x = 130; x < 350; x++) set(x, y, hijab); // الجسم بنفس لون الحجاب
  ell(240, 262, 56, 76, [205, 155, 125]);          // الوجه
  if (hairShow) { // خصلة شعر داكنة ظاهرة أعلى الجبهة (تحت حافة الحجاب)
    for (let y = 196; y < 214; y++) for (let x = 205; x < 275; x++) { const a=(x-240)/56,b=(y-262)/76; if (a*a+b*b<=1) set(x,y,[40,28,22]); }
  }
  const img = { data: d };
  return MM.buildWorkFromImageData(img, W, H, null);
}

const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname,'index.html'),'utf8');
let fail = 0;
const ok = (c, n) => { console.log((c ? '  ✔ ' : '  ✘ ') + n); if (!c) fail++; };
const box = { x: 184, y: 186, w: 112, h: 152 };
const prof = { wearsHeadCover: true, headCover: 'hijab', coverForehead: true };
console.log('=== غطاء الرأس (مشاهد تركيبية) ===');
const run = (col, hair) => { const w = mk(col, hair, [215,218,225]); return MM.analyzeHeadCover(w, box, MM.buildRegions(box, W, H), prof); };
for (const [n, c] of [['أسود',[18,18,18]],['كحلي',[20,28,70]],['أبيض',[240,240,240]]]) {
  const a = run(c, false), b = run(c, true);
  ok(a.state !== 'attention', 'حجاب ' + n + ' سليم ⇒ لا إنذار كاذب');
  ok(a.state !== 'ok' || a.confidence < 0.7, 'حجاب ' + n + ' سليم ⇒ لا جزم بالسلامة');
  ok(b.state === 'attention', 'حجاب ' + n + ' + شعر ظاهر ⇒ تحذير');
}
console.log('=== حظر السحابة في وضع المرآة ===');
ok(/function assertCloudAllowed\(\)/.test(html), 'assertCloudAllowed موجودة');
for (const f of ['callProxyWorker','callCloudStructured','callCloudText']) {
  const i = html.search(new RegExp('(async\\s+)?function\\s+' + f + '\\b'));
  ok(i > 0 && html.slice(i, i + 400).includes('assertCloudAllowed()'), f + ' تستدعي الحارس');
}
ok(!/لضمان خصوصية صورك/.test(html) || !/افصل الإنترنت/.test(html), 'لا طلب فصل الإنترنت من الكفيف');
ok(!/gender\s*=\s*'male'/.test(html.slice(html.indexOf('لم يكتمل الضبط') - 600, html.indexOf('لم يكتمل الضبط') + 100)), 'لا افتراض ذكر عند نقص الضبط');
console.log(fail ? '\n✘ فشل ' + fail : '\n✔ كل الاختبارات نجحت');
process.exit(fail ? 1 : 0);
