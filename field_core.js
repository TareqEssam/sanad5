/* سند — منطق الاختبار الميداني (بلا واجهة): بروتوكول المشاهد، التحقق من اكتمال القراءات، وملخص الجلسة.
   قابل للاختبار في Node (انظر fieldtest.js). الواجهة في field_ui.js وخطافات التسجيل في index.html.
   كل زمن t في الأحداث = مللي ثانية منذ بدء الجلسة. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SanadField = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 'field-protocol-v3';
  const VEHICLES = ['car', 'bus', 'truck', 'motorcycle'];
  const COCO_MIN_SCORE = 0.45;                 // أدنى ثقة تُحتسب «رصدًا صالحًا» للتحقق (التسجيل نفسه بعتبة أدنى)
  const STAIRS = ['stairs', 'stairway', 'step'];

  /* ---------- أدوات صغيرة ---------- */
  const det = (events, a, b) => events.filter(e => e.type === 'detection' && e.t >= a && e.t <= b);
  const arch = (events, a, b) => events.filter(e => e.type === 'arch' && e.t >= a && e.t <= b);
  const hasClass = (e, classes, minScore) => (e.data.predictions || []).some(p => classes.includes(p.class) && p.score >= minScore);
  const stepsFromM = m => Math.max(1, Math.round(m / 0.7));
  const mText = m => (String(m).replace('.', '٫'));

  /* ---------- مقاييس الإضاءة ---------- */
  function lightBand(q) {
    if (!q || typeof q.meanLuminance !== 'number') return null;
    if (q.meanLuminance < 28 || q.torchAuto) return 'dark';
    if (q.torchOn) return 'dim';
    if (q.meanLuminance < 52) return 'dim';
    if (q.meanLuminance >= 70) return 'normal';
    return 'between';
  }

  /* ---------- أكبر تصنيفات SegFormer (للتسجيل) ---------- */
  function topLabels(labels, gw, gh, id2label, n) {
    const total = gw * gh;
    if (!total || !labels || labels.length < total) return [];
    const cnt = new Uint32Array(256);
    for (let i = 0; i < total; i++) cnt[labels[i]]++;
    const out = [];
    for (let id = 0; id < 256; id++) if (cnt[id]) out.push({ label: String((id2label && id2label[id]) || ('id' + id)).toLowerCase().trim(), frac: Math.round(cnt[id] / total * 1000) / 1000 });
    out.sort((a, b) => b.frac - a.frac);
    return out.slice(0, n || 8);
  }

  /* ---------- قواعد الأدلة ---------- */
  // كل قاعدة تُرجع { have, need, ok, text, hint }
  function ruleEvidence(rule, events, a, b) {
    const D = det(events, a, b), A = arch(events, a, b);
    switch (rule.type) {
      case 'coco':
      case 'flow':
      case 'event': {
        const minScore = rule.minScore || COCO_MIN_SCORE;
        const hits = D.filter(e => hasClass(e, rule.classes, minScore));
        let have = hits.length, extra = '', ok = have >= rule.minTicks;
        const label = rule.noun || 'قراءات';
        if (rule.requireDistance) {
          const withD = hits.filter(e => e.data.predictions.some(p => rule.classes.includes(p.class) && p.score >= minScore && Number.isFinite(p.estimatedDistanceMeters))).length;
          const needD = Math.max(2, Math.ceil(rule.minTicks / 2));
          if (withD < needD) { ok = false; extra = ' (منها بتقدير مسافة ' + withD + '/' + needD + ')'; }
        }
        if (rule.minDistinctPositions) {
          const pos = new Set(); hits.forEach(e => e.data.predictions.forEach(p => { if (rule.classes.includes(p.class) && p.relativePosition) pos.add(p.relativePosition); }));
          if (pos.size < rule.minDistinctPositions) { ok = false; extra += ' (مواضع مختلفة ' + pos.size + '/' + rule.minDistinctPositions + ')'; }
        }
        return { have, need: rule.minTicks, ok, text: label + ': ' + have + '/' + rule.minTicks + extra, hint: rule.hint };
      }
      case 'arch': {
        const need = rule.minSamples, labels = rule.labels, minFrac = rule.minFrac;
        const good = A.filter(e => {
          const top = e.data.labels || [];
          const frac = l => (top.find(x => x.label === l) || { frac: 0 }).frac;
          return rule.all ? labels.every(l => frac(l) >= minFrac) : labels.some(l => frac(l) >= minFrac);
        });
        return { have: good.length, need, ok: good.length >= need, text: 'قراءات المكان المطابقة: ' + good.length + '/' + need + ' (وصلت ' + A.length + ' قراءة)', hint: rule.hint, archTotal: A.length };
      }
      case 'light': {
        const n = D.filter(e => lightBand(e.data.frameQuality) === rule.band).length;
        return { have: n, need: rule.minTicks, ok: n >= rule.minTicks, text: 'قراءات في هذه الإضاءة: ' + n + '/' + rule.minTicks, hint: rule.hint };
      }
      case 'mixed': {
        const classes = new Set(); let ticks = 0;
        D.forEach(e => { const ps = (e.data.predictions || []).filter(p => p.score >= COCO_MIN_SCORE && p.known); if (ps.length) ticks++; ps.forEach(p => classes.add(p.class)); });
        const okA = A.length >= (rule.archMinSamples || 0);
        const ok = ticks >= rule.minTicks && classes.size >= rule.minDistinctClasses && okA;
        return { have: ticks, need: rule.minTicks, ok, text: 'قراءات فيها أجسام: ' + ticks + '/' + rule.minTicks + ' — أنواع مختلفة: ' + classes.size + '/' + rule.minDistinctClasses + ' — قراءات المكان: ' + A.length + '/' + (rule.archMinSamples || 0), hint: rule.hint };
      }
    }
    return { have: 0, need: 1, ok: false, text: 'قاعدة غير معروفة' };
  }

  /* ---------- طرق قياس المسافة المرجعية (الدقة الحقيقية لكل طريقة) ---------- */
  const DIST_METHODS = {
    tape: { label: 'شريط قياس', grade: 'precise', uncertainty: d => 0.05 },
    marks: { label: 'علامات أرضية معايرة', grade: 'precise', uncertainty: d => 0.1 },
    steps: { label: 'خطوات (تقريبي)', grade: 'approximate', uncertainty: d => Math.max(0.3, 0.15 * d) },
    eye: { label: 'تقدير بالعين (تقريبي)', grade: 'approximate', uncertainty: d => Math.max(0.5, 0.25 * d) }
  };

  /* ---------- ثبات الهاتف أثناء النقطة: أرقام خام فقط بلا عتبات ---------- */
  function stabilityOf(events, a, b) {
    const M = events.filter(e => e.type === 'motion' && e.t >= a && e.t <= b), O = events.filter(e => e.type === 'orientation' && e.t >= a && e.t <= b);
    const std = arr => { if (arr.length < 2) return null; const m = arr.reduce((s, v) => s + v, 0) / arr.length; return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length); };
    const r2 = v => v === null ? null : Math.round(v * 100) / 100;
    const mag = M.filter(e => [e.data.x, e.data.y, e.data.z].every(Number.isFinite)).map(e => Math.hypot(e.data.x, e.data.y, e.data.z));
    const rot = M.filter(e => [e.data.rx, e.data.ry, e.data.rz].every(Number.isFinite)).map(e => Math.hypot(e.data.rx, e.data.ry, e.data.rz));
    return { motionSamples: M.length, orientationSamples: O.length, accelMagnitudeStd: r2(std(mag)),
      rotationRateRms: rot.length ? r2(Math.sqrt(rot.reduce((s, v) => s + v * v, 0) / rot.length)) : null,
      betaStdDeg: r2(std(O.map(e => e.data.beta).filter(Number.isFinite))), gammaStdDeg: r2(std(O.map(e => e.data.gamma).filter(Number.isFinite))) };
  }

  /* ---------- بروتوكول المشاهد ---------- */
  const SAFETY_COMMON = 'المرافق المبصر وحده مسؤول عن السلامة. لا تنظر إلى الشاشة وأنت تمشي، وأوقف التجربة فورًا إن تغيّرت الظروف أو شعرت بعدم الأمان.';
  const SEG_NEED = 'يحتاج نموذج «المكان» (SegFormer) مُنزَّلًا ومفعّلًا؛ يفحصه التطبيق قبل البدء.';

  function distCp(id, m, rule, extra) {
    return Object.assign({
      id, label: 'عند ' + mText(m) + ' م', distanceM: m,
      lines: ['قِس المسافة بين الهاتف والهدف بشريط قياس أو بعلامات على الأرض (' + mText(m) + ' م). الأفضل ألا تعتمد على الخطوات؛ فإن لم يتوفر شريط فاستعمل ≈ ' + stepsFromM(m) + ' خطوات وسيُسجَّل المرجع «تقريبيًا».', 'أمسك الهاتف أمام صدرك عموديًا وثبّته بلا حركة، والهدف في منتصف الصورة.', 'اضغط «بدء القياس»، ولا تتحرك حتى يكتمل.'],
      minHoldMs: 8000, maxWaitMs: 45000, rule
    }, extra || {});
  }

  const SCENES = {
    approaching_vehicle: {
      title: 'سيارة متحركة تقترب', icon: '🚗', minutes: 10, needsSeg: false,
      purpose: 'قياس رصد التطبيق للمركبات المتحركة وتوقيت إنذار الاقتراب.',
      place: 'رصيف أو مكان آمن يبعد 3 أمتار على الأقل عن حارة السيارات، في شارع تمر فيه سيارات باستمرار (ليس مزدحمًا جدًا وليس خاليًا).',
      bring: 'الهاتف فقط. لا تطلب من أي سائق تغيير سرعته أو مساره.',
      safety: ['لا تقف في الطريق ولا على حافة الرصيف.', 'لا تحاول «تقريب» السيارة من الهاتف بأي وسيلة.', SAFETY_COMMON],
      trials: [
        { title: 'سيارات قادمة نحوك', prepare: ['اختر موضعًا على الرصيف ترى منه السيارات تقترب في مسارها من مسافة 30 مترًا أو أكثر (مثل نهاية شارع مستقيم).'] },
        { title: 'سيارات تمر من يمينك إلى يسارك', prepare: ['قف بجانب الشارع (≥ 3 م عن الحارة) وجّه الكاميرا نحو الشارع بحيث تعبر السيارات من اليمين إلى اليسار.'] },
        { title: 'سيارات تمر من يسارك إلى يمينك', prepare: ['كالمحاولة السابقة لكن بحيث تعبر السيارات من اليسار إلى اليمين.'] }
      ],
      makeCheckpoints: () => [{
        id: 'pass', label: 'مرور سيارة', minHoldMs: 6000, maxWaitMs: 180000,
        lines: ['أمسك الهاتف أمام صدرك عموديًا والكاميرا نحو الشارع.', 'اضغط «بدء القياس» ثم انتظر.', 'عند رؤيتك سيارة تقترب اضغط «ظهرت سيارة»، وعند مرورها أمامك اضغط «مرّت السيارة».', 'يكتمل القياس تلقائيًا بعد تسجيل مرور سيارة واحدة على الأقل. يمكنك تسجيل أكثر.'],
        markers: [{ kind: 'vehicle_visible', label: '🚗 ظهرت سيارة', required: true }, { kind: 'vehicle_passed', label: '✅ مرّت السيارة', required: true }],
        rule: { type: 'event', classes: VEHICLES, minTicks: 4, noun: 'قراءات مركبة', hint: 'لم يلتقط التطبيق السيارة بما يكفي: اجعل السيارة أكبر في الصورة (قف أقرب قليلًا مع بقائك آمنًا) وتجنب التصوير ضد الشمس.' }
      }],
      answers: [{ id: 'vehicles', label: 'كم سيارة مرّت أمامك تقريبًا خلال هذه المحاولة؟', min: 1, max: 40 }]
    },
    parked_vehicle: {
      title: 'سيارة متوقفة وأنت تقترب', icon: '🅿️', minutes: 8, needsSeg: false,
      purpose: 'معايرة تقدير المسافة للمركبات عند مسافات معروفة فعليًا.',
      place: 'موقف أو شارع جانبي هادئ فيه سيارة متوقفة محركها مطفأ، وأرض مستوية خالية خلفك.',
      bring: 'شريط قياس إن أمكن (أو احسب الخطوة العادية ≈ 0.7 م).',
      safety: ['لا تقترب من السيارة لأقل من 1.5 م ولا تلمسها.', 'تأكد أنها متوقفة وأن لا أحد يركبها أو سيشغّلها.', SAFETY_COMMON],
      trials: [
        { title: 'من أمام السيارة (أو خلفها) مباشرة', prepare: ['حدد موضع السيارة، وابدأ من أبعد نقطة (6 م) ثم اقترب نقطة نقطة.'] },
        { title: 'من زاوية جانبية (≈ 30°)', prepare: ['كالمحاولة السابقة لكن من زاوية جانبية بحيث ترى جانب السيارة ومقدمتها.'] }
      ],
      makeCheckpoints: () => [6, 4, 3, 2, 1.5].map(m => distCp('d' + m, m, { type: 'coco', classes: VEHICLES, minTicks: 5, requireDistance: true, noun: 'قراءات سيارة', hint: 'السيارة لم تُرصد جيدًا: وجّه الكاميرا لتظهر السيارة كاملة في الصورة وفي المنتصف، وتأكد من الإضاءة.' }))
    },
    crowd: {
      title: 'زحام أشخاص', icon: '🚶', minutes: 6, needsSeg: false,
      purpose: 'قياس رصد الأشخاص المتعددين وتقدير مسافاتهم وأماكنهم.',
      place: 'رصيف واسع أو ساحة عامة آمنة فيها حركة مشاة مستمرة.',
      bring: 'الهاتف فقط.',
      safety: ['لا تزاحم أحدًا ولا تصوّر وجوه الناس عن قرب؛ التطبيق لا يحفظ صورًا لكن احترم المكان.', SAFETY_COMMON],
      trials: [
        { title: 'وقوف في مكان فيه مشاة', prepare: ['قف في مكان لا يعيق أحدًا والمشاة يمرون أمامك من الجانبين.'] },
        { title: 'مشي بطيء بين المشاة', prepare: ['امشِ ببطء على الرصيف الواسع والهاتف أمام صدرك. انظر أنت إلى الطريق لا إلى الشاشة؛ سيهتز الهاتف عند اكتمال المدة.'] }
      ],
      makeCheckpoints: () => [{
        id: 'flow', label: 'مشاة', minHoldMs: 45000, maxWaitMs: 150000,
        lines: ['اضغط «بدء القياس» وابقَ في المكان (أو امشِ ببطء في المحاولة الثانية) لمدة 45 ثانية على الأقل.', 'ينتهي القياس تلقائيًا حين تكتمل القراءات.'],
        rule: { type: 'flow', classes: ['person'], minTicks: 10, minDistinctPositions: 2, requireDistance: true, noun: 'قراءات أشخاص', hint: 'لم يظهر مشاة كفاية: انتقل إلى مكان أكثر ازدحامًا أو انتظر مدة أطول، وأبقِ الكاميرا في مستوى الصدر.' }
      }],
      answers: [{ id: 'people', label: 'كم شخصًا مرّوا أمام الكاميرا تقريبًا؟', min: 1, max: 200 }]
    },
    stairs: {
      title: 'سلم أو درجات', icon: '🪜', minutes: 8, needsSeg: true,
      purpose: 'قياس رصد السلالم بنموذج المكان عند مسافات معروفة (للتصوير فقط، لا للصعود).',
      place: 'سلم صاعد واضح الدرجات في مكان آمن وهادئ، وأرضية مستوية أمامه.',
      bring: 'شريط قياس إن أمكن. ' + SEG_NEED,
      safety: ['لا تصعد ولا تنزل اعتمادًا على سند أبدًا.', 'لا تقترب من أول درجة لأقل من 2 م.', SAFETY_COMMON],
      trials: [
        { title: 'سلم صاعد من الأمام', prepare: ['قف أمام السلم مباشرة بحيث تكون الدرجات في منتصف الصورة.'] },
        { title: 'السلم من زاوية جانبية', prepare: ['كالمحاولة السابقة لكن من زاوية جانبية (≈ 30°).'] }
      ],
      makeCheckpoints: () => [4, 3, 2].map(m => distCp('d' + m, m, { type: 'arch', labels: STAIRS, minFrac: 0.01, minSamples: 2, hint: 'لم يتعرف التطبيق على السلم: اجعل الدرج يملأ ثلث الصورة على الأقل، مال الهاتف قليلًا للأسفل، وتأكد من إضاءة كافية.' }, { minHoldMs: 10000, maxWaitMs: 90000, needsSeg: true }))
    },
    sidewalk_end: {
      title: 'نهاية رصيف أو حافة', icon: '🛣️', minutes: 6, needsSeg: true,
      purpose: 'قياس رصد الرصيف والطريق معًا عند حافة الرصيف من مسافة آمنة.',
      place: 'رصيف عليه حافة واضحة إلى طريق هادئ قليل الحركة.',
      bring: SEG_NEED,
      safety: ['ابقَ خلف الحافة بمسافة 2 م على الأقل في جميع الأوقات.', 'لا تضع قدمك على الحافة ولا تنزل إلى الطريق.', SAFETY_COMMON],
      trials: [
        { title: 'من الأمام', prepare: ['قف عموديًا على الحافة بحيث تظهر الحافة والطريق أمامك.'] },
        { title: 'من زاوية جانبية', prepare: ['كالمحاولة السابقة لكن من زاوية جانبية (≈ 30°).'] }
      ],
      makeCheckpoints: () => [3, 2].map(m => distCp('d' + m, m, { type: 'arch', labels: ['sidewalk', 'road'], all: true, minFrac: 0.03, minSamples: 2, hint: 'يجب أن يظهر الرصيف والطريق معًا: ارفع الهاتف قليلًا لتشمل الصورة الحافة وما بعدها.' }, { minHoldMs: 10000, maxWaitMs: 90000, needsSeg: true, lines: ['قف على بعد ' + mText(m) + ' م خلف الحافة (قِسها بشريط أو علامات؛ الخطوات ≈ ' + stepsFromM(m) + ' وتُسجَّل تقريبية) ولا تقترب أكثر.', 'أمسك الهاتف أمام صدرك عموديًا وثبّته بلا حركة، والحافة والطريق ظاهران.', 'اضغط «بدء القياس» ولا تتحرك حتى يكتمل.'] }))
    },
    wall: {
      title: 'حائط أو عائق ثابت قريب', icon: '🧱', minutes: 8, needsSeg: true,
      purpose: 'قياس تعرف التطبيق على الحائط (نسبة الحائط في الصورة) عند اقتراب تدريجي بمسافات معروفة.',
      place: 'ممر داخلي أو جدار خارجي مستوٍ وخالٍ من العوائق، مع مساحة تسمح بالابتعاد 3 م.',
      bring: 'شريط قياس إن أمكن. ' + SEG_NEED,
      safety: ['توقف قبل الحائط بـ 0.7 م على الأقل ولا تلمسه.', 'تأكد من خلو الأرض من أي عثرات.', SAFETY_COMMON],
      trials: [
        { title: 'نحو الحائط مباشرة', prepare: ['قف أمام الحائط في وسطه والهاتف موازٍ له.'] },
        { title: 'نحو الحائط بزاوية (≈ 30°)', prepare: ['كالمحاولة السابقة لكن بزاوية 30° مع الحائط.'] }
      ],
      makeCheckpoints: () => [3, 2, 1.5, 1, 0.7].map(m => distCp('d' + m, m, { type: 'arch', labels: ['wall'], minFrac: 0.15, minSamples: 2, hint: 'لم تُسجَّل نسبة حائط كافية: واجه الحائط بالكاميرا واجعله يملأ جزءًا كبيرًا من الصورة، وأضئ المكان.' }, { minHoldMs: 8000, maxWaitMs: 75000, needsSeg: true }))
    },
    low_light: {
      title: 'إضاءة ضعيفة أو ظلام', icon: '🌙', minutes: 10, needsSeg: false,
      purpose: 'قياس أداء الرصد عند ثلاث درجات إضاءة (عادية، خافتة، مظلمة) وسلوك الكشاف التلقائي.',
      place: 'غرفة أو ممر داخلي آمن تستطيع التحكم في إضاءته، دون أشخاص يعتمدون على هذه الإنارة.',
      bring: 'كرسي أو شخص يقف على بعد 2 م أمام الكاميرا (هدف معروف). ثبّت الهاتف على سطح ثابت أو أسنده.',
      safety: ['لا تتحرك في الظلام: ابقَ ثابتًا.', 'لا تُطفئ إنارة سلم أو ممر يستخدمه الآخرون.', SAFETY_COMMON],
      trials: [
        { title: 'الإضاءة تنخفض تدريجيًا', prepare: ['ضع الهدف (كرسي أو شخص) على بعد 2 م أمام الكاميرا. ستبدأ بإضاءة عادية ثم تخفضها على مرحلتين.'] },
        { title: 'تكرار بهدف آخر', prepare: ['كرر مع شيء مختلف (كرسي ← شخص أو العكس) على بعد 2 م أيضًا.'] }
      ],
      makeCheckpoints: () => [
        { id: 'normal', band: 'normal', label: 'إضاءة عادية', lines: ['أبقِ الإضاءة العادية (مصابيح الغرفة مضاءة).'], hint: 'لم تُسجَّل إضاءة عادية: أضئ المكان أكثر.' },
        { id: 'dim', band: 'dim', label: 'إضاءة خافتة', lines: ['اخفض الإضاءة حتى تظهر في الأعلى «الإضاءة الحالية: خافتة».'], hint: 'اخفض الإضاءة أكثر قليلًا (لكن ليس ظلامًا كاملًا) حتى تظهر «خافتة».' },
        { id: 'dark', band: 'dark', label: 'مظلم', lines: ['اخفض الإضاءة حتى تقترب من الظلام. إن شغّل التطبيق الكشاف تلقائيًا فهذا متوقع؛ لا تطفئه.'], hint: 'المكان لم يصل للظلام: أطفئ المزيد من المصابيح أو غطِّ النوافذ.' }
      ].map(c => ({ id: c.id, label: c.label, distanceM: 2, minHoldMs: 12000, maxWaitMs: 150000, lines: c.lines.concat(['ثبّت الهاتف بلا حركة واضغط «بدء القياس».']), rule: { type: 'light', band: c.band, minTicks: 6, hint: c.hint } }))
    },
    mixed: {
      title: 'مشهد مختلط', icon: '🏙️', minutes: 6, needsSeg: true,
      purpose: 'قياس الأداء الشامل في مشهد حقيقي فيه أشخاص ومركبات ورصيف ومبانٍ.',
      place: 'مكان آمن يجمع أكثر من عنصر: مشاة وسيارة متوقفة أو متحركة بعيدًا ورصيف ومبانٍ.',
      bring: SEG_NEED,
      safety: ['ابقَ على الرصيف بعيدًا عن حارة السيارات.', SAFETY_COMMON],
      trials: [
        { title: 'وقوف ثابت', prepare: ['قف في موضع آمن ترى منه عناصر المشهد المختلفة.'] },
        { title: 'مشي بطيء', prepare: ['امشِ ببطء على الرصيف والهاتف أمام صدرك. انظر أنت إلى الطريق؛ سيهتز الهاتف عند اكتمال المدة.'] }
      ],
      makeCheckpoints: () => [{
        id: 'mix', label: 'مشهد مختلط', minHoldMs: 45000, maxWaitMs: 150000,
        lines: ['اضغط «بدء القياس» وابقَ (أو امشِ ببطء) 45 ثانية على الأقل والكاميرا نحو المشهد.', 'ينتهي القياس تلقائيًا حين تكتمل القراءات.'],
        needsSeg: true,
        rule: { type: 'mixed', minTicks: 15, minDistinctClasses: 2, archMinSamples: 2, hint: 'المشهد فقير: اختر مكانًا يظهر فيه نوعان مختلفان على الأقل (مثل شخص وسيارة) وأبقِ الكاميرا نحوهما.' }
      }],
      answers: [{ id: 'people', label: 'كم شخصًا ظهروا تقريبًا؟', min: 0, max: 200 }, { id: 'vehicles', label: 'كم مركبة ظهرت تقريبًا؟', min: 0, max: 100 }]
    }
  };
  const SCENE_ORDER = ['approaching_vehicle', 'parked_vehicle', 'crowd', 'stairs', 'sidewalk_end', 'wall', 'low_light', 'mixed'];

  // خطة كاملة مفرودة: trials[i].checkpoints هي كائنات جاهزة
  function plan(sceneId) {
    const s = SCENES[sceneId]; if (!s) return null;
    const trials = s.trials.map((t, i) => ({
      index: i + 1, title: t.title, prepare: t.prepare,
      checkpoints: s.makeCheckpoints(i + 1).map(c => Object.assign({ needsSeg: !!s.needsSeg && c.needsSeg !== false }, c)),
      answers: s.answers || []
    }));
    return { id: sceneId, title: s.title, icon: s.icon, minutes: s.minutes, purpose: s.purpose, place: s.place, bring: s.bring, safety: s.safety, needsSeg: s.needsSeg, trials,
      totalCheckpoints: trials.reduce((n, t) => n + t.checkpoints.length, 0) };
  }

  /* ---------- تقييم نقطة قياس ---------- */
  // ctx: { sensorsExpected:boolean, markers:[kinds…] }
  function evaluateCheckpoint(cp, events, a, b, ctx) {
    ctx = ctx || {};
    const checks = [], problems = [], guidance = []; let referenceGrade = null;
    const D = det(events, a, b), dur = Math.max(0, b - a);
    // 1) صحة حلقة الرصد
    const expected = Math.floor(dur / 1200), needTicks = Math.max(2, Math.floor(expected * 0.5));
    const healthOk = D.length >= needTicks;
    checks.push({ id: 'health', label: 'انتظام الرصد', ok: healthOk, text: 'قراءات الأجسام ' + D.length + '/' + needTicks });
    if (!healthOk) { problems.push('الرصد لم يعمل بانتظام (' + D.length + ' قراءة فقط)'); guidance.push('أغلق التطبيقات الأخرى وأبقِ الشاشة مضاءة والتطبيق في الواجهة، ولا تقفل الهاتف.'); }
    // 1b) مدة القياس الفعلية شرط إلزامي (لا يكفي ضغط «إنهاء» مبكرًا)
    const durOk = dur >= (cp.minHoldMs || 0) - 250;
    checks.push({ id: 'duration', label: 'مدة القياس', ok: durOk, text: Math.round(dur / 1000) + ' من ' + Math.round((cp.minHoldMs || 0) / 1000) + ' ث' });
    if (!durOk) { problems.push('أُنهي القياس قبل المدة المطلوبة'); guidance.push('اترك القياس يكتمل بنفسه ولا تضغط «إنهاء» قبل انتهاء المدة.'); }
    // 2) القاعدة الرئيسية
    const ev = ruleEvidence(cp.rule, events, a, b);
    checks.push({ id: 'target', label: 'القراءة المطلوبة', ok: ev.ok, text: ev.text });
    if (!ev.ok) {
      problems.push('لم تكتمل القراءة المطلوبة — ' + ev.text);
      if (cp.rule.type === 'arch' && ev.archTotal === 0) guidance.push('لم تصل أي قراءة من نموذج المكان: تأكد من تنزيله وتفعيل «الرصد التلقائي للمكان» ثم أعد.');
      if (ev.hint) guidance.push(ev.hint);
    }
    // 3) علامات المرافق المطلوبة
    for (const m of (cp.markers || [])) {
      if (!m.required) continue;
      const undone = new Set(events.filter(e => e.type === 'participant_marker_undo').map(e => e.data.ofT));
      const got = events.some(e => e.type === 'participant_marker' && e.t >= a && e.t <= b && e.data.kind === m.kind && !undone.has(e.t));
      checks.push({ id: 'marker_' + m.kind, label: m.label, ok: got, text: got ? 'سُجّلت' : 'لم تُضغط' });
      if (!got) { problems.push('لم تضغط «' + m.label.replace(/^\S+\s/, '') + '»'); guidance.push('اضغط الأزرار عند وقوع الحدث نفسه، فهي المرجع الذي نقارن به رصد التطبيق.'); }
    }
    // 4) المسافة الفعلية (إن وُجد هدف مسافة)
    if (cp.distanceM) {
      const st = events.filter(e => e.type === 'checkpoint_start' && e.t >= a - 5 && e.t <= a + 5).pop();
      const okD = !!(st && Number.isFinite(st.data.actualDistanceM) && DIST_METHODS[st.data.distanceMethod]);
      checks.push({ id: 'distance', label: 'المسافة الفعلية وطريقة قياسها', ok: okD, text: okD ? st.data.actualDistanceM + ' م — ' + DIST_METHODS[st.data.distanceMethod].label : 'غير مدخلة أو بلا طريقة قياس' });
      if (!okD) { problems.push('لم تُدخل المسافة الفعلية وطريقة قياسها'); guidance.push('اختر كيف قِست المسافة (شريط، علامات، خطوات، تقدير) قبل بدء القياس.'); }
      if (okD) referenceGrade = DIST_METHODS[st.data.distanceMethod].grade;
    }
    // 5) الحساسات (تحذير لا يمنع)
    let sensorWarn = null;
    if (ctx.sensorsExpected && dur >= 4000) {
      const n = events.filter(e => (e.type === 'orientation' || e.type === 'motion') && e.t >= a && e.t <= b).length;
      checks.push({ id: 'sensors', label: 'حساسات الميل والحركة', ok: n >= 5, blocking: false, text: n + ' قراءة' });
      if (n < 5) sensorWarn = 'لم تصل قراءات الحساسات في هذه النقطة؛ سُجّل ذلك ولن يمنع الإكمال.';
    }
    const ok = checks.filter(c => c.blocking !== false).every(c => c.ok);
    return { ok, checks, problems, guidance, sensorWarn, referenceGrade, stability: stabilityOf(events, a, b), evidence: { have: ev.have, need: ev.need } };
  }

  // تقدم حي مختصر أثناء القياس
  function liveProgress(cp, events, a, b) {
    const ev = ruleEvidence(cp.rule, events, a, b);
    return { ok: ev.ok, text: ev.text, have: ev.have, need: ev.need };
  }

  /* ---------- ملخص الجلسة ---------- */
  function summarizeSession(sceneId, events) {
    const p = plan(sceneId); if (!p) return null;
    const last = new Map(), attempts = new Map(), answers = new Map();
    for (const e of events) {
      if (e.type === 'checkpoint_end') {
        const k = e.data.trial + ':' + e.data.cp;
        last.set(k, { status: e.data.status, attempt: e.data.attempt, problems: e.data.problems || [] });
        attempts.set(k, Math.max(attempts.get(k) || 0, e.data.attempt || 1));
      } else if (e.type === 'trial_answer') answers.set(e.data.trial, e.data.answers);
    }
    const trials = p.trials.map(t => {
      const cps = t.checkpoints.map(c => { const r = last.get(t.index + ':' + c.id); return { id: c.id, label: c.label, status: r ? r.status : 'pending', attempts: attempts.get(t.index + ':' + c.id) || 0, problems: r ? r.problems : [] }; });
      const needsAnswers = t.answers.length > 0, answered = !!answers.get(t.index);
      return { index: t.index, title: t.title, checkpoints: cps, needsAnswers, answered, answers: answers.get(t.index) || null,
        valid: cps.every(c => c.status === 'ok') && (!needsAnswers || answered) };
    });
    const totalCp = p.totalCheckpoints, okCp = trials.reduce((n, t) => n + t.checkpoints.filter(c => c.status === 'ok').length, 0);
    const totalAns = trials.filter(t => t.needsAnswers).length, okAns = trials.filter(t => t.needsAnswers && t.answered).length;
    const missing = [];
    trials.forEach(t => {
      t.checkpoints.forEach(c => { if (c.status !== 'ok') missing.push({ trial: t.index, trialTitle: t.title, cp: c.id, label: c.label, status: c.status, problems: c.problems }); });
      if (t.needsAnswers && !t.answered) missing.push({ trial: t.index, trialTitle: t.title, cp: 'answers', label: 'سؤال العدّ', status: 'pending', problems: ['لم تُسجَّل إجابة العدّ'] });
    });
    const att = [];
    for (const e of events) if (e.type === 'checkpoint_end') att.push({ trial: e.data.trial, cp: e.data.cp, attempt: e.data.attempt, status: e.data.status, durationMs: e.data.durationMs || null, manualEnd: !!e.data.manual, problems: e.data.problems || [], distance: e.data.distance || null, stability: e.data.stability || null, sensorWarn: e.data.sensorWarn || null });
    const finals = new Map(); att.forEach(x => finals.set(x.trial + ':' + x.cp, x));
    const okFinals = [...finals.values()].filter(x => x.status === 'ok');
    const quality = { attempts: att, preciseReferences: okFinals.filter(x => x.distance && x.distance.grade === 'precise').length, approximateReferences: okFinals.filter(x => x.distance && x.distance.grade === 'approximate').length,
      failedAttempts: att.filter(x => x.status === 'failed').length, skipped: att.filter(x => x.status === 'skipped').length, unsureAnswers: events.filter(e => e.type === 'trial_answer').reduce((n, e) => n + Object.keys(e.data.unsure || {}).length, 0),
      facilitatorNotes: events.filter(e => e.type === 'facilitator_note').length, sensorWarnings: att.filter(x => x.sensorWarn).length };
    const total = totalCp + totalAns, good = okCp + okAns;
    return { scene: sceneId, requiredTrials: trials.length, validTrials: trials.filter(t => t.valid).length, totalCheckpoints: totalCp, validCheckpoints: okCp, totalAnswers: totalAns, validAnswers: okAns,
      completeness: total ? Math.round(good / total * 100) : 0, status: good === total ? 'complete' : (good ? 'partial' : 'empty'), trials, missing, quality };
  }

  // شبكة دلالية منخفضة الدقة (≤ n×n) بأخذ العينة من منتصف كل خلية، مع مفتاح التصنيفات الموجودة فقط
  function lowResGrid(labels, gw, gh, id2label, n) {
    n = n || 16; const total = gw * gh; if (!total || !labels || labels.length < total) return null;
    const w = Math.min(n, gw), h = Math.min(n, gh), data = [], legend = {};
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const id = labels[Math.min(gh - 1, Math.floor((y + 0.5) * gh / h)) * gw + Math.min(gw - 1, Math.floor((x + 0.5) * gw / w))];
      data.push(id); if (!(id in legend)) legend[id] = String((id2label && id2label[id]) || ('id' + id)).toLowerCase().trim();
    }
    return { w, h, data, legend };
  }

  return { PROTOCOL_VERSION, DIST_METHODS, stabilityOf, SCENES, SCENE_ORDER, COCO_MIN_SCORE, plan, evaluateCheckpoint, liveProgress, summarizeSession, ruleEvidence, topLabels, lowResGrid, lightBand, stepsFromM };
});
