const P = require('./place_core.js'); const fs = require('fs');
let ok = 0, bad = 0; const t = (n, c) => { if (c) { ok++; console.log('  ✔ ' + n); } else { bad++; console.log('  ✘ ' + n); } };
// yaw: هاتف رأسي، alpha يتغير → الاتجاه يتغير بنفس المقدار
const y0 = P.yawOf(0, 90, 0), y1 = P.yawOf(90, 90, 0);
t('yaw يتغير بتغير alpha', Math.abs(((y0 - y1) % 360 + 360) % 360 - 90) < 1 || Math.abs(((y1 - y0) % 360 + 360) % 360 - 90) < 1);
t('yaw بلا حساس = null', P.yawOf(null, 90, 0) === null);
t('relYaw التفاف', P.relYaw(10, 350) === 20);
t('sector 0/1/2/3', [0, 90, 180, 270].every((d, i) => P.sectorOf(d).idx === i));
t('نطاق غير مركزي', P.sectorOf(45).centered === false && P.sectorOf(80).centered === true);
const mk = (hasSeg = true) => P.create({ hasSeg, hasYaw: true });
const person = (pos = 'أمامك', s = 3) => ({ cls: 'person', ar: 'شخص', score: .8, priority: 3, pos, steps: s });
const chair = { cls: 'chair', ar: 'كرسي', score: .7, priority: 2, pos: 'على اليمين', steps: 4 };
const indoor = [{ label: 'floor', frac: .3 }, { label: 'wall', frac: .3 }, { label: 'ceiling', frac: .15 }, { label: 'bed', frac: .15 }];
let c = mk();
for (let i = 0; i < 4; i++) { c.addCoco(0, [person(), chair]); c.addSeg(0, indoor); }
c.addCoco(0, [{ cls: 'dog', ar: 'كلب', score: .8, priority: 3, pos: 'أمامك', steps: 2 }]);   // إطار واحد عابر
let s = c.summary();
t('جسم عابر (إطار واحد) لا يُذكر', !s.sectors[0].objects.some(o => o.cls === 'dog'));
t('جسم ثابت يُذكر مع خطوات', s.sectors[0].objects.some(o => o.cls === 'person' && o.steps === 3));
t('ثقة منخفضة < 0.56 تُتجاهل', (() => { const d = mk(); for (let i = 0; i < 4; i++) d.addCoco(0, [{ cls: 'person', ar: 'شخص', score: .4, priority: 3, pos: 'أمامك', steps: 2 }]); return d.summary().sectors[0].objects.length === 0; })());
t('تصنيف داخلي', s.kind.kind === 'indoor');
let txt = P.narrate(s);
t('الوصف يذكر التقريب والعصا', /تقريبي/.test(txt) && /العصا/.test(txt));
t('الجهات غير المغطاة تُعلَن صراحة', /لم أحصل على رؤية كافية/.test(txt) && /1 من 4|وصفت 1 من 4/.test(txt));
t('لا ادعاء رؤية في جهة بلا بيانات', !/خلفك: .*شخص/.test(txt));
// خارجي
c = mk(); for (let i = 0; i < 4; i++) c.addSeg(1, [{ label: 'sky', frac: .3 }, { label: 'road', frac: .3 }, { label: 'building', frac: .3 }]);
t('تصنيف خارجي', c.summary().kind.kind === 'outdoor');
// غير حاسم
c = mk(); for (let i = 0; i < 4; i++) c.addSeg(0, [{ label: 'sky', frac: .05 }, { label: 'floor', frac: .15 }]);
t('تصنيف غير حاسم يُعلَن', c.summary().kind.kind === 'unknown' && /لم أتمكن من تحديد/.test(P.narrate(c.summary())));
// خطر أولاً
c = mk(); for (let i = 0; i < 4; i++) { c.addCoco(0, [person()]); c.addSeg(0, indoor); } c.addHazard('سيارة أمامك');
t('الخطر أول جملة', P.narrate(c.summary()).startsWith('تنبيه أولاً'));
c = mk(); for (let i = 0; i < 4; i++) c.addSeg(2, [{ label: 'stairs', frac: .2 }, { label: 'wall', frac: .3 }]);
t('سلالم من SegFormer تُحذَّر', /سلالم/.test(P.narrate(c.summary())));
// نصائح
c = mk(); for (let i = 0; i < 3; i++) c.addSeg(0, [{ label: 'wall', frac: .8 }]); t('حائط قريب → نصيحة', /الحائط/.test(c.advice(0)));
c = mk(); for (let i = 0; i < 3; i++) c.addSeg(0, [{ label: 'floor', frac: .8 }]); t('أرضية فقط → ارفع', /ارفع/.test(c.advice(0)));
c = mk(); for (let i = 0; i < 5; i++) c.addTilt(0, 130); t('ميل للأعلى → أنزل', /أنزل/.test(c.advice(0)));
c = mk(); t('بلا بيانات → لا نصيحة', c.advice(0) === null);
// بلا seg: يُوصف بالأجسام فقط ولا يُخمَّن النوع
c = mk(false); for (let i = 0; i < 4; i++) c.addCoco(0, [person()]);
s = c.summary(); t('بلا SegFormer لا تخمين للمكان', s.kind.kind === 'unknown' && !/مغلق|مفتوح/.test(P.narrate(s)) && s.sectors[0].reliable);
// أربع جهات
c = mk(); for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) { c.addCoco(k, [chair]); c.addSeg(k, indoor); }
t('أربع جهات مغطاة', c.summary().covered === 4 && !/من 4 جهات فقط/.test(P.narrate(c.summary())));
t('الملفات في sw.js وindex.html', /place_core/.test(fs.readFileSync('sw.js', 'utf8')) && /place_ui\.js/.test(fs.readFileSync('index.html', 'utf8')) && /describePlace/.test(fs.readFileSync('index.html', 'utf8')));
console.log(bad ? '✘ فشل ' + bad : '✔ كل الاختبارات نجحت (' + ok + ')'); process.exit(bad ? 1 : 0);
