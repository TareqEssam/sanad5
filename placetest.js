const P = require('./place_core.js');
const fs = require('fs');
let ok = 0, bad = 0;
const t = (name, condition) => {
  if (condition) { ok++; console.log('  ✔ ' + name); }
  else { bad++; console.log('  ✘ ' + name); }
};
const mk = (opts = {}) => P.create(Object.assign({ hasSeg: true, hasCoco: true, hasYaw: true }, opts));
const person = (pos = 'أمامك', steps = 3) => ({ cls: 'person', ar: 'شخص', score: .8, priority: 3, pos, steps });
const chair = { cls: 'chair', ar: 'كرسي', score: .7, priority: 2, pos: 'على اليمين', steps: 4 };
const indoor = [{ label: 'floor', frac: .3 }, { label: 'wall', frac: .3 }, { label: 'ceiling', frac: .15 }, { label: 'bed', frac: .15 }];
const segCols = { left: [{ label: 'door', frac: .18 }], center: [{ label: 'wall', frac: .7 }], right: [{ label: 'floor', frac: .6 }] };
const indoorWithDoor = [{ label: 'floor', frac: .3 }, { label: 'wall', frac: .3 }, { label: 'ceiling', frac: .15 }, { label: 'bed', frac: .15 }, { label: 'door', frac: .08 }];
function feed(c, idx, n = 3, withObjects = true, fracs = indoor, cols = segCols) {
  c.markRequested(idx);
  for (let i = 0; i < n; i++) {
    c.addCoco(idx, withObjects ? [person(), chair] : []);
    if (fracs) c.addSeg(idx, fracs, cols);
  }
}

console.log('=== اختبارات صف المكان V20.14 ===');
const y0 = P.yawOf(0, 90, 0), y1 = P.yawOf(90, 90, 0);
t('yaw يتغير بتغير alpha', Math.abs(((y0 - y1) % 360 + 360) % 360 - 90) < 1 || Math.abs(((y1 - y0) % 360 + 360) % 360 - 90) < 1);
t('yaw بلا حساس = null', P.yawOf(null, 90, 0) === null);
t('relYaw يعالج عبور 360', P.relYaw(10, 350) === 20);
t('تقسيم الاتجاهات الأربعة', [0, 90, 180, 270].every((d, i) => P.sectorOf(d).idx === i));
t('حدود القطاع تمنع اعتماد اتجاه مائل', P.sectorOf(45).centered === false && P.sectorOf(80).centered === true);

let c = mk(); feed(c, 0, 4, true, indoorWithDoor);
c.addCoco(0, [{ cls: 'dog', ar: 'كلب', score: .8, priority: 3, pos: 'أمامك', steps: 2 }]);
let s = c.summary();
t('جسم عابر في إطار واحد لا يُذكر', !s.sectors[0].objects.some(o => o.cls === 'dog'));
t('الجسم الثابت يظهر مع تقدير خطوات تقريبي', s.sectors[0].objects.some(o => o.cls === 'person' && o.steps === 3));
t('الأجسام منخفضة الثقة تُرفض', (() => { const x = mk(); x.markRequested(0); for (let i = 0; i < 4; i++) x.addCoco(0, [{ cls: 'person', ar: 'شخص', score: .4, priority: 3, pos: 'أمامك' }]); return x.summary().sectors[0].objects.length === 0; })());
t('تصنيف داخلي بعد ثلاث عينات تقسيم', s.kind.kind === 'indoor');
t('المشهد يذكر أنه وصف تقريبي ولا يثبت سلامة الطريق', /تقريبي/.test(P.narrate(s)) && /لا يدل على خلو الطريق/.test(P.narrate(s)));
t('لا يصف الجهات التي لم يطلب فحصها', !/على يمينك:|خلفك:|على يسارك:/.test(P.narrate(s)) && /لم أفحص بقية الجهات/.test(P.narrate(s)));
t('تحديد الباب في الطرف الأيسر من الصورة', s.sectors[0].landmarkDetails.some(x => x.label === 'door' && x.position === 'في الطرف الأيسر من المشهد'));
c = mk(); c.markRequested(0); for (let i = 0; i < 3; i++) c.addCoco(0, [person()]); c.addSeg(0, indoorWithDoor, segCols); c.addSeg(0, indoor, { left: [], center: [{ label: 'wall', frac: .7 }], right: [{ label: 'floor', frac: .6 }] }); c.addSeg(0, indoor, { left: [], center: [{ label: 'wall', frac: .7 }], right: [{ label: 'floor', frac: .6 }] });
t('المعلم الذي يظهر في قراءة واحدة فقط لا يُعرض كمعلم مؤكد', !c.summary().sectors[0].landmarks.includes('باب'));

c = mk(); c.markRequested(0); for (let i = 0; i < 3; i++) c.addCoco(0, [person()]); c.addSeg(0, indoor, segCols);
t('عينة تقسيم واحدة لا تكفي لاعتماد الجهة', !c.summary().sectors[0].reliable && !c.sectorStatus(0).done);
c.addSeg(0, indoor, segCols);
t('عينتان تقسيم + ثلاثة إطارات أجسام تكفيان لاعتماد الجهة', c.summary().sectors[0].reliable && c.sectorStatus(0).done);

c = mk({ hasCoco: false, hasSeg: true }); c.markRequested(0); c.addSeg(0, indoor, segCols);
t('نموذج التقسيم وحده لا يعتمد الجهة من قراءة واحدة', !c.sectorStatus(0).done);
c.addSeg(0, indoor, segCols);
t('يمكن العمل بنموذج التقسيم وحده بعد قراءتين', c.sectorStatus(0).done && c.summary().covered === 1);
t('وصف التقسيم وحده لا يخترع أجسام COCO', c.summary().sectors[0].objects.length === 0);

c = mk({ hasCoco: true, hasSeg: false }); feed(c, 0, 3, true, null, null);
s = c.summary();
t('الأجسام وحدها تعمل دون SegFormer', s.covered === 1 && !s.hasSeg && s.kind.kind === 'unknown');
t('لا يخمن نوع المكان دون SegFormer', !/مكان مغلق|مكان مفتوح أو في الشارع/.test(P.narrate(s)));

c = mk(); c.markRequested(2); for (let i = 0; i < 4; i++) { c.addCoco(2, [chair]); c.addSeg(2, [{ label: 'stairs', frac: .2 }, { label: 'wall', frac: .3 }]); }
t('السلالم المرصودة تظهر كاحتمال خطر', /سلالم/.test(P.narrate(c.summary())) && /احتمال وجود/.test(P.narrate(c.summary())));
t('لا يخلط موضع الجسم داخل الصورة بالجهة المطلقة', /في الطرف الأيمن من المشهد/.test(P.narrate(c.summary())));

c = mk(); c.markRequested(0); c.rejectQuality(0, 'covered');
t('الإطار المرفوض لا يزيد عدد العينات', c.sectorStatus(0).frames === 0 && c.summary().qualityRejected === 1);
t('الإطار المرفوض لا يجعل القطاع موثوقاً', !c.summary().sectors[0].reliable);
t('الوصف يعلن استبعاد صور غير صالحة', /استبعدت بعض الإطارات/.test(P.narrate(c.summary())));

c = mk(); c.markRequested(0); for (let i = 0; i < 3; i++) c.addSeg(0, [{ label: 'wall', frac: .8 }], { left: [{ label: 'wall', frac: .9 }], center: [], right: [] });
t('نصيحة الحائط لا تطلب من المستخدم الابتعاد أو المشي', /دون أن تتحرك/.test(c.advice(0)) && !/ابتعد خطوة/.test(c.advice(0)));
c = mk(); c.markRequested(0); for (let i = 0; i < 4; i++) c.addTilt(0, 130);
t('نصيحة الميل لا تتضمن حركة جسم المستخدم', /الهاتف/.test(c.advice(0)) && !/ابتعد|امش/.test(c.advice(0)));

c = mk(); for (let k = 0; k < 4; k++) feed(c, k, 4);
t('أربع جهات مطلوبة ومكتملة تُحتسب أربعاً', c.summary().covered === 4 && c.summary().scanned === 4);
t('الحالة غير المطلوبة لا تُحسب مغطاة', (() => { const x = mk(); feed(x, 0, 4); x.addCoco(1, [person()]); x.addSeg(1, indoor, segCols); x.addSeg(1, indoor, segCols); return x.summary().covered === 1 && x.summary().scanned === 1; })());

const html = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('place_ui.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
t('صيغة «أين أنا» مسجلة صوتياً', /'اين انا'/.test(html));
t('أمر استكمال الجهات متاح', /continuePlace/.test(html) && /continueScan/.test(ui));
t('زر الاستكمال وزر الإيقاف متاحان لقارئ الشاشة', /place-continue-btn/.test(html) && /place-stop-btn/.test(html));
t('غياب الحساس يمنع المسح التلقائي للجهات', /حساس الاتجاه غير متاح أو غير مستقر/.test(ui) && /run\.hasYaw/.test(ui));
t('لا توجد قفزة تلقائية لجهة مفترضة عند فشل الحساس', !/run\.manualIdx\s*=\s*target/.test(ui));
t('الزر يطلب الضغط أولاً ثم تحريك الهاتف', /اضغط زر استكمال الجهات أولاً، ثم حرّك الهاتف/.test(ui));
t('إلغاء انتظار النماذج يستجيب دون انتظار المهلة كاملة', /run\.cancelPromise\.then\(\(\) => null\)/.test(ui) && /run\.cancelResolve\(\)/.test(ui));
t('استعادة الكاميرا تنتظر حتى بعد تسجيل الإلغاء', /waitForCamera\(r\.saved\.facing, 10000, true\)/.test(ui));
t('صف المكان لا يغير وضع الملابس أو المرآة الدائم', !/lifeMode\s*=/.test(ui));
t('تحديث Service Worker', /VERSION = 'v26'/.test(sw));

console.log(bad ? `✘ فشل ${bad} من ${ok + bad}` : `✔ كل الاختبارات نجحت (${ok})`);
process.exit(bad ? 1 : 0);
