/* اختبار جاهزية الجسم الكامل (وضع الكرسي) — V20.10 */
const MM = require(require('path').join(__dirname,'mirror_core.js')).SanadMirror;
const W = 480, H = 640;
const data = new Uint8ClampedArray(W * H * 4);
function px(x, y, r, g, b) { const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }

function scene(o) {
  o = Object.assign({ topFrac: 0.10, bhFrac: 0.80, cxFrac: 0.50, headWFrac: 0.085, feet: true }, o || {});
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 215, 218, 225);
  for (let y = 576; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 148, 148, 156);
  const top = Math.round(H * o.topFrac), bh = Math.round(H * o.bhFrac), bot = top + bh;
  const cx = Math.round(W * o.cxFrac), headHalf = Math.max(6, Math.round(W * o.headWFrac / 2)), bodyHalf = Math.round(headHalf * 2.3);
  const faceH = Math.max(8, Math.round(bh * 0.11));
  const faceTop = top + Math.round(bh * 0.06);
  for (let y = faceTop + faceH; y < (o.feet ? bot - Math.round(bh * 0.02) : H); y++)
    for (let x = cx - bodyHalf; x < cx + bodyHalf; x++) px(x, y, 45, 62, 110);
  for (let y = faceTop; y < faceTop + faceH; y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 226, 184, 156);
  for (let y = top; y < faceTop; y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 45, 33, 26);
  if (o.feet) for (let y = bot - Math.round(bh * 0.02); y < bot + Math.round(bh * 0.02); y++)
    for (let x = cx - bodyHalf; x < cx + bodyHalf; x++) px(x, y, 30, 30, 34);
  return MM.buildWorkFromImageData({ data }, W, H);
}
function evalScene(work) {
  const box = MM.detectFaceBoxBySkin(work);
  const extent = MM.detectPersonExtent(work, box);
  return MM.evaluateFullBodyFraming(work, box);
}
let fails = 0;
function ck(label, cond, extra) { console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? '  → ' + extra : '')); if (!cond) fails++; }

console.log('=== جاهزية الجسم الكامل ===');
let r = evalScene(scene({ topFrac: 0.10, bhFrac: 0.80, feet: true }));
ck('جسم كامل داخل الكادر ⇒ ready', r.ok, r.code + ' | ' + r.hint);
r = evalScene(scene({ topFrac: 0.02, bhFrac: 0.98, feet: false }));
ck('القدمان مقصوصة ⇒ tooClose', r.code === 'tooClose', r.code + ' | ' + r.hint);
r = evalScene(scene({ topFrac: 0.10, bhFrac: 0.80, feet: true, cxFrac: 0.80 }));
ck('مائل عن المنتصف ⇒ offCenter', r.code === 'offCenter', r.code + ' | ' + r.hint);
r = evalScene(scene({ topFrac: 0.35, bhFrac: 0.45, feet: true }));
ck('بعيد جداً ⇒ tooFar/noFace', !r.ok && (r.code === 'tooFar' || r.code === 'noFace'), r.code + ' | ' + r.hint);
console.log(fails ? '\n✖ فشل ' + fails : '\n✔ كل الحالات المتوقعة');
process.exit(fails ? 1 : 0);
