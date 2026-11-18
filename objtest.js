/* [objtest] نفس بيئة loadtest.js لكن لاختبار حلقة كاشف الأجسام (coco-ssd) وحساس الميل بنموذج وهمي.
   (الوصف الأصلي للبيئة:) اختبار تكامل الرصد التلقائي بالنماذج: يحمّل index.html كاملاً في بيئة محاكاة **مع live_recog_core.js الحقيقي**
   (كما يحدث في المتصفح)، وعامل وهمي يحاكي بروتوكول embed_worker.js، ثم يشغّل حلقة الرصد فعلياً ويتحقق مما يُنطق.
   يلتقط أخطاء من نوع «استُخدم قبل الإعلان» (TDZ) التي لا تظهر حين يغيب SanadLive.
   تنبيه: النموذجان وهميان؛ لا يقيس سرعة ولا دقة. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const SL = require(path.join(__dirname, 'live_recog_core.js'));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
let fails = 0;
const ck = (label, cond, extra) => { console.log((cond ? '  ✔ ' : '  ✘ ') + label + (extra ? '  → ' + extra : '')); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// بصمة وهمية مطبّعة (768) تُستخدم لصنف خطر وتُرجعها «النموذج» نفسها ⇒ تطابق قوي
const V = new Float32Array(768); { let s = 0; for (let i = 0; i < 768; i++) { V[i] = Math.sin(i * 12.9898) * 43758.5453 % 1; s += V[i] * V[i]; } s = Math.sqrt(s); for (let i = 0; i < 768; i++) V[i] /= s; }
const W = new Float32Array(768); { let s = 0; for (let i = 0; i < 768; i++) { W[i] = Math.cos(i * 78.233) * 12345.6789 % 1; s += W[i] * W[i]; } s = Math.sqrt(s); for (let i = 0; i < 768; i++) W[i] /= s; }
const ID2 = { 0: 'wall', 1: 'door', 2: 'stairs', 3: 'sky' };

function boot(opts) {
  opts = opts || {};
  const env = { store: {}, spoken: [], msgs: [], urls: [], variant: 0, loadErrors: [], worker: null };
  const mkEl = id => ({
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener() { }, appendChild() { }, remove() { }, setAttribute() { }, getAttribute() { return null; },
    style: { setProperty() { } }, dataset: {}, files: null, children: [], focus() { }, click() { },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  });
  const els = {}; ids.forEach(i => { els[i] = mkEl(i); });
  const sb = {}; sb.window = sb; sb.globalThis = sb;
  const mkCanvas = () => {
    const c = mkEl('canvas'); c.width = 0; c.height = 0;
    c.getContext = () => ({
      drawImage() { },
      getImageData(x, y, w, h) { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i++) d[i] = (((i * 13) % 200) + 20 + env.variant) % 256; return { data: d, width: w, height: h }; }
    });
    c.toBlob = cb => cb({ size: 1, type: 'image/jpeg' });
    return c;
  };
  sb.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [],
    createElement: t => t === 'canvas' ? mkCanvas() : mkEl('new-' + t), body: mkEl('body'), addEventListener() { }, documentElement: mkEl('html'), hidden: false };
  sb.localStorage = { getItem: k => (k in env.store ? env.store[k] : null), setItem: (k, v) => { env.store[k] = String(v); }, removeItem: k => { delete env.store[k]; } };
  sb.sessionStorage = { getItem: () => null, setItem() { } };
  sb.navigator = { userAgent: 'node', mediaDevices: {}, onLine: true, hardwareConcurrency: 8, deviceMemory: 8 };
  sb.speechSynthesis = { getVoices: () => [{ lang: 'ar-EG', name: 'Test', default: true }, { lang: 'en-US', name: 'EN' }],
    speak(t) { env.spoken.push((t && t.text) ? t.text : String(t)); setTimeout(() => { try { t.onstart && t.onstart({}); } catch (e) { } try { t.onend && t.onend({}); } catch (e) { } }, 2); }, cancel() { }, addEventListener() { }, speaking: false, pending: false };
  sb.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  sb.location = { href: 'https://x/', protocol: 'https:' };
  sb.matchMedia = () => ({ matches: false, addEventListener() { } });
  sb.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sb.requestAnimationFrame = f => setTimeout(f, 0);
  // مؤقتات الحلقة الحية (≥150ms) تُهمل كي تبقى الدورات يدوية وحتمية؛ ما دونها (مثل طابور الكلام) يعمل
  sb.setTimeout = (fn, ms) => (ms >= 150 ? 0 : setTimeout(fn, ms)); sb.clearTimeout = id => { try { clearTimeout(id); } catch (e) { } };
  sb.setInterval = () => 0; sb.clearInterval = () => { };
  sb.Image = mkEl('img'); sb.Blob = class { };
  sb.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  sb.addEventListener = () => { };
  sb.fetch = () => Promise.reject(new Error('شبكة ممنوعة'));
  sb.console = { log(m) { if (/خطأ تحميل/.test(String(m))) env.loadErrors.push(m); }, warn() { }, error() { }, info() { }, debug() { } };
  sb.SanadLive = SL;
  sb.__V = V; sb.__W = W;
  class FakeWorker {
    constructor(url) {
      if (opts.noWorker) throw new Error('Worker غير مدعوم');
      env.urls.push(url); env.worker = this; setTimeout(() => this.onmessage && this.onmessage({ data: { type: 'alive' } }), 0);
    }
    postMessage(m) {
      env.msgs.push(m.type);
      const reply = r => setTimeout(() => this.onmessage && this.onmessage({ data: r }), 1);
      if (m.type === 'init') reply({ type: 'ready' });
      else if (m.type === 'seg-init') reply({ type: 'seg-ready', id2label: ID2, nativeSize: { width: 512, height: 512 } });
      else if (m.type === 'embed') reply({ id: m.id, ok: true, vec: new Float32Array(V), ms: 120 });
      else if (m.type === 'seg') {
        const labels = new Uint8Array(20 * 16).fill(3);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) labels[y * 20 + x] = x < 3 ? 2 : (x >= 18 ? 1 : 3);
        reply({ id: m.id, ok: true, labels, gw: 20, gh: 16, ms: 400, fallback: false });
      }
    }
    terminate() { }
  }
  sb.Worker = FakeWorker;
  vm.createContext(sb);
  blocks.forEach((b, i) => { try { vm.runInContext(b, sb, { timeout: 8000 }); } catch (e) { env.loadErrors.push('كتلة ' + i + ': ' + e.message); } });
  env.sb = sb; env.els = els;
  env.run = expr => { try { return vm.runInContext(expr, sb, { timeout: 8000 }); } catch (e) { return 'EXC: ' + e.message; } };
  return env;
}

const detectCalls = [];
function setupObj(env) {
  const r = env.run;
  r("navModeEnabled = true; lifeMode = 'walk'; localScanEnabled = true; assistantSpeaking = false; isProcessing = false; isListening = false; isScanningFrame = false;");
  r("playSpatialBeep = function(){}; vibrate = function(){};");
  // probe-canvas عنصر وهمي بلا getContext في البيئة؛ نعطيه سياقاً يُرجع بكسلات متنوعة (إطار سليم)
  env.els['probe-canvas'].getContext = () => ({ drawImage() { }, getImageData(x, y, w, h) { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i++) d[i] = ((i * 13) % 200) + 20; return { data: d, width: w, height: h }; } });
  const v = env.els['camera-preview']; v.videoWidth = 720; v.videoHeight = 1280; v.paused = false; v.ended = false;
}
function mkModel(queue) {
  return { detect: async (vid, n, th) => { detectCalls.push([n, th]); const x = queue.shift(); if (x instanceof Error) throw x; return x || []; } };
}
const car = (x, y, w, h, s) => ({ class: 'car', score: s == null ? 0.7 : s, bbox: [x, y, w, h] });
const person = (x, y, w, h, s) => ({ class: 'person', score: s == null ? 0.9 : s, bbox: [x, y, w, h] });
async function mtick(env) { const p = env.run('liveMonitorTick()'); if (p && p.then) await p; await sleep(20); }
const spokenCount = (env, re) => env.spoken.filter(t => re.test(t)).length;

(async () => {
  console.log('=== ١) فشل تحميل coco: إعلان صوتي مرة واحدة ثم إعادة محاولة تلقائية ===');
  let env = boot(); setupObj(env);
  ck('لا أخطاء تحميل', env.loadErrors.length === 0, env.loadErrors.join(' | '));
  let loads = 0, failLoad = true;
  const good = mkModel([]);
  env.sb.cocoSsd = { load: () => { loads++; return failLoad ? Promise.reject(new Error('net')) : Promise.resolve(good); } };
  const r1 = await env.run('initLocalObjectEngine()');
  await sleep(20);
  ck('الفشل يُرجع null ويُفرّغ الوعد (كان يبقى الوعد الفاشل للأبد)', r1 === null && env.run('objectModelLoading') === null && env.run('objectModel') === null);
  ck('أُعلن الفشل بالصوت مرة واحدة', spokenCount(env, /تعذر تحميل كاشف الأجسام/) === 1, env.spoken.join(' | '));
  await env.run('initLocalObjectEngine()'); await sleep(20);
  ck('فشل ثانٍ لا يكرر الإعلان', spokenCount(env, /تعذر تحميل كاشف الأجسام/) === 1 && loads === 2);
  failLoad = false;
  env.run('lastCocoLoadAttempt = Date.now()');
  await mtick(env);
  ck('قبل انقضاء 20ث لا إعادة محاولة', loads === 2 && env.run('objectModel') === null);
  env.run('lastCocoLoadAttempt = Date.now() - 25000');
  await mtick(env); await sleep(20);
  ck('بعد 20ث تُعاد المحاولة تلقائياً من حلقة الرصد وينجح التحميل', loads === 3 && env.run('objectModel !== null') === true && env.run('cocoLoadFailNotified') === false);

  console.log('\n=== ٢) الترتيب: الأقرب قبل الأعلى ثقة ===');
  env = boot(); setupObj(env); const q2 = [];
  env.run('objectModel = null'); env.sb.__m = mkModel(q2); env.run('objectModel = __m');
  detectCalls.length = 0;
  q2.push([person(50, 500, 40, 100, 0.95), car(200, 400, 320, 300, 0.6)]);
  await mtick(env);
  ck('يُقرأ نطاق أوسع للتسجيل (50 جسمًا/0.25) ثم تُعاد تصفية الإنتاج إلى 10 أجسام/0.56', detectCalls.length === 1 && detectCalls[0][0] === 50 && detectCalls[0][1] === 0.25 && env.run('COCO_MAX_BOXES') === 10, JSON.stringify(detectCalls));
  ck('السيارة القريبة في الوسط تُنطق لا الشخص البعيد عالي الثقة', /سيارة أمامك/.test(env.spoken.join(' ')) && !/شخص/.test(env.spoken.join(' ')), env.spoken.join(' | '));
  const rk = env.run(`JSON.stringify(rankLocalObjects([{class:'cup',score:.99,bbox:[0,0,10,10]},{class:'car',score:.6,bbox:[200,400,320,300]},{class:'toaster',score:.9,bbox:[0,0,5,5]}],720,1280).map(o=>o.p.class))`);
  ck('الأجسام غير المعروفة تُستبعد والأولوية أولاً', rk === '["car","cup"]', rk);

  console.log('\n=== ٣) الاقتراب يُكشف حتى لو تقدّم عليه جسم جانبي في الترتيب ===');
  env = boot(); setupObj(env); const q3 = [];
  env.sb.__m = mkModel(q3); env.run('objectModel = __m');
  const nearPersonLeft = person(10, 300, 150, 500, 0.9);
  q3.push([nearPersonLeft, car(260, 500, 200, 200)]);
  await mtick(env);
  ck('الدورة الأولى: الجسم الأقرب (الشخص على اليسار) هو المنطوق', /شخص على اليسار/.test(env.spoken.join(' ')), env.spoken.join(' | '));
  q3.push([nearPersonLeft, car(240, 470, 260, 230)]);   // مساحة 59800 مقابل 40000 = +49.5%
  await mtick(env);
  ck('السيارة في الوسط تكبر ≥34% ⇒ «انتبه! سيارة تقترب» رغم أن الشخص ما زال الأعلى ترتيباً', /انتبه! سيارة تقترب/.test(env.spoken.join(' ')), env.spoken.join(' | '));
  q3.push([car(240, 470, 262, 232)]);   // نمو ضئيل ⇒ لا اقتراب
  const nBefore = env.spoken.length; await mtick(env);
  ck('نمو أقل من 34% لا يُنبَّه بالاقتراب', !/انتبه! سيارة تقترب/.test(env.spoken.slice(nBefore).join(' ')));
  q3.push([]); await mtick(env);
  ck('غياب الأجسام يُصفّر التتبع', env.run('prevCenterThreat') === null);

  console.log('\n=== ٤) لا عمى أثناء الكلام: يستمر الرصد، والاقتراب وحده يقاطع ===');
  env = boot(); setupObj(env); const q4 = [], utts = [];
  env.sb.speechSynthesis.speak = t => { env.spoken.push(t.text); utts.push(t); };   // الكلام لا ينتهي حتى نُنهيه يدوياً
  env.sb.__m = mkModel(q4); env.run('objectModel = __m'); detectCalls.length = 0;
  q4.push([car(260, 500, 200, 200)]); await mtick(env);
  ck('أول تنبيه (سيارة أمامك) يبدأ النطق ويبقى المساعد «يتكلم»', env.run('assistantSpeaking') === true && spokenCount(env, /سيارة أمامك/) === 1 && env.run('speechPriority') === 0);
  q4.push([person(300, 400, 100, 300)]); await mtick(env);     // جسم آخر غير عاجل أثناء الكلام
  ck('جسم غير عاجل أثناء الكلام: يُرصد لكن لا يقاطع', detectCalls.length === 2 && env.spoken.length === 1, env.spoken.join(' | '));
  q4.push([car(260, 500, 200, 200)]); await mtick(env);        // يعود إلى نفس الحجم الأول ⇒ مرجع جديد
  q4.push([car(240, 470, 260, 230)]); await mtick(env);        // +49.5%
  ck('الاقتراب العاجل يقاطع الكلام الجاري', /انتبه! سيارة تقترب/.test(env.spoken[env.spoken.length - 1]) && env.run('urgentSpeechActive()') === true, env.spoken.join(' | '));
  const nSpoken = env.spoken.length;
  q4.push([car(200, 420, 340, 300)]); await mtick(env);        // مساحة 102000 مقابل 59800 = +70%
  ck('استمرار نفس الاقتراب أثناء نطقه لا يقطع الجملة ولا يكررها', env.spoken.length === nSpoken && detectCalls.length === 5, env.spoken.length + ' / ' + detectCalls.length);
  env.run('assistantSpeaking = false');                         // انتهى الكلام
  q4.push([car(150, 380, 420, 380)]);                           // مساحة 159600 = +56%
  await mtick(env);
  ck('بعد انتهاء الجملة يُعاد التنبيه العاجل (كما قبل التعديل)', env.spoken.length === nSpoken + 1 && /انتبه! سيارة تقترب/.test(env.spoken[env.spoken.length - 1]), env.spoken.join(' | '));

  console.log('\n=== ٥) أولوية الجملة تُحسب لكل مقطع ===');
  env = boot(); setupObj(env); const u5 = [];
  env.sb.speechSynthesis.speak = t => { env.spoken.push(t.text); u5.push(t); };
  env.run("speak('عاجل', true, 2)");
  ck('جملة عاجلة جارية', env.run('urgentSpeechActive()') === true);
  env.run("speak('عادية', false)");
  ck('إضافة جملة عادية للطابور لا تُنزل أولوية الجارية', env.run('urgentSpeechActive()') === true && u5.length === 1);
  u5[0].onend({});
  ck('عند بدء الجملة العادية تصبح الأولوية 0', u5.length === 2 && env.run('urgentSpeechActive()') === false && env.run('speechPriority') === 0);
  env.run("speak('عاجل جديد', true, 2)"); env.run("speak('أمر مستخدم')");
  ck('كلام المستخدم الافتراضي يقاطع العاجل ويُصفّر الأولوية', env.run('urgentSpeechActive()') === false);

  console.log('\n=== ٦) لا فشل صامت في الرصد ===');
  env = boot(); setupObj(env); const q6 = [];
  env.sb.__m = mkModel(q6); env.run('objectModel = __m');
  q6.push(new Error('webgl lost'), new Error('webgl lost'));
  await mtick(env); await mtick(env);
  ck('خطآن متتاليان: لا إعلان بعد', spokenCount(env, /تعذر رصد الأجسام/) === 0 && env.run('isScanningFrame') === false);
  q6.push(new Error('webgl lost')); await mtick(env);
  ck('الخطأ الثالث المتتالي يُعلَن بالصوت وتتغير الشارة', spokenCount(env, /تعذر رصد الأجسام/) === 1 && /خطأ في الرصد/.test(env.els['local-scanner-badge'] ? env.els['local-scanner-badge'].textContent : env.run('localScannerBadge.textContent')), env.run('localScannerBadge.textContent'));
  q6.push(new Error('x'), new Error('x')); await mtick(env); await mtick(env);
  ck('لا تكرار للإعلان خلال دقيقة', spokenCount(env, /تعذر رصد الأجسام/) === 1);
  q6.push([]); await mtick(env);
  ck('النجاح يصفّر العدّاد ويعيد الشارة «نشط»', env.run('cocoDetectFails') === 0 && /نشط/.test(env.run('localScannerBadge.textContent')), env.run('localScannerBadge.textContent'));
  ck('الحلقة تعمل بعد الأخطاء (isScanningFrame=false)', env.run('isScanningFrame') === false);

  console.log('\n=== ٧) حساس الميل على iOS: إعادة المحاولة عند أول لمسة ===');
  const mkOrient = (permResult) => {
    const e = boot(); const h = { doc: {}, win: {}, removed: [], perm: 0, mode: permResult };
    e.sb.document.addEventListener = (t, f) => { h.doc[t] = f; };
    e.sb.document.removeEventListener = (t) => { h.removed.push(t); delete h.doc[t]; };
    e.sb.addEventListener = (t, f) => { h.win[t] = f; };
    e.sb.DeviceOrientationEvent = { requestPermission: () => { h.perm++; return h.mode === 'reject' ? Promise.reject(new Error('gesture')) : Promise.resolve(h.mode); } };
    return { e, h };
  };
  let { e: e7, h: h7 } = mkOrient('reject');
  e7.run('initOrientationSensor()'); await sleep(20);
  ck('رفض بلا لمسة ⇒ لا ربط، وتُسجَّل مستمعات اللمس', h7.perm === 1 && !h7.win.deviceorientation && typeof h7.doc.click === 'function');
  h7.mode = 'granted'; h7.doc.click(); await sleep(20);
  ck('عند اللمسة ينجح الطلب ويُربط الحساس', h7.perm === 2 && typeof h7.win.deviceorientation === 'function');
  h7.win.deviceorientation({ beta: 83 });
  ck('تُقرأ قيمة الميل', e7.run('phonePitchBeta') === 83);
  ck('تُزال مستمعات اللمس بعد النجاح', h7.removed.length === 3 && !h7.doc.click);
  e7.run('initOrientationSensor()'); await sleep(10);
  ck('لا طلب إضافي بعد الربط', h7.perm === 2);
  ({ e: e7, h: h7 } = mkOrient('denied'));
  e7.run('initOrientationSensor()'); await sleep(20);
  ck('الرفض الصريح: لا ربط ولا إعادة طلب', h7.perm === 1 && !h7.win.deviceorientation && e7.run('orientationDenied') === true);
  e7.run('initOrientationSensor()'); await sleep(10);
  ck('بعد الرفض الصريح لا يُطلب مجدداً', h7.perm === 1);
  const e8 = boot(); const w8 = {}; e8.sb.addEventListener = (t, f) => { w8[t] = f; }; e8.sb.DeviceOrientationEvent = {};
  e8.run('initOrientationSensor(); initOrientationSensor();');
  ck('أندرويد/غيره بلا requestPermission: يُربط فوراً ومرة واحدة', typeof w8.deviceorientation === 'function' && e8.run('orientationAttached') === true);

  console.log(fails ? '\n✘ فشل ' + fails : '\n✔ كل فحوص حلقة الأجسام نجحت');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  ✘ استثناء: ' + e.stack); process.exit(1); });
