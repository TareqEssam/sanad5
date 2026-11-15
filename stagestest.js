/* اختبار V20.10: صدق النتيجة + مراحل التأطير الخمس + الإعداد الصوتي */
const fs = require('fs');
const MM = require(require('path').join(__dirname,'mirror_core.js')).SanadMirror;
const W = 480, H = 640;
const data = new Uint8ClampedArray(W * H * 4);
function px(x, y, r, g, b) { const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
function clear(r, g, b) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, r, g, b); }

/* بناء مشهد: person {topFrac, bhFrac, cxFrac, headWFrac, feet, back} */
function scene(o) {
  o = Object.assign({ topFrac: 0.1, bhFrac: 0.8, cxFrac: 0.5, headWFrac: 0.085, feet: true, back: false, faceHFrac: null }, o || {});
  clear(215, 218, 225);
  for (let y = 576; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 148, 148, 156);
  const top = Math.round(H * o.topFrac), bh = Math.round(H * o.bhFrac), bot = top + bh;
  const cx = Math.round(W * o.cxFrac);
  const faceH0 = o.faceHFrac ? Math.max(8, Math.round(H * o.faceHFrac)) : Math.max(8, Math.round(bh * 0.11));
  let headHalf = o.faceHFrac ? Math.round(faceH0 * 0.38) : Math.max(6, Math.round(W * o.headWFrac / 2));
  const bodyHalf = Math.round(headHalf * 2.3);
  const faceH = faceH0;
  const faceTop = top + Math.round(bh * 0.06);
  if (o.back) {
    for (let y = top; y < bot; y++) for (let x = cx - bodyHalf; x < cx + bodyHalf; x++) px(x, y, 45, 62, 110);
    for (let y = top; y < top + faceH; y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 45, 33, 26);
    for (let y = top; y < top + Math.round(bh * 0.2); y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 45, 33, 26);
  } else {
    for (let y = faceTop + faceH; y < (o.feet ? bot - Math.round(bh * 0.02) : H); y++)
      for (let x = cx - bodyHalf; x < cx + bodyHalf; x++) px(x, y, 45, 62, 110);
    for (let y = faceTop; y < faceTop + faceH; y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 226, 184, 156);
    for (let y = top; y < faceTop; y++) for (let x = cx - headHalf; x < cx + headHalf; x++) px(x, y, 45, 33, 26);
    if (o.feet) for (let y = bot - Math.round(bh * 0.02); y < bot + Math.round(bh * 0.02); y++)
      for (let x = cx - bodyHalf; x < cx + bodyHalf; x++) px(x, y, 30, 30, 34);
  }
  return MM.buildWorkFromImageData({ data }, W, H);
}
function check(label, cond, extra) {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? '  ' + extra : ''));
  if (!cond) process.exitCode = 1;
  return cond;
}
function stageOf(work, stage) {
  const box = MM.detectFaceBoxBySkin(work);
  const extent = MM.detectPersonExtent(work, box);
  return MM.evaluateStageFraming(work, box, extent, stage);
}
console.log('=== ١) مراحل التأطير الخمس ===');
let w = scene({ topFrac: 0.12, bhFrac: 0.70, feet: true });
let st = stageOf(w, 'face');
check('الوجه: جاهز', st.ok, JSON.stringify(st.metrics));
w = scene({ topFrac: 0.02, bhFrac: 0.30, feet: false, faceHFrac: 0.40 });   /* وجه كبير جداً */
st = stageOf(w, 'face');
check('الوجه القريب جداً ⇒ tooClose', st.code === 'tooClose' || st.code === 'chinCut' || st.code === 'headCut', st.code + ' | ' + st.hint);
w = scene({ topFrac: 0.30, bhFrac: 0.45, feet: true });
st = stageOf(w, 'face');
check('الوجه البعيد ⇒ tooFar/noFace', !st.ok, st.code);
w = scene({ topFrac: 0.08, bhFrac: 0.80, feet: true });
st = stageOf(w, 'upper');
check('العلوي: جاهز', st.ok, JSON.stringify(st.metrics));
w = scene({ topFrac: 0.02, bhFrac: 0.98, feet: false });
st = stageOf(w, 'upper');
check('العلوي مع Corps كبير ⇒ not ok', !st.ok, st.code);
w = scene({ topFrac: 0.10, bhFrac: 0.82, feet: true });
st = stageOf(w, 'lower');
check('السفلي (القدمان ظاهران): جاهز', st.ok, JSON.stringify(st.metrics));
w = scene({ topFrac: 0.02, bhFrac: 1.10, feet: false });
st = stageOf(w, 'lower');
check('السفلي والقدمان مقصوصة ⇒ noFeet', st.code === 'noFeet', st.code + ' | ' + st.hint);
w = scene({ topFrac: 0.10, bhFrac: 0.80, feet: true });
st = stageOf(w, 'full');
check('الجسم كامل: جاهز', st.ok, JSON.stringify(st.metrics));
w = scene({ topFrac: 0.06, bhFrac: 0.94, feet: true });
st = stageOf(w, 'full');
check('الجسم قريب (القدمان مقصوصة) ⇒ noFeet', st.code === 'noFeet', st.code);
w = scene({ topFrac: 0.08, bhFrac: 0.82, back: true });
st = stageOf(w, 'back');
check('الظهر: جاهز', st.ok, JSON.stringify(st.metrics));
w = scene({ topFrac: 0.08, bhFrac: 0.82, feet: true });
st = stageOf(w, 'back');
check('الظهر والوجه ظاهر ⇒ stillFront', st.code === 'stillFront', st.code + ' | ' + st.hint);

console.log('\n=== ٢) صدق الحذاء: لا نخترع لوناً إذا لم تظهر القدمان ===');
w = scene({ topFrac: 0.02, bhFrac: 1.05, feet: false });
let box = MM.detectFaceBoxBySkin(w);
let ext = MM.detectPersonExtent(w, box);
let shoeRes = MM.analyzeShoes(w, { feet: { x: 0, y: H * 0.85, w: W, h: H * 0.15 } }, ext);
check('القدمان خارج الكادر ⇒ لا لون للحذاء', !shoeRes.metrics.leftColor && shoeRes.state === 'unknown', shoeRes.text);
console.log('    النص: ' + shoeRes.text);
w = scene({ topFrac: 0.10, bhFrac: 0.80, feet: true });
box = MM.detectFaceBoxBySkin(w); ext = MM.detectPersonExtent(w, box);
shoeRes = MM.analyzeShoes(w, { feet: { x: 0, y: H * 0.85, w: W, h: H * 0.15 } }, ext);
check('القدمان ظاهران ⇒ لون مقروء', !!shoeRes.metrics.leftColor, JSON.stringify(shoeRes.metrics) + ' | ' + shoeRes.text);

console.log('\n=== ٣) الفحص الكامل عبر runInspection (مع شيم canvas) ===');
/* شيم canvas بسيط في Node */
global.document = { createElement: function () { return {
  width: 0, height: 0,
  getContext: function () { return {
    drawImage: function (src) { this._src = src; },
    getImageData: function (x, y, w, h) {
      const src = this._src; const out = new Uint8ClampedArray(w * h * 4);
      const sw = src.width, sh = src.height;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const sx = Math.min(sw - 1, Math.floor(xx * sw / w)), sy = Math.min(sh - 1, Math.floor(yy * sh / h));
        const si = (sy * sw + sx) * 4, di = (yy * w + xx) * 4;
        out[di] = src.data[si]; out[di+1] = src.data[si+1]; out[di+2] = src.data[si+2]; out[di+3] = 255;
      }
      return { data: out, width: w, height: h };
    }
  }; }
}; } };
/* لقطة بلا قدمين (الجزء السفلي مقصوص) — يجب ألا يذكر سند لون الحذاء */
const cutData = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; cutData[i] = 215; cutData[i+1] = 218; cutData[i+2] = 225; cutData[i+3] = 255; }
for (let y = 20; y < H; y++) for (let x = 200; x < 280; x++) { const i = (y * W + x) * 4; cutData[i] = 45; cutData[i+1] = 62; cutData[i+2] = 110; cutData[i+3] = 255; }
for (let y = 60; y < 150; y++) for (let x = 215; x < 265; x++) { const i = (y * W + x) * 4; cutData[i] = 226; cutData[i+1] = 184; cutData[i+2] = 156; cutData[i+3] = 255; }
(async function () {
  const out = await MM.runInspection({
    source: { data: cutData, width: W, height: H }, maxDim: 1024, mode: 'lower',
    profile: { gender: 'male', hasBeard: false }
  });
  console.log('    الخلاصة: ' + out.report.short);
  const shoeTxt = (out.results || []).filter(r => r.id === 'shoes').map(r => r.text).join(' | ');
  console.log('    نص الحذاء: ' + shoeTxt);
  const shoeClaim = (out.results || []).some(r => r.id === 'shoeColor');
  check('لا يُذكر لون الحذاء حين لا تظهر القدمان', !shoeClaim && /قدماك خارج/.test(shoeTxt), shoeTxt);
})();
