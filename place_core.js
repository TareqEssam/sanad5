/* سند — «صف المكان»: منطق صرف (بلا DOM) قابل للاختبار في Node.
   لا يلتقط صوراً ولا يرسل شيئاً: يستقبل أرقاماً/تسميات من محركات الجهاز ويبني وصفاً عربياً حذراً. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SanadPlace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SECTORS = [
    { id: 0, name: 'أمامك' },
    { id: 1, name: 'على يمينك' },
    { id: 2, name: 'خلفك' },
    { id: 3, name: 'على يسارك' }
  ];
  const CFG = { minFramesPerSector: 3, minSegPerSector: 1, objMinFrames: 2, objMinShare: 0.3, objMinScore: 0.56, maxPerSector: 5, wallDominant: 0.62, floorDominant: 0.6, sectorHalfWidth: 40, maxSectorSeconds: 14 };

  /* ---------- اتجاه الكاميرا الخلفية (W3C: alpha, beta, gamma بالدرجات) ---------- */
  function yawOf(alpha, beta, gamma) {
    if (![alpha, beta, gamma].every(Number.isFinite)) return null;
    const r = Math.PI / 180, a = alpha * r, b = beta * r, g = gamma * r;
    const X = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a);
    const Y = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a);
    const yaw = Math.atan2(X, Y) / r;
    return (yaw + 360) % 360;
  }
  // الدوران إلى اليمين (باتجاه عقارب الساعة) من نقطة البداية: 0..360
  function relYaw(cur, start) { if (!Number.isFinite(cur) || !Number.isFinite(start)) return null; return ((cur - start) % 360 + 360) % 360; }
  function sectorOf(rot) {
    if (!Number.isFinite(rot)) return null;
    const idx = Math.round(rot / 90) % 4, center = idx * 90;
    const diff = Math.min(Math.abs(rot - center), 360 - Math.abs(rot - center));
    return { idx, centered: diff <= CFG.sectorHalfWidth, diff };
  }

  /* ---------- أسماء عربية للمعالم (ADE20K) ---------- */
  const AR = {
    wall: 'حائط', building: 'مبنى', sky: 'سماء', floor: 'أرضية', tree: 'أشجار', ceiling: 'سقف', road: 'طريق سيارات', bed: 'سرير',
    windowpane: 'شباك', grass: 'عشب', cabinet: 'دولاب', sidewalk: 'رصيف', person: 'أشخاص', earth: 'أرض ترابية', door: 'باب', table: 'طاولة',
    mountain: 'جبل', plant: 'نباتات', curtain: 'ستارة', chair: 'كراسي', car: 'سيارات', water: 'مياه', painting: 'لوحة', sofa: 'أريكة',
    shelf: 'رف', house: 'منزل', sea: 'بحر', mirror: 'مرآة', rug: 'سجادة', field: 'أرض مفتوحة', armchair: 'كرسي مريح', seat: 'مقاعد', fence: 'سور',
    desk: 'مكتب', wardrobe: 'دولاب ملابس', lamp: 'إضاءة', railing: 'حاجز', column: 'عمود', signboard: 'لافتة', counter: 'طاولة مطبخ', sink: 'حوض',
    stairs: 'سلالم', stairway: 'سلم', step: 'درجة', refrigerator: 'ثلاجة', pole: 'عمود', screen: 'شاشة', bathtub: 'بانيو', toilet: 'مرحاض', bench: 'مقعد',
    fireplace: 'مدفأة', stove: 'بوتاجاز', kitchen: 'مطبخ', bannister: 'درابزين', banister: 'درابزين', bookcase: 'مكتبة', box: 'صناديق', pillow: 'وسائد',
    awning: 'مظلة', streetlight: 'عمود إنارة', 'traffic light': 'إشارة مرور', bus: 'حافلة', truck: 'شاحنة', van: 'عربة', bicycle: 'دراجات', minibike: 'دراجة نارية',
    path: 'ممر', escalator: 'سلم متحرك', 'swimming pool': 'حمام سباحة', river: 'نهر', lake: 'بحيرة', fountain: 'نافورة', bridge: 'جسر', skyscraper: 'برج'
  };
  const INDOOR = { floor: 1, ceiling: 1.2, bed: 2, cabinet: 1, door: .5, table: 1, curtain: 1.2, chair: 1, sofa: 2, shelf: 1, rug: 1.5, armchair: 1.5, desk: 1.5, wardrobe: 2, lamp: 1, painting: 1.2, counter: 1.5, sink: 1.5, refrigerator: 2, bookcase: 1.5, pillow: 1.5, toilet: 2, bathtub: 2, stove: 2, kitchen: 2, fireplace: 1.5 };
  const OUTDOOR = { sky: 3, road: 3, building: 1.8, sidewalk: 3, tree: 2, car: 1.5, grass: 2, earth: 1.5, mountain: 2, sea: 3, water: 1, house: 1.5, fence: 1, streetlight: 2, bus: 1.5, truck: 1.5, field: 2, river: 2, bridge: 2, skyscraper: 2, 'traffic light': 2, signboard: 1, pole: 1 };
  const HAZ_SEG = { stairs: 'سلالم', stairway: 'سلم', step: 'درجات', water: 'مياه', road: 'طريق سيارات', escalator: 'سلم متحرك', 'swimming pool': 'مياه', river: 'مياه', sea: 'مياه', lake: 'مياه' };
  function baseLabel(l) { return String(l || '').toLowerCase().split(',')[0].trim(); }
  function arOf(l) { return AR[baseLabel(l)] || null; }

  /* ---------- جلسة المسح ---------- */
  function create(opts) {
    opts = opts || {};
    const st = { hasSeg: !!opts.hasSeg, hasYaw: !!opts.hasYaw, sectors: SECTORS.map(s => ({ id: s.id, frames: 0, segN: 0, objs: {}, segSum: {}, tiltLow: 0, tiltHigh: 0, retried: 0, started: 0 })), hazards: [], notes: [], cancelled: false };
    return {
      state: st,
      addCoco(idx, preds) {
        const s = st.sectors[idx]; if (!s) return; s.frames++;
        const seen = new Set();
        for (const p of preds || []) {
          if (!p || !p.ar || !(p.score >= CFG.objMinScore)) continue;
          const key = p.cls + '|' + (p.pos || '');
          if (seen.has(key)) continue; seen.add(key);
          const o = s.objs[key] || (s.objs[key] = { cls: p.cls, ar: p.ar, pos: p.pos || 'أمامك', frames: 0, steps: [], priority: p.priority || 0, count: 0 });
          o.frames++; if (Number.isFinite(p.steps)) o.steps.push(p.steps);
        }
        // عدد النسخ في أفضل إطار (للأشخاص والسيارات)
        const per = {}; for (const p of preds || []) if (p && p.ar && p.score >= CFG.objMinScore) per[p.cls] = (per[p.cls] || 0) + 1;
        for (const k of Object.keys(s.objs)) { const o = s.objs[k]; if (per[o.cls] > o.count) o.count = per[o.cls]; }
      },
      addSeg(idx, fracs) {
        const s = st.sectors[idx]; if (!s || !fracs || !fracs.length) return; s.segN++;
        for (const f of fracs) { const l = baseLabel(f.label); s.segSum[l] = (s.segSum[l] || 0) + (Number(f.frac) || 0); }
      },
      addTilt(idx, beta) { const s = st.sectors[idx]; if (!s || !Number.isFinite(beta)) return; if (beta < 55) s.tiltLow++; else if (beta > 115) s.tiltHigh++; },
      addHazard(text) { if (text && !st.hazards.includes(text)) st.hazards.push(String(text).slice(0, 120)); },
      sectorStatus(idx) {
        const s = st.sectors[idx], segOk = !st.hasSeg || s.segN >= CFG.minSegPerSector;
        return { frames: s.frames, segN: s.segN, done: s.frames >= CFG.minFramesPerSector && segOk, needSeg: st.hasSeg && s.segN < CFG.minSegPerSector };
      },
      // ماذا نطلب من المستخدم إن كان القطاع غير واضح؟ null = لا شيء
      advice(idx) {
        const s = st.sectors[idx], n = Math.max(1, s.segN);
        const avg = l => (s.segSum[l] || 0) / n;
        if (s.tiltHigh > s.tiltLow + 2) return 'أنزل الهاتف قليلاً';
        if (s.tiltLow > s.tiltHigh + 2) return 'ارفع الهاتف قليلاً ليصبح مستقيماً';
        if (s.segN >= 1 && avg('floor') + avg('road') + avg('earth') + avg('sidewalk') + avg('grass') > CFG.floorDominant) return 'ارفع الهاتف قليلاً';
        if (s.segN >= 1 && avg('wall') > CFG.wallDominant) return 'الحائط قريب جداً؛ ابتعد خطوة إن أمكن أو أمِل الهاتف يميناً ويساراً قليلاً';
        return null;
      },
      cancel() { st.cancelled = true; },
      summary() { return summarize(st); }
    };
  }

  function median(a) { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; }

  function sectorSummary(st, s) {
    const out = { id: s.id, name: SECTORS[s.id].name, frames: s.frames, segN: s.segN, objects: [], landmarks: [], hazards: [], reliable: false, wallClose: false, openAhead: false };
    const minF = Math.max(CFG.objMinFrames, Math.ceil(s.frames * CFG.objMinShare));
    const objs = Object.values(s.objs).filter(o => o.frames >= minF).sort((a, b) => (b.priority - a.priority) || (b.frames - a.frames));
    // دمج نفس الصنف في أكثر من جهة: نبقي الأكثر ظهوراً
    const bestByCls = {}; for (const o of objs) if (!bestByCls[o.cls] || o.frames > bestByCls[o.cls].frames) bestByCls[o.cls] = o;
    out.objects = Object.values(bestByCls).sort((a, b) => (b.priority - a.priority) || (b.frames - a.frames)).slice(0, CFG.maxPerSector)
      .map(o => ({ cls: o.cls, ar: o.ar, pos: o.pos, count: o.count || 1, steps: median(o.steps), priority: o.priority, frames: o.frames }));
    if (s.segN) {
      const n = s.segN, avg = {};
      for (const l of Object.keys(s.segSum)) avg[l] = s.segSum[l] / n;
      out.avg = avg;
      const lm = Object.keys(avg).filter(l => AR[l] && avg[l] >= 0.04 && !['floor', 'ceiling', 'sky', 'wall', 'earth', 'person', 'car', 'chair', 'table'].includes(l)).sort((a, b) => avg[b] - avg[a]).slice(0, 4);
      out.landmarks = lm.map(l => AR[l]);
      out.hazards = Object.keys(HAZ_SEG).filter(l => avg[l] >= 0.03).map(l => HAZ_SEG[l]).filter((v, i, a) => a.indexOf(v) === i);
      out.wallClose = avg.wall >= CFG.wallDominant;
      out.openAhead = (avg.sky || 0) + (avg.road || 0) + (avg.field || 0) >= 0.4;
    }
    out.reliable = s.frames >= CFG.minFramesPerSector && (!st.hasSeg || s.segN >= CFG.minSegPerSector);
    return out;
  }

  function classify(st) {
    if (!st.hasSeg) return { kind: 'unknown', conf: 0 };
    let ind = 0, out = 0, n = 0;
    for (const s of st.sectors) {
      if (!s.segN) continue; n += s.segN;
      for (const l of Object.keys(s.segSum)) { ind += (INDOOR[l] || 0) * s.segSum[l]; out += (OUTDOOR[l] || 0) * s.segSum[l]; }
    }
    if (!n) return { kind: 'unknown', conf: 0 };
    ind /= n; out /= n; const tot = ind + out;
    if (tot < 0.15) return { kind: 'unknown', conf: 0 };
    const share = Math.max(ind, out) / tot;
    if (share < 0.62) return { kind: 'unknown', conf: share };
    return { kind: ind > out ? 'indoor' : 'outdoor', conf: share };
  }

  function summarize(st) {
    const sectors = st.sectors.map(s => sectorSummary(st, s));
    const kind = classify(st);
    const covered = sectors.filter(s => s.reliable).length;
    return { sectors, kind, covered, total: 4, hazards: st.hazards.slice(), hasSeg: st.hasSeg, hasYaw: st.hasYaw, cancelled: st.cancelled };
  }

  /* ---------- الصياغة العربية ---------- */
  function stepsText(n) { if (!Number.isFinite(n)) return ''; if (n <= 1) return 'على بعد خطوة تقريباً'; if (n === 2) return 'على بعد خطوتين تقريباً'; if (n <= 10) return 'على بعد نحو ' + n + ' خطوات'; return 'بعيد نسبياً'; }
  function countWord(ar, c) { return c >= 2 ? (ar + ' (نحو ' + c + ')') : ar; }

  function narrate(sum) {
    const L = [];
    // 1) السلامة أولاً
    if (sum.hazards.length) L.push('تنبيه أولاً: رُصد أثناء الفحص ' + sum.hazards.join('، ') + '. تحرّك بحذر واستعمل العصا.');
    const segHaz = []; sum.sectors.forEach(s => s.hazards.forEach(h => segHaz.push(h + ' ' + s.name)));
    if (segHaz.length) L.push('احتمال وجود ' + segHaz.slice(0, 3).join('، ') + '. تأكد بعصاك قبل أي حركة.');
    const near = []; sum.sectors.forEach(s => s.objects.forEach(o => { if (o.priority >= 3 && Number.isFinite(o.steps) && o.steps <= 3) near.push(o.ar + ' ' + s.name); }));
    if (near.length) L.push('قريب منك: ' + near.slice(0, 3).join('، ') + '.');
    // 2) نوع المكان (بحذر)
    if (sum.kind.kind === 'indoor') L.push('يبدو أنك داخل مكان مغلق' + (sum.kind.conf < 0.75 ? ' (تقدير غير مؤكد)' : '') + '.');
    else if (sum.kind.kind === 'outdoor') L.push('يبدو أنك في مكان مفتوح أو في الشارع' + (sum.kind.conf < 0.75 ? ' (تقدير غير مؤكد)' : '') + '.');
    else if (sum.hasSeg) L.push('لم أتمكن من تحديد إن كان المكان مغلقاً أو مفتوحاً بثقة.');
    // 3) كل جهة
    for (const s of sum.sectors) {
      if (!s.reliable) { L.push(s.name + ': لم أحصل على رؤية كافية، لا أستطيع وصفها بثقة.'); continue; }
      const parts = [];
      if (s.wallClose) parts.push('حائط قريب');
      else if (s.openAhead) parts.push('مساحة مفتوحة');
      for (const o of s.objects) parts.push(countWord(o.ar, o.count) + (o.count < 2 && Number.isFinite(o.steps) ? ' ' + stepsText(o.steps) : '') + (o.pos && o.pos !== 'أمامك' && s.id === 0 ? ' ' + o.pos : ''));
      for (const l of s.landmarks) if (!parts.includes(l)) parts.push(l);
      L.push(s.name + ': ' + (parts.length ? parts.join('، ') : 'لا شيء واضح') + '.');
    }
    // 4) أمانة التغطية
    if (sum.covered < 4) L.push('تنبيه: وصفت ' + sum.covered + ' من 4 جهات فقط بثقة.');
    L.push('هذا وصف تقريبي من الهاتف وحده؛ الخطوات تقدير، فلا تعتمد عليه وحده وتأكد بالعصا.');
    return L.join(' ');
  }

  return { SECTORS, CFG, yawOf, relYaw, sectorOf, create, summarize, narrate, arOf, baseLabel };
});
