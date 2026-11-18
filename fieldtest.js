/* Field recorder v2: static integration checks + executable validation-core tests. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const sw = fs.readFileSync(__dirname + '/sw.js', 'utf8');
const core = require('./field_recording_core.js');
const live = require('./live_recog_core.js');
let failed = 0;
function ck(name, ok, detail='') { console.log((ok?'✔ ':'✘ ')+name+(detail?' → '+detail:'')); if(!ok)failed++; }
const has = s => html.includes(s);
[
  ['واجهة التسجيل الموجهة موجودة', has('field-recorder-heading') && has('field-start-button')],
  ['ثمانية مشاهد الاختبار موجودة', ['approaching_vehicle','parked_vehicle','crowd','stairs','sidewalk_end','wall','low_light','mixed'].every(has)],
  ['الشركة والطراز ونظام التشغيل تُدخل يدويًا', ['field-device-maker','field-device-model','field-os-version'].every(has)],
  ['تسجيل الجهاز يتضمن UA Client Hints ومواصفات الكاميرا', ['getHighEntropyValues','hardwareConcurrency','deviceMemory','getCapabilities','frameRate','pixelRatio'].every(has)],
  ['عتبة التسجيل 0.25 مع الحفاظ على عتبة قرار الإنتاج 0.56', has('detect(videoElement, 50, 0.25)') && has('filter(p => Number(p.score) >= 0.56).slice(0, COCO_MAX_BOXES)')],
  ['كل مربع يسجل بالبكسل وبالإحداثيات النسبية', has('bboxPixels') && has('bboxNormalized')],
  ['نتائج SegFormer والنسب وشبكة التصنيف كاملة تسجل', has("fieldPush('arch_result'") && has('thresholdRatio') && has('fraction') && has('classHistogram') && has('labelGrid')],
  ['قرارات SegFormer وأسباب الكبت تسجل', has("fieldPush('arch_decision'") && has('diagnostics: r.diagnostics')],
  ['نتائج DINOv2 وقراراته وإعلاناته تسجل', has("fieldPush('vision_inference'") && has("fieldPush('embedding_decision'") && has("fieldPush('vision_announcement'")],
  ['قرار اقتراب COCO وأسباب عدم الإعلان مرتبطة بقراءة الكشف', has("fieldPush('alert_decision'") && has('detectionSeq:fieldLastDetectionEventSeq') && has('suppressionReason') && has('suppressionReasons')],
  ['النص المطلوب نطقه وحالة بدء/انتهاء/فشل النطق تسجل', has("fieldPush('speech'") && has("fieldPush('speech_playback'") && has("phase:'started'") && has("finish('watchdog-timeout')")],
  ['الكشاف الآلي وحالة الإضاءة يسجلان', has("fieldPush('torch_evaluation'") && has("fieldPush('torch_state'")],
  ['حالة تعطيل النموذج بسبب البطء أو الخطأ تسجل', has("fieldPush('model_state'")],
  ['أسباب تخطي استدلال المكان تسجل', has("fieldPush('live_recog_skip'") && has('thumbnail-rejected-as-dark-or-flat')],
  ['الميل والجاذبية والتسارع والدوران تسجل', has("fieldPush('orientation'") && has("fieldPush('motion'") && has('accelerationIncludingGravity')],
  ['المسافة المرجعية الحقيقية ترتبط بقراءة الكشف', has("fieldPush('ground_truth_distance'") && has('relatedDetectionSeq')],
  ['علامة ظهور الهدف مطلوبة', has('markFieldTargetVisible') && has('target_visible')],
  ['حالات إخفاء الصفحة والعودة وإغلاقها تسجل', has("fieldPush('lifecycle'") && has("reason:'pagehide'") && has("reason:'visibilitychange'")],
  ['الحفظ الدوري السريع موجود', /fieldAutosaveTimer\s*=\s*setInterval[\s\S]{0,100}2000/.test(html)],
  ['الجلسات غير المكتملة تظهر للمشارك بعد إعادة الفتح', has('abandonedOrInterrupted') && has('جلسة غير مكتملة أو قديمة أو تحتاج إعادة')],
  ['لا يوجد تسجيل صور أو فيديو أو صوت', !has('new MediaRecorder') && has('audio: false')],
  ['ملف التسجيل الأساسي محمّل في الصفحة ومخزن في SW', has('field_recording_core.js') && sw.includes('field_recording_core.js')],
  ['قاعدة V1 محفوظة وتُرقّى بدل إنشاء قاعدة منفصلة وفقد التسجيلات السابقة', has("const FIELD_DB_NAME = 'sanad_field_trials_v1'") && has('indexedDB.open(FIELD_DB_NAME, 2)')],
  ['معرّفات الكاميرا الفريدة لا تُحفظ', has('delete safeConstraints.deviceId') && has('delete safeConstraints.groupId')],
  ['Service Worker محدث إلى v19', /const VERSION = 'v19'/.test(sw)]
].forEach(x=>ck(...x));
const good={scene:'stairs',durationMs:20000,device:{manualModel:'iPhone test'},sensors:{deviceMotionAvailable:true,deviceOrientationAvailable:true},events:[...Array.from({length:5},()=>({type:'motion',data:{gravity:{x:0,y:0,z:9.8}}})),...Array.from({length:5},()=>({type:'orientation',data:{beta:1,gamma:2}})),{type:'target_visible'},{type:'ground_truth_distance',data:{meters:2}},{type:'ground_truth_distance',data:{meters:3}},{type:'arch_result'},{type:'arch_result'},...Array.from({length:5},()=>({type:'detection',data:{frameQuality:{meanLuminance:40}}}))]};
const goodResult=core.evaluateSession(good);
ck('المحرك يقبل جلسة مكتملة فعليًا',goodResult.validForAnalysis,JSON.stringify(goodResult.issues));
const badResult=core.evaluateSession({scene:'stairs',durationMs:5000,device:{},sensors:{deviceMotionAvailable:true,deviceOrientationAvailable:true},events:[{type:'target_visible'}]});
ck('المحرك يرفض الجلسة الناقصة ويحدد أسباب الإعادة',!badResult.validForAnalysis && ['duration_short','coco_samples_low','seg_samples_low','ground_truth_missing','device_model_missing','motion_samples_low','orientation_samples_low'].every(k=>badResult.issues.some(i=>i.code===k)),badResult.issues.map(i=>i.code).join(','));
const oneDistance=core.evaluateSession({...good,events:good.events.filter(e=>e.type!=='ground_truth_distance').concat([{type:'ground_truth_distance',data:{meters:2}}])});
ck('جلسة المسافة لا تُقبل بنقطة واحدة فقط',!oneDistance.validForAnalysis&&oneDistance.issues.some(i=>i.code==='ground_truth_missing'),oneDistance.issues.map(i=>i.code).join(','));
const announcer=live.createArchAnnouncer({need:1,strongRatio:3});
const finding=[{key:'stairs',ar:'سلم',pos:'أمامك',priority:3,ratio:4,frac:.2,minPct:.05}];
const first=announcer.update(finding,10000,true),second=announcer.update(finding,11000,true);
ck('سجل SegFormer يميز الإعلان المسموح عن كبت فترة التهدئة',!!first.alert&&second.diagnostics.some(d=>d.reason==='announcement-cooldown'),JSON.stringify(second.diagnostics));
const box=core.normalizeBox([10,20,30,40],100,100);
ck('تطبيع المربعات يعطي قيمًا نسبية صحيحة',JSON.stringify(box)==='[0.1,0.2,0.3,0.4]',JSON.stringify(box));
console.log(failed?`فشل ${failed} فحص`:'نجاح جميع فحوص التسجيل الميداني');
process.exit(failed?1:0);
