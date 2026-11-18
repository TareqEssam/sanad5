/* سند — واجهة الاختبار الميداني الموجَّه للمرافق المبصر.
   تعتمد على: field_core.js (بروتوكول المشاهد والتحقق) وعلى متغيرات index.html العامة
   (fieldRecording, fieldPush, objectModel, liveRecog, ...). لا صور ولا فيديو ولا صوت ولا رفع شبكي. */
'use strict';
(function () {
  const FC = window.SanadField;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const now = () => fieldClockNow();
  const vib = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };
  const fw = { el: null, plan: null, stage: 'idle', trial: 1, cp: 0, attempt: 1, redo: false, visited: new Set(), shownTrial: 0, run: null,
    runTimer: null, preTimer: null, sampler: null, lagTimer: null, lag: { max: 0, last: 0 }, longTasks: { n: 0, ms: 0 }, battery: null,
    actual: null, lastResult: null, skipSensors: false, lastGuidance: [], answersDraft: {}, savedOnce: false, exportedOnce: false };

  /* ====================== التخزين المحلي ====================== */
  // يفتح القاعدة بإصدارها الحالي أيًّا كان (قد تكون رُقّيت إلى 2 بنسخة أخرى) ولا يفقد التسجيلات؛ ويضيف المخزن إن لم يوجد.
  function dbOpen() { return new Promise((res, rej) => { const r = indexedDB.open(FIELD_DB_NAME); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('sessions')) r.result.createObjectStore('sessions', { keyPath: 'id' }); };
    r.onsuccess = () => { const db = r.result; if (db.objectStoreNames.contains('sessions')) return res(db); const v = db.version; db.close(); const r2 = indexedDB.open(FIELD_DB_NAME, v + 1); r2.onupgradeneeded = () => r2.result.createObjectStore('sessions', { keyPath: 'id' }); r2.onsuccess = () => res(r2.result); r2.onerror = () => rej(r2.error); }; r.onerror = () => rej(r.error); }); }
  async function dbAll() { const db = await dbOpen(); const all = await new Promise((res, rej) => { const q = db.transaction('sessions', 'readonly').objectStore('sessions').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); db.close(); return all; }
  async function dbPut(obj) { const db = await dbOpen(); await new Promise((res, rej) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(obj); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); }
  function download(data, name) { const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
  async function shareOrDownload(data, name) {
    const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'قراءات اختبار سند', text: 'ملف قراءات اختبار سند' }); return 'shared'; } }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    download(data, name); return 'downloaded';
  }

  /* ====================== بيانات الهاتف ====================== */
  async function collectProfile() {
    const n = navigator, o = {};
    const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d === undefined ? null : d; } };
    o.userAgent = n.userAgent; o.platform = n.platform || null; o.vendor = n.vendor || null;
    o.language = n.language || null;
    o.cores = n.hardwareConcurrency || null; o.deviceMemoryGB = n.deviceMemory || null; o.maxTouchPoints = n.maxTouchPoints || 0;
    o.onLine = n.onLine; o.secureContext = window.isSecureContext; o.protocol = location.protocol;
    o.displayMode = await safe(() => matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser');
    const uad = n.userAgentData;
    if (uad) { o.uaData = { brands: uad.brands, mobile: uad.mobile, platform: uad.platform };
      o.uaData.high = await safe(() => uad.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList', 'uaFullVersion'])); }
    o.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1, orientation: (screen.orientation && screen.orientation.type) || null, innerWidth: innerWidth, innerHeight: innerHeight,
      visualViewportScale: window.visualViewport ? window.visualViewport.scale : null, refreshHint: null };
    o.gpu = await safe(() => { const c = document.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl'); if (!gl) return { webgl: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl: true, version: gl.getParameter(gl.VERSION), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) }; });
    o.battery = await safe(async () => { if (!n.getBattery) return null; const b = fw.battery || await n.getBattery(); fw.battery = b; return { level: b.level, charging: b.charging, chargingTimeS: b.chargingTime, dischargingTimeS: b.dischargingTime }; });
    o.connection = n.connection ? { effectiveType: n.connection.effectiveType, saveData: n.connection.saveData } : null;
    o.storage = await safe(async () => { const e = n.storage && n.storage.estimate ? await n.storage.estimate() : null; return { persisted: n.storage && n.storage.persisted ? await n.storage.persisted() : null, usageMB: e ? Math.round(e.usage / 1048576) : null }; });
    o.sensorsApi = { deviceOrientation: 'DeviceOrientationEvent' in window, deviceMotion: 'DeviceMotionEvent' in window, motionNeedsPermission: typeof (window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) === 'function', accelerometer: 'Accelerometer' in window, gyroscope: 'Gyroscope' in window, wakeLock: 'wakeLock' in n, vibrate: 'vibrate' in n };
    o.speech = await safe(() => { if (!('speechSynthesis' in window)) return { available: false }; const v = speechSynthesis.getVoices() || []; return { available: true, voices: v.length, arabic: v.filter(x => /^ar/i.test(x.lang)).slice(0, 5).map(x => ({ name: x.name, lang: x.lang, local: x.localService })) }; });
    o.cameraPermission = await safe(async () => (await n.permissions.query({ name: 'camera' })).state);
    o.videoInputCount = await safe(async () => (await n.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length);
    o.jsHeap = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null;
    return o;
  }
  function cameraInfo() {
    const t = videoStream && videoStream.getVideoTracks && videoStream.getVideoTracks()[0]; if (!t) return null;
    let s = {}, c = {}; try { s = t.getSettings() || {}; } catch (e) {} try { c = t.getCapabilities ? t.getCapabilities() : {}; } catch (e) {}
    const rng = r => r && typeof r === 'object' ? { min: r.min, max: r.max } : (r === undefined ? null : r);
    return { label: t.label || null, readyState: t.readyState, settings: { width: s.width, height: s.height, frameRate: s.frameRate, facingMode: s.facingMode, zoom: s.zoom, focusMode: s.focusMode, aspectRatio: s.aspectRatio },
      capabilities: { width: rng(c.width), height: rng(c.height), frameRate: rng(c.frameRate), zoom: rng(c.zoom), torch: c.torch === true, focusMode: c.focusMode || null },
      video: { videoWidth: videoElement.videoWidth, videoHeight: videoElement.videoHeight } };
  }
  function appConfig() {
    const g = f => { try { return f(); } catch (e) { return undefined; } };
    let sonar = null; try { sonar = typeof sonarCalibrated !== 'undefined' ? !!sonarCalibrated : null; } catch (e) {}
    return { appVersion: 'V20.12', protocol: FC.PROTOCOL_VERSION, swControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      lifeMode: g(() => lifeMode), localScanEnabled: g(() => localScanEnabled), navModeEnabled: g(() => navModeEnabled), liveHazardEnabled: g(() => liveHazardEnabled), liveItemsEnabled: g(() => liveItemsEnabled), liveArchEnabled: g(() => liveArchEnabled),
      spatialAudioEnabled: g(() => spatialAudioEnabled), autoTorchEnabled: g(() => autoTorchEnabled), torchSupported: g(() => torchSupported), facingMode: g(() => facingMode),
      models: { coco: 'coco-ssd lite_mobilenet_v2', cocoLoaded: !!objectModel, segReady: !!g(() => segReady), embedReady: !!g(() => embedReady) },
      thresholds: { appScore: 0.56, recordFloor: FIELD_COCO_FLOOR, maxBoxes: COCO_MAX_BOXES, liveLoopMs: 1200 }, sonarCalibrated: sonar,
      hazardPoolSize: g(() => hazardPool.length) === undefined ? null : g(() => hazardPool.length), personalItemsCount: g(() => personalItems ? personalItems.length : null) };
  }

  /* ====================== مجمّع أنظمة دوري ====================== */
  function startSampler() {
    stopSampler();
    try { if (window.PerformanceObserver) { const po = new PerformanceObserver(l => { for (const e of l.getEntries()) { fw.longTasks.n++; fw.longTasks.ms += e.duration; } }); po.observe({ entryTypes: ['longtask'] }); fw.po = po; } } catch (e) {}
    let last = performance.now(); fw.lagTimer = setInterval(() => { const t = performance.now(), lag = t - last - 250; last = t; if (lag > fw.lag.max) fw.lag.max = lag; }, 250);
    fw.sampler = setInterval(() => {
      if (!fieldRecording) return;
      const v = videoElement, q = (v && v.getVideoPlaybackQuality) ? v.getVideoPlaybackQuality() : null, b = fw.battery;
      fieldPush('system', { battery: b ? { level: b.level, charging: b.charging } : null, jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, online: navigator.onLine, hidden: document.hidden,
        trackState: (videoStream && videoStream.getVideoTracks()[0] || {}).readyState || null, torchOn: !!torchOn, wakeLock: !!(wakeLock && !wakeLock.released), speaking: !!assistantSpeaking, detectEmaMs: Math.round(cocoEmaDetectMs * 10) / 10, cocoSamples: cocoDetectSamples,
        video: v ? { readyState: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight, dropped: q ? q.droppedVideoFrames : null, total: q ? q.totalVideoFrames : null } : null,
        loopLagMaxMs: Math.round(fw.lag.max), longTasks: fw.longTasks.n, longTaskMs: Math.round(fw.longTasks.ms), segEmaMs: Math.round(liveRecog.ema.seg), embedEmaMs: Math.round(liveRecog.ema.embed), segOff: !!liveRecog.off.seg });
      fw.lag.max = 0; fw.longTasks = { n: 0, ms: 0 };
    }, 5000);
  }
  function stopSampler() { if (fw.sampler) clearInterval(fw.sampler); if (fw.lagTimer) clearInterval(fw.lagTimer); if (fw.po) { try { fw.po.disconnect(); } catch (e) {} } fw.sampler = fw.lagTimer = fw.po = null; }

  /* ====================== حفظ الجلسة ====================== */
  function stampSession(final) {
    const s = fieldRecording; if (!s) return null;
    const snap = JSON.parse(JSON.stringify(s)); snap.updatedAt = new Date().toISOString();
    snap.summary = FC.summarizeSession(s.scene, s.events); snap.completionStatus = final ? (snap.summary.status) : 'in_progress';
    const c = {}; s.events.forEach(e => { c[e.type] = (c[e.type] || 0) + 1; }); snap.eventCounts = c;
    if (final) { snap.completed = true; snap.endedAt = new Date().toISOString(); snap.durationMs = Math.round(now() - fieldStartedAt); }
    return snap;
  }
  async function saveSession(final) { const snap = stampSession(final); if (snap) await dbPut(snap); return snap; }
  window.fieldFlushNow = function () { try { const snap = stampSession(false); if (snap) { dbOpen().then(db => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(snap); tx.oncomplete = () => db.close(); }); } } catch (e) {} };

  /* ====================== شاشة الإعدادات ====================== */
  window.fieldSceneChanged = function () {
    const sel = $('field-scene-select'), box = $('field-scene-instructions'); if (!sel || !box || !FC) return;
    const p = FC.plan(sel.value);
    box.innerHTML = '<strong style="color:#99f6e4">' + p.icon + ' ' + esc(p.title) + '</strong>' +
      '<p><b>الهدف:</b> ' + esc(p.purpose) + '</p><p><b>المكان:</b> ' + esc(p.place) + '</p><p><b>تحتاج:</b> ' + esc(p.bring) + '</p>' +
      '<p><b>المطلوب منك:</b> ' + p.trials.length + ' محاولات/تكرارات، وفي المجموع ' + p.totalCheckpoints + ' نقطة قياس، ≈ ' + p.minutes + ' دقائق.</p>' +
      '<p style="color:#fde68a"><b>السلامة:</b> ' + p.safety.map(esc).join(' ') + '</p>' +
      '<p style="color:#99f6e4">سيرشدك التطبيق خطوة بخطوة، ويتحقق بنفسه من اكتمال كل قراءة ويطلب إعادتها عند النقص. لا تحتاج إلى سؤال أحد.</p>';
  };
  window.fieldRefreshProgress = async function () {
    const list = $('field-progress-list'), code = String(($('field-participant-code') || {}).value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    if (!list) return; if (!code) { list.innerHTML = '<span style="color:#94a3b8">اكتب رمز المشارك لتظهر المشاهد المكتملة.</span>'; return; }
    let rows = []; try { rows = (await dbAll()).filter(s => s.participantCode === code); } catch (e) {}
    let doneN = 0, nextScene = null;
    const html = FC.SCENE_ORDER.map(id => {
      const p = FC.plan(id), mine = rows.filter(s => s.scene === id && s.summary && s.summary.validCheckpoints > 0);
      const best = mine.sort((a, b) => (b.summary.completeness - a.summary.completeness) || (b.summary.validCheckpoints - a.summary.validCheckpoints))[0];
      let mark = '⚪ لم يبدأ', col = '#94a3b8';
      if (best && best.summary.status === 'complete') { mark = '✅ مكتمل'; col = '#86efac'; doneN++; }
      else if (best) { mark = '🟠 ناقص ' + best.summary.completeness + '%'; col = '#fdba74'; if (!nextScene) nextScene = id; }
      else if (!nextScene) nextScene = id;
      return '<div style="display:flex;justify-content:space-between;gap:8px"><span>' + p.icon + ' ' + esc(p.title) + '</span><span style="color:' + col + '">' + mark + '</span></div>';
    }).join('');
    list.innerHTML = '<div style="font-weight:700;margin-bottom:4px">تقدمك: ' + doneN + ' من 8 مشاهد</div>' + html + (nextScene && doneN < 8 ? '<div style="margin-top:6px;color:#99f6e4">المشهد التالي المقترح: ' + esc(FC.SCENES[nextScene].title) + '</div>' : (doneN === 8 ? '<div style="margin-top:6px;color:#86efac">اكتملت المشاهد الثمانية. شكرًا لك! صدّر الملفات وأرسلها لفريق التطوير.</div>' : ''));
    if (nextScene && $('field-scene-select') && !$('field-scene-select').dataset.userPicked) { $('field-scene-select').value = nextScene; window.fieldSceneChanged(); }
  };
  document.addEventListener('DOMContentLoaded', () => { window.fieldSceneChanged && window.fieldSceneChanged(); window.fieldRefreshProgress && window.fieldRefreshProgress(); const s = $('field-scene-select'); if (s) s.addEventListener('change', () => { s.dataset.userPicked = '1'; }); });
  if (document.readyState !== 'loading') { setTimeout(() => { window.fieldSceneChanged(); window.fieldRefreshProgress(); const s = $('field-scene-select'); if (s) s.addEventListener('change', () => { s.dataset.userPicked = '1'; }); }, 0); }

  window.exportSavedFieldSessions = async function (share) {
    const st = $('field-recorder-settings-status');
    try { const all = await dbAll(); if (!all.length) { st.textContent = 'لا توجد جلسات محفوظة على هذا الهاتف بعد.'; return; }
      const out = { schema: 'sanad-field-export-v2', exportedAt: new Date().toISOString(), sessions: all };
      if (share) { const r = await shareOrDownload(out, 'sanad-field-sessions.json'); st.textContent = r === 'shared' ? 'تمت المشاركة.' : (r === 'cancelled' ? 'أُلغيت المشاركة.' : 'تعذرت المشاركة المباشرة فنُزِّل الملف (' + all.length + ' جلسة).'); }
      else { download(out, 'sanad-field-sessions.json'); st.textContent = 'تم تجهيز ملف يحتوي على ' + all.length + ' جلسة.'; } }
    catch (e) { st.textContent = 'تعذر قراءة التسجيلات المحلية: ' + (e.message || e); }
  };

  /* ====================== بدء الجلسة ====================== */
  window.startFieldRecording = async function () {
    const st = $('field-recorder-settings-status'), say = m => { st.textContent = m; };
    if (fieldRecording) { fwRender(); return; }
    if (!FC) { say('ملف field_core.js لم يُحمَّل؛ أعد فتح التطبيق بالإنترنت مرة واحدة.'); return; }
    const participant = String($('field-participant-code').value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    if (!participant) { say('اكتب رمز مشارك غير شخصي أولًا، مثل P03 (أحرف إنجليزية وأرقام فقط).'); $('field-participant-code').focus(); return; }
    if (!$('field-consent-check').checked) { say('أكّد مربع الخصوصية والسلامة أولًا.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('تشغيل الكاميرا يحتاج HTTPS أو localhost.'); return; }
    const scene = $('field-scene-select').value, plan = FC.plan(scene);
    // أذونات الحساسات داخل لمسة المستخدم (iOS) — تُطلب كلها دون انتظار متسلسل
    const reqs = []; fieldMotionPermission = 'not-required';
    try { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') { fieldMotionPermission = 'asked'; reqs.push(DeviceMotionEvent.requestPermission().then(r => { fieldMotionPermission = r; })); }
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') reqs.push(DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') attachOrientationListener(); })); } catch (e) { fieldMotionPermission = 'unavailable'; }
    if (reqs.length) await Promise.allSettled(reqs);
    if (!fieldMotionAttached && window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', ev => { if (!fieldRecording || now() - fieldLastMotionAt < 100) return; fieldLastMotionAt = now(); const a = ev.accelerationIncludingGravity || {}, r = ev.rotationRate || {};
        fieldPush('motion', { x: Number.isFinite(a.x) ? a.x : null, y: Number.isFinite(a.y) ? a.y : null, z: Number.isFinite(a.z) ? a.z : null, rx: Number.isFinite(r.alpha) ? r.alpha : null, ry: Number.isFinite(r.beta) ? r.beta : null, rz: Number.isFinite(r.gamma) ? r.gamma : null, interval: Number.isFinite(ev.interval) ? ev.interval : null }); }, { passive: true });
      fieldMotionAttached = true;
    }
    // الرصد المستمر يلزم تشغيله لأن الاختبار يقيسه؛ نفعّله تلقائيًا ونوثق ذلك
    fw.restore = { localScan: localScanEnabled, nav: navModeEnabled, arch: !!liveArchEnabled, life: lifeMode };
    const clean = id => String(($(id) || {}).value || '').replace(/[^\w .\-+()\u0600-\u06FF]/g, '').trim().slice(0, 40);
    fw.manual = { model: clean('field-phone-model'), os: clean('field-phone-os') };
    const autoEnabled = [];
    if (!localScanEnabled) { localScanEnabled = true; try { writeLS(LS_LOCAL_SCAN, true); } catch (e) {} autoEnabled.push('localScan'); }
    if (!navModeEnabled) { setNavMode(true, false); autoEnabled.push('navMode'); }
    let prior = []; try { prior = (await dbAll()).filter(s => s.participantCode === participant && s.scene === scene); } catch (e) {}
    try { setLifeMode('walk', true); await startApp(true); } catch (e) { say('تعذر بدء التطبيق والكاميرا: ' + (e.message || e)); return; }
    fieldStartedAt = now(); fieldLastDetectAt = 0; fieldSkips = {};
    fieldRecording = { schema: 'sanad-field-session-v2', protocol: FC.PROTOCOL_VERSION, id: 'sf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), run: prior.length + 1, participantCode: participant,
      scene, sceneTitle: plan.title, startedAt: new Date().toISOString(), plan: { trials: plan.trials.length, totalCheckpoints: plan.totalCheckpoints, checkpoints: plan.trials.map(t => t.checkpoints.map(c => ({ id: c.id, distanceM: c.distanceM || null, rule: c.rule.type })) ) },
      device: { userAgent: navigator.userAgent, manualModel: fw.manual.model || null, manualOs: fw.manual.os || null }, deviceProfile: null, camera: cameraInfo(), appConfig: Object.assign(appConfig(), { autoEnabledForTest: autoEnabled }),
      sensors: { deviceMotionPermission: fieldMotionPermission, deviceOrientationAvailable: !!window.DeviceOrientationEvent, deviceMotionAvailable: !!window.DeviceMotionEvent },
      notes: 'No images, video, or audio are recorded. bbox values are pixels of the camera frame (frameWidth x frameHeight).', events: [] };
    fieldPush('session_started', { scene, participantCode: participant, run: fieldRecording.run });
    fw.plan = plan; fw.trial = 1; fw.cp = 0; fw.attempt = 1; fw.redo = false; fw.visited = new Set(); fw.shownTrial = 0; fw.skipSensors = false; fw.savedOnce = false; fw.exportedOnce = false; fw.answersDraft = {};
    collectProfile().then(p => { if (fieldRecording) { fieldRecording.deviceProfile = p; fieldRecording.device = { userAgent: navigator.userAgent, manualModel: fw.manual.model || null, manualOs: fw.manual.os || null, model: p.uaData && p.uaData.high && p.uaData.high.model || null }; fieldPush('device_profile', { gpu: p.gpu && p.gpu.renderer || null, batteryLevel: p.battery && p.battery.level }); } }).catch(() => {});
    setTimeout(() => { if (fieldRecording) fieldRecording.camera = cameraInfo(); }, 2500);
    startSampler();
    if (fieldAutosaveTimer) clearInterval(fieldAutosaveTimer);
    fieldAutosaveTimer = setInterval(() => saveSession(false).catch(() => {}), 4000);
    fw.stage = 'preflight'; fwRender(); fwStartPreTimer();
  };

  /* ====================== فحص الجاهزية ====================== */
  function recent(types, ms) { const ev = fieldRecording.events, t0 = Math.round(now() - fieldStartedAt) - ms; let n = 0; for (let i = ev.length - 1; i >= 0 && ev[i].t >= t0; i--) if (types.includes(ev[i].type)) n++; return n; }
  function countType(t) { return fieldRecording.events.reduce((n, e) => n + (e.type === t ? 1 : 0), 0); }
  function preItems() {
    const items = [], plan = fw.plan;
    const camOk = !!(videoElement && !videoElement.paused && videoElement.videoWidth > 0);
    items.push({ id: 'cam', ok: camOk, label: 'الكاميرا تعمل', fix: camOk ? '' : 'اسمح باستخدام الكاميرا للموقع. إن رُفض الإذن فعدّله من إعدادات المتصفح ثم أعد فتح الصفحة.' });
    const modelOk = !!objectModel; items.push({ id: 'coco', ok: modelOk, label: 'نموذج رصد الأجسام جاهز', fix: modelOk ? '' : 'جارٍ تحميل النموذج (يحتاج إنترنت أول مرة فقط). انتظر قليلًا أو اضغط «أعد المحاولة».', action: modelOk ? null : { act: 'retryModel', text: 'أعد المحاولة' } });
    const ticks = countType('detection'); items.push({ id: 'ticks', ok: ticks >= 2, label: 'الرصد يعمل (' + ticks + ' قراءة)', fix: ticks >= 2 ? '' : 'لم تبدأ قراءات الرصد بعد؛ ابقَ في هذه الشاشة وانتظر ثوانيَ.' });
    if (plan.needsSeg) {
      const flagSaved = (typeof isSavedFlag === 'function') && isSavedFlag(LS_SEG_READY);
      const on = !!liveArchEnabled, ready = !!segReady, arch = countType('arch');
      items.push({ id: 'archOn', ok: on, label: 'الرصد التلقائي للمكان مفعّل', fix: on ? '' : 'هذا المشهد يقيس نموذج المكان (السلالم والحوائط والرصيف).', action: on ? null : { act: 'enableArch', text: 'فعّله الآن' } });
      items.push({ id: 'seg', ok: ready, label: 'نموذج المكان (SegFormer) جاهز', fix: ready ? '' : (flagSaved ? 'جارٍ تشغيل النموذج المحفوظ… انتظر.' : 'لم يُنزَّل نموذج المكان على هذا الهاتف. أنهِ الجلسة ونزّله من الإعدادات (بالإنترنت، ≈ 4.4 ميجا) ثم ارجع.') });
      items.push({ id: 'archread', ok: arch >= 1, label: 'وصلت قراءة من نموذج المكان (' + arch + ')', fix: arch >= 1 ? '' : 'القراءة الأولى قد تتأخر حتى نصف دقيقة على الهواتف البطيئة. وجّه الكاميرا نحو مشهد فيه تفاصيل وانتظر.' });
    }
    const sens = recent(['orientation', 'motion'], 3000), sensOk = sens >= 3 || fw.skipSensors;
    items.push({ id: 'sens', ok: sensOk, soft: true, label: 'حساسات الميل والحركة (' + sens + ' قراءة حديثة)', fix: sensOk ? '' : 'لم تصل قراءات. حرّك الهاتف قليلًا. على آيفون اسمح بـ«الحركة والاتجاه». إن لم تتوفر فتابع بدونها وسيُسجَّل ذلك.', action: sensOk ? null : { act: 'skipSensors', text: 'تابع بدون الحساسات' } });
    const b = fw.battery; if (b) items.push({ id: 'bat', ok: b.charging || b.level >= 0.25, soft: true, label: 'البطارية ' + Math.round(b.level * 100) + '%' + (b.charging ? ' (تشحن)' : ''), fix: (b.charging || b.level >= 0.25) ? '' : 'البطارية منخفضة؛ صِلها بالشاحن قبل الاختبار.' });
    const wl = !!(wakeLock && !wakeLock.released); items.push({ id: 'wake', ok: wl, soft: true, label: wl ? 'الشاشة ستبقى مضاءة' : 'لم يُفعّل منع انطفاء الشاشة', fix: wl ? '' : 'اضبط مهلة إطفاء الشاشة في هاتفك على أطول مدة ممكنة، ولا تقفل الهاتف أثناء الاختبار.' });
    return items;
  }
  function preReady(items) { return items.filter(i => !i.soft).every(i => i.ok) && items.filter(i => i.soft && i.id === 'sens').every(i => i.ok); }
  function fwStartPreTimer() { if (fw.preTimer) clearInterval(fw.preTimer); fw.preTimer = setInterval(() => { if (fw.stage !== 'preflight' || !fieldRecording) { clearInterval(fw.preTimer); fw.preTimer = null; return; } fwRenderPre(); }, 900); }
  function fwRenderPre() {
    const box = $('fw-pre-list'), btn = $('fw-pre-go'); if (!box) return;
    const items = preItems();
    box.innerHTML = items.map(i => '<div class="fw-chk ' + (i.ok ? 'ok' : (i.soft ? 'warn' : 'bad')) + '"><div>' + (i.ok ? '✅' : (i.soft ? '⚠️' : '⏳')) + ' ' + esc(i.label) + '</div>' + (i.fix ? '<div class="fw-fix">' + esc(i.fix) + '</div>' : '') + (i.action ? '<button class="fw-b sm" data-act="' + i.action.act + '">' + esc(i.action.text) + '</button>' : '') + '</div>').join('');
    if (btn) btn.disabled = !preReady(items);
  }

  /* ====================== التقدم بين المحاولات ====================== */
  function summary() { return FC.summarizeSession(fieldRecording.scene, fieldRecording.events); }
  function nextTarget() {
    const sum = summary();
    for (const t of sum.trials) {
      for (let i = 0; i < t.checkpoints.length; i++) {
        const c = t.checkpoints[i];
        const pending = c.status === 'pending' || (fw.redo && c.status !== 'ok' && !fw.visited.has(t.index + ':' + c.id));
        if (pending) return { type: 'cp', trial: t.index, cp: i };
      }
      const plan = fw.plan.trials[t.index - 1];
      if (plan.answers.length && !t.answers && t.checkpoints.every(c => c.status === 'ok' || c.status === 'skipped')) return { type: 'answers', trial: t.index };
    }
    return { type: 'summary' };
  }
  function fwAdvance() {
    const nt = nextTarget();
    if (nt.type === 'summary') { fw.stage = 'summary'; saveSession(false).catch(() => {}); fw.savedOnce = true; }
    else if (nt.type === 'answers') { fw.trial = nt.trial; fw.stage = 'answers'; fw.answersDraft = {}; }
    else { const changed = nt.trial !== fw.shownTrial; fw.trial = nt.trial; fw.cp = nt.cp; fw.attempt = (summary().trials[nt.trial - 1].checkpoints[nt.cp].attempts || 0) + 1;
      fw.actual = fw.plan.trials[nt.trial - 1].checkpoints[nt.cp].distanceM || null;
      if (changed) { fw.stage = 'trial_intro'; } else fw.stage = 'cp_ready'; }
    fwRender();
  }

  /* ====================== نقطة القياس ====================== */
  const curTrial = () => fw.plan.trials[fw.trial - 1], curCp = () => curTrial().checkpoints[fw.cp];
  function startCheckpoint() {
    const cp = curCp(), ev = fieldPush('checkpoint_start', { trial: fw.trial, cp: cp.id, attempt: fw.attempt, targetDistanceM: cp.distanceM || null, actualDistanceM: cp.distanceM ? fw.actual : null, ruleType: cp.rule.type, minHoldMs: cp.minHoldMs, appConfig: { liveArchEnabled: !!liveArchEnabled, torchOn: !!torchOn, lifeMode } });
    fw.run = { a: ev.t, startedAt: now(), lastRequiredAt: 0 };
    fw.stage = 'cp_run'; fwRender();
    if (fw.runTimer) clearInterval(fw.runTimer); fw.runTimer = setInterval(runTick, 400); vib(40);
  }
  function runTick() {
    if (fw.stage !== 'cp_run' || !fieldRecording) { clearInterval(fw.runTimer); return; }
    const cp = curCp(), t = Math.round(now() - fieldStartedAt), el = now() - fw.run.startedAt;
    const prog = FC.liveProgress(cp, fieldRecording.events, fw.run.a, t);
    const ptxt = $('fw-prog'), bar = $('fw-bar'), tm = $('fw-time'), lt = $('fw-light');
    if (tm) tm.textContent = Math.floor(el / 1000) + ' ث';
    if (bar) bar.style.width = Math.min(100, Math.round(el / cp.minHoldMs * 100)) + '%';
    if (ptxt) ptxt.textContent = prog.text + (prog.ok ? ' ✅' : '');
    if (lt) { const d = fieldRecording.events.slice(-60).reverse().find(e => e.type === 'detection'); const q = d && d.data.frameQuality; lt.textContent = q ? 'الإضاءة الحالية: ' + q.lightLabel + ' (' + q.meanLuminance + ')' + (q.torchOn ? ' — الكشاف يعمل' : '') : ''; }
    const req = (cp.markers || []).filter(m => m.required);
    if (req.length) {
      const undone = new Set(fieldRecording.events.filter(e => e.type === 'participant_marker_undo').map(e => e.data.ofT));
      const got = req.every(m => fieldRecording.events.some(e => e.type === 'participant_marker' && e.t >= fw.run.a && e.data.kind === m.kind && !undone.has(e.t)));
      if (got) { const lastT = Math.max(...fieldRecording.events.filter(e => e.type === 'participant_marker' && e.t >= fw.run.a && req.some(m => m.kind === e.data.kind)).map(e => e.t)); if (t - lastT >= 3000 && el >= cp.minHoldMs) return finishCheckpoint(); }
    } else if (el >= cp.minHoldMs && prog.ok) return finishCheckpoint();
    if (el >= cp.maxWaitMs) finishCheckpoint();
  }
  function finishCheckpoint(manual) {
    if (fw.runTimer) { clearInterval(fw.runTimer); fw.runTimer = null; }
    const cp = curCp(), t = Math.round(now() - fieldStartedAt);
    const ev = FC.evaluateCheckpoint(cp, fieldRecording.events, fw.run.a, t, { sensorsExpected: !fw.skipSensors });
    const status = ev.ok ? 'ok' : 'failed';
    fieldPush('checkpoint_end', { trial: fw.trial, cp: cp.id, attempt: fw.attempt, status, manual: !!manual, durationMs: t - fw.run.a, checks: ev.checks, problems: ev.problems, evidence: ev.evidence });
    fw.visited.add(fw.trial + ':' + cp.id); fw.lastResult = ev; fw.lastGuidance = ev.guidance;
    fw.stage = 'cp_result'; fwRender(); vib(ev.ok ? [60] : [120, 60, 120]);
    if (ev.ok && !ev.sensorWarn) setTimeout(() => { if (fw.stage === 'cp_result' && fw.lastResult === ev) fwAdvance(); }, 1600);
  }
  function skipCheckpoint() {
    const cp = curCp(); fieldPush('checkpoint_end', { trial: fw.trial, cp: cp.id, attempt: fw.attempt, status: 'skipped', problems: ['تخطّاها المرافق'] }); fw.visited.add(fw.trial + ':' + cp.id); fwAdvance();
  }
  function mark(kind) {
    const cp = fw.stage === 'cp_run' ? curCp() : null;
    const ev = fieldPush('participant_marker', { kind, trial: fw.trial, cp: cp ? cp.id : null, attempt: fw.attempt }); fw.lastMarker = ev; vib(30);
    const el = $('fw-note'); if (el) el.textContent = 'سُجّلت العلامة: ' + ({ vehicle_visible: 'ظهرت سيارة', vehicle_passed: 'مرّت السيارة', false_alarm: 'إنذار غير صحيح', missed_hazard: 'خطر لم يكتشفه', scene_note: 'ملاحظة' }[kind] || kind) + ' (' + Math.floor((now() - fw.run.startedAt) / 1000) + ' ث)';
  }
  function undoMarker() {
    const ev = fieldRecording.events.slice().reverse().find(e => e.type === 'participant_marker' && !fieldRecording.events.some(u => u.type === 'participant_marker_undo' && u.data.ofT === e.t));
    if (!ev) return; fieldPush('participant_marker_undo', { ofT: ev.t, kind: ev.data.kind }); const el = $('fw-note'); if (el) el.textContent = 'تم التراجع عن آخر علامة.';
  }

  /* ====================== الإجراءات ====================== */
  const ACT = {
    retryModel() { try { initLocalObjectEngine(); } catch (e) {} },
    enableArch() { const c = $('live-arch-checkbox'); if (c) { c.checked = true; c.dispatchEvent(new Event('change')); } else { liveArchEnabled = true; } fwRenderPre(); },
    skipSensors() { fw.skipSensors = true; fieldPush('sensors_skipped', {}); fwRenderPre(); },
    startTrials() { if (fw.preTimer) clearInterval(fw.preTimer); fieldPush('preflight_passed', { items: preItems().map(i => ({ id: i.id, ok: i.ok })) }); fwAdvance(); },
    beginTrial() { fw.shownTrial = fw.trial; fieldPush('trial_start', { trial: fw.trial, title: curTrial().title }); fw.stage = 'cp_ready'; fwRender(); },
    startCp: startCheckpoint,
    endCp() { finishCheckpoint(true); },
    skipCp: skipCheckpoint,
    retryCp() { fw.attempt = (fw.attempt || 1) + 1; fw.visited.delete(fw.trial + ':' + curCp().id); fw.actual = curCp().distanceM || null; fw.stage = 'cp_ready'; fwRender(); },
    nextAfterResult() { fwAdvance(); },
    dist(arg) { const v = Math.max(0.3, Math.round((fw.actual + Number(arg)) * 100) / 100); fw.actual = v; const el = $('fw-dist'); if (el) el.textContent = v.toFixed(2).replace(/0$/, '') + ' م'; },
    mark(arg) { mark(arg); }, undo: undoMarker,
    ans(arg) { const [id, d] = arg.split(':'); const a = curTrial().answers.find(x => x.id === id); const cur = fw.answersDraft[id] == null ? (a.min || 0) : fw.answersDraft[id]; fw.answersDraft[id] = Math.max(a.min || 0, Math.min(a.max || 999, cur + Number(d))); const el = $('fw-ans-' + id); if (el) el.textContent = fw.answersDraft[id]; },
    saveAnswers() { const out = {}; curTrial().answers.forEach(a => { out[a.id] = fw.answersDraft[a.id] == null ? (a.min || 0) : fw.answersDraft[a.id]; }); fieldPush('trial_answer', { trial: fw.trial, answers: out }); fwAdvance(); },
    async saveFile() { await saveSession(false); const snap = stampSession(false); snap.completed = true; download(snap, snap.id + '.json'); fw.exportedOnce = true; fwSetNote('نُزِّل الملف وحُفظت نسخة على الهاتف. أرسله لفريق التطوير.'); },
    async shareFile() { await saveSession(false); const snap = stampSession(false); const r = await shareOrDownload(snap, snap.id + '.json'); fw.exportedOnce = r !== 'cancelled'; fwSetNote(r === 'shared' ? 'تمت المشاركة.' : (r === 'cancelled' ? 'أُلغيت المشاركة.' : 'المشاركة المباشرة غير مدعومة هنا فنُزِّل الملف.')); },
    redoMissing() { fw.redo = true; fw.visited = new Set(); fieldPush('redo_missing', {}); fwAdvance(); },
    async redoScene() { if (!confirm('سيُحفظ ما سُجّل حتى الآن ثم تبدأ جلسة جديدة للمشهد نفسه من أول محاولة. متابعة؟')) return; const sc = fieldRecording.scene; await endSession('restart'); $('field-scene-select').value = sc; $('field-scene-select').dataset.userPicked = '1'; window.startFieldRecording(); },
    async finish() { await endSession('finished'); },
    async quit() { if (!confirm('إنهاء الجلسة الآن؟ سيُحفظ ما سُجّل كجلسة ناقصة ويمكنك إعادتها لاحقًا.')) return; await endSession('quit'); }
  };
  function fwSetNote(m) { const el = $('fw-save-note'); if (el) el.textContent = m; }
  window.markFieldEvent = k => { if (fieldRecording) mark(k); };
  window.fwRequestExit = () => { if (fieldRecording) fwRender(); };
  window.stopAndExportFieldRecording = () => ACT.finish();

  // يعيد إعدادات التطبيق إلى ما كانت عليه قبل الاختبار حتى لا يتغير سلوك الاستعمال العادي
  function restoreAppSettings() {
    const r = fw.restore; if (!r) return; const done = [];
    if (localScanEnabled !== r.localScan) { localScanEnabled = r.localScan; try { writeLS(LS_LOCAL_SCAN, r.localScan); } catch (e) {} try { liveLocalScanCheckbox.checked = r.localScan; } catch (e) {} done.push('localScan'); }
    if (navModeEnabled !== r.nav) { setNavMode(r.nav, false); done.push('navMode'); }
    if (!!liveArchEnabled !== r.arch) { const c = $('live-arch-checkbox'); if (c) { c.checked = r.arch; c.dispatchEvent(new Event('change')); } else liveArchEnabled = r.arch; done.push('liveArch'); }
    if (lifeMode !== r.life) { setLifeMode(r.life, true); done.push('lifeMode'); }
    fieldPush('settings_restored', { restored: done }); fw.restore = null;
  }
  async function endSession(reason) {
    if (!fieldRecording) return;
    if (fw.runTimer) clearInterval(fw.runTimer); if (fw.preTimer) clearInterval(fw.preTimer);
    fieldPush('session_ended', { reason }); stopSampler();
    try { restoreAppSettings(); } catch (e) {} if (fieldAutosaveTimer) { clearInterval(fieldAutosaveTimer); fieldAutosaveTimer = null; }
    let snap = null; try { snap = await saveSession(true); } catch (e) { try { snap = stampSession(true); } catch (e2) {} }
    const exported = fw.exportedOnce; fw.restore = null; fieldRecording = null; fw.stage = 'idle'; if (fw.el) fw.el.style.display = 'none';
    try { openSettings(); } catch (e) {}
    const st = $('field-recorder-settings-status'); if (st && snap) st.textContent = 'انتهت الجلسة (' + (snap.summary.status === 'complete' ? 'مكتملة ✅' : 'ناقصة ' + snap.summary.completeness + '%') + '). ' + (exported ? 'سبق تنزيل/مشاركة ملفها.' : 'لم يُنزَّل ملفها بعد: استخدم «تصدير كل التسجيلات المحفوظة».');
    window.fieldRefreshProgress();
  }

  /* ====================== العرض ====================== */
  function ensureEl() {
    if (fw.el) return fw.el;
    const st = document.createElement('style');
    st.textContent = '#fw{position:fixed;left:0;right:0;bottom:0;z-index:60;max-height:74vh;overflow:auto;background:#020617;color:#f8fafc;border-top:3px solid #0d9488;border-radius:18px 18px 0 0;padding:12px 14px 18px;font:16px/1.65 system-ui,"Segoe UI",Tahoma,sans-serif;box-shadow:0 -8px 30px rgba(0,0,0,.6)}' +
      '#fw.full{top:0;max-height:none;border-radius:0}#fw h2{font-size:19px;font-weight:800;color:#99f6e4;margin:0 0 6px}#fw p{margin:4px 0}' +
      '#fw .fw-top{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;color:#cbd5e1;margin-bottom:6px}' +
      '#fw .fw-b{display:block;width:100%;min-height:52px;margin-top:8px;padding:10px;border-radius:12px;font-weight:800;font-size:17px;background:#0f766e;color:#fff;border:0}#fw .fw-b:disabled{opacity:.4}' +
      '#fw .fw-b.sec{background:#334155}#fw .fw-b.red{background:#991b1b}#fw .fw-b.amb{background:#92400e}#fw .fw-b.blu{background:#1e40af}#fw .fw-b.sm{min-height:40px;font-size:14px;width:auto;display:inline-block;padding:6px 14px;margin:6px 0 0}' +
      '#fw .fw-card{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:10px;margin:8px 0}#fw .fw-warn{background:#451a03;border:1px solid #b45309;color:#fde68a}' +
      '#fw .fw-ol{margin:4px 0;padding-inline-start:22px}#fw .fw-ol li{margin:4px 0}#fw .fw-chk{border-radius:10px;padding:8px 10px;margin:6px 0;background:#0f172a;border:1px solid #334155}' +
      '#fw .fw-chk.ok{border-color:#15803d}#fw .fw-chk.bad{border-color:#b91c1c}#fw .fw-chk.warn{border-color:#b45309}#fw .fw-fix{font-size:13px;color:#fca5a5;margin-top:2px}#fw .fw-chk.warn .fw-fix{color:#fcd34d}' +
      '#fw .fw-barbox{height:14px;background:#1e293b;border-radius:8px;overflow:hidden;margin:8px 0}#fw #fw-bar{height:100%;width:0;background:#14b8a6;transition:width .4s}' +
      '#fw .fw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}#fw .fw-step{display:flex;align-items:center;justify-content:center;gap:14px;margin:6px 0}#fw .fw-step button{width:56px;height:52px;border-radius:12px;background:#334155;color:#fff;font-size:24px;font-weight:800;border:0}#fw .fw-step b{font-size:26px;min-width:80px;text-align:center}' +
      '#fw .big{font-size:40px;font-weight:800;text-align:center;color:#5eead4}#fw table{width:100%;border-collapse:collapse;font-size:14px}#fw td,#fw th{padding:4px 6px;border-bottom:1px solid #1e293b;text-align:right}';
    document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'fw'; el.style.display = 'none'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'مرشد الاختبار الميداني');
    el.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b || b.disabled) return; const f = ACT[b.dataset.act]; if (f) f(b.dataset.arg); });
    document.body.appendChild(el); fw.el = el; return el;
  }
  const FULL = new Set(['preflight', 'summary', 'answers']);
  function topBar() {
    const p = fw.plan, t = fw.stage === 'preflight' ? '' : ' · المحاولة ' + fw.trial + ' من ' + p.trials.length;
    return '<div class="fw-top"><span>' + p.icon + ' ' + esc(p.title) + t + '</span><button class="fw-b sm red" data-act="quit" style="margin:0">✖ إنهاء</button></div>';
  }
  function fwRender() {
    const el = ensureEl(); if (!fieldRecording) { el.style.display = 'none'; return; }
    el.style.display = 'block'; el.classList.toggle('full', FULL.has(fw.stage));
    const p = fw.plan; let h = topBar();
    if (fw.stage === 'preflight') {
      const nCp = p.totalCheckpoints;
      h += '<h2>قبل أن نبدأ: ما المطلوب منك؟</h2>' +
        '<div class="fw-card"><p><b>الهدف:</b> ' + esc(p.purpose) + '</p><p><b>أين:</b> ' + esc(p.place) + '</p><p><b>تحتاج:</b> ' + esc(p.bring) + '</p>' +
        '<p><b>الخطة:</b> ' + p.trials.length + ' محاولات، فيها ' + nCp + ' نقطة قياس، ≈ ' + p.minutes + ' دقائق. يخبرك التطبيق بكل خطوة، ويتحقق بنفسه من تسجيل القراءة، ويطلب إعادتها إن نقصت.</p></div>' +
        '<div class="fw-card fw-warn"><b>⚠️ السلامة أولًا</b><ul class="fw-ol">' + p.safety.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>' +
        '<h2>فحص الجاهزية</h2><div id="fw-pre-list"></div>' +
        '<button id="fw-pre-go" class="fw-b" data-act="startTrials" disabled>▶ جاهز — ابدأ المحاولة الأولى</button>';
    } else if (fw.stage === 'trial_intro') {
      const t = curTrial();
      h += '<h2>المحاولة ' + t.index + ' من ' + p.trials.length + ': ' + esc(t.title) + '</h2><div class="fw-card"><b>جهّز:</b><ul class="fw-ol">' + t.prepare.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>' +
        '<div class="fw-card"><b>سنقيس ' + t.checkpoints.length + ' نقطة:</b> ' + t.checkpoints.map(c => esc(c.label)).join(' ← ') + '</div>' +
        '<p style="color:#fde68a;font-size:14px">' + esc(p.safety[p.safety.length - 1]) + '</p><button class="fw-b" data-act="beginTrial">▶ فهمت — ابدأ هذه المحاولة</button>';
    } else if (fw.stage === 'cp_ready' || fw.stage === 'cp_run') {
      const t = curTrial(), cp = curCp(), run = fw.stage === 'cp_run';
      h += '<h2>النقطة ' + (fw.cp + 1) + ' من ' + t.checkpoints.length + ' — ' + esc(cp.label) + '</h2>' + (fw.attempt > 1 ? '<div class="fw-card fw-warn">هذه إعادة (المحاولة رقم ' + fw.attempt + ' لهذه النقطة).' + (fw.lastGuidance.length ? '<br>' + fw.lastGuidance.map(esc).join('<br>') : '') + '</div>' : '');
      if (!run) {
        h += '<div class="fw-card"><ol class="fw-ol">' + cp.lines.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol></div>';
        if (cp.distanceM) h += '<div class="fw-card"><div>المسافة <b>الفعلية</b> بين الهاتف والهدف (عدّلها إن لم تكن بالضبط ' + String(cp.distanceM).replace('.', '٫') + ' م):</div><div class="fw-step"><button data-act="dist" data-arg="-0.25">−</button><b id="fw-dist">' + fw.actual.toFixed(2).replace(/0$/, '') + ' م</b><button data-act="dist" data-arg="0.25">+</button></div></div>';
        if (cp.rule.type === 'light') h += '<div class="fw-card" id="fw-light" style="font-weight:800"></div>';
        h += '<button class="fw-b" data-act="startCp">▶ بدء القياس</button><button class="fw-b sec sm" data-act="skipCp">⏭ تخطَّ هذه النقطة (تُحفظ ناقصة)</button>';
        if (cp.rule.type === 'light') { const tick = () => { const d = fieldRecording && fieldRecording.events.slice(-60).reverse().find(e => e.type === 'detection'); const q = d && d.data.frameQuality, l = $('fw-light'); if (l && fw.stage === 'cp_ready') { l.textContent = q ? 'الإضاءة الحالية: ' + q.lightLabel + ' (' + q.meanLuminance + ')' + (q.torchOn ? ' — الكشاف يعمل' : '') : 'بانتظار قراءة الإضاءة…'; setTimeout(tick, 800); } }; setTimeout(tick, 100); }
      } else {
        h += '<div class="big" id="fw-time">0 ث</div><div class="fw-barbox"><div id="fw-bar"></div></div><div class="fw-card" id="fw-prog" style="font-weight:700">…</div>';
        if (cp.rule.type === 'light') h += '<div class="fw-card" id="fw-light" style="font-weight:800"></div>';
        h += cp.distanceM ? '<p style="color:#fde68a">🛑 لا تتحرك ولا تغيّر زاوية الهاتف حتى يكتمل القياس.</p>' : '';
        if (cp.markers && cp.markers.length) h += '<div class="fw-grid">' + cp.markers.map(m => '<button class="fw-b ' + (m.kind === 'vehicle_passed' ? 'blu' : 'amb') + '" data-act="mark" data-arg="' + m.kind + '">' + esc(m.label) + '</button>').join('') + '</div>';
        h += '<div class="fw-grid"><button class="fw-b sec sm" data-act="mark" data-arg="false_alarm">🔔 سمعت إنذارًا غير صحيح</button><button class="fw-b sec sm" data-act="mark" data-arg="missed_hazard">⚠️ كان هناك خطر لم يُنبَّه له</button></div>' +
          '<div class="fw-grid"><button class="fw-b sec sm" data-act="mark" data-arg="scene_note">📝 علّم لحظة</button><button class="fw-b sec sm" data-act="undo">↩️ تراجع عن آخر علامة</button></div><div id="fw-note" style="font-size:13px;color:#99f6e4;min-height:20px"></div>' +
          '<button class="fw-b sec sm" data-act="endCp">⏹ إنهاء القياس الآن</button>';
      }
    } else if (fw.stage === 'cp_result') {
      const r = fw.lastResult, cp = curCp();
      h += r.ok ? '<h2 style="color:#86efac">✅ تم تسجيل القراءة المطلوبة</h2>' : '<h2 style="color:#fca5a5">❌ لم تُسجَّل القراءة المطلوبة — يجب إعادة هذه النقطة</h2>';
      h += '<div class="fw-card">' + r.checks.map(c => '<div>' + (c.ok ? '✅' : (c.blocking === false ? '⚠️' : '❌')) + ' ' + esc(c.label) + ': ' + esc(c.text) + '</div>').join('') + '</div>';
      if (!r.ok) h += '<div class="fw-card fw-warn"><b>ماذا حدث:</b><ul class="fw-ol">' + r.problems.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul><b>ماذا تفعل الآن:</b><ul class="fw-ol">' + r.guidance.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>' +
        '<button class="fw-b" data-act="retryCp">🔁 أعد هذه النقطة الآن</button><button class="fw-b sec sm" data-act="skipCp">⏭ تخطَّ (تُحفظ ناقصة)</button>';
      else { if (r.sensorWarn) h += '<div class="fw-card fw-warn">' + esc(r.sensorWarn) + '</div>'; h += '<button class="fw-b" data-act="nextAfterResult">التالي ▶</button>'; }
    } else if (fw.stage === 'answers') {
      const t = curTrial();
      h += '<h2>انتهت المحاولة ' + t.index + ' — سؤال سريع</h2>' + t.answers.map(a => '<div class="fw-card"><div>' + esc(a.label) + '</div><div class="fw-step"><button data-act="ans" data-arg="' + a.id + ':-1">−</button><b id="fw-ans-' + a.id + '">' + (a.min || 0) + '</b><button data-act="ans" data-arg="' + a.id + ':1">+</button></div></div>').join('') +
        '<button class="fw-b" data-act="saveAnswers">حفظ الإجابة ومتابعة ▶</button>';
    } else if (fw.stage === 'summary') {
      const s = summary(), ok = s.status === 'complete';
      h += '<h2 style="color:' + (ok ? '#86efac' : '#fdba74') + '">' + (ok ? '✅ اكتمل هذا المشهد بكل قراءاته' : '🟠 المشهد ناقص — ' + s.completeness + '% فقط') + '</h2>' +
        '<div class="fw-card">المحاولات الصالحة: <b>' + s.validTrials + ' من ' + s.requiredTrials + '</b> · نقاط القياس الصالحة: <b>' + s.validCheckpoints + ' من ' + s.totalCheckpoints + '</b></div>' +
        '<div class="fw-card"><table>' + s.trials.map(t => '<tr><th colspan="2">المحاولة ' + t.index + ': ' + esc(t.title) + (t.valid ? ' ✅' : ' ❌') + '</th></tr>' + t.checkpoints.map(c => '<tr><td>' + esc(c.label) + '</td><td>' + ({ ok: '✅ سُجّلت', failed: '❌ لم تكتمل', skipped: '⏭ تُخطيت', pending: '⏳ لم تُنفَّذ' }[c.status]) + (c.attempts > 1 ? ' (بعد ' + c.attempts + ' محاولات)' : '') + '</td></tr>').join('') + (t.needsAnswers ? '<tr><td>سؤال العدّ</td><td>' + (t.answered ? '✅ سُجّل' : '⏳ لم يُجَب') + '</td></tr>' : '')).join('') + '</table></div>';
      if (!ok) h += '<div class="fw-card fw-warn"><b>مطلوب منك:</b> إعادة ' + s.missing.length + ' نقطة قياس لإكمال هذا المشهد (' + s.missing.slice(0, 4).map(m => 'المحاولة ' + m.trial + ' — ' + esc(m.label)).join('، ') + (s.missing.length > 4 ? '…' : '') + '). لن يُعدّ المشهد مكتملًا قبل ذلك.</div><button class="fw-b" data-act="redoMissing">🔁 أعد النقاط الناقصة الآن (' + s.missing.length + ')</button>';
      h += '<button class="fw-b ' + (ok ? '' : 'sec') + '" data-act="saveFile">💾 حفظ وتنزيل الملف</button><button class="fw-b blu" data-act="shareFile">📤 مشاركة الملف مع فريق التطوير</button><div id="fw-save-note" style="font-size:14px;color:#99f6e4;margin:6px 0">حُفظت نسخة على هذا الهاتف تلقائيًا.</div>' +
        '<button class="fw-b sec" data-act="redoScene">🔄 إعادة المشهد كاملًا من البداية</button><button class="fw-b sec" data-act="finish">' + (ok ? '✔ إنهاء، واختيار مشهد آخر' : 'إنهاء بدون إكمال (يُحفظ ناقصًا)') + '</button>';
    }
    el.innerHTML = h; if (fw.stage === 'preflight') fwRenderPre(); el.scrollTop = 0;
  }
  window.fwRender = fwRender;
})();
