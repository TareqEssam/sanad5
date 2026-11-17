// فحوص ثابتة لوضع التسجيل الميداني: لا تحاكي هاتفًا حقيقيًا ولا تثبت جودة القياسات.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const checks = [
  ['واجهة المشاركة موجودة', html.includes('field-recorder-heading') && html.includes('field-start-button')],
  ['اختيار المشاهد الثمانية موجود', ['approaching_vehicle','parked_vehicle','crowd','stairs','sidewalk_end','wall','low_light','mixed'].every(x => html.includes(x))],
  ['علامات المرافق الأربع موجودة', ['false_alarm','missed_hazard','real_approach','scene_note'].every(x => html.includes(x))],
  ['زمن detect يسجل', html.includes('detectMs: Math.round(detectMs * 10) / 10')],
  ['تسلسل المربعات والثقة والمسافة يسجل', html.includes('estimatedDistanceMeters') && html.includes('relativePosition') && html.includes('score: Number(p.score)')],
  ['حساسا الميل والحركة يسجلان', html.includes("fieldPush('orientation'") && html.includes("fieldPush('motion'")],
  ['الكلام المعلن يسجل', html.includes("fieldPush('speech'")],
  ['التخزين محلي في IndexedDB', html.includes("indexedDB.open(FIELD_DB_NAME")],
  ['التصدير يدوي إلى JSON', html.includes('downloadFieldJson(finalData') && html.includes('exportSavedFieldSessions')],
  ['لا توجد واجهة MediaRecorder في وضع التسجيل', !html.includes('new MediaRecorder')],
  ['لا يطلب ميكروفونًا في الكاميرا', /getUserMedia\(\{ video: \{[\s\S]{0,300}?audio: false/.test(html)],
  ['تعليمات السلامة والدليل مرفقان', fs.existsSync(__dirname + '/FIELD_TESTING_GUIDE_AR.md')]
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? '✔ ' : '✘ ') + name); if (!ok) failed++; }
console.log(failed ? `فشل ${failed} فحص` : `نجاح ${checks.length} فحصًا`);
process.exit(failed ? 1 : 0);
