// اختبار سلوكي لدورة «صف المكان» الفعلية (place_ui.js + place_core.js) داخل صندوق رمل بأجزاء وهمية (حساس، كاميرا، كلام، حلقات الرصد).
// الفرق عن placetest.js: ذاك يفحص نصوص الكود، وهذا يشغّل الدورة فعلاً ويقيس ما نُطق وما أُلغي.
// التشغيل: node placeflowtest.js [مجلد المشروع]   (الافتراضي: مجلد الملف). لا يمثل هاتفاً حقيقياً ولا نماذج حقيقية.
const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = path.resolve(process.argv[2] || __dirname);
const SHOW = process.argv.includes('--show');
let failed = 0; const ok = (n, c, extra) => { console.log((c ? '✔ ' : '✘ ') + n + (extra && !c ? '  → ' + extra : '')); if (!c) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeEnv(opts) {
  opts = opts || {};
  const log = { spoken: [], status: [], stopCalls: 0, cameraSwitches: [], beeps: [], dueMin: Infinity, boostWhileCollecting: [], boostSamples: 0 };
  const els = {}; const el = id => els[id] || (els[id] = { id, hidden: false, disabled: false, classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  const sb = {}; sb.window = sb; sb.globalThis = sb;
  const handlers = [];
  sb.addEventListener = (t, h) => { if (t === 'deviceorientation') handlers.push(h); };
  sb.removeEventListener = (t, h) => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
  sb.document = { getElementById: el };
  sb.console = { log() {}, warn() {}, error() {}, info() {} };
  sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout; sb.setInterval = setInterval; sb.clearInterval = clearInterval;
  sb.Promise = Promise; sb.Date = Date; sb.Math = Math; sb.Number = Number; sb.Object = Object; sb.Set = Set; sb.Array = Array; sb.String = String; sb.JSON = JSON;
  // ---- حالة التطبيق الوهمية ----
  sb.assistantSpeaking = false; sb.isProcessing = false; sb.facingMode = opts.facing || 'environment'; sb.navModeEnabled = true; sb.torchOn = false;
  sb.videoElement = { videoWidth: 640, videoHeight: 480, paused: false }; sb.videoStream = {}; sb.localScanEnabled = true; sb.liveArchEnabled = true;
  sb.liveRecog = { off: { seg: false }, due: { arch: 5000 } }; sb.segReady = true; sb.LS_SEG_READY = 'k'; sb.isSavedFlag = () => true; sb.startSegWorker = async () => true;
  sb.segMeta = { id2label: { 0: 'wall', 1: 'floor', 2: 'ceiling', 3: 'door', 4: 'bed' } }; sb.phonePitchBeta = 90; sb.lastDescription = ''; sb.fieldRecording = null;
  sb.SanadField = { topLabels(labels, gw, gh, id2, n) { const c = {}; for (const v of labels) c[v] = (c[v] || 0) + 1; return Object.keys(c).map(k => ({ label: id2[k], frac: c[k] / labels.length })).sort((a, b) => b.frac - a.frac).slice(0, n); } };
  sb.LOCAL_OBJECT_MAP = { person: { ar: 'شخص', priority: 3 }, chair: { ar: 'كرسي', priority: 2 } };
  sb.estimateObjectDistance = () => ({ steps: 3, meters: 2.4 }); sb.getRelativePositionArabic = () => 'أمامك';
  sb.probeFrameQuality = () => ({ meanY: 90, sharpness: 8, isLensCovered: false });
  sb.initLocalObjectEngine = async () => ({}); sb.setNavMode = () => {}; sb.startLiveMonitoring = () => {}; sb.applyTorch = async () => true;
  sb.updateStatus = t => log.status.push(t);
  sb.speak = (t, interrupt) => { log.spoken.push(String(t)); sb.assistantSpeaking = true; setTimeout(() => { sb.assistantSpeaking = false; }, 25); };
  sb.stopSpeaking = () => { log.stopCalls++; sb.assistantSpeaking = false; };
  sb.switchCameraFacing = async f => { log.cameraSwitches.push(f); sb.facingMode = f; };
  sb.playSpatialBeep = s => log.beeps.push(s);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(dir, 'place_core.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(dir, 'place_ui.js'), 'utf8'), sb);
  const PS = sb.PlaceScan;
  if (!PS) throw new Error('PlaceScan لم يُعرَّف');
  Object.assign(PS.cfg, { calibrationMs: 60, sectorMs: 3200, adjustmentMs: 200, stallMs: 2500, continueWaitMs: 1500, modelWarmupMs: 500, hazardPauseMs: 200 });
  // ---- محاكاة الحساس: yaw ثابت يُحدَّث كل 20ms ----
  let yaw = 0;
  const sensor = setInterval(() => { for (const h of handlers.slice()) h({ alpha: (360 - yaw) % 360, beta: 90, gamma: 0 }); }, 20);
  // ---- محاكاة حلقات الرصد الخلفية (coco كل 100ms، التجزئة كل 150ms بعد أن تصبح «مستحقة») ----
  const GW = 12, GH = 9; const labels = new Uint8Array(GW * GH).fill(0);
  for (let y = 6; y < GH; y++) for (let x = 0; x < GW; x++) labels[y * GW + x] = 1;
  for (let y = 0; y < 2; y++) for (let x = 0; x < GW; x++) labels[y * GW + x] = 2;
  for (let y = 2; y < 6; y++) for (let x = 0; x < 3; x++) labels[y * GW + x] = 3;
  for (let y = 3; y < 7; y++) for (let x = 5; x < 9; x++) labels[y * GW + x] = 4;
  const loop = setInterval(() => {
    if (PS.boost) log.boostSamples++;
    log.dueMin = Math.min(log.dueMin, sb.liveRecog.due.arch);
    PS.onCoco([{ class: 'person', score: .9, bbox: [10, 10, 50, 100] }, { class: 'chair', score: .8, bbox: [500, 10, 50, 100] }], 640, 480);
    if (!opts.noSeg && sb.liveRecog.due.arch <= Date.now() - 0) { PS.onArch({ labels, gw: GW, gh: GH }); sb.liveRecog.due.arch = Date.now() + (opts.segEveryMs || 150); }
  }, 100);
  // ---- مُوجِّه المستخدم الوهمي: يلف الهاتف حين يسمع التعليمة ----
  const driver = setInterval(() => {
    const last = log.spoken[log.spoken.length - 1] || '';
    if (opts.noYaw) return;
    if (/نحو يمينك تماماً/.test(last)) yaw = 90; else if (/نحو يسارك تماماً/.test(last)) yaw = 270; else if (/بجوار رأسك/.test(last)) yaw = 180;
  }, 30);
  const stopAll = () => { clearInterval(sensor); clearInterval(loop); clearInterval(driver); };
  const setYaw = v => { yaw = v; };
  // بلا حساس: لا أحداث إطلاقاً
  if (opts.noYaw) { clearInterval(sensor); }
  return { sb, PS, log, stopAll, setYaw };
}
async function waitUntil(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(40); } return false; }

(async () => {
  console.log('مجلد الاختبار: ' + dir);
  /* ---------- 1) المسار الكامل: أمام ثم يمين ويسار ثم الخلف ---------- */
  {
    const E = makeEnv(); const { PS, log } = E;
    PS.start();
    const reachedWait = await waitUntil(() => PS.waitingForContinue, 15000);
    ok('الدورة تصل إلى انتظار «استكمال الجهات» بعد وصف الأمام', reachedWait, JSON.stringify(log.spoken.slice(-2)));
    PS.continueScan();
    const reachedBack = await waitUntil(() => PS.running && PS.waitingForContinue && log.spoken.some(t => /على يمينك:/.test(t)), 20000);
    ok('يمين ويسار يُجمعان ثم يُعرض وصفهما ويُسأل عن الخلف', reachedBack, JSON.stringify(log.spoken.slice(-3)));
    PS.continueScan();
    const finished = await waitUntil(() => !PS.running, 15000);
    ok('الدورة تنتهي وتحرّر الحالة', finished);
    E.stopAll();
    const all = log.spoken.join(' || ');
    if (SHOW) console.log('\n--- كل ما نُطق ---\n' + log.spoken.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n');
    const count = re => log.spoken.filter(t => re.test(t)).length;
    ok('وصف الجهة الأمامية يُنطق مرة واحدة فقط (لا يُكرَّر في الخلاصات)', count(/أمامك:/) === 1, 'عدد مرات «أمامك:» = ' + count(/أمامك:/));
    ok('التحفظ الطويل «لا يدل على خلو الطريق» يُنطق مرة واحدة', count(/لا يدل على خلو الطريق/) === 1, 'عدد = ' + count(/لا يدل على خلو الطريق/));
    ok('وصف اليمين واليسار يخلو من الأمام', log.spoken.some(t => /على يمينك:/.test(t) && /على يسارك:/.test(t) && !/أمامك:/.test(t)));
    ok('الخاتمة تصف الخلف فقط ولا تعيد غيره', log.spoken.some(t => /خلفك:/.test(t) && !/أمامك:|على يمينك:|على يسارك:/.test(t)));
    ok('الخلف لا يذكر «شخص» (قد يكون المستخدم نفسه)', !log.spoken.some(t => /خلفك:[^.]*شخص/.test(t)));
    ok('كاميرا خلفية أصلاً ⇒ لا تبديل ولا استعادة', log.cameraSwitches.length === 0);
    ok('نغمات الوصول للجهات: يمين ويسار ووسط(خلف)', ['right', 'left', 'center'].every(b => log.beeps.includes(b)));
    ok('أثناء الجمع يُفعَّل التسريع (boost) ثم يُلغى بعد الانتهاء', log.boostSamples > 5 && !PS.boost);
    ok('عند بدء الجمع يُصفَّر مؤقت التجزئة (عينة فورية) بدل انتظار الرصد الخلفي', log.dueMin === 0, 'أصغر قيمة due.arch = ' + log.dueMin);
  }
  /* ---------- 2) الإلغاء يُسكت الكلام ويحرّر ---------- */
  {
    const E = makeEnv(); const { PS, log } = E;
    PS.start(); await waitUntil(() => log.spoken.length >= 1, 3000);
    const before = log.stopCalls; PS.cancel();
    ok('زر «إيقاف الوصف» (cancel) يستدعي stopSpeaking فوراً', log.stopCalls > before);
    ok('الدورة تتحرر بعد الإلغاء', await waitUntil(() => !PS.running, 8000));
    E.stopAll();
  }
  /* ---------- 3) زر «اسكت» العلوي ---------- */
  {
    const E = makeEnv(); const { PS, log } = E;
    PS.start(); await waitUntil(() => PS.waitingForContinue, 15000);
    const s0 = log.stopCalls; PS.onStopButton();
    ok('أثناء انتظار الاستكمال: «اسكت» يُسكت الكلام فقط ولا يُنهي المسح', log.stopCalls > s0 && PS.running && PS.waitingForContinue);
    PS.cancel(); await waitUntil(() => !PS.running, 5000);
    ok('«اسكت» بلا مسح يعمل كالمعتاد', (() => { const s = log.stopCalls; PS.onStopButton(); return log.stopCalls === s + 1; })());
    E.stopAll();
    const E2 = makeEnv(); E2.PS.start(); await waitUntil(() => E2.log.spoken.length >= 1, 3000);
    E2.PS.onStopButton();
    ok('أثناء التوجيه/الجمع: «اسكت» يُلغي المسح', await waitUntil(() => !E2.PS.running, 8000));
    E2.stopAll();
  }
  /* ---------- 4) بلا حساس اتجاه: الأمام فقط وبلا اختلاق ---------- */
  {
    const E = makeEnv({ noYaw: true }); const { PS, log } = E;
    PS.start(); const done = await waitUntil(() => !PS.running, 20000);
    E.stopAll();
    ok('بلا حساس: ينتهي بوصف الأمام فقط ويشرح السبب', done && log.spoken.some(t => /حساس الاتجاه غير متاح/.test(t)) && !log.spoken.some(t => /على يمينك:|على يسارك:|خلفك:/.test(t)));
  }
  /* ---------- 5) الكاميرا الأمامية: تبديل ثم استعادة ---------- */
  {
    const E = makeEnv({ facing: 'user' }); const { PS, log, sb } = E;
    PS.start(); await waitUntil(() => PS.waitingForContinue, 15000);
    ok('كاميرا المرآة (أمامية) ⇒ تُبدَّل للخلفية للوصف', log.cameraSwitches[0] === 'environment');
    PS.cancel(); await waitUntil(() => !PS.running, 8000); E.stopAll();
    ok('وبعد الانتهاء تُستعاد الأمامية', log.cameraSwitches[log.cameraSwitches.length - 1] === 'user' && sb.facingMode === 'user');
  }
  /* ---------- 6) بطء التجزئة: هل يكتمل القطاع؟ (عينة كل 2.6 ث تقارب هاتفاً بطيئاً) ---------- */
  {
    const E = makeEnv({ segEveryMs: 2600 }); const { PS, log } = E;
    PS.start(); const reached = await waitUntil(() => PS.waitingForContinue || !PS.running, 20000);
    const sp = log.spoken.join(' ');
    E.stopAll(); PS.cancel();
    ok('تجزئة بطيئة (2.6ث) لا تُفشل الجهة الأمامية', reached && !/لم أتمكن من استكمال وصف الجهة الأمامية|لم أحصل على قراءات كافية/.test(sp), sp.slice(0, 200));
  }
  console.log(failed ? '\n✘ فشل ' + failed : '\n✔ كل اختبارات الدورة نجحت');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ في الاختبار:', e); process.exit(2); });
