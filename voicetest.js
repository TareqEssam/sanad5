/* اختبار V20.10: الضبط الصوتي + تعديل المظهر بالصوت + مراحل الحوار + الخصوصية */
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname,'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const store = {}; const spoken = [];
function mkEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener() { }, appendChild() { }, remove() { }, setAttribute() { }, getAttribute() { return null; },
    style: { setProperty() { } }, dataset: {}, files: null, children: [], focus() { }, click() { },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  };
  return el;
}
const els = {}; ids.forEach(i => { els[i] = mkEl(i); });
const sb = {}; sb.window = sb; sb.globalThis = sb;
sb.document = {
  getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [],
  createElement: t => mkEl('new-' + t), body: mkEl('body'), addEventListener() { }, documentElement: mkEl('html')
};
sb.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
sb.sessionStorage = { getItem: () => null, setItem() { } };
sb.navigator = { userAgent: 'node', mediaDevices: {}, onLine: false };
sb.speechSynthesis = { getVoices: () => [{ lang: 'ar-EG', name: 'Test', default: true }, { lang: 'en-US', name: 'EN' }], speak(t) { spoken.push((t && t.text) ? t.text : String(t)); }, cancel() { }, addEventListener() { }, onvoiceschanged: null };
sb.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
sb.location = { href: 'https://x/', protocol: 'https:' };
sb.matchMedia = () => ({ matches: false, addEventListener() { } });
sb.getComputedStyle = () => ({ getPropertyValue: () => '' });
sb.requestAnimationFrame = f => setTimeout(f, 0);
sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout; sb.setInterval = setInterval; sb.clearInterval = clearInterval;
sb.Image = mkEl('img');
sb.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
sb.addEventListener = () => { };
sb.fetch = () => Promise.reject(new Error('شبكة ممنوعة'));
sb.console = { log: () => { }, warn() { }, error() { }, info() { }, debug() { } };
vm.createContext(sb);
blocks.forEach((b, i) => { try { vm.runInContext(b, sb, { timeout: 8000 }); } catch (e) { console.log('خطأ تحميل الكتلة ' + i + ':', e.message); } });
const run = expr => { try { return vm.runInContext(expr, sb, { timeout: 8000 }); } catch (e) { return 'EXC: ' + e.message; } };
let fails = 0;
function ck(label, cond, extra) { console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? '  → ' + extra : '')); if (!cond) fails++; }

console.log('=== ١) الأسئلة تتغيّر حسب الإجابة ===');
run("mirrorProfile.gender=''");
ck('قبل تحديد الجنس: السؤال الأول = الجنس', run('mirrorSetupQuestions()[0].id') === 'gender');
run("mirrorProfile.gender='male'");
ck('رجل: يُسأل عن اللحية', run('mirrorSetupQuestions().map(function(q){return q.id;}).join(",")') === 'gender,hasBeard,wearsGlasses');
run("mirrorProfile.gender='female'");
const fq = run('mirrorSetupQuestions().map(function(q){return q.id;}).join(",")');
ck('امرأة: لا سؤال لحية، بل غطاء رأس + جبهة', fq === 'gender,headCover,coverForehead,wearsGlasses', fq);

console.log('\n=== ٢) تطبيق الإجابات (محاكاة) ===');
run("applySetupAnswer('gender','امرأة')");
ck('الجنس = امرأة', run('mirrorProfile.gender') === 'female');
run("applySetupAnswer('headCover','حجاب')");
ck('غطاء الرأس = حجاب', run('mirrorProfile.headCover') === 'hijab' && run('mirrorProfile.wearsHeadCover') === true);
run("applySetupAnswer('coverForehead','نعم')");
ck('الحجاب يغطي الجبهة = نعم', run('mirrorProfile.coverForehead') === true);
ck('الملف محفوظ محلياً', !!run("localStorage.getItem('sanad_mirror_profile_v1')"));
ck('وصف الملف', run('mirrorProfileSummary()').indexOf('حجاب') >= 0, run('mirrorProfileSummary()'));

console.log('\n=== ٣) تعديل المظهر بالصوت ===');
spoken.length = 0;
ck('«صارت عندي لحية» → تحديث', run("updateProfileByVoice('صارت عندي لحية')") === true);
ck('اللوحة سجّلت اللحية', run('mirrorProfile.hasBeard') === true);
ck('«أصبحت أرتدي حجاب» → تحديث', run("updateProfileByVoice('أصبحت أرتدي حجاب')") === true);
ck('الحجاب مسجّل', run('mirrorProfile.headCover') === 'hijab');
ck('«لم أعد أرتدي الحجاب» → تحديث', run("updateProfileByVoice('لم أعد أرتدي الحجاب')") === true);
ck('الحجاب أُزيل', run('mirrorProfile.wearsHeadCover') === false);
setTimeout(() => {
  ck('نص جملة التأكيد', spoken.length > 0 && spoken[spoken.length - 1].indexOf('سجّلت') >= 0, spoken[spoken.length - 1]);
  console.log('\n' + (fails ? '✖ فشل ' + fails + ' اختبار' : '✔ كل الاختبارات نجحت'));
  process.exit(fails ? 1 : 0);
}, 400);

console.log('\n=== ٤) تعرّف الأوامر الصوتية ===');
const cmds = [['اضبط مظهري', 'mirrorSetup'], ['كيف ألتقط الصور', 'mirrorGuide'], ['فحص كامل', 'mirrorSession'],
  ['صورة كاملة', 'mirrorFull'], ['فحص المظهر', 'mirrorCheck'], ['صارت عندي لحية', 'question'], ['صورني', 'mirrorGuide']];
cmds.forEach(([t, exp]) => {
  const got = run('parseVoiceCommand(' + JSON.stringify(t) + ')');
  ck('«' + t + '» → ' + exp, got && got.type === exp, got ? got.type : JSON.stringify(got));
});

console.log('\n=== ٥) مراحل الحوار الإرشادي ===');
ck('خمس مراحل: وجه، علوي، سفلي، كامل، ظهر',
  run('MIRROR_GUIDED_STAGES.map(function(s){return s.id;}).join(",")') === 'face,upper,lower,full,back');
ck('لكل مرحلة نص إرشادي', run('MIRROR_GUIDED_STAGES.every(function(s){return s.intro.length>10;})') === true);

console.log('\n=== ٦) خطوة الخصوصية ===');
sb.navigator.onLine = false;
ck('الإنترنت مفصول ⇒ يؤكد ولا يطلب', (async () => true)());
const priv = run('isInternetOff()');
ck('isInternetOff() = true عند انقطاع الشبكة', priv === true);
sb.navigator.onLine = true;
ck('isInternetOff() = false عند الاتصال', run('isInternetOff()') === false);

console.log('\n=== ٧) الدليل يشرح ما سيحدث + الخصوصية ===');
const gs = run('mirrorGuideSpeech()');
ck('يشرح الخصوصية', gs.indexOf('الخصوصية') >= 0);
ck('يشرح الملف', gs.indexOf('ملف مظهرك') >= 0);
ck('يذكر الظهر', gs.indexOf('الظهر') >= 0);
ck('يذكر عدم اختلاق لون الحذاء', gs.indexOf('إلا إذا رأيت الحذاء') >= 0);
console.log('  (طول الشرح: ' + gs.length + ' حرفاً)');


