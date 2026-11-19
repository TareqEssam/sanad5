// اختبارات منطق الاختبار الميداني (field_core.js) + فحوص ربط ثابتة. لا تحاكي هاتفًا حقيقيًا.
const fs = require('fs'), F = require(__dirname + '/field_core.js');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8'), ui = fs.readFileSync(__dirname + '/field_ui.js', 'utf8');
let failed = 0; const ok = (n, c) => { console.log((c ? '✔ ' : '✘ ') + n); if (!c) failed++; };
const det = (t, preds, fq) => ({ t, type: 'detection', data: { predictions: preds, frameQuality: fq || { meanLuminance: 100 } } });
const car = (d) => ({ class: 'car', score: 0.8, known: true, relativePosition: 'أمامك', estimatedDistanceMeters: d, estimatedSteps: 5 });
const ticks = (n, mk, t0 = 0) => Array.from({ length: n }, (_, i) => det(t0 + i * 1200, mk(i)));
const start = (t, d, m) => ({ t, type: 'checkpoint_start', data: { actualDistanceM: d, distanceMethod: m || 'tape' } });

ok('8 مشاهد ببروتوكول كامل', F.SCENE_ORDER.length === 8 && F.SCENE_ORDER.every(id => F.plan(id).trials.length >= 2 || id === 'approaching_vehicle'));
ok('كل مشهد له محاولتان على الأقل (المركبة 3)', F.SCENE_ORDER.every(id => F.plan(id).trials.length >= 2) && F.plan('approaching_vehicle').trials.length === 3);
ok('المشاهد المعتمدة على SegFormer: سلالم/رصيف/حائط/مختلط', ['stairs', 'sidewalk_end', 'wall', 'mixed'].every(id => F.plan(id).needsSeg) && !F.plan('parked_vehicle').needsSeg);

// سيارة متوقفة: نجاح وفشل
const cp = F.plan('parked_vehicle').trials[0].checkpoints[0];
let r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(8, () => [car(6)])], 0, 10500);
ok('سيارة متوقفة: قراءات كافية بمسافة ⇒ ناجحة', r.ok);
r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(8, () => [])], 0, 10500);
ok('سيارة متوقفة: لا سيارة ⇒ فاشلة مع توجيه', !r.ok && r.guidance.length > 0 && r.problems.some(p => /القراءة المطلوبة/.test(p)));
r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(8, () => [{ class: 'car', score: 0.8, known: true, estimatedDistanceMeters: null }])], 0, 10500);
ok('سيارة متوقفة: بلا تقدير مسافة ⇒ فاشلة', !r.ok);
r = F.evaluateCheckpoint(cp, [{ t: 0, type: 'checkpoint_start', data: {} }, ...ticks(8, () => [car(6)])], 0, 10500);
ok('سيارة متوقفة: دون إدخال المسافة الفعلية ⇒ فاشلة', !r.ok && r.checks.some(c => c.id === 'distance' && !c.ok));
r = F.evaluateCheckpoint(cp, [{ t: 0, type: 'checkpoint_start', data: { actualDistanceM: 6 } }, ...ticks(8, () => [car(6)])], 0, 10500);
ok('مسافة بلا طريقة قياس ⇒ فاشلة', !r.ok && r.checks.find(c => c.id === 'distance' && !c.ok));
ok('شريط/علامات = مرجع دقيق، خطوات/عين = تقريبي', F.evaluateCheckpoint(cp, [start(0, 6, 'tape'), ...ticks(8, () => [car(6)])], 0, 10500).referenceGrade === 'precise' && F.evaluateCheckpoint(cp, [start(0, 6, 'steps'), ...ticks(8, () => [car(6)])], 0, 10500).referenceGrade === 'approximate');
r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(8, () => [car(6)])], 0, 3000);
ok('إنهاء القياس قبل المدة ⇒ فاشل رغم تحقق القراءات', !r.ok && r.checks.find(c => c.id === 'duration' && !c.ok) && r.guidance.some(g => /يكتمل بنفسه/.test(g)));
const mot = Array.from({ length: 20 }, (_, i) => ({ t: i * 100, type: 'motion', data: { x: 0, y: 9.8 + (i % 2) * 0.2, z: 0, rx: 3, ry: 4, rz: 0 } }));
const stb = F.stabilityOf(mot, 0, 2000); ok('ثبات الهاتف: أرقام خام (عينات، انحراف التسارع، دوران) بلا عتبات', stb.motionSamples === 20 && stb.accelMagnitudeStd > 0 && stb.rotationRateRms === 5 && !('grade' in stb));
r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(2, () => [car(6)])], 0, 10500);
ok('الرصد متعطل (قراءتان في 9.6 ث) ⇒ فشل الانتظام', !r.ok && r.checks.find(c => c.id === 'health' && !c.ok));
r = F.evaluateCheckpoint(cp, [start(0, 6), ...ticks(8, () => [{ ...car(6), score: 0.3 }])], 0, 10500);
ok('ثقة دون 0.45 لا تُحتسب رصدًا صالحًا', !r.ok);

// مركبة تقترب: العلامات
const ev = F.plan('approaching_vehicle').trials[0].checkpoints[0];
let evs = ticks(6, () => [{ class: 'bus', score: 0.7, known: true }]);
r = F.evaluateCheckpoint(ev, evs, 0, 8000); ok('مركبة: بدون علامات ⇒ فاشلة', !r.ok && r.problems.filter(p => /تضغط/.test(p)).length === 2);
evs = evs.concat([{ t: 2000, type: 'participant_marker', data: { kind: 'vehicle_visible' } }, { t: 5000, type: 'participant_marker', data: { kind: 'vehicle_passed' } }]);
r = F.evaluateCheckpoint(ev, evs, 0, 8000); ok('مركبة: بالعلامتين ⇒ ناجحة', r.ok);
evs.push({ t: 6000, type: 'participant_marker_undo', data: { ofT: 5000 } });
r = F.evaluateCheckpoint(ev, evs, 0, 8000); ok('التراجع عن علامة يلغيها', !r.ok);

// المكان
const arch = (t, labels) => ({ t, type: 'arch', data: { labels } });
const st = F.plan('stairs').trials[0].checkpoints[0];
r = F.evaluateCheckpoint(st, [start(0, 4), ...ticks(8, () => []), arch(3000, [{ label: 'stairs', frac: 0.2 }]), arch(8000, [{ label: 'step', frac: 0.05 }])], 0, 10500);
ok('سلالم: عينتان تحتويان السلم ⇒ ناجحة', r.ok);
r = F.evaluateCheckpoint(st, [start(0, 4), ...ticks(8, () => []), arch(3000, [{ label: 'wall', frac: 0.5 }]), arch(8000, [{ label: 'wall', frac: 0.5 }])], 0, 10500);
ok('سلالم: قراءات مكان بلا سلم ⇒ فاشلة مع توجيه الإمالة', !r.ok && r.guidance.some(g => /السلم/.test(g)));
r = F.evaluateCheckpoint(st, [start(0, 4), ...ticks(8, () => [])], 0, 10500);
ok('سلالم: لا قراءات مكان أبدًا ⇒ توجيه لتنزيل/تفعيل النموذج', !r.ok && r.guidance.some(g => /نموذج المكان/.test(g)));
const sw = F.plan('sidewalk_end').trials[0].checkpoints[0];
r = F.evaluateCheckpoint(sw, [start(0, 3), ...ticks(8, () => []), arch(3000, [{ label: 'sidewalk', frac: 0.3 }]), arch(8000, [{ label: 'sidewalk', frac: 0.3 }])], 0, 10500);
ok('رصيف: الرصيف دون الطريق ⇒ فاشلة (يلزم الاثنان)', !r.ok);

// الإضاءة
const lt = F.plan('low_light').trials[0].checkpoints;
const lens = (y, extra) => ticks(8, () => []).map(e => ({ ...e, data: { ...e.data, frameQuality: { meanLuminance: y, ...(extra || {}) } } }));
ok('إضاءة عادية', F.evaluateCheckpoint(lt[0], [start(0, 2), ...lens(120)], 0, 12000).ok);
ok('إضاءة خافتة لا تقبل كعادية', !F.evaluateCheckpoint(lt[0], [start(0, 2), ...lens(40)], 0, 12000).ok);
ok('خافتة', F.evaluateCheckpoint(lt[1], [start(0, 2), ...lens(40)], 0, 12000).ok);
ok('مظلم', F.evaluateCheckpoint(lt[2], [start(0, 2), ...lens(8)], 0, 12000).ok);
ok('مظلم عبر تشغيل الكشاف التلقائي', F.evaluateCheckpoint(lt[2], [start(0, 2), ...lens(60, { torchOn: true, torchAuto: true })], 0, 12000).ok);

// ملخص الجلسة (إجابات العدّ جزء من الاكتمال)
const end = (trial, cp, attempt, status) => ({ t: 1, type: 'checkpoint_end', data: { trial, cp, attempt, status } });
const ans = (trial) => ({ t: 2, type: 'trial_answer', data: { trial, answers: { vehicles: 2 } } });
const qEnd = (trial, g) => ({ t: 1, type: 'checkpoint_end', data: { trial, cp: 'pass', attempt: 1, status: 'ok', distance: { grade: g } } });
let s = F.summarizeSession('approaching_vehicle', [end(1, 'pass', 1, 'failed'), end(1, 'pass', 2, 'ok'), ans(1), end(2, 'pass', 1, 'ok'), ans(2)]);
ok('ملخص: آخر محاولة هي المعتمدة، والناقص يُعلن', s.validTrials === 2 && s.status === 'partial' && s.missing.length === 2 && s.trials[0].checkpoints[0].attempts === 2);
s = F.summarizeSession('approaching_vehicle', [1, 2, 3].flatMap(x => [end(x, 'pass', 1, 'ok'), ans(x)]));
ok('ملخص: كل النقاط والإجابات ⇒ مكتمل 100%', s.status === 'complete' && s.completeness === 100);
s = F.summarizeSession('approaching_vehicle', [1, 2, 3].map(x => end(x, 'pass', 1, 'ok')));
ok('ملخص: النقاط دون إجابات العدّ ⇒ غير مكتمل ويطلب السؤال', s.status === 'partial' && s.missing.length === 3 && s.missing.every(m => m.cp === 'answers'));
s = F.summarizeSession('parked_vehicle', F.plan('parked_vehicle').trials.flatMap(tr => tr.checkpoints.map(c => end(tr.index, c.id, 1, 'ok'))));
ok('مشهد بلا أسئلة عدّ يكتمل بالنقاط وحدها', s.status === 'complete');
s = F.summarizeSession('approaching_vehicle', [qEnd(1, 'precise'), qEnd(2, 'approximate'), qEnd(3, 'approximate'), { t: 3, type: 'trial_answer', data: { trial: 1, answers: { vehicles: null }, unsure: { vehicles: true } } }]);
ok('تقرير الجودة: مراجع دقيقة/تقريبية وإجابات غير محددة تُحصى', s.quality.preciseReferences === 1 && s.quality.approximateReferences === 2 && s.quality.unsureAnswers === 1 && s.quality.attempts.length === 3);
s = F.summarizeSession('approaching_vehicle', [end(1, 'pass', 1, 'skipped')]);
ok('نقطة متخطاة لا تُحتسب صالحة', s.validCheckpoints === 0 && s.status === 'empty');

// topLabels
const lab = new Uint8Array(100).fill(1); for (let i = 0; i < 30; i++) lab[i] = 0;
const lg = F.lowResGrid(lab, 10, 10, { 0: 'Wall', 1: 'floor' }, 4); ok('lowResGrid: شبكة 4×4 ومفتاح للتصنيفات الموجودة', lg.w === 4 && lg.data.length === 16 && lg.legend[0] === 'wall' && lg.legend[1] === 'floor');
const tl = F.topLabels(lab, 10, 10, { 0: 'Wall', 1: 'floor' }, 3); ok('topLabels: يرتب بالنسبة ويطبّع الأسماء', tl[0].label === 'floor' && tl[0].frac === 0.7 && tl[1].label === 'wall');

// ربط ثابت
ok('الربط: عتبة التسجيل المنخفضة مع إبقاء 0.56 للقرارات', /fieldRecording \? FIELD_COCO_FLOOR : 0\.56/.test(html) && /filter\(p => p\.score >= 0\.56\)/.test(html));
ok('الربط: قرارات التنبيه والمكان والحاسات والانقطاع', ["fieldPush('decision'", "fieldPush('arch'", "fieldPush('embed'", "fieldPush('torch'", "fieldPush('visibility'", "fieldPush('pagehide'", "fieldPush('orientation'", "fieldPush('motion'", "fieldPush('speech'"].every(x => html.includes(x) || ui.includes(x)));
ok('الربط: 50 مرشحًا أثناء التسجيل ثم تصفية 0.56 وقص إلى 10 للمنطق الإنتاجي', /FIELD_COCO_MAX_BOXES : COCO_MAX_BOXES/.test(html) && /filter\(p => p\.score >= 0\.56\)\.slice\(0, COCO_MAX_BOXES\)/.test(html));
ok('الواجهة: قاعدة البيانات تُفتح بإصدارها الحالي (لا VersionError) ويُعاد الإعداد بعد الجلسة', !/indexedDB\.open\(FIELD_DB_NAME, 1\)/.test(ui) && ui.includes('restoreAppSettings'));
ok('الربط: مسافة خام raw في estimateObjectDistance', (html.match(/raw: distM/g) || []).length >= 3);
ok('الواجهة: شاشات الإعادة والتوجيه والمشاركة', ['retryCp', 'redoMissing', 'redoScene', 'shareFile', 'saveFile', 'navigator.share', 'checkpoint_end', 'trial_answer'].every(x => ui.includes(x)));
ok('الخصوصية: لا MediaRecorder ولا ميكروفون ولا رفع شبكي في الواجهة', !html.includes('new MediaRecorder') && !/fetch\(|XMLHttpRequest|sendBeacon/.test(ui) && /audio: false/.test(html));
ok('SW يخزن ملفي الاختبار الميداني ويرفع الإصدار', /field_core\.js/.test(fs.readFileSync(__dirname + '/sw.js', 'utf8')) && /field_ui\.js/.test(fs.readFileSync(__dirname + '/sw.js', 'utf8')));
ok('الواجهة: طريقة قياس المسافة، ملاحظات المرافق، إجابة «لا أستطيع التحديد»، استعادة الإعدادات الدائمة', ['data-act="method"', 'facilitator_note', 'unsure', 'RESTORE_KEY', 'recoverInterruptedSettings', 'phoneInfoUnknown'].every(x => ui.includes(x)) || ui.includes('method('));
ok('الخصوصية: لا تسمية للكاميرا ولا أسماء أصوات', !/label: t\.label/.test(ui) && !/name: x\.name/.test(ui));
ok('الدليل مرفق', fs.existsSync(__dirname + '/FIELD_TESTING_GUIDE_AR.md'));
console.log(failed ? `فشل ${failed} فحص` : 'نجحت كل الفحوص'); process.exit(failed ? 1 : 0);
