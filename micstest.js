/* اختبار V20.12: إذن الميكروفون والاهتزاز مع النغمة، ومنع التجمّد */
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
const vibes = [];
sb.navigator.vibrate = p => { vibes.push(p); return true; };
sb.setTimeout = (f, ms) => setTimeout(f, Math.min(ms, ms / 100)); /* تسريع المهل ١٠٠ ضعف */

async function scenario(name, { state, gum }) {
  vibes.length = 0;
  sb.navigator.permissions = state === 'throw' ? { query: () => Promise.reject(new Error('x')) } : { query: () => Promise.resolve({ state }) };
  sb.navigator.mediaDevices = { getUserMedia: gum };
  run('micGrantedThisSession=false; lastListenError=""');
  const t0 = Date.now();
  const ok = await vm.runInContext('ensureMicPermission()', sb);
  const err = run('lastListenError');
  return { ok, err, ms: Date.now() - t0, vibes: vibes.length };
}
(async () => {
  console.log('=== إذن الميكروفون ===');
  let r = await scenario('granted', { state: 'granted', gum: () => Promise.reject(new Error('لا يجب استدعاؤه')) });
  ck('ممنوح مسبقاً ⇒ true فوراً بلا فتح تيار', r.ok === true);

  r = await scenario('denied', { state: 'denied', gum: () => Promise.reject(new Error('no')) });
  ck('محظور ⇒ false + سبب not-allowed + اهتزاز', r.ok === false && r.err === 'not-allowed' && r.vibes >= 1, r.err);

  let stopped = 0;
  r = await scenario('prompt-ok', { state: 'prompt', gum: () => Promise.resolve({ getTracks: () => [{ stop() { stopped++; } }] }) });
  ck('prompt ثم سماح ⇒ true وإغلاق التيار', r.ok === true && stopped === 1);
  ck('اهتزاز يسبق ظهور مربع الإذن', r.vibes >= 1);
  ck('نطق تنبيه «اختر السماح»', spoken.some(t => /اختر السماح/.test(t)));

  r = await scenario('prompt-deny', { state: 'prompt', gum: () => Promise.reject(Object.assign(new Error('d'), { name: 'NotAllowedError' })) });
  ck('رفض المستخدم ⇒ false + not-allowed', r.ok === false && r.err === 'not-allowed');

  r = await scenario('no-mic', { state: 'prompt', gum: () => Promise.reject(Object.assign(new Error('d'), { name: 'NotFoundError' })) });
  ck('لا ميكروفون ⇒ audio-capture', r.ok === false && r.err === 'audio-capture');

  r = await scenario('hang', { state: 'prompt', gum: () => new Promise(() => {}) });
  ck('الطلب المعلّق للأبد ⇒ ينتهي بمهلة perm-timeout ولا يتجمد', r.ok === false && r.err === 'perm-timeout', r.ms + 'ms');
  ck('لا وعد عالق بعد المهلة (يمكن إعادة الطلب)', run('micPermInflight') === null);

  r = await scenario('unknown-api', { state: 'throw', gum: () => Promise.resolve({ getTracks: () => [{ stop() { } }] }) });
  ck('متصفح بلا permissions API ⇒ يطلب عبر getUserMedia', r.ok === true);
  const again = await scenario('again', { state: 'throw', gum: () => Promise.reject(new Error('لا يُعاد الطلب')) });
  run('micGrantedThisSession=true');
  const r2 = await vm.runInContext('ensureMicPermission()', sb);
  ck('بعد السماح في الجلسة لا يُعاد المربع', r2 === true);

  console.log('\n=== النغمة مع الاهتزاز ===');
  vibes.length = 0;
  run('playMicReadyTone()');
  ck('نغمة «تكلّم» يصحبها اهتزاز', vibes.length === 1 && Array.isArray(vibes[0]));
  vibes.length = 0;
  run('micEndCue()');
  ck('نغمة «انتهى» يصحبها اهتزاز', vibes.length === 1);
  vibes.length = 0;
  sb.AudioContext = class { constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; } resume() { return new Promise(() => {}); } };
  run('audioContext = null');
  const t1 = Date.now();
  await vm.runInContext('micReadyCue()', sb);
  ck('ctx.resume() المعلّق لا يجمّد الإشارة + اهتزاز بديل', vibes.length >= 1 && (Date.now() - t1) < 3000, (Date.now() - t1) + 'ms');

  console.log('\n=== زر اسأل/أمر ===');
  vibes.length = 0; spoken.length = 0;
  sb.navigator.permissions = { query: () => Promise.resolve({ state: 'denied' }) };
  sb.SpeechRecognition = class { start() { } stop() { } abort() { } };
  run('isProcessing=false; mirrorSetupState=null; isListening=false');
  await vm.runInContext('activateVoiceCommands()', sb);
  ck('الإذن محظور ⇒ يُنطق السبب (لا صمت) مع اهتزاز', spoken.some(t => /الميكروفون غير مسموح/.test(t)) && vibes.length >= 1, spoken.join(' | '));
  ck('الزر لا يبقى عالقاً بعد الفشل', run('voiceCmdStarting') === false);

  spoken.length = 0; vibes.length = 0;
  run('isProcessing=true');
  await vm.runInContext('activateVoiceCommands()', sb);
  ck('أثناء مهمة جارية ⇒ يُخبَر المستخدم بدل الصمت', spoken.some(t => /مهمة الآن/.test(t)) && vibes.length >= 1);
  run('isProcessing=false');

  spoken.length = 0;
  run('mirrorSetupState={qs:[],idx:0}');
  await vm.runInContext('activateVoiceCommands()', sb);
  ck('أثناء أسئلة الضبط ⇒ لا يتداخل استماعان', spoken.some(t => /أسألك الآن/.test(t)));
  run('mirrorSetupState=null');

  console.log(fails ? '\n✖ فشل ' + fails : '\n✔ كل الاختبارات نجحت');
  process.exit(fails ? 1 : 0);
})();
