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
// جدول أصناف المكان الحقيقي من index.html (لا نسخة مكررة)
const CRIT = eval('(' + html.match(/const ADE20K_CRITICAL = (\{[\s\S]*?\n\});/)[1] + ')');
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

{
  const a = SL.computeInterval(1000, { k: 6, minDelay: 1500, maxDelay: 12000 });
  ok(a.tier === 'mid' && a.delay === 6000, 'المكان: k=6 ⇒ فاصل 6ث عند 1000ms (≈14% من المعالج)');
  ok(SL.computeInterval(100, { k: 6, minDelay: 1500, maxDelay: 12000 }).delay === 1500, 'المكان: حد أدنى 1.5ث');
  ok(SL.computeInterval(3000, { samples: 5, offAt: 3500, k: 6, minDelay: 1500, maxDelay: 12000 }).tier === 'slow', 'المكان يتسامح حتى 3.5ث قبل الإيقاف (offAt)');
  ok(SL.computeInterval(4000, { samples: 5, offAt: 3500 }).tier === 'off', 'وبعدها يتوقف');
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
  ok(g({ wantHazard: false, wantArch: true, segReady: true, backendReady: false }) === 'run', 'المكان وحده يكفي للتشغيل دون نموذج البصمات');
  ok(g({ wantHazard: false, wantArch: true, segReady: false }) === 'nobackend', 'المكان مفعّل والنموذج غير جاهز ⇒ يحاول التجهيز من الكاش فقط');
  ok(g({ wantHazard: false, wantArch: true, segReady: true, lifeMode: 'grooming' }) === 'off' && g({ wantArch: true, segReady: true, lifeMode: 'clothes' }) === 'off', 'المكان أيضاً ممنوع في المرآة/الملابس');
  ok(g({ wantHazard: false, wantArch: true, segReady: true, busyUser: true }) === 'user', 'المكان أيضاً يصمت أثناء طلب المستخدم');
}

console.log('=== مخطِّط الميزات وقصاصة الجسم ===');
{
  const all = [{ id: 'scene', due: 0 }, { id: 'roi', due: 0 }, { id: 'arch', due: 0 }];
  ok(SL.chooseFeature(all, 1000, () => true).pick === 'scene', 'الأولوية: المخاطر أولاً');
  ok(SL.chooseFeature(all, 1000, id => id !== 'scene').pick === 'roi', 'بوابة المشهد رفضت المخاطر ⇒ التالية');
  ok(SL.chooseFeature([{ id: 'scene', due: 5000 }, { id: 'arch', due: 0 }], 1000, () => true).pick === 'arch', 'المخاطر لم يحن موعدها ⇒ المكان يعمل في الفجوة');
  let c = SL.chooseFeature([{ id: 'scene', due: 3000 }, { id: 'arch', due: 4000 }], 1000, () => true);
  ok(c.pick === null && c.waitMs === 1500, 'لا شيء حان ⇒ ينتظر (حتى 1.5ث)');
  c = SL.chooseFeature([{ id: 'scene', due: 1300 }], 1000, () => true);
  ok(c.pick === null && c.waitMs === 300, 'ينتظر بقدر الموعد القريب');
  c = SL.chooseFeature(all, 1000, () => false);
  ok(c.pick === null && c.waitMs === 500, 'المشهد لم يتغير ⇒ يعيد الفحص بعد نصف ثانية');
  ok(SL.chooseFeature([], 1000, () => true).waitMs === 1500, 'لا ميزات جاهزة ⇒ 1.5ث');
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

console.log('=== المكان: أبعاد الإدخال وتلخيص الشبكة ===');
{
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  ok(eq(SL.segDims(640, 480), [384, 288]) && eq(SL.segDims(480, 640), [288, 384]), '4:3 أفقي/عمودي ⇒ 384×288 / 288×384');
  ok(eq(SL.segDims(1280, 720), [384, 224]) && eq(SL.segDims(720, 1280), [224, 384]), '16:9 ⇒ مضاعفات 32 (384×224)');
  ok(eq(SL.segDims(0, 0), [384, 288]) && eq(SL.segDims(1920, 200), [384, 160]), 'بلا أبعاد ⇒ افتراضي؛ بانورامي ⇒ الحد الأدنى 160');
  let allMult = true; for (const [w, h] of [[640, 480], [1280, 720], [1080, 1920], [3000, 2000], [100, 100]]) { const d = SL.segDims(w, h); if (d[0] % 32 || d[1] % 32 || Math.min(...d) < 160) allMult = false; }
  ok(allMult, 'كل الأبعاد مضاعفات 32 وبحد أدنى 160');

  const id2 = { 0: 'wall', 1: 'door', 2: 'stairs', 3: 'sky', 4: 'windowpane', 5: 'stairway', 6: 'road', 7: 'floor' };
  const mk = (gw, gh, fn) => { const a = new Uint8Array(gw * gh); for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) a[y * gw + x] = fn(x, y); return a; };
  const gw = 20, gh = 16;
  // سلالم على اليسار (3 أعمدة من 20 = 15%) + باب على اليمين (2 من 20 = 10%) + الباقي سماء
  let f = SL.summarizeSegGrid(mk(gw, gh, x => x < 3 ? 2 : (x >= 18 ? 1 : 3)), gw, gh, id2, CRIT);
  ok(f.length === 2 && f[0].key === 'stairs' && f[0].pos === 'على اليسار' && f[1].key === 'door' && f[1].pos === 'على اليمين', 'سلالم يسار + باب يمين، مرتّبة بالأولوية');
  ok(close(f[0].frac, 0.15) && close(f[0].ratio, 0.15 / 0.02), 'نسبة المساحة والنسبة للعتبة صحيحتان');
  ok(SL.summarizeSegGrid(mk(gw, gh, () => 3), gw, gh, id2, CRIT).length === 0, 'سماء فقط ⇒ لا شيء حرج');
  ok(SL.summarizeSegGrid(mk(gw, gh, (x, y) => (x === 0 && y === 0) ? 2 : 3), gw, gh, id2, CRIT).length === 0, 'سلالم أقل من العتبة (0.3%) ⇒ تُتجاهل كما في القديم');
  f = SL.summarizeSegGrid(mk(gw, gh, x => x >= 7 && x < 13 ? 1 : 3), gw, gh, id2, CRIT);
  ok(f.length === 1 && f[0].pos === 'أمامك', 'باب في الوسط ⇒ «أمامك»');
  ok(SL.summarizeSegGrid(null, 4, 4, id2, CRIT).length === 0 && SL.summarizeSegGrid(new Uint8Array(3), 4, 4, id2, CRIT).length === 0, 'مدخلات ناقصة ⇒ فارغ بلا استثناء');
  // نفس تنسيق analyzeLocalArchitecture القديم
  f = SL.summarizeSegGrid(mk(gw, gh, x => x < 3 ? 2 : (x < 6 ? 5 : (x >= 16 ? 1 : 3))), gw, gh, id2, CRIT);
  const txt = SL.formatArchFindings(f);
  ok(txt.filter(t => t.includes('سلم') || t.includes('سلالم')).length === 1, 'سلالم وسلم ⇒ مجموعة واحدة (كالقديم)');
  ok(txt.every(t => /(على اليسار|على اليمين|أمامك)$/.test(t)) && txt.length <= 4, 'النصوص بصيغة «اسم موضع» وحتى 4');
  const many = []; for (let i = 0; i < 9; i++) many.push({ ar: 'شيء' + i, pos: 'أمامك' });
  ok(SL.formatArchFindings(many).length === 4, 'حد أقصى 4');
}
console.log('=== المكان: مُعلِن التنبيه والإخبار الهادئ ===');
{
  const F = (key, ratio, pos) => ({ key, ar: (CRIT[key] || { ar: key }).ar, pos: pos || 'أمامك', priority: (CRIT[key] || { priority: 1 }).priority, ratio, frac: ratio * (CRIT[key] || { minPct: 0.02 }).minPct });
  let an = SL.createArchAnnouncer(), r;
  r = an.update([F('stairs', 4)], 1000);
  ok(r.alert && r.alert.group === 'stairs' && r.alert.kind === 'hazard', 'سلالم واضحة (4× العتبة) ⇒ تنبيه فوري');
  ok(an.update([F('stairs', 4)], 5000).alert === null, 'تهدئة 10ث: لا تكرار');
  ok(an.update([F('stairs', 4)], 12000).alert !== null, 'بعد التهدئة والسلالم ما زالت ⇒ تنبيه ثانٍ');
  an = SL.createArchAnnouncer();
  ok(an.update([F('stairs', 1.5)], 1000).alert === null, 'سلالم ضعيفة (1.5×) في إطار واحد ⇒ لا تنبيه');
  ok(an.update([F('stairs', 1.5)], 3000).alert !== null, 'وتكرارها في إطار ثانٍ ⇒ تنبيه (تصويت 2 من 3)');
  an = SL.createArchAnnouncer();
  ok(an.update([F('step', 4)], 1000).alert.group === 'stairs' && an.update([F('stairway', 5)], 20000).alert.group === 'stairs', 'سلالم/سلم/درجة مجموعة واحدة');
  an = SL.createArchAnnouncer(); an.update([F('stairs', 4)], 1000);
  an.update([], 2000); an.update([], 3000);
  ok(an.update([F('stairs', 4)], 4000).alert !== null, 'غابت إطارين ثم عادت ⇒ ينبَّه فوراً من جديد');
  an = SL.createArchAnnouncer();
  r = an.update([F('door', 4)], 1000);
  ok(r.info && r.info.group === 'door' && r.alert === null, 'باب واضح ⇒ إخبار هادئ لا تنبيه');
  ok(an.update([F('door', 4)], 8000).info === null, 'الباب نفسه خلال 20ث ⇒ لا تكرار');
  ok(an.update([F('door', 4)], 22000).info !== null, 'بعد 20ث ⇒ يُذكر ثانية');
  an = SL.createArchAnnouncer();
  r = an.update([F('stairs', 4), F('door', 4)], 1000);
  ok(r.alert && r.info === null, 'تنبيه وإخبار معاً ⇒ التنبيه فقط');
  ok(an.update([F('door', 4)], 2000).info !== null, 'والإخبار لم يُستهلك: يُذكر لاحقاً');
  an = SL.createArchAnnouncer();
  ok(an.update([F('door', 4)], 1000, false).info === null, 'المنع (المساعد يتكلم) ⇒ لا إخبار');
  ok(an.update([F('door', 4)], 1500, true).info !== null, 'ولا يُحتسب مُعلَناً: يُذكر حين يُسمح');
  an = SL.createArchAnnouncer();
  an.update([F('door', 4)], 1000);
  ok(an.update([F('windowpane', 4)], 3000).info === null, 'إخباران متتاليان خلال 6ث ⇒ الثاني ينتظر');
  ok(an.update([F('windowpane', 4)], 8000).info && an.update([F('windowpane', 4)], 8100).info === null, 'ثم يُذكر مرة واحدة');
  an = SL.createArchAnnouncer();
  ok(an.update([F('road', 4)], 1000).info !== null && an.update([F('road', 4)], 30000).info === null && an.update([F('road', 4)], 50000).info !== null, 'الطريق: هادئ جداً (45ث)');
  ok(an.update([F('sky', 9)], 60000).alert === null, 'أصناف غير معرّفة في السياسة تُتجاهل');
  ok(SL.ARCH_POLICY.stairs.kind === 'hazard' && SL.ARCH_POLICY.water.kind === 'hazard' && SL.ARCH_POLICY.wall.kind === 'hazard' && SL.ARCH_POLICY.pole.kind === 'hazard', 'السلالم والمياه والحائط والعمود = تنبيه');
  ok(SL.ARCH_POLICY.door.kind === 'info' && SL.ARCH_POLICY.windowpane.kind === 'info', 'الباب والشباك = إخبار هادئ');
  const covered = Object.keys(CRIT).filter(k => !['stairway', 'step'].includes(k) && !SL.ARCH_POLICY[k]);
  ok(covered.length === 0, 'كل صنف في ADE20K_CRITICAL له سياسة إعلان (' + (covered.join('،') || 'لا نقص') + ')');
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

console.log('=== العامل embed_worker.js (DINOv2 + SegFormer: بروتوكول + طابور + تطابق النموذج) ===');
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

  ok(posted[0] && posted[0].type === 'alive', 'العامل يُعلن «alive» عند اكتمال تحميل السكربت');
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


  // ---- SegFormer المباشر (نموذج ومعالج وهميان يحاكيان الواجهة الحقيقية التي قرأتها في المكتبة) ----
  const makeSeg = (extra) => {
    const posted = [], sb = { console, Float32Array, Promise, Math, Date, Object, Map, Error, String };
    sb.self = sb; sb.postMessage = (m, tr) => posted.push(m);
    const st = { C: 4, gh: 6, gw: 8, id2label: { 0: 'wall', 1: 'door', 2: 'stairs', 3: 'sky' }, segArgs: null, rejectCustom: false, throwOther: false, sizes: [], concurrent: 0, maxConcurrent: 0 };
    class FakeRawImage { constructor(data, w, h, c) { this.data = data; this.width = w; this.height = h; this.channels = c; } }
    const enter = async () => { st.concurrent++; st.maxConcurrent = Math.max(st.maxConcurrent, st.concurrent); await new Promise(r => setTimeout(r, 10)); st.concurrent--; };
    const processor = Object.assign(async img => { st.sizes.push(JSON.stringify(processor.size)); return { pixel_values: { dims: [1, 3, 8, 8] } }; }, { size: { height: 512, width: 512 } });
    const model = Object.assign(async inputs => {
      await enter();
      if (st.throwOther) throw new Error('out of memory');
      if (st.rejectCustom && processor.size.width !== 512) throw new Error('Got invalid dimensions for input: pixel_values index: 2 Got: 288 Expected: 512');
      const data = new Float32Array(st.C * st.gh * st.gw);
      for (let y = 0; y < st.gh; y++) for (let x = 0; x < st.gw; x++) { const cls = x < 3 ? 2 : (x >= 6 ? 1 : 3); data[cls * st.gh * st.gw + y * st.gw + x] = 5; }
      return { logits: { dims: [1, st.C, st.gh, st.gw], data } };
    }, { config: { id2label: st.id2label }, sessions: { model: { inputNames: ['pixel_values'] } } });
    sb.__loadTransformers = async () => ({
      env: { backends: { onnx: { wasm: {} } } }, RawImage: FakeRawImage,
      AutoProcessor: { from_pretrained: async id => processor },
      AutoModelForSemanticSegmentation: { from_pretrained: async (id, opt) => { st.segArgs = [id, opt]; return model; } },
      pipeline: async () => async blob => { await enter(); return { dims: [1, 5, 8], data: new Float32Array(40).map((_, i) => ((i * 31) % 17) - 8) }; }
    });
    vm.createContext(sb); vm.runInContext(workerSrc, sb);
    return { posted, st, send: m => sb.onmessage({ data: m }), frame: id => ({ type: 'seg', id, w: 64, h: 48, buf: new ArrayBuffer(64 * 48 * 4) }) };
  };
  {
    const w = makeSeg();
    w.send({ type: 'seg-init' });
    await waitFor(() => w.posted.find(m => m.type === 'seg-ready'));
    const sr = w.posted.find(m => m.type === 'seg-ready');
    ok(w.st.segArgs[0] === 'Xenova/segformer-b0-finetuned-ade-512-512' && w.st.segArgs[1].device === 'wasm' && w.st.segArgs[1].dtype === 'q8', 'نفس نموذج المكان وإعداده الحاليين (segformer-b0 / wasm / q8) ⇒ يعيد استخدام الكاش المحفوظ');
    ok(sr.id2label[2] === 'stairs' && sr.nativeSize.width === 512, 'يُرجع id2label والحجم الأصلي');
    w.send(w.frame(31)); await waitFor(() => w.posted.find(m => m.id === 31));
    const r31 = w.posted.find(m => m.id === 31);
    ok(r31.ok && r31.gw === 8 && r31.gh === 6 && r31.labels.length === 48 && r31.fallback === false, 'تجزئة ناجحة: شبكة 8×6 (دقة الربع) بلا رجوع');
    ok(w.st.sizes[0] === '{"width":64,"height":48}', 'يضبط حجم المعالج على حجم الإطار المرسل (لا يرفعه إلى 512)');
    ok(r31.labels[0] === 2 && r31.labels[7] === 1 && r31.labels[4] === 3, 'argmax صحيح لكل خلية (سلالم يسار، سماء وسط، باب يمين)');
    ok(typeof r31.ms === 'number', 'يُرجع زمن الحساب الفعلي');
    const sm = SL.summarizeSegGrid(r31.labels, r31.gw, r31.gh, sr.id2label, CRIT);
    ok(sm[0].key === 'stairs' && sm[0].pos === 'على اليسار' && sm.some(f => f.key === 'door' && f.pos === 'على اليمين'), 'ناتج العامل يمرّ مباشرة إلى ملخّص المكان');
    // الملف لا يقبل إلا حجمه الأصلي ⇒ رجوع تلقائي ويبقى الرصد يعمل
    w.st.rejectCustom = true; w.st.sizes = [];
    w.send(w.frame(32)); await waitFor(() => w.posted.find(m => m.id === 32));
    const r32 = w.posted.find(m => m.id === 32);
    ok(r32.ok && r32.fallback === true && w.st.sizes.length === 2 && w.st.sizes[1] === JSON.stringify({ height: 512, width: 512 }), 'رفض الحجم المخصّص ⇒ رجوع للحجم الأصلي ونجاح الطلب');
    w.st.sizes = []; w.send(w.frame(33)); await waitFor(() => w.posted.find(m => m.id === 33));
    ok(w.st.sizes.length === 1 && w.posted.find(m => m.id === 33).fallback === true, 'ويتذكر ذلك فلا يكرر المحاولة المكلفة');
  }
  {
    const w = makeSeg();
    w.send({ type: 'seg-init' }); await waitFor(() => w.posted.find(m => m.type === 'seg-ready'));
    w.st.throwOther = true; w.send(w.frame(41)); await waitFor(() => w.posted.find(m => m.id === 41));
    ok(w.posted.find(m => m.id === 41).ok === false && /memory/.test(w.posted.find(m => m.id === 41).message), 'خطأ غير متعلق بالحجم ⇒ يُبلَّغ ولا يُحوَّل لرجوع');
    w.st.throwOther = false; w.send(w.frame(42)); await waitFor(() => w.posted.find(m => m.id === 42));
    ok(w.posted.find(m => m.id === 42).ok && w.posted.find(m => m.id === 42).fallback === false, 'والحجم المخصّص يبقى مفعّلاً بعده');
  }
  {
    // نموذجان في عامل واحد: لا استدلالان متداخلان إطلاقاً
    const w = makeSeg();
    w.send({ type: 'init' }); w.send({ type: 'seg-init' });
    await waitFor(() => w.posted.find(m => m.type === 'ready') && w.posted.find(m => m.type === 'seg-ready'));
    w.send({ type: 'embed', id: 51, blob: {} }); w.send(w.frame(52)); w.send({ type: 'embed', id: 53, blob: {} }); w.send(w.frame(54));
    await waitFor(() => w.posted.filter(m => m.id >= 51).length === 4);
    ok(w.posted.filter(m => m.id >= 51).map(m => m.id).join() === '51,52,53,54' && w.posted.filter(m => m.id >= 51).every(m => m.ok), 'بصمات وتجزئات متداخلة الطلب ⇒ تُنفَّذ بالترتيب');
    ok(w.st.maxConcurrent === 1, 'النموذجان في طابور واحد: أقصى تزامن = ' + w.st.maxConcurrent);
  }
  ok(/mod\.AutoModelForSemanticSegmentation\.from_pretrained/.test(workerSrc) && !/\bpipeline\([^)]*segmentation/.test(workerSrc), 'التجزئة تستدعي النموذج مباشرة لا pipeline (بلا رفع 150 صنفاً لحجم الصورة)');

  // فشل التهيئة (الشبكة/الكاش) يُبلَّغ ولا يعلّق، ويمكن إعادة المحاولة
  const posted2 = []; const sb2 = Object.assign({}, sandbox); sb2.self = sb2; sb2.postMessage = m => posted2.push(m);
  sb2.__loadTransformers = async () => { throw new Error('Failed to fetch'); };
  vm.createContext(sb2); vm.runInContext(workerSrc, sb2);
  sb2.onmessage({ data: { type: 'init' } });
  await waitFor(() => posted2.find(m => m.type === 'init-error'));
  ok(/Failed to fetch/.test(posted2.find(m => m.type === 'init-error').message), 'فشل التحميل ⇒ init-error برسالة واضحة');
  sb2.onmessage({ data: { type: 'seg-init' } });
  await waitFor(() => posted2.find(m => m.type === 'seg-init-error'));
  ok(true, 'فشل تحميل المكان ⇒ seg-init-error (لا يؤثر على نموذج البصمات)');
  sb2.onmessage({ data: { type: 'embed', id: 9, blob: {} } });
  await waitFor(() => posted2.find(m => m.id === 9));
  ok(posted2.find(m => m.id === 9).ok === false, 'طلب بصمة بلا نموذج ⇒ فشل صريح لا تعليق');

  console.log('=== الربط في index.html و sw.js ===');
  ok(/<script src="live_recog_core\.js"><\/script>/.test(html), 'index.html يحمّل live_recog_core.js');
  ok(/new Worker\('embed_worker\.js', \{ type: 'module' \}\)/.test(html), 'العامل يُنشأ من ملف الموقع نفسه (module)');
  ok(/CORE_FILES = \[[^\]]*live_recog_core\.js[^\]]*embed_worker\.js/.test(sw), 'sw.js يخزّن الملفين الجديدين للعمل بلا إنترنت');
  ok(/const VERSION = 'v20'/.test(sw), 'رقم إصدار الـSW رُفع ليصل التحديث');
  // الحلقة الحية لا تستدعي نموذج البصمات على الخيط الرئيسي أبداً
  const live = html.slice(html.indexOf('async function liveRecogTick()'), html.indexOf('function startLiveRecognition()'));
  ok(live.length > 500 && !/personalExtractor|ensurePersonalModel\(|embedFrame\(|embedCanvas\(|loadTransformersEngineFixed/.test(live), 'حلقة الرصد الحي: لا استدلال ولا تحميل على الخيط الرئيسي (عبر العامل فقط)');
  ok(/workerEmbedTimed\(/.test(live) && /workerSegTimed\(/.test(live) && /SL\.liveGate\(/.test(live) && /SL\.chooseFeature\(/.test(live), 'تستخدم العامل (للنموذجين) والبوابة والمخطِّط');
  ok(!/segPipeline|\.pipeline\(/.test(live), 'الرصد الحي لا يستدعي pipeline إطلاقاً');
  const wk = html.slice(html.indexOf('async function liveRecogEnsureWorkers('), html.indexOf('function liveRecogDisable('));
  ok(/isSavedFlag\(LS_DINO_READY\)/.test(wk) && /isSavedFlag\(LS_SEG_READY\)/.test(wk) && !/ensurePersonalModel|ensureSegFormerPipeline|loadTransformersEngineFixed/.test(wk), 'لا تنزيل تلقائي لأي نموذج: يلزم أن يكون مجهّزاً سابقاً');
  ok(/stopLiveRecognition\(\); if \(liveMonitorTimer\)/.test(html) && /startLiveRecognition\(\);\n  if \(liveMonitorTimer\) return;/.test(html), 'يبدأ ويتوقف مع الرصد (الخلفية/الإغلاق)');
  ok(/claimEmbedder\(\);\n\s+captureFrame/.test(html) && /isProcessing = true; hideRiskIndicator\(\); claimEmbedder\(\);/.test(html), 'علّمني/ما هذا؟/البحث تُبطل نتائج الرصد المعلّقة');
  ok(/hazardPool = generalClasses\.filter\(c => c\.kind === 'hazard' \|\| c\.kind === 'background'\)/.test(html) && /decideGeneral\(v, hazardPool\)/.test(html), 'الرصد الحي يقارن بمجموعة المخاطر المصغّرة فقط');
  ok(/يشبه خطراً معروفاً/.test(html), 'علّمني يحذّر إن شابه شيئك خطراً معروفاً');
  const hz = html.slice(html.indexOf('function handleLiveVector('), html.indexOf('async function liveRecogTick()'));
  ok(hz.indexOf('liveHazardEnabled') < hz.indexOf('liveItemsEnabled') && /speak\(msg, true\)/.test(hz) && /speak\(msg, false\)/.test(hz), 'الخطر يُعالَج قبل أشيائي ويقاطع، وأشيائي لا تقاطع');
  ok(/\(now - liveRecog\.lastHazardTime\) > 6000/.test(hz), 'أشيائي لا تُنطق خلال 6ث من تنبيه خطر');
  ok(/window\.sanadLiveStats = /.test(html), 'مدخل القياس sanadLiveStats() موجود');
  ok(/live-recog-hazard-checkbox/.test(html) && /live-recog-items-checkbox/.test(html) && /live-arch-checkbox/.test(html) && /readLS\(LS_LIVE_ITEMS, '0'\) === '1'/.test(html) && /readLS\(LS_LIVE_ARCH, '1'\) !== '0'/.test(html), 'ثلاثة إعدادات: المخاطر (مفعّل) والمكان (مفعّل) وأشيائي (مطفأ افتراضياً)');
  // زر الفحص: نفس المسار السريع + نتيجة حيّة حديثة + بديل قديم عند تعذّر العامل
  const an = html.slice(html.indexOf('async function analyzeLocalArchitecture() {'), html.indexOf('/* ===== الرصد التلقائي بالنماذج'));
  ok(/liveRecog\.lastArch/.test(an) && /SL\.sceneDiff\(fresh\.thumb, th\) < 6/.test(an) && /Date\.now\(\) - fresh\.t < 4000/.test(an), 'الزر يعيد استخدام نتيجة حيّة عمرها < 4ث لنفس المشهد (فوري)');
  ok(/runSegFrame\(\)/.test(an) && /return analyzeLocalArchitectureLegacy\(\)/.test(an), 'ثم العامل، ثم البديل القديم على الخيط الرئيسي إن تعذّر');
  ok(/async function analyzeLocalArchitectureLegacy\(\)/.test(html) && /segPipeline\(canvas\.toDataURL/.test(html), 'البديل القديم محفوظ كما هو (pipeline)');
  const lgStart = html.indexOf('async function analyzeLocalArchitectureLegacy()');
  const lg = html.slice(lgStart, html.indexOf('\nasync function ', lgStart + 20));
  ok(/loadTransformersEngineFixed\(\)/.test(lg) && !/ensureSegFormerPipeline/.test(lg), 'البديل يحمّل pipeline الخيط الرئيسي فعلاً (لا يعتمد على جاهزية العامل)');
  ok(/a\.includes\('سلم'\) \|\| a\.includes\('سلال'\)/.test(html), 'تلميح العمق للسلم يعمل مع «سلالم» أيضاً (كان يفوته)');
  ok((html.match(/async function ensureSegFormerPipeline\(\)/g) || []).length === 1 && /startSegWorker\(\)\)\) \{ {8}\/\/ بديل/.test(html), 'تنزيل نموذج المكان يمرّ بالعامل أولاً (لا نسختان في الذاكرة)');
  const ha = html.slice(html.indexOf('function handleLiveArch('), html.indexOf('async function liveRecogTick()'));
  ok(/speak\(msg, true\)/.test(ha) && /speak\(msg, false\)/.test(ha) && /allowInfo/.test(ha) && /ADE20K_CRITICAL/.test(ha), 'المكان: التنبيه يقاطع والإخبار هادئ ويُمنع أثناء الكلام وبعد تنبيه، بنفس جدول الأصناف');
  ok(/liveRecog\.lastHazardTime = now/.test(ha), 'تنبيه المكان يُسكت أشيائي لمدة (كتنبيه المخاطر)');

  console.log(fail ? '\n✘ فشل ' + fail : '\n✔ كل فحوص الرصد التلقائي نجحت');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✘ استثناء: ' + e.message); process.exit(1); });
