/* سند — منطق الرصد التلقائي بالبصمات (DINOv2) — دوال خالصة بلا DOM ولا شبكة.
   الغرض: ضمّ «المخاطر العامة» و«أشيائي» إلى الرصد التلقائي دون إبطائه:
     - بوابة تغيّر المشهد (لا بصمة إن لم يتغير شيء).
     - ميزانية تكيّفية (الفاصل = ثلاثة أضعاف زمن البصمة المقيس، فلا يتجاوز نحو 25% من المعالج).
     - تصويت زمني لتقليل الإنذارات الكاذبة (تطابقان من ثلاثة، أو تطابق قوي واحد).
     - الخطر أولاً دائماً، وأشياؤك لا تحجبه.
     - لا شيء من هذا يعمل في وضع المرآة/الملابس.
   كل الأرقام هنا قيم ابتدائية تحتاج معايرة على صور وأجهزة حقيقية (كعتبات التشابه الأصلية). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SanadLive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- البصمة: مطابقة حرفية لما كان في embedFrame وللعامل embed_worker.js ---------- */
  function normVec(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
    return o;
  }
  // الناتج: [CLS مُطبَّع | متوسط رموز الرقع مُطبَّع] ثم تطبيع الكل = 768 بعداً لـ dinov2-small
  function reduceEmbedding(dims, data) {
    const D = dims[dims.length - 1], N = dims.length >= 3 ? dims[dims.length - 2] : 1;
    const cls = normVec(data.slice(0, D)), mean = new Float32Array(D);
    if (N > 1) { for (let t = 1; t < N; t++) for (let i = 0; i < D; i++) mean[i] += data[t * D + i] / (N - 1); }
    const both = new Float32Array(2 * D); both.set(cls, 0); both.set(normVec(N > 1 ? mean : cls), D);
    return normVec(both);
  }

  /* ---------- بوابة تغيّر المشهد ---------- */
  function sceneDiff(a, b) {            // متوسط فرق السطوع المطلق (0..255) بين مصغّرتين رماديتين
    if (!a || !b || a.length !== b.length || !a.length) return 255;
    let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }
  function thumbUsable(t) {             // يرفض الإطار المعتم جداً أو المتجانس (عدسة مغطاة)
    if (!t || !t.length) return false;
    let m = 0; for (let i = 0; i < t.length; i++) m += t[i];
    m /= t.length;
    let v = 0; for (let i = 0; i < t.length; i++) v += (t[i] - m) * (t[i] - m);
    return m >= 12 && Math.sqrt(v / t.length) >= 3;
  }
  function shouldEmbed(o) {
    if (!o.lastEmbedAt) return true;
    return o.diff >= (o.gateDiff == null ? 6 : o.gateDiff) || (o.now - o.lastEmbedAt) >= (o.maxStaleMs || 4000);
  }

  /* ---------- الميزانية التكيّفية ---------- */
  function updateEma(prev, sample, alpha) {
    alpha = alpha || 0.3;
    return prev > 0 ? prev * (1 - alpha) + sample * alpha : sample;
  }
  // tier: fast ≤400ms | mid ≤1200 | slow ≤2500 | off (>2500 بعد 3 قياسات على الأقل)
  function computeInterval(emaMs, o) {
    o = o || {};
    const weak = (o.cores && o.cores <= 2) || (o.mem && o.mem <= 2);
    const e = emaMs > 0 ? emaMs : (weak ? 1500 : 800);
    let tier = e <= 400 ? 'fast' : (e <= 1200 ? 'mid' : (e <= 2500 ? 'slow' : 'off'));
    if (tier === 'off' && (o.samples || 0) < 3) tier = 'slow';
    return { tier, ema: e, delay: tier === 'off' ? 0 : Math.round(Math.min(7500, Math.max(900, e * 3))) };
  }

  /* ---------- التصويت الزمني ---------- */
  function createVoteTracker(opt) {
    const o = Object.assign({ windowMs: 9000, need: 2, strong: 0.65, keep: 3 }, opt || {});
    let log = [];
    return {
      setWindow(ms) { o.windowMs = Math.max(1000, ms | 0); },
      // hit = {name, score} أو null (لا مطابقة). يُرجع {name,score,why} إذا تأكد التنبيه.
      push(hit, now) {
        log.push({ t: now, name: hit ? hit.name : null });
        log = log.filter(e => now - e.t <= o.windowMs).slice(-o.keep);
        if (!hit) return null;
        if (hit.score >= o.strong) return { name: hit.name, score: hit.score, why: 'strong' };
        const n = log.filter(e => e.name === hit.name).length;
        return n >= o.need ? { name: hit.name, score: hit.score, why: 'votes' } : null;
      },
      clearedFor(n) { return log.length >= n && log.slice(-n).every(e => !e.name); },
      reset() { log = []; }
    };
  }

  /* ---------- مَن يعمل الآن؟ (الخصوصية والأولوية) ---------- */
  function liveGate(s) {
    if (!s.running || s.hidden) return 'idle';
    if (!s.nav) return 'off';
    if (s.lifeMode === 'grooming' || s.lifeMode === 'clothes') return 'off';   // لا بصمات تلقائية في المرآة
    if (s.busyUser) return 'user';                                            // طلب المستخدم له الأولوية
    if (s.speaking) return 'speaking';
    if (!s.videoOk) return 'novideo';
    const hz = !!(s.wantHazard && s.hasHazardPool), it = !!(s.wantItems && s.hasItems);
    if (!hz && !it) return 'nothing';          // لا شيء نقارن به ⇒ لا نحمّل ولا نبصم
    if (!s.backendReady) return 'nobackend';
    return 'run';
  }
  function pickSlot(counter, o) {          // كل ثالث فتحة تُخصَّص لقصاصة جسم (أشيائي) إن وُجد مرشح
    return (o && o.items && o.roi && counter % 3 === 2) ? 'roi' : 'scene';
  }

  /* ---------- قصاصة الجسم من كاشف الأجسام ---------- */
  const ROI_EXCLUDE = new Set(['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep',
    'cow', 'elephant', 'bear', 'zebra', 'giraffe']);
  function chooseRoi(preds, vw, vh) {
    if (!preds || !vw || !vh) return null;
    let best = null;
    for (const p of preds) {
      if (!p || !p.bbox || ROI_EXCLUDE.has(p.class) || (p.score || 0) < 0.5) continue;
      const w = p.bbox[2], h = p.bbox[3], ar = (w * h) / (vw * vh);
      if (!(ar >= 0.02 && ar <= 0.6)) continue;
      if (!best || ar > best.ar) best = { ar, x: p.bbox[0], y: p.bbox[1], w, h, cls: p.class };
    }
    if (!best) return null;
    const px = best.w * 0.12, py = best.h * 0.12;
    const x0 = Math.max(0, best.x - px), y0 = Math.max(0, best.y - py);
    const x1 = Math.min(vw, best.x + best.w + px), y1 = Math.min(vh, best.y + best.h + py);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cls: best.cls };
  }

  /* ---------- «ما هذا؟»: الخطر أولاً ثم أشياؤك ---------- */
  // d = قرار أشيائي، g = قرار الحزم العامة، h = { generalSpeech(g), medRe }
  function composeIdentifyMessage(d, g, h) {
    const medTail = ' هذا تخمين بصري؛ تأكد من الاسم المكتوب قبل الاستعمال.';
    let personal = null;
    if (d.kind === 'match') personal = 'أظنه ' + d.name + ' من أشيائك.' + (h.medRe.test(d.name) ? medTail : '');
    else if (d.kind === 'ambiguous') personal = 'قد يكون ' + d.a + ' أو ' + d.b + ' من أشيائك. لست متأكداً.';
    if (g.kind === 'match' && g.cls && g.cls.kind === 'hazard') {
      return h.generalSpeech(g) + (d.kind === 'match' ? ' ' + personal : '');
    }
    if (g.kind === 'ambiguous' && g.r && g.r[0] && g.r[0].kind === 'hazard') {
      return 'تنبيه محتمل: قد يكون أمامك ' + g.a + ' أو ' + g.b + '. هذا تخمين بصري؛ تأكد بعصاك.' + (d.kind === 'match' ? ' ' + personal : '');
    }
    if (personal) return personal;
    if (g.kind === 'match') return h.generalSpeech(g);
    if (g.kind === 'ambiguous') return 'قد يكون ' + g.a + ' أو ' + g.b + ' من المعرفة العامة. لست متأكداً.';
    return 'لا أعرف هذا الشيء. قرّبه وأعد المحاولة أو علّمني إياه.';
  }

  return { VERSION: 'L1', normVec, reduceEmbedding, sceneDiff, thumbUsable, shouldEmbed, updateEma, computeInterval,
    createVoteTracker, liveGate, pickSlot, chooseRoi, composeIdentifyMessage };
});
