/* سند — منطق الرصد التلقائي بالبصمات (DINOv2) — دوال خالصة بلا DOM ولا شبكة.
   الغرض: ضمّ «المخاطر العامة» و«أشيائي» إلى الرصد التلقائي دون إبطائه:
     - بوابة تغيّر المشهد (لا بصمة إن لم يتغير شيء).
     - ميزانية تكيّفية (الفاصل = ثلاثة أضعاف زمن البصمة المقيس، فلا يتجاوز نحو 25% من المعالج).
     - تصويت زمني لتقليل الإنذارات الكاذبة (تطابقان من ثلاثة، أو تطابق قوي واحد).
     - الخطر أولاً دائماً، وأشياؤك لا تحجبه.
     - لا شيء من هذا يعمل في وضع المرآة/الملابس.
   المكان (SegFormer): تُحلَّل شبكة التصنيف بدقة الربع مباشرة (بلا بناء أقنعة كاملة) وتُلخَّص بنفس أصناف
   ADE20K_CRITICAL وعتباتها، ويُنطق السلم/الماء/الحائط/العمود كتنبيه، والأبواب والشبابيك وغيرها كإخبار هادئ.
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
  // tier: fast ≤400ms | mid ≤1200 | slow ≤2500 | off (> offAt بعد 3 قياسات على الأقل)
  // k = مضاعف الفاصل (3 ⇒ ≈25% من المعالج)، minDelay/maxDelay بالملّي ثانية
  function computeInterval(emaMs, o) {
    o = o || {};
    const k = o.k || 3, minD = o.minDelay || 900, maxD = o.maxDelay || 7500, offAt = o.offAt || 2500;
    const weak = (o.cores && o.cores <= 2) || (o.mem && o.mem <= 2);
    const e = emaMs > 0 ? emaMs : (weak ? 1500 : 800);
    let tier = e <= 400 ? 'fast' : (e <= 1200 ? 'mid' : (e <= offAt ? 'slow' : 'off'));
    if (tier === 'off' && (o.samples || 0) < 3) tier = 'slow';
    return { tier, ema: e, delay: tier === 'off' ? 0 : Math.round(Math.min(maxD, Math.max(minD, e * k))) };
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
    if (s.lifeMode === 'grooming' || s.lifeMode === 'clothes') return 'off';   // لا بصمات ولا تجزئة تلقائية في المرآة
    if (s.busyUser) return 'user';                                            // طلب المستخدم له الأولوية
    if (s.speaking) return 'speaking';
    if (!s.videoOk) return 'novideo';
    const hz = !!(s.wantHazard && s.hasHazardPool), it = !!(s.wantItems && s.hasItems), ar = !!s.wantArch;
    if (!hz && !it && !ar) return 'nothing';        // لا شيء نقارن به ⇒ لا نحمّل ولا نعمل
    const usable = ((hz || it) && !!s.backendReady) || (ar && !!s.segReady);
    if (!usable) return 'nobackend';
    return 'run';
  }
  // مخطِّط الميزات: feats مرتّبة بالأولوية [{id, due}] (مُصفّاة بالجاهزية). يختار أول ميزة حان وقتها ونجحت بوابة المشهد.
  function chooseFeature(feats, now, passGate) {
    let wait = Infinity;
    for (const f of feats) {
      const w = (f.due || 0) - now;
      if (w > 0) { wait = Math.min(wait, w); continue; }
      if (passGate(f.id)) return { pick: f.id, waitMs: 0 };
      wait = Math.min(wait, 500);
    }
    return { pick: null, waitMs: Number.isFinite(wait) ? Math.max(200, Math.min(wait, 1500)) : 1500 };
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

  /* ---------- المكان: تلخيص شبكة SegFormer ---------- */
  // أبعاد إدخال التجزئة: الضلع الطويل longSide (مضاعف 32) والقصير بنسبة الفيديو مقرّباً لمضاعف 32 (≥160)
  function segDims(vw, vh, longSide, mult) {
    longSide = longSide || 384; mult = mult || 32;
    if (!vw || !vh) return [longSide, Math.round(longSide * 0.75 / mult) * mult];
    const ar = vw >= vh ? vh / vw : vw / vh;
    const short = Math.max(mult * 5, Math.round(longSide * ar / mult) * mult);
    return vw >= vh ? [longSide, short] : [short, longSide];
  }
  // labels: Uint8Array(gw*gh) من argmax؛ id2label من النموذج؛ critical = ADE20K_CRITICAL
  function summarizeSegGrid(labels, gw, gh, id2label, critical) {
    const total = gw * gh;
    if (!total || !labels || labels.length < total) return [];
    const cnt = new Uint32Array(256), sx = new Float64Array(256);
    for (let y = 0, p = 0; y < gh; y++) for (let x = 0; x < gw; x++, p++) { const id = labels[p]; cnt[id]++; sx[id] += x + 0.5; }
    const out = [];
    for (let id = 0; id < 256; id++) {
      if (!cnt[id]) continue;
      const lbl = String((id2label && id2label[id]) || '').toLowerCase().trim(), meta = critical[lbl];
      if (!meta) continue;
      const frac = cnt[id] / total;
      if (frac < meta.minPct) continue;
      const cx = (sx[id] / cnt[id]) / gw;
      out.push({ key: lbl, ar: meta.ar, pos: cx < 0.34 ? 'على اليسار' : (cx > 0.66 ? 'على اليمين' : 'أمامك'),
        priority: meta.priority, frac, ratio: frac / meta.minPct, minPct: meta.minPct });
    }
    out.sort((a, b) => b.priority - a.priority || b.ratio - a.ratio);
    return out;
  }
  // نفس تنسيق analyzeLocalArchitecture القديم: نصوص مدمجة (السلالم مجموعة واحدة) وحتى 4
  function formatArchFindings(findings, limit) {
    const seen = new Set(), res = [];
    for (const f of findings || []) {
      // «سلالم» لا تحتوي «سلم» نصّاً، فالتجميع القديم كان يفصل «سلالم» عن «سلم»؛ نجمعها هنا في مجموعة واحدة
      const grp = (f.ar.includes('سلم') || f.ar.includes('سلال') || f.ar.includes('درج')) ? 'stairs' : f.ar;
      if (!seen.has(grp)) { seen.add(grp); res.push(f.ar + ' ' + f.pos); }
    }
    return res.slice(0, limit || 4);
  }
  const archGroup = k => (k === 'stairs' || k === 'stairway' || k === 'step') ? 'stairs' : k;
  // سياسة الإعلان: hazard ينبّه ويقاطع، info إخبار هادئ، ambient هادئ جداً (طريق/رصيف يتكرران أثناء المشي)
  const ARCH_POLICY = {
    stairs: { kind: 'hazard', cool: 10000 }, water: { kind: 'hazard', cool: 10000 },
    wall: { kind: 'hazard', cool: 10000 }, pole: { kind: 'hazard', cool: 10000 },
    door: { kind: 'info', cool: 20000 }, windowpane: { kind: 'info', cool: 20000 }, railing: { kind: 'info', cool: 20000 },
    banister: { kind: 'info', cool: 20000 }, mirror: { kind: 'info', cool: 20000 },
    road: { kind: 'ambient', cool: 45000 }, sidewalk: { kind: 'ambient', cool: 45000 }
  };
  function createArchAnnouncer(opt) {
    const o = Object.assign({ strongRatio: 3, need: 2, infoGapMs: 6000 }, opt || {});
    const trackers = new Map(), lastSaid = new Map(), absent = new Map();
    let win = 9000, lastInfoAt = -Infinity;
    const tr = g => {
      let t = trackers.get(g);
      if (!t) { t = createVoteTracker({ need: o.need, strong: o.strongRatio, windowMs: win }); trackers.set(g, t); }
      return t;
    };
    return {
      setWindow(ms) { win = Math.max(1000, ms | 0); trackers.forEach(t => t.setWindow(win)); },
      reset() { trackers.clear(); lastSaid.clear(); absent.clear(); lastInfoAt = -Infinity; },
      // يُرجع { alert, info }: كل منهما {group, kind, ar, pos, ratio, priority} أو null. ما يُرجَع يُعدّ مُعلَناً (تهدئة).
      update(findings, now, allowInfo) {
        const byGroup = new Map();
        for (const f of findings || []) {
          const g = archGroup(f.key), cur = byGroup.get(g);
          if (!cur || f.ratio > cur.ratio) byGroup.set(g, f);
        }
        let alert = null, info = null;
        const groups = new Set([...trackers.keys(), ...byGroup.keys()]);
        for (const g of groups) {
          const pol = ARCH_POLICY[g]; if (!pol) continue;
          const f = byGroup.get(g);
          const conf = tr(g).push(f ? { name: g, score: f.ratio } : null, now);
          if (!f) {
            const n = (absent.get(g) || 0) + 1; absent.set(g, n);
            if (n >= 2 && pol.kind === 'hazard') lastSaid.delete(g);     // غاب ثم عاد ⇒ ينبَّه من جديد
            continue;
          }
          absent.set(g, 0);
          if (!conf) continue;
          const last = lastSaid.get(g);
          if (last && now - last.t < pol.cool) continue;
          const cand = { group: g, kind: pol.kind, ar: f.ar, pos: f.pos, ratio: f.ratio, priority: f.priority };
          if (pol.kind === 'hazard') { if (!alert || cand.ratio > alert.ratio) alert = cand; }
          else if (!info || cand.priority > info.priority || (cand.priority === info.priority && cand.ratio > info.ratio)) info = cand;
        }
        // الإخبار الهادئ لا يُعلَن (ولا يُحتسب مُعلَناً) إن مُنع أو سبقه تنبيه أو إخبار قريب
        if (info && (alert || allowInfo === false || now - lastInfoAt < o.infoGapMs)) info = null;
        if (alert) lastSaid.set(alert.group, { t: now, pos: alert.pos });
        if (info) { lastSaid.set(info.group, { t: now, pos: info.pos }); lastInfoAt = now; }
        return { alert, info };
      }
    };
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

  return { VERSION: 'L2', normVec, reduceEmbedding, sceneDiff, thumbUsable, shouldEmbed, updateEma, computeInterval,
    createVoteTracker, liveGate, chooseFeature, chooseRoi, segDims, summarizeSegGrid, formatArchFindings,
    createArchAnnouncer, ARCH_POLICY, composeIdentifyMessage };
});
