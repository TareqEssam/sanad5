/* سند — «صف المكان»: مسح بصري محلي دون حفظ صور أو إرسالها.
   يبدأ بوصف المشهد أمام المستخدم من موضع ثابت. لا يطلب الدوران تلقائياً.
   المسح الاختياري للجهات يحتاج حساس اتجاه مستقرّاً ويطلب تحريك الهاتف فقط، لا المشي. */
(function () {
  'use strict';
  const P = window.SanadPlace;
  if (!P) return;

  const cfg = {
    calibrationMs: 1600,
    minYawSamples: 8,
    maxYawSpreadDeg: 18,
    sectorMs: 9000,
    adjustmentMs: 3500,
    stallMs: 12000,
    continueWaitMs: 30000,
    modelWarmupMs: 30000,
    qualityCacheMs: 650,
    orientationStaleMs: 5000,
    hazardPauseMs: 3500
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let run = null;
  let qualityCache = { at: 0, value: null };

  function circularStats(values) {
    if (!values || !values.length) return null;
    let sx = 0, sy = 0;
    for (const v of values) { const a = v * Math.PI / 180; sx += Math.cos(a); sy += Math.sin(a); }
    const r = Math.sqrt(sx * sx + sy * sy) / values.length;
    const mean = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
    const spread = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(r, 1e-9)))) * 180 / Math.PI;
    return { mean, spread, concentration: r };
  }

  async function speakWait(text, maxMs) {
    if (!text) return;
    speak(text, false);
    const t0 = Date.now();
    await sleep(250);
    while (typeof assistantSpeaking !== 'undefined' && assistantSpeaking && Date.now() - t0 < (maxMs || 10000) && run && !run.cancelled) await sleep(180);
  }

  function currentSector() {
    if (!run || !run.hasYaw || run.yaw == null || run.yaw0 == null) return run && !run.hasYaw ? { idx: 0, centered: true } : null;
    return P.sectorOf(P.relYaw(run.yaw, run.yaw0));
  }

  function onOrientation(ev) {
    if (!run) return;
    const y = P.yawOf(ev.alpha, ev.beta, ev.gamma);
    if (y == null) return;
    run.yaw = y;
    run.lastYawAt = Date.now();
    if (run.calibrating) {
      run.yawSamples.push(y);
      if (run.yawSamples.length > 40) run.yawSamples.shift();
    }
  }

  function frameQuality() {
    const now = Date.now();
    if (qualityCache.value && now - qualityCache.at < cfg.qualityCacheMs) return qualityCache.value;
    let q = null, reason = null;
    try { if (typeof probeFrameQuality === 'function') q = probeFrameQuality(videoElement); } catch (e) {}
    try {
      if (q && q.isLensCovered) reason = 'covered';
      else if (q && Number.isFinite(q.meanY) && q.meanY < 14) reason = 'dark';
    } catch (e) { /* إذا تعذر فحص الجودة لا نختلق سبب رفض */ }
    const value = { ok: !reason, reason, meanY: q && q.meanY, sharpness: q && q.sharpness };
    qualityCache = { at: now, value };
    return value;
  }

  function segmentationColumns(res) {
    const w = Number(res && res.gw), h = Number(res && res.gh), labels = res && res.labels;
    if (!w || !h || !labels || labels.length < w * h || !segMeta || !segMeta.id2label) return null;
    const names = ['left', 'center', 'right'], out = {};
    for (let c = 0; c < 3; c++) {
      const x0 = Math.floor(c * w / 3), x1 = Math.floor((c + 1) * w / 3);
      const counts = Object.create(null); let total = 0;
      for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) {
        const id = labels[y * w + x]; counts[id] = (counts[id] || 0) + 1; total++;
      }
      out[names[c]] = Object.keys(counts).map(id => ({
        label: String(segMeta.id2label[id] || ('id' + id)).toLowerCase().trim(),
        frac: total ? counts[id] / total : 0
      })).sort((a, b) => b.frac - a.frac).slice(0, 8);
    }
    return out;
  }

  /* ---- خطافات تستدعيها حلقات الرصد الموجودة في index.html ---- */
  function onCoco(preds, vw, vh) {
    if (!run || !run.collecting || run.cancelled || run.pausedUntil > Date.now()) return;
    const sec = currentSector();
    if (!sec || !sec.centered || sec.idx !== run.collectTarget) return;
    const quality = frameQuality();
    if (!quality.ok) { run.core.rejectQuality(sec.idx, quality.reason); return; }
    const sectorState = run.core.state.sectors[sec.idx];
    if (sectorState.started === 0) sectorState.started = Date.now();
    const out = [];
    for (const p of preds || []) {
      const meta = LOCAL_OBJECT_MAP[p.class]; if (!meta) continue;
      const d = estimateObjectDistance(p, vw, vh);
      out.push({ cls: p.class, ar: meta.ar, score: p.score, priority: meta.priority, pos: getRelativePositionArabic(p.bbox, vw), steps: d && Number.isFinite(d.steps) ? d.steps : null });
    }
    run.core.addCoco(sec.idx, out);
    if (typeof phonePitchBeta === 'number') run.core.addTilt(sec.idx, phonePitchBeta);
  }

  function onArch(res) {
    if (!run || !run.collecting || run.cancelled || run.pausedUntil > Date.now() || typeof segMeta === 'undefined' || !segMeta) return;
    const sec = currentSector();
    if (!sec || !sec.centered || sec.idx !== run.collectTarget) return;
    const quality = frameQuality();
    if (!quality.ok) { run.core.rejectQuality(sec.idx, quality.reason); return; }
    try {
      const labels = SanadField.topLabels(res.labels, res.gw, res.gh, segMeta.id2label, 40);
      run.core.addSeg(sec.idx, labels, segmentationColumns(res));
    } catch (e) { console.warn('place segmentation sample', e); }
  }

  function onHazard(text, urgent) {
    if (!run) return;
    if (text) {
      if (run.core) run.core.addHazard(text);
      else { run.pendingHazards = run.pendingHazards || []; if (!run.pendingHazards.includes(text)) run.pendingHazards.push(String(text).slice(0, 120)); }
    }
    run.pausedUntil = Date.now() + cfg.hazardPauseMs;
    if (urgent) run.urgent = text || 'تنبيه خطر أثناء الفحص';
  }

  async function waitForCamera(target, timeoutMs, allowWhenCancelled) {
    const end = Date.now() + (timeoutMs || 12000);
    while (Date.now() < end && (allowWhenCancelled || (run && !run.cancelled))) {
      if (facingMode === target && videoElement && videoElement.videoWidth > 0 && !videoElement.paused) return true;
      await sleep(150);
    }
    return false;
  }

  async function warmLocalModels() {
    let hasCoco = false, hasSeg = false;
    if (localScanEnabled) {
      try {
        const result = await Promise.race([
          initLocalObjectEngine(),
          sleep(cfg.modelWarmupMs).then(() => null)
        ]);
        hasCoco = !!result;
      } catch (e) { hasCoco = false; }
    }
    if (liveArchEnabled && !liveRecog.off.seg) {
      if (!segReady && typeof isSavedFlag === 'function' && isSavedFlag(LS_SEG_READY)) {
        try { await startSegWorker(); } catch (e) {}
      }
      hasSeg = !!segReady;
    }
    return { hasCoco, hasSeg };
  }

  async function collectSector(idx) {
    if (!run || run.cancelled) return false;
    run.collectTarget = idx;
    run.core.markRequested(idx);
    run.collecting = true;
    run.lastCollectionStarted = Date.now();
    const end = Date.now() + cfg.sectorMs;
    while (run && !run.cancelled && !run.urgent && Date.now() < end) {
      await sleep(250);
      if (!run || run.cancelled) break;
      if (run.hasYaw) {
        if (Date.now() - run.lastYawAt > cfg.orientationStaleMs) { run.orientationLost = true; break; }
        const sec = currentSector();
        if (!sec || !sec.centered || sec.idx !== idx) break;
      }
      const status = run.core.sectorStatus(idx);
      if (status.done && Date.now() - run.lastCollectionStarted >= 2500) break;
    }
    if (!run) return false;
    run.collecting = false;
    if (run.cancelled || run.urgent) return false;
    let status = run.core.sectorStatus(idx);
    if (!status.done && run.hasSeg) {
      const advice = run.core.advice(idx);
      if (advice) {
        await speakWait(advice + '. ابق في موضعك وثبّت الهاتف.', 6000);
        const retryEnd = Date.now() + cfg.adjustmentMs;
        run.collecting = true;
        while (Date.now() < retryEnd && run && !run.cancelled && !run.urgent) {
          await sleep(250);
          if (run.hasYaw) {
            if (Date.now() - run.lastYawAt > cfg.orientationStaleMs) { run.orientationLost = true; break; }
            const sec = currentSector(); if (!sec || !sec.centered || sec.idx !== idx) break;
          }
          status = run.core.sectorStatus(idx);
          if (status.done) break;
        }
        run.collecting = false;
      }
    }
    return !!(run && !run.cancelled && run.core.sectorStatus(idx).done);
  }

  function showPlaceControls(show, canContinue) {
    const row = document.getElementById('place-action-row');
    const next = document.getElementById('place-continue-btn');
    const stop = document.getElementById('place-stop-btn');
    if (row) row.classList.toggle('hidden', !show);
    if (next) { next.hidden = !canContinue; next.disabled = !canContinue; }
    if (stop) stop.hidden = !show;
  }

  async function start() {
    if (run) {
      speak(run.waitingForContinue ? 'اضغط زر استكمال الجهات إن كنت في موضع ثابت وآمن، أو زر إيقاف.' : 'وصف المكان قيد التنفيذ. يمكنك إيقافه من زر إيقاف.');
      return;
    }
    if (typeof videoElement === 'undefined' || !videoElement || videoElement.videoWidth === 0) {
      const m = 'الكاميرا غير جاهزة بعد. حاول بعد لحظات.'; updateStatus(m); speak(m); return;
    }
    if (typeof isProcessing !== 'undefined' && isProcessing) { speak('انتظر حتى ينتهي الإجراء الحالي ثم كرر الأمر.'); return; }

    const saved = { nav: !!navModeEnabled, facing: facingMode, torch: !!torchOn };
    run = {
      cancelled: false, finishing: false, collecting: false, calibrating: true,
      yaw0: null, yaw: null, yawSamples: [], hasYaw: false, lastYawAt: 0,
      collectTarget: 0, pausedUntil: 0, urgent: null, core: null, saved,
      t0: Date.now(), waitingForContinue: false, waitTimer: null,
      orientationLost: false, qualityWarnings: false, pendingHazards: [], cancelResolve: null
    };
    run.cancelPromise = new Promise(resolve => { run.cancelResolve = resolve; });
    run.handler = ev => onOrientation(ev);
    window.addEventListener('deviceorientation', run.handler, { passive: true });
    showPlaceControls(true, false);

    try {
      // التحويل إلى الكاميرا الخلفية عند الحاجة، دون تغيير وضع المستخدم أو حفظ إعداد جديد.
      if (facingMode !== 'environment') {
        updateStatus('أحوّل إلى الكاميرا الخلفية لوصف المكان…');
        await switchCameraFacing('environment', true);
        if (!await waitForCamera('environment', 12000)) throw new Error('تعذر تشغيل الكاميرا الخلفية.');
      }
      if (!navModeEnabled) setNavMode(true, false);
      if (typeof startLiveMonitoring === 'function') startLiveMonitoring();

      updateStatus('قف في موضع ثابت وآمن. سأصف ما أمامك أولاً، ولن أطلب منك المشي أو الدوران.');
      await speakWait('قف في موضع ثابت وآمن. لا تمش ولا تقترب من أي شيء. سأصف ما أمامك أولاً. بعد ذلك يمكنك اختيار استكمال الجهات بتحريك الهاتف فقط، إذا كان ذلك آمناً ومريحاً لك.', 10000);
      await sleep(cfg.calibrationMs);
      if (!run || run.cancelled) return finish(true);

      const yawStats = circularStats(run.yawSamples);
      run.calibrating = false;
      if (yawStats && run.yawSamples.length >= cfg.minYawSamples && yawStats.spread <= cfg.maxYawSpreadDeg) {
        run.yaw0 = yawStats.mean;
        run.yaw = run.yaw == null ? yawStats.mean : run.yaw;
        run.hasYaw = true;
      } else {
        run.yaw0 = null; run.hasYaw = false;
      }

      updateStatus('جارٍ تجهيز محركات الرؤية المحلية…');
      const models = await Promise.race([warmLocalModels(), run.cancelPromise.then(() => null)]);
      if (!run || run.cancelled || !models) return finish(true);
      if (run.urgent) return finish(false);
      if (!models.hasCoco && !models.hasSeg) {
        throw new Error('لا يوجد محرك رؤية جاهز. فعّل الرصد المحلي أو جهّز نموذج المكان من الإعدادات، ثم أعد المحاولة.');
      }
      run.core = P.create({ hasCoco: models.hasCoco, hasSeg: models.hasSeg, hasYaw: run.hasYaw });
      (run.pendingHazards || []).forEach(h => run.core.addHazard(h));
      run.hasCoco = models.hasCoco; run.hasSeg = models.hasSeg;
      if (!models.hasSeg) await speakWait('تنبيه: نموذج تقسيم المكان غير جاهز؛ سأكتفي بالأجسام التي يستطيع الكاشف المحلي تمييزها.', 7000);
      if (!models.hasCoco) await speakWait('تنبيه: كاشف الأجسام غير متاح؛ سأعتمد على نموذج تقسيم المكان فقط.', 7000);

      updateStatus('أصف المشهد أمامك. ابق ثابتاً…');
      const frontOk = await collectSector(0);
      if (!run || run.cancelled) return finish(true);
      if (run.urgent) return finish(false);
      if (!frontOk) {
        const partial = P.narrate(run.core.summary());
        await finish(false, false, partial + ' لم أتمكن من استكمال وصف الجهة الأمامية بثقة كافية.');
        return;
      }

      const frontText = P.narrate(run.core.summary());
      if (!run.hasYaw) {
        await finish(false, false, frontText + ' حساس الاتجاه غير متاح أو غير مستقر؛ لذلك لم أطلب منك مسح الجهات الأخرى. يمكنك توجيه الهاتف لجهة أخرى من موضع آمن وطلب الوصف مرة أخرى.');
        return;
      }

      run.waitingForContinue = true;
      showPlaceControls(true, true);
      updateStatus(frontText + ' يمكنك استكمال الجهات اختيارياً بالضغط على زر «استكمال الجهات» أولاً.');
      await speakWait(frontText + ' إذا كان المكان آمناً وأنت ثابت في موضعك، اضغط زر استكمال الجهات أولاً، ثم حرّك الهاتف ببطء ناحية اليمين دون المشي أو تحريك قدميك. إن لم يكن ذلك آمناً، اترك الفحص هنا.', 60000);
      if (!run || run.cancelled || !run.waitingForContinue) return;
      // المهلة تبدأ بعد انتهاء الكلام، ولا يُعاد نطق الوصف الأمامي عند انتهائها.
      run.waitTimer = setTimeout(() => {
        if (run && run.waitingForContinue) finish(false, false, 'انتهت مهلة استكمال الجهات. الوصف الأمامي كما سبق. قل صف المكان لبدء فحص جديد.');
      }, cfg.continueWaitMs);
    } catch (e) {
      console.warn('placescan', e);
      await finish(false, true);
    }
  }

  async function continueScan() {
    if (!run || !run.waitingForContinue || run.cancelled || run.finishing) return false;
    if (run.waitTimer) { clearTimeout(run.waitTimer); run.waitTimer = null; }
    run.waitingForContinue = false;
    showPlaceControls(true, false);
    if (!run.hasYaw || Date.now() - run.lastYawAt > cfg.orientationStaleMs) {
      await finish(false, false, 'فقدت قراءة حساس الاتجاه. لن أخمّن الجهات. أعد «صف المكان» إذا كنت ثابتاً وآمناً.');
      return false;
    }
    const atStart = currentSector();
    if (!atStart || !atStart.centered || atStart.idx !== 0) {
      await finish(false, false, 'تغير اتجاه الهاتف قبل استكمال المسح. لن أصف الجهات على أساس اتجاه غير مؤكد. أعد الفحص من الاتجاه الذي تريد اعتباره أمامك.');
      return false;
    }
    try {
      for (let target = 1; target <= 3 && run && !run.cancelled && !run.urgent; target++) {
        const prompt = target === 1
          ? 'وأنت ثابت في موضعك، حرّك الهاتف ببطء ناحية يمينك ربع دورة. لا تمش ولا تحرك قدميك. توقف عندما أقول ثبت.'
          : 'استمر في تحريك الهاتف فقط، في الاتجاه نفسه، ربع دورة أخرى. ابق ثابتاً ولا تمش.';
        await speakWait(prompt, 9000);
        let reached = false;
        const reachEnd = Date.now() + cfg.stallMs;
        while (run && !run.cancelled && !run.urgent && Date.now() < reachEnd) {
          if (Date.now() - run.lastYawAt > cfg.orientationStaleMs) { run.orientationLost = true; break; }
          const sec = currentSector();
          if (sec && sec.centered && sec.idx === target) { reached = true; break; }
          await sleep(200);
        }
        if (!run || run.cancelled || run.urgent) break;
        if (!reached) {
          await speakWait('لم أستطع التحقق من وصول الهاتف إلى الجهة التالية. سأوقف المسح دون تخمين.', 5000);
          break;
        }
        const ok = await collectSector(target);
        if (!run || run.cancelled || run.urgent) break;
        if (!ok) {
          await speakWait('لم أحصل على قراءات كافية لهذه الجهة. سأوقف المسح بدلاً من تخمين بقية المكان.', 5000);
          break;
        }
      }
      await finish(false);
    } catch (e) {
      console.warn('placescan continue', e);
      await finish(false, true);
    }
    return true;
  }

  async function restoreSettings(r) {
    // استعادة الكاميرا أولاً حتى لا تُترك معاينة سوداء عند الرجوع من المرآة.
    try {
      if (r.saved && r.saved.facing && facingMode !== r.saved.facing) {
        await switchCameraFacing(r.saved.facing, true);
        await waitForCamera(r.saved.facing, 10000, true);
      }
    } catch (e) { console.warn('place camera restore', e); }
    try { if (r.saved && navModeEnabled !== r.saved.nav) setNavMode(r.saved.nav, false); } catch (e) {}
    if (r.saved && r.saved.torch && facingMode === 'environment' && videoStream && !torchOn) {
      try { await applyTorch(true, true, false); } catch (e) {}
    }
  }

  async function finish(cancelled, failed, overrideText) {
    if (!run || run.finishing) return;
    const r = run; r.finishing = true; r.collecting = false; r.waitingForContinue = false;
    if (r.waitTimer) { clearTimeout(r.waitTimer); r.waitTimer = null; }
    window.removeEventListener('deviceorientation', r.handler);
    showPlaceControls(false, false);
    await restoreSettings(r);
    run = null;

    if (r.urgent) {
      const m = 'أوقفت وصف المكان بسبب تنبيه خطر. تعامل مع الخطر أولاً، ولا تتحرك اعتماداً على الوصف البصري.';
      updateStatus(m); speak(m, false, 1); lastDescription = m; return;
    }
    if (cancelled || r.cancelled) { updateStatus('تم إيقاف وصف المكان.'); return; }
    if (failed || !r.core) {
      const m = 'تعذر إكمال وصف المكان. ' + (failed && failed.message ? failed.message : 'استعمل العصا وحاول مرة أخرى.');
      updateStatus(m); speak(m); return;
    }
    const sum = r.core.summary();
    const text = overrideText || P.narrate(sum);
    lastDescription = text; updateStatus(text); speak(text, true, 1);
    if (typeof fieldRecording !== 'undefined' && fieldRecording && typeof fieldPush === 'function') {
      fieldPush('placescan', {
        covered: sum.covered, scanned: sum.scanned, kind: sum.kind.kind,
        kindConf: Math.round(sum.kind.conf * 100) / 100,
        hazards: sum.hazards.length, hasSeg: sum.hasSeg, hasCoco: sum.hasCoco, hasYaw: sum.hasYaw,
        orientationLost: !!r.orientationLost, yawSamples: r.yawSamples.length,
        yawSpread: circularStats(r.yawSamples)?.spread ?? null,
        qualityRejected: sum.qualityRejected, durationMs: Date.now() - r.t0,
        sectors: sum.sectors.map(s => ({ name: s.name, requested: s.requested, frames: s.frames, segN: s.segN, reliable: s.reliable, qualityRejected: s.qualityRejected, objects: s.objects.map(o => o.cls), landmarks: s.landmarks }))
      });
    }
    window.__lastPlaceSummary = sum;
  }

  window.PlaceScan = {
    start,
    continueScan,
    onCoco,
    onArch,
    onHazard,
    cfg,
    cancel() {
      if (!run) return;
      run.cancelled = true;
      if (typeof run.cancelResolve === 'function') run.cancelResolve();
      if (run.waitTimer) { clearTimeout(run.waitTimer); run.waitTimer = null; }
      if (run.waitingForContinue) finish(true);
    },
    get running() { return !!run; },
    get waitingForContinue() { return !!(run && run.waitingForContinue); }
  };
})();
