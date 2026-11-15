/* اختبار الرصد التلقائي بالبصمات (live_recog_core.js + embed_worker.js + ربطها في index.html).
   تنبيه: اختبار منطق وبروتوكول بنموذج وهمي — لا يقيس سرعة ولا دقة النموذج الحقيقي (لا متصفح ولا Hugging Face هنا).
   قياس السرعة الفعلية يتم على الهاتف من شاشة الحالة (انظر CHANGES_PHASE1.md). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SL = require(path.join(__dirname, 'live_recog_core.js'));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const workerSrc = fs.readFileSync(path.join(__dirname, 'embed_worker.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
let fail = 0;
const ok = (c, n) => { console.log((c ? '  ✔ ' : '  ✘ ') + n); if (!c) fail++; };
const close = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

console.log('=== البصمة: مطابقة حرفية لما كان في embedFrame ===');
{
  // النسخة القديمة منسوخة حرفياً من index.html الأصلي قبل التعديل
  const normVec = v => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; };
  const legacy = (dims, d) => {
    const D = dims[dims.length - 1], N = dims.length >= 3 ? dims[dims.length - 2] : 1;
    const cls = normVec(d.slice(0, D)), mean = new Float32Array(D);
    if (N > 1) { for (let t = 1; t < N; t++) for (let i = 0; i < D; i++) mean[i] += d[t * D + i] / (N - 1); }
    const both = new Float32Array(2 * D); both.set(cls, 0); both.set(normVec(N > 1 ? mean : cls), D);
    return normVec(both);
  };
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  for (const dims of [[1, 257, 384], [1, 384], [1, 5, 8]]) {
    const n = dims.reduce((a, b) => a * b, 1), d = new Float32Array(n).map(() => rnd());
    const a = legacy(dims, d), b = SL.reduceEmbedding(dims, d);
    ok(a.length === b.length && a.every((x, i) => x === b[i]), 'reduceEmbedding ≡ القديمة، الأبعاد ' + dims.join('×') + ' ⇒ ' + b.length + ' بعداً');
  }
  const b768 = SL.reduceEmbedding([1, 257, 384], new Float32Array(257 * 384).map(() => rnd()));
  ok(b768.length === 768 && close(b768.reduce((s, x) => s + x * x, 0), 1, 1e-4), 'dinov2-small ⇒ 768 بعداً ومُطبَّع (يطابق PACK_DIM)');
}

console.log('=== بوابة المشهد ===');
{
  const a = new Uint8Array(768).fill(100), b = new Uint8Array(768).fill(100), c = new Uint8Array(768).fill(160);
  ok(SL.sceneDiff(a, b) === 0, 'مشهد ثابت ⇒ فرق 0');
  ok(close(SL.sceneDiff(a, c), 60), 'تغيّر السطوع 60 ⇒ فرق 60');
  ok(SL.sceneDiff(null, a) === 255 && SL.sceneDiff(a, new Uint8Array(10)) === 255, 'لا مرجع/أبعاد مختلفة ⇒ يُعدّ تغيّراً كاملاً');
  ok(SL.shouldEmbed({ diff: 0, now: 1000, lastEmbedAt: 0 }) === true, 'أول مرة ⇒ بصمة');
  ok(SL.shouldEmbed({ diff: 1, now: 2000, lastEmbedAt: 1000 }) === false, 'مشهد ساكن وقريب ⇒ لا بصمة');
  ok(SL.shouldEmbed({ diff: 9, now: 2000, lastEmbedAt: 1000 }) === true, 'تغيّر كافٍ ⇒ بصمة');
  ok(SL.shouldEmbed({ diff: 0, now: 6000, lastEmbedAt: 1000 }) === true, 'مشهد ساكن لكن مضت 4ث ⇒ إعادة تقييم دورية');
  ok(SL.thumbUsable(new Uint8Array(768).fill(3)) === false, 'إطار معتم ⇒ مرفوض');
  ok(SL.thumbUsable(new Uint8Array(768).fill(120)) === false, 'إطار متجانس (عدسة مغطاة) ⇒ مرفوض');
  ok(SL.thumbUsable(Uint8Array.from({ length: 768 }, (_, i) => (i * 37) % 200)) === true, 'إطار طبيعي ⇒ مقبول');
}

console.log('=== الميزانية التكيّفية ===');
{
  ok(SL.updateEma(0, 300) === 300 && close(SL.updateEma(300, 600), 390), 'EMA: أول قياس ثم تنعيم');
  const f = SL.computeInterval(300), m = SL.computeInterval(1000), s = SL.computeInterval(2000);
  ok(f.tier === 'fast' && f.delay === 900, 'جهاز سريع (300ms) ⇒ فاصل 0.9ث (الحد الأدنى)');
  ok(m.tier === 'mid' && m.delay === 3000, 'متوسط (1000ms) ⇒ فاصل 3ث = 3×الزمن');
  ok(s.tier === 'slow' && s.delay === 6000, 'بطيء (2000ms) ⇒ فاصل 6ث');
  ok(SL.computeInterval(3000, { samples: 1 }).tier === 'slow', 'بطيء جداً لكن قياس واحد ⇒ لا قرار بالإيقاف بعد');
  const off = SL.computeInterval(3000, { samples: 3 });
  ok(off.tier === 'off' && off.delay === 0, 'بطيء جداً بعد 3 قياسات ⇒ إيقاف الميزة');
  { const w = SL.computeInterval(0, { cores: 2 }), n = SL.computeInterval(0, {});
    ok(w.tier === 'slow' && w.delay === 4500 && n.tier === 'mid' && n.delay === 2400, 'قبل أول قياس: الضعيف يبدأ بفاصل 4.5ث والعادي 2.4ث، ثم يتبع القياس الفعلي'); }
  let duty = true; for (const e of [100, 300, 700, 1200, 2000, 2500]) { const p = SL.computeInterval(e); if (e / (e + p.delay) > 0.26) duty = false; }
  ok(duty, 'نسبة استخدام المعالج ≤ ~25% في كل المستويات');
}

console.log('=== التصويت الزمني (تقليل الإنذارات الكاذبة) ===');
{
  const vt = SL.createVoteTracker({ strong: 0.65 });
  ok(vt.push({ name: 'حفرة', score: 0.58 }, 1000) === null, 'تطابق ضعيف واحد ⇒ لا تنبيه');
  const c = vt.push({ name: 'حفرة', score: 0.58 }, 2000);
  ok(c && c.name === 'حفرة' && c.why === 'votes', 'تطابقان من ثلاثة ⇒ تنبيه');
  const v2 = SL.createVoteTracker({ strong: 0.65 });
  const s1 = v2.push({ name: 'درج', score: 0.7 }, 1000);
  ok(s1 && s1.why === 'strong', 'تطابق قوي واحد ⇒ تنبيه فوري');
  const v3 = SL.createVoteTracker({ strong: 0.65 });
  v3.push({ name: 'حفرة', score: 0.58 }, 1000); v3.push(null, 2000);
  ok(v3.push({ name: 'مطب', score: 0.58 }, 3000) === null, 'أسماء مختلفة لا تُجمع');
  const v4 = SL.createVoteTracker({ strong: 0.65 });
  v4.push({ name: 'حفرة', score: 0.58 }, 1000);
  ok(v4.push({ name: 'حفرة', score: 0.58 }, 20000) === null, 'تطابق قديم خارج النافذة لا يُحتسب');
  const v5 = SL.createVoteTracker({ strong: 0.65 }); v5.setWindow(30000);
  v5.push({ name: 'حفرة', score: 0.58 }, 1000);
  ok(v5.push({ name: 'حفرة', score: 0.58 }, 20000) !== null, 'نافذة أوسع للأجهزة البطيئة ⇒ يُحتسب');
  const v6 = SL.createVoteTracker({}); v6.push(null, 1); v6.push(null, 2);
  ok(v6.clearedFor(2) === true, 'إطاران خاليان ⇒ يُعاد تفعيل التنبيه عند عودة الخطر');
}

console.log('=== من يعمل الآن؟ (الخصوصية والأولوية) ===');
{
  const base = { running: true, hidden: false, nav: true, lifeMode: 'walk', busyUser: false, speaking: false, videoOk: true, backendReady: true, wantHazard: true, hasHazardPool: true, wantItems: false, hasItems: false };
  const g = o => SL.liveGate(Object.assign({}, base, o));
  ok(g({}) === 'run', 'الحالة العادية ⇒ يعمل');
  ok(g({ lifeMode: 'grooming' }) === 'off' && g({ lifeMode: 'clothes' }) === 'off', 'وضع المرآة/الملابس ⇒ لا بصمات تلقائية إطلاقاً');
  ok(g({ busyUser: true }) === 'user', 'أثناء «علّمني»/«ما هذا؟»/الاستماع ⇒ صامت');
  ok(g({ speaking: true }) === 'speaking', 'أثناء كلام المساعد ⇒ ينتظر');
  ok(g({ nav: false }) === 'off', 'التنبيهات المستمرة مطفأة ⇒ لا شيء');
  ok(g({ hidden: true }) === 'idle', 'الصفحة مخفية ⇒ خامل');
  ok(g({ hasHazardPool: false }) === 'nothing', 'لا حزمة مخاطر ولا أشياء ⇒ لا تحميل ولا بصمة');
  ok(g({ backendReady: false }) === 'nobackend', 'لا عامل جاهز ⇒ يحاول التجهيز من الكاش فقط');
  ok(g({ hasHazardPool: false, wantItems: true, hasItems: true }) === 'run', 'أشيائي وحدها كافية للتشغيل عند تفعيلها');
  ok(g({ hasHazardPool: false, wantItems: true, hasItems: false, backendReady: false }) === 'nothing', 'أشيائي مفعّلة لكن فارغة ⇒ لا شيء');
}

console.log('=== فتحات البصمة وقصاصة الجسم ===');
{
  ok(SL.pickSlot(0, { items: true, roi: true }) === 'scene' && SL.pickSlot(2, { items: true, roi: true }) === 'roi', 'كل ثالث فتحة للقصاصة عند وجودها');
  ok(SL.pickSlot(2, { items: true, roi: false }) === 'scene' && SL.pickSlot(2, { items: false, roi: true }) === 'scene', 'بلا مرشح أو بلا أشياء ⇒ دائماً المشهد (المخاطر)');
  const r = SL.chooseRoi([
    { class: 'person', bbox: [0, 0, 300, 400], score: 0.9 },
    { class: 'cup', bbox: [100, 100, 80, 80], score: 0.7 },
    { class: 'bottle', bbox: [300, 120, 120, 200], score: 0.6 }], 640, 480);
  ok(r && r.cls === 'bottle', 'يختار أكبر جسم مرشح ويستثني الأشخاص والمركبات');
  ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 640 && r.y + r.h <= 480, 'القصاصة داخل الإطار');
  ok(SL.chooseRoi([{ class: 'cup', bbox: [0, 0, 10, 10], score: 0.9 }], 640, 480) === null, 'جسم صغير جداً ⇒ لا قصاصة');
  ok(SL.chooseRoi([{ class: 'cup', bbox: [0, 0, 600, 450], score: 0.9 }], 640, 480) === null, 'جسم يملأ الإطار ⇒ لا قصاصة');
  ok(SL.chooseRoi([{ class: 'cup', bbox: [100, 100, 100, 100], score: 0.3 }], 640, 480) === null, 'ثقة ضعيفة ⇒ لا قصاصة');
}

console.log('=== «ما هذا؟»: الخطر أولاً ولا تحجبه أشياؤك ===');
{
  const medRe = /(دواء|حبوب|قرص)/;
  const gs = d => 'تنبيه محتمل: أظن أن أمامك ' + d.name + '. هذا تخمين بصري؛ تأكد بعصاك.';
  const h = { generalSpeech: gs, medRe };
  const dMatch = { kind: 'match', name: 'كوبي', r: [] }, dNone = { kind: 'unknown', r: [] };
  const gHaz = { kind: 'match', name: 'حفرة', cls: { name: 'حفرة', kind: 'hazard', score: 0.7 }, r: [] };
  const gObj = { kind: 'match', name: 'كرسي', cls: { name: 'كرسي', kind: 'object', score: 0.7 }, r: [] };
  let m = SL.composeIdentifyMessage(dMatch, gHaz, h);
  ok(m.startsWith('تنبيه محتمل') && m.includes('حفرة') && m.includes('كوبي'), 'مطابقة شخصية + خطر ⇒ الخطر أولاً ثم الشخصي');
  ok(m.indexOf('حفرة') < m.indexOf('كوبي'), 'ترتيب الجملة: الخطر قبل الشيء');
  ok(SL.composeIdentifyMessage(dNone, gHaz, h) === gs(gHaz), 'خطر فقط ⇒ ينطق الخطر');
  ok(SL.composeIdentifyMessage(dMatch, gObj, h).startsWith('أظنه كوبي'), 'مطابقة شخصية + شيء عام عادي ⇒ كالسابق (الشخصي)');
  const gAmbHaz = { kind: 'ambiguous', a: 'حفرة', b: 'مطب', r: [{ name: 'حفرة', kind: 'hazard', score: 0.6 }, { name: 'مطب', kind: 'hazard', score: 0.58 }] };
  m = SL.composeIdentifyMessage(dMatch, gAmbHaz, h);
  ok(m.startsWith('تنبيه محتمل') && m.includes('حفرة') && m.includes('مطب') && m.includes('كوبي'), 'التباس بين خطرين ⇒ ينبّه أولاً ولا يصمت');
  const gAmbObj = { kind: 'ambiguous', a: 'كرسي', b: 'طاولة', r: [{ name: 'كرسي', kind: 'object', score: 0.6 }] };
  ok(SL.composeIdentifyMessage(dNone, gAmbObj, h).includes('من المعرفة العامة'), 'التباس بين أشياء عادية ⇒ كالسابق');
  ok(SL.composeIdentifyMessage({ kind: 'match', name: 'دواء الضغط', r: [] }, gHaz, h).includes('تأكد من الاسم المكتوب'), 'تحذير الأدوية يبقى مع الاسم');
  ok(SL.composeIdentifyMessage(dNone, { kind: 'unknown', r: [] }, h).startsWith('لا أعرف هذا الشيء'), 'لا شيء معروف ⇒ الرسالة الأصلية');
}

console.log('=== العامل embed_worker.js (بروتوكول + طابور + تطابق النموذج) ===');
(async () => {
  const posted = [];
  const sandbox = { console, Float32Array, Promise, Math, Date, Object, Map, Error, String };
  sandbox.self = sandbox;
  sandbox.postMessage = (m, tr) => posted.push(m);
  let pipelineArgs = null, envSeen = null, calls = 0, concurrent = 0, maxConcurrent = 0;
  sandbox.__loadTransformers = async () => ({
    env: { backends: { onnx: { wasm: {} } }, useWasmCache: false },
    pipeline: async (task, model, opt) => {
      pipelineArgs = [task, model, opt];
      return async blob => {
        calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 15));
        concurrent--;
        const N = 5, D = 8, data = new Float32Array(N * D).map((_, i) => ((i * 31) % 17) - 8);
        return { dims: [1, N, D], data };
      };
    }
  });
  vm.createContext(sandbox);
  vm.runInContext(workerSrc, sandbox);
  const send = m => sandbox.onmessage({ data: m });
  const waitFor = (f, ms) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { const r = f(); if (r) { clearInterval(i); res(r); } else if (Date.now() - t0 > (ms || 2000)) { clearInterval(i); rej(new Error('timeout')); } }, 5); });

  send({ type: 'init' });
  await waitFor(() => posted.find(m => m.type === 'ready'));
  ok(true, 'init ⇒ ready');
  ok(pipelineArgs[0] === 'image-feature-extraction' && pipelineArgs[1] === 'Xenova/dinov2-small' && pipelineArgs[2].device === 'wasm' && pipelineArgs[2].dtype === 'q8',
    'نفس النموذج والإعداد المستخدمين في الحزم: dinov2-small / wasm / q8');
  ok(sandbox.__loadTransformers && /cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@4\.3\.2/.test(workerSrc), 'يستورد نفس الإصدار المثبّت في index.html');
  const mainVer = (html.match(/import\('https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@([\d.]+)'\)/) || [])[1];
  ok(mainVer === '4.3.2', 'إصدار index.html = ' + mainVer);

  send({ type: 'embed', id: 1, blob: {} }); send({ type: 'embed', id: 2, blob: {} }); send({ type: 'embed', id: 3, blob: {} });
  await waitFor(() => posted.filter(m => m.id).length === 3);
  const res = posted.filter(m => m.id);
  ok(res.map(m => m.id).join() === '1,2,3' && res.every(m => m.ok), 'ثلاثة طلبات ⇒ ثلاث نتائج بالترتيب');
  ok(maxConcurrent === 1, 'طابور واحد: لا استدلالان متداخلان (أقصى تزامن = ' + maxConcurrent + ')');
  const legacyVec = SL.reduceEmbedding([1, 5, 8], new Float32Array(40).map((_, i) => ((i * 31) % 17) - 8));
  ok(res[0].vec.length === 16 && res[0].vec.every((x, i) => x === legacyVec[i]), 'ناتج العامل ≡ SanadLive.reduceEmbedding');
  ok(typeof res[0].ms === 'number' && res[0].ms >= 0, 'يُرجع زمن الحساب الفعلي ms');
  ok(env_ok(), 'يضبط numThreads=1 وproxy=false ويفعّل كاش WASM');
  function env_ok() { return /numThreads = 1/.test(workerSrc) && /proxy = false/.test(workerSrc) && /useWasmCache = true/.test(workerSrc); }

  // فشل التهيئة (الشبكة/الكاش) يُبلَّغ ولا يعلّق، ويمكن إعادة المحاولة
  const posted2 = []; const sb2 = Object.assign({}, sandbox); sb2.self = sb2; sb2.postMessage = m => posted2.push(m);
  sb2.__loadTransformers = async () => { throw new Error('Failed to fetch'); };
  vm.createContext(sb2); vm.runInContext(workerSrc, sb2);
  sb2.onmessage({ data: { type: 'init' } });
  await waitFor(() => posted2.length);
  ok(posted2[0].type === 'init-error' && /Failed to fetch/.test(posted2[0].message), 'فشل التحميل ⇒ init-error برسالة واضحة');
  sb2.onmessage({ data: { type: 'embed', id: 9, blob: {} } });
  await waitFor(() => posted2.find(m => m.id === 9));
  ok(posted2.find(m => m.id === 9).ok === false, 'طلب بصمة بلا نموذج ⇒ فشل صريح لا تعليق');

  console.log('=== الربط في index.html و sw.js ===');
  ok(/<script src="live_recog_core\.js"><\/script>/.test(html), 'index.html يحمّل live_recog_core.js');
  ok(/new Worker\('embed_worker\.js', \{ type: 'module' \}\)/.test(html), 'العامل يُنشأ من ملف الموقع نفسه (module)');
  ok(/CORE_FILES = \[[^\]]*live_recog_core\.js[^\]]*embed_worker\.js/.test(sw), 'sw.js يخزّن الملفين الجديدين للعمل بلا إنترنت');
  ok(/const VERSION = 'v15'/.test(sw), 'رقم إصدار الـSW رُفع ليصل التحديث');
  // الحلقة الحية لا تستدعي نموذج البصمات على الخيط الرئيسي أبداً
  const live = html.slice(html.indexOf('async function liveRecogTick()'), html.indexOf('function startLiveRecognition()'));
  ok(live.length > 500 && !/personalExtractor|ensurePersonalModel\(|embedFrame\(|embedCanvas\(|loadTransformersEngineFixed/.test(live), 'حلقة الرصد الحي: لا استدلال ولا تحميل على الخيط الرئيسي (عبر العامل فقط)');
  ok(/workerEmbedTimed\(/.test(live) && /SL\.liveGate\(/.test(live), 'تستخدم العامل والبوابة');
  const wk = html.slice(html.indexOf('async function liveRecogEnsureWorker()'), html.indexOf('function liveRecogTooSlow()'));
  ok(/isSavedFlag\(LS_DINO_READY\)/.test(wk) && !/ensurePersonalModel|loadTransformersEngineFixed/.test(wk), 'لا تنزيل تلقائي للنموذج: يلزم أن يكون مجهّزاً سابقاً');
  ok(/stopLiveRecognition\(\); if \(liveMonitorTimer\)/.test(html) && /startLiveRecognition\(\);\n  if \(liveMonitorTimer\) return;/.test(html), 'يبدأ ويتوقف مع الرصد (الخلفية/الإغلاق)');
  ok(/claimEmbedder\(\);\n\s+captureFrame/.test(html) && /isProcessing = true; hideRiskIndicator\(\); claimEmbedder\(\);/.test(html), 'علّمني/ما هذا؟/البحث تُبطل نتائج الرصد المعلّقة');
  ok(/hazardPool = generalClasses\.filter\(c => c\.kind === 'hazard' \|\| c\.kind === 'background'\)/.test(html) && /decideGeneral\(v, hazardPool\)/.test(html), 'الرصد الحي يقارن بمجموعة المخاطر المصغّرة فقط');
  ok(/يشبه خطراً معروفاً/.test(html), 'علّمني يحذّر إن شابه شيئك خطراً معروفاً');
  const hz = html.slice(html.indexOf('function handleLiveVector('), html.indexOf('async function liveRecogTick()'));
  ok(hz.indexOf('liveHazardEnabled') < hz.indexOf('liveItemsEnabled') && /speak\(msg, true\)/.test(hz) && /speak\(msg, false\)/.test(hz), 'الخطر يُعالَج قبل أشيائي ويقاطع، وأشيائي لا تقاطع');
  ok(/\(now - liveRecog\.lastHazardTime\) > 6000/.test(hz), 'أشيائي لا تُنطق خلال 6ث من تنبيه خطر');
  ok(/window\.sanadLiveStats = /.test(html), 'مدخل القياس sanadLiveStats() موجود');
  ok(/live-recog-hazard-checkbox/.test(html) && /live-recog-items-checkbox/.test(html) && /readLS\(LS_LIVE_ITEMS, '0'\) === '1'/.test(html), 'إعدادان في الواجهة: المخاطر (مفعّل) وأشيائي (مطفأ افتراضياً)');

  console.log(fail ? '\n✘ فشل ' + fail : '\n✔ كل فحوص الرصد التلقائي نجحت');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✘ استثناء: ' + e.message); process.exit(1); });
