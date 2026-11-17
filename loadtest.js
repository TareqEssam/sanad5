/* اختبار تكامل الرصد التلقائي بالنماذج: يحمّل index.html كاملاً في بيئة محاكاة **مع live_recog_core.js الحقيقي**
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
async function setup(env) {
  const r = env.run;
  await sleep(80);   // يستقر إقلاع التطبيق (تحميل الحزم غير المتزامن) قبل ضبط مجموعة المخاطر
  r("installedPacks = []; personalItems = [];");
  r("hazardPool = [{name:'حفرة', kind:'hazard', vecs:[__V], pack:'t'}, {name:'خلفية', kind:'background', vecs:[__W], pack:'t'}]; generalClasses = hazardPool.slice();");
  r("navModeEnabled = true; lifeMode = 'walk'; assistantSpeaking = false;");
  r("playSpatialBeep = function(){}; vibrate = function(){};");
  const v = env.els['camera-preview']; v.videoWidth = 640; v.videoHeight = 480; v.paused = false; v.ended = false;
  env.store['sanad_dino_ready_v1'] = '1'; env.store['sanad_segformer_ready_v1'] = '1';
  r("liveRecog.running = true;");
}
// zeroDue=true: يجعل كل الميزات «حان وقتها» (للتحقق أن الحجب سببه البوابة لا الموعد)
// zeroDue=false: يحترم المواعيد كما في الواقع (بعد بصمة المخاطر يتأخر موعدها فيعمل المكان في الفجوة)
async function tick(env, n, zeroDue) {
  for (let i = 0; i < (n || 1); i++) {
    env.run("liveRecog.holdUntil = 0;");
    if (zeroDue) env.run("liveRecog.due.scene = 0; liveRecog.due.roi = 0; liveRecog.due.arch = 0;");
    env.variant = (env.variant + 60) % 200;           // تغيّر المشهد ليمرّ من بوابة التغيّر
    const p = env.run('liveRecogTick()'); if (p && p.then) await p;
    await sleep(15);
  }
}
const count = (env, t) => env.msgs.filter(x => x === t).length;

(async () => {
  console.log('=== ١) التحميل الكامل مع SanadLive (مسار المتصفح) ===');
  const env = boot();
  ck('لا أخطاء تحميل (TDZ أو غيرها)', env.loadErrors.length === 0, env.loadErrors.join(' | '));
  ck('SL معرّف وكائنات الرصد أُنشئت', env.run('SL !== null && typeof liveRecog.archAnnouncer.update === "function" && typeof liveRecog.hazardVotes.push === "function"') === true);
  ck('دوال الحالة المبكرة آمنة: segReady/embedReady معلنة', env.run('segReady === false && embedReady === false') === true);
  ck('sanadLiveStats() متاحة قبل أي عامل', env.run('typeof sanadLiveStats()') === 'object' && env.run('sanadLiveStats().worker') === false);

  console.log('\n=== ٢) تجهيز العاملين من الكاش (بلا تنزيل) ثم رصد المخاطر والمكان ===');
  await setup(env);
  await tick(env, 1);      // gate = nobackend ⇒ يجهّز العاملين من الأعلام المحفوظة
  await sleep(30);
  ck('أُنشئ عامل واحد من embed_worker.js', env.urls.length === 1 && env.urls[0] === 'embed_worker.js', env.urls.join());
  ck('جُهّز نموذجا البصمات والمكان في العامل نفسه', count(env, 'init') === 1 && count(env, 'seg-init') === 1 && env.run('embedReady && segReady') === true);
  await tick(env, 2, false);      // الأولى: المخاطر. الثانية: موعد المخاطر تأخّر ⇒ يعمل المكان في الفجوة
  const said = env.spoken.join(' | ');
  ck('نُطق تنبيه الخطر من الحزمة (حفرة)', /حفرة/.test(said), said);
  ck('نُطق تنبيه المكان (سلالم) مع «تأكد بعصاك»', /سلالم على اليسار\. تأكد بعصاك/.test(said), said);
  ck('الباب لم يُنطق مع وجود تنبيه سلالم (التنبيه أولاً)', !/باب/.test(said));
  const st = env.run('sanadLiveStats()');
  ck('الإحصاءات: عامل نشط وقياسات للنموذجين', st.worker === true && st.embed.samples >= 1 && st.seg.samples >= 1 && st.seg.inputLongSide === 384, JSON.stringify({ e: st.embed.samples, s: st.seg.samples }));
  ck('زمن العامل الوهمي يغذّي الميزانية (lastMs)', st.embed.lastMs === 120 && st.seg.lastMs === 400);

  console.log('\n=== ٣) الصمت وأولوية المستخدم والخصوصية ===');
  let n0 = count(env, 'embed') + count(env, 'seg');
  env.run('isProcessing = true'); await tick(env, 3, true); env.run('isProcessing = false');
  ck('أثناء «علّمني/ما هذا؟» (isProcessing): لا طلبات جديدة للعامل', count(env, 'embed') + count(env, 'seg') === n0);
  env.run('isListening = true'); await tick(env, 2, true); env.run('isListening = false');
  ck('أثناء الاستماع: لا طلبات', count(env, 'embed') + count(env, 'seg') === n0);
  env.run('assistantSpeaking = true'); await tick(env, 2, true); env.run('assistantSpeaking = false');
  ck('أثناء كلام المساعد: لا طلبات', count(env, 'embed') + count(env, 'seg') === n0);
  env.run("lifeMode = 'grooming'"); await tick(env, 3, true);
  ck('وضع المرآة: لا بصمات ولا تجزئة إطلاقاً', count(env, 'embed') + count(env, 'seg') === n0);
  env.run("lifeMode = 'clothes'"); await tick(env, 2, true);
  ck('وضع الملابس: لا طلبات', count(env, 'embed') + count(env, 'seg') === n0);
  env.run("lifeMode = 'walk'");
  env.run('navModeEnabled = false'); await tick(env, 2, true); env.run('navModeEnabled = true');
  ck('التنبيهات المستمرة مطفأة: لا طلبات', count(env, 'embed') + count(env, 'seg') === n0);
  env.run('claimEmbedder()'); const pHold = env.run('liveRecogTick()'); if (pHold && pHold.then) await pHold;
  ck('بعد claimEmbedder() يتوقف الرصد لحظات (طلب مستخدم جارٍ)', count(env, 'embed') + count(env, 'seg') === n0);
  env.run('liveRecog.holdUntil = 0');
  env.run('liveHazardEnabled = false; liveArchEnabled = false'); await tick(env, 2, true);
  ck('كل الميزات مطفأة: لا طلبات', count(env, 'embed') + count(env, 'seg') === n0);
  env.run('liveHazardEnabled = true; liveArchEnabled = true');

  console.log('\n=== ٤) نتيجة حيّة تُسرّع زر الفحص ===');
  env.run('liveRecog.lastArch = null; liveRecog.due.scene = Date.now() + 60000; liveRecog.due.roi = Date.now() + 60000; liveRecog.due.arch = 0;'); await tick(env, 2, false);
  ck('وُجدت نتيجة مكان حيّة', env.run('liveRecog.lastArch !== null') === true);
  const segBefore = count(env, 'seg');
  env.run('liveRecog.lastArch.thumb = grabLiveThumb(); liveRecog.lastArch.t = Date.now()');    // نفس المشهد الآن
  const a1 = await env.run('analyzeLocalArchitecture()');
  ck('الزر يعيد النتيجة الحيّة فوراً بلا طلب جديد للعامل', count(env, 'seg') === segBefore && a1.some(t => /سلالم/.test(t)), JSON.stringify(a1));
  env.variant = (env.variant + 100) % 200;   // المشهد تغيّر كثيراً ⇒ لا تُعاد النتيجة القديمة
  const a2 = await env.run('analyzeLocalArchitecture()');
  ck('تغيّر المشهد ⇒ طلب جديد للعامل ونتيجة صحيحة', count(env, 'seg') === segBefore + 1 && a2.some(t => /سلالم على اليسار/.test(t)) && a2.some(t => /باب على اليمين/.test(t)), JSON.stringify(a2));

  console.log('\n=== ٥) أشيائي: هادئة ومطفأة افتراضياً ===');
  ck('الإعداد الافتراضي: أشيائي مطفأة، والمكان والمخاطر مفعّلة', env.run('liveItemsEnabled === false && liveArchEnabled === true && liveHazardEnabled === true') === true);
  ck('لم يُنطق «أظن أمامك» أبداً (أشيائي مطفأة)', !/أظن أمامك/.test(env.spoken.join(' ')));

  console.log('\n=== ٦) فشل العامل لا يكسر شيئاً ===');
  env.worker.onerror();
  ck('خطأ العامل ⇒ يُلغى الجاهزان ولا استثناء', env.run('embedReady === false && segReady === false && visionWorker === null') === true);
  let n1 = count(env, 'embed') + count(env, 'seg'); await tick(env, 2, true);
  ck('بعد الخطأ لا طلبات إلى عامل ميت', count(env, 'embed') + count(env, 'seg') === n1);

  console.log('\n=== ٧) بيئة بلا Worker ===');
  const e2 = boot({ noWorker: true });
  ck('يُحمَّل بلا أخطاء', e2.loadErrors.length === 0, e2.loadErrors.join(' | '));
  await setup(e2);
  await tick(e2, 2, true); await sleep(30);
  ck('الرصد لا يعمل ولا ينهار', e2.run('embedReady === false && segReady === false') === true && e2.msgs.length === 0);
  const a3 = await e2.run('analyzeLocalArchitecture()');
  ck('زر المكان: يسقط إلى البديل القديم ويُرجع قائمة فارغة بلا استثناء', Array.isArray(a3) && a3.length === 0, JSON.stringify(a3));
  ck('الإحصاءات تُظهر عدم وجود عامل', e2.run('sanadLiveStats().worker') === false && e2.run('sanadLiveStats().backendEmbed') === 'none');

  console.log(fails ? '\n✘ فشل ' + fails : '\n✔ كل فحوص التكامل نجحت');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  ✘ استثناء: ' + e.stack); process.exit(1); });
