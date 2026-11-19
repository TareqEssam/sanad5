/* سند — «صف المكان»: المتحكم (يربط place_core.js بالتطبيق). بلا صور ولا شبكة.
   يعتمد على حلقات الرصد الحية الموجودة (COCO + SegFormer) ولا يوقفها، فتستمر تنبيهات الخطر أثناء الفحص. */
(function () {
  'use strict';
  const P = window.SanadPlace;
  if (!P) return;
  const cfg = { prefaceMs: 7000, sectorMs: 9000, stallMs: 12000, maxStalls: 2, totalMs: 120000, hazardPauseMs: 3500 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let run = null;

  async function speakWait(text, maxMs) {
    speak(text, false);
    const t0 = Date.now();
    await sleep(400);
    while (typeof assistantSpeaking !== 'undefined' && assistantSpeaking && Date.now() - t0 < (maxMs || 12000) && run && !run.cancelled) await sleep(200);
  }

  function currentSector() {
    if (!run || !run.hasYaw || run.yaw == null) return run && !run.hasYaw ? { idx: run.manualIdx, centered: true } : null;
    return P.sectorOf(P.relYaw(run.yaw, run.yaw0));
  }

  function onOrientation(ev) {
    if (!run) return;
    const y = P.yawOf(ev.alpha, ev.beta, ev.gamma);
    if (y == null) return;
    if (run.yaw0 == null && run.calibrating) run.yaw0 = y;
    run.yaw = y; run.hasYaw = true; run.lastYawAt = Date.now();
  }

  /* ---- خطافات تُستدعى من index.html ---- */
  function onCoco(preds, vw, vh) {
    if (!run || !run.collecting || run.pausedUntil > Date.now()) return;
    const sec = currentSector(); if (!sec || !sec.centered) return;
    if (run.core.state.sectors[sec.idx].started === 0) run.core.state.sectors[sec.idx].started = Date.now();
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
    if (!run || !run.collecting || run.pausedUntil > Date.now() || typeof segMeta === 'undefined' || !segMeta) return;
    const sec = currentSector(); if (!sec || !sec.centered) return;
    try { run.core.addSeg(sec.idx, SanadField.topLabels(res.labels, res.gw, res.gh, segMeta.id2label, 40)); } catch (e) {}
  }
  function onHazard(text, urgent) {
    if (!run) return;
    run.core.addHazard(text);
    run.pausedUntil = Date.now() + cfg.hazardPauseMs;
    if (urgent) run.urgent = text;
  }

  async function start() {
    if (run) { speak('الوصف قيد التنفيذ. قل «توقف» لإلغائه.'); return; }
    if (typeof videoElement === 'undefined' || !videoElement || videoElement.videoWidth === 0) { const m = 'الكاميرا غير جاهزة بعد. حاول بعد لحظات.'; updateStatus(m); speak(m); return; }
    if (typeof isProcessing !== 'undefined' && isProcessing) { speak('انتظر حتى ينتهي الإجراء الحالي ثم كرر الأمر.'); return; }
    const saved = { nav: navModeEnabled, mode: lifeMode };
    run = { cancelled: false, collecting: false, calibrating: true, yaw0: null, yaw: null, hasYaw: false, manualIdx: 0, pausedUntil: 0, urgent: null, core: null, saved, t0: Date.now() };
    const handler = ev => onOrientation(ev);
    window.addEventListener('deviceorientation', handler);
    run.handler = handler;
    try {
      if (!navModeEnabled) setNavMode(true, false);
      if (lifeMode !== 'walk' && typeof setLifeMode === 'function') { try { setLifeMode('walk', true); } catch (e) {} }
      if (typeof startLiveMonitoring === 'function') startLiveMonitoring();
      updateStatus('صف المكان: قف ثابتاً…');
      await speakWait('قف ثابتاً الآن ولا تتحرك حتى أنتهي، نحو دقيقة. سأنبهك فوراً إن ظهر خطر. أمسك الهاتف أمامك مستقيماً.', 12000);
      if (!run.cancelled) await sleep(cfg.prefaceMs > 3000 ? 1500 : 0);
      if (run.cancelled) return finish(true);
      run.hasYaw = run.yaw != null;
      run.yaw0 = run.yaw;
      run.calibrating = false;
      const segOk = typeof segReady !== 'undefined' && (segReady || (typeof segPipeline !== 'undefined' && !!segPipeline));
      run.core = P.create({ hasSeg: !!segOk && liveArchEnabled, hasYaw: run.hasYaw });
      run.hasSeg = !!segOk && liveArchEnabled;
      run.collecting = true;
      if (!run.hasSeg) await speakWait('تنبيه: نموذج تمييز الأماكن غير جاهز، سأصف الأجسام فقط.', 8000);

      const covered = new Set();
      let target = 0, stalls = 0, retried = {};
      const loopEnd = Date.now() + cfg.totalMs;
      while (!run.cancelled && covered.size < 4 && Date.now() < loopEnd) {
        if (run.urgent) break;
        const stepStart = Date.now();
        if (target > 0) {
          if (run.hasYaw) await speakWait(target === 1 ? 'استدر ببطء إلى يمينك ربع دورة، ثم ثبّت.' : (target === 2 ? 'استمر في الاستدارة ربع دورة أخرى ثم ثبّت.' : 'استمر في الاستدارة ربع دورة أخرى إلى يسارك ثم ثبّت.'), 9000);
          else { run.manualIdx = target; await speakWait('استدر ربع دورة إلى يمينك ثم ثبّت، سأنتظر قليلاً.', 9000); await sleep(2500); }
        }
        // انتظر وصول الدوران للجهة المطلوبة (مع مهلة)
        let reached = target === 0 || !run.hasYaw;
        const reachEnd = Date.now() + cfg.stallMs;
        while (!reached && !run.cancelled && Date.now() < reachEnd) {
          const s = currentSector(); if (s && s.centered && s.idx === target) reached = true; else await sleep(250);
        }
        if (run.cancelled || run.urgent) break;
        if (!reached) {
          stalls++;
          if (stalls <= cfg.maxStalls) { await speakWait('لم أشعر بالدوران بعد؛ استدر ببطء ربع دورة.', 6000); continue; }
          stalls = 0; target++; if (target > 3) break; continue;    // تخطَّ الجهة ونعلن ذلك في الوصف
        }
        stalls = 0;
        if (!run.hasYaw) run.manualIdx = target;
        // جمع العينات في هذه الجهة
        const collectEnd = Date.now() + cfg.sectorMs;
        while (!run.cancelled && !run.urgent && Date.now() < collectEnd) {
          await sleep(300);
          const st = run.core.sectorStatus(target);
          if (st.done && Date.now() - stepStart > 3500) break;
          if (run.hasYaw) { const s = currentSector(); if (s && s.idx === target && !s.centered) break; }
        }
        if (run.cancelled || run.urgent) break;
        // تعليمات تكيفية إن لم تتضح الصورة
        const adv = run.core.advice(target);
        if (adv && !retried[target]) {
          retried[target] = 1;
          await speakWait(adv + ' وثبّت لحظة.', 7000);
          const e2 = Date.now() + 4500; while (!run.cancelled && !run.urgent && Date.now() < e2) await sleep(300);
        }
        if (run.core.sectorStatus(target).done || retried[target]) covered.add(target);
        target++; if (target > 3) break;
      }
      await finish(false);
    } catch (e) {
      console.warn('placescan', e);
      try { await finish(false, true); } catch (e2) {}
    }
  }

  async function finish(cancelled, failed) {
    if (!run) return;
    const r = run; run.collecting = false;
    window.removeEventListener('deviceorientation', r.handler);
    // استرجاع الإعدادات
    try { if (r.saved && navModeEnabled !== r.saved.nav) setNavMode(r.saved.nav, false); } catch (e) {}
    run = null;
    if (r.urgent) {
      const m = 'أوقفت الوصف بسبب خطر قريب. تعامل معه أولاً، ثم قل «صف المكان» لأبدأ من جديد.';
      updateStatus(m); speak(m, false, 1); lastDescription = m; return;
    }
    if (cancelled || r.cancelled) { updateStatus('تم إلغاء وصف المكان.'); return; }
    if (failed || !r.core) { const m = 'تعذر إكمال وصف المكان. استعمل العصا وحاول مرة أخرى.'; updateStatus(m); speak(m); return; }
    const sum = r.core.summary(); const text = P.narrate(sum);
    lastDescription = text; updateStatus(text); speak(text, true, 1);
    if (typeof fieldRecording !== 'undefined' && fieldRecording && typeof fieldPush === 'function') {
      fieldPush('placescan', { covered: sum.covered, kind: sum.kind.kind, kindConf: Math.round(sum.kind.conf * 100) / 100, hazards: sum.hazards.length, hasSeg: sum.hasSeg, hasYaw: sum.hasYaw, durationMs: Date.now() - r.t0,
        sectors: sum.sectors.map(s => ({ name: s.name, frames: s.frames, segN: s.segN, reliable: s.reliable, objects: s.objects.map(o => o.cls) })) });
    }
    window.__lastPlaceSummary = sum;
  }

  window.PlaceScan = {
    start, onCoco, onArch, onHazard, cfg,
    cancel() { if (run) { run.cancelled = true; } },
    get running() { return !!run; }
  };
})();
