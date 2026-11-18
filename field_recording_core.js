/* Pure validation and aggregation helpers for Sanad field sessions. No DOM, camera, network or storage. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SanadFieldCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ARCH_SCENES = new Set(['stairs', 'sidewalk_end', 'wall', 'mixed']);
  const COCO_SCENES = new Set(['approaching_vehicle', 'parked_vehicle', 'crowd', 'stairs', 'sidewalk_end', 'wall', 'low_light', 'mixed']);
  const DISTANCE_SCENES = new Set(['parked_vehicle', 'stairs', 'sidewalk_end', 'wall']);
  function evaluateSession(session) {
    const events = Array.isArray(session && session.events) ? session.events : [];
    const count = type => events.filter(e => e && e.type === type).length;
    const durationMs = Number(session && session.durationMs) || events.reduce((m,e)=>Math.max(m,Number(e && e.t)||0),0);
    const detections = count('detection');
    const arch = count('arch_result');
    const targetVisible = count('target_visible');
    const frameQuality = events.filter(e => e && e.type === 'detection' && e.data && e.data.frameQuality).length;
    const motionSamples = events.filter(e=>e&&e.type==='motion'&&e.data&&e.data.gravity&&['x','y','z'].some(k=>Number.isFinite(e.data.gravity[k]))).length;
    const orientationSamples = events.filter(e=>e&&e.type==='orientation'&&e.data&&['beta','gamma'].some(k=>Number.isFinite(e.data[k]))).length;
    const issues = [];
    if (durationMs < 12000) issues.push({ code: 'duration_short', message: 'مدة التسجيل أقل من 12 ثانية؛ أعد المشهد لمدة 15–30 ثانية.' });
    if (targetVisible < 1) issues.push({ code: 'target_not_confirmed', message: 'لم تؤكد أن العنصر المستهدف ظاهر في الكاميرا؛ وجّه الهاتف للمشهد واضغط «العنصر ظاهر».' });
    if (COCO_SCENES.has(session.scene) && detections < 5) issues.push({ code: 'coco_samples_low', message: `قراءات COCO قليلة (${detections}/5 على الأقل). تأكد من تشغيل رصد الأجسام وانتظر حتى تتجمع خمس قراءات.` });
    if (ARCH_SCENES.has(session.scene) && arch < 2) issues.push({ code: 'seg_samples_low', message: `نتائج SegFormer غير كافية (${arch}/2). فعّل نموذج المكان وتنبيهاته، وانتظر نتيجتين على الأقل.` });
    if (session.scene === 'low_light' && frameQuality < 5) issues.push({ code: 'quality_samples_low', message: `قياسات الإضاءة وجودة الإطار غير كافية (${frameQuality}/5). أبق الهاتف ثابتًا واجمع خمس قراءات.` });
    if (session.sensors?.deviceMotionAvailable && motionSamples < 5) issues.push({ code: 'motion_samples_low', message: `قراءات حساس الحركة والجاذبية غير كافية (${motionSamples}/5). اسمح بإذن الحركة عند الطلب، ثم أعد الجلسة.` });
    if (session.sensors?.deviceOrientationAvailable && orientationSamples < 5) issues.push({ code: 'orientation_samples_low', message: `قراءات حساس ميل الهاتف غير كافية (${orientationSamples}/5). اسمح بإذن اتجاه الجهاز من أول لمسة، ثم أعد الجلسة.` });
    const groundTruthValues = events.filter(e => e && e.type === 'ground_truth_distance' && e.data && Number.isFinite(Number(e.data.meters))).map(e=>Math.round(Number(e.data.meters)*10)/10);
    const groundTruth = groundTruthValues.length;
    const distinctGroundTruth = new Set(groundTruthValues).size;
    if (DISTANCE_SCENES.has(session.scene) && distinctGroundTruth < 2) issues.push({ code: 'ground_truth_missing', message: `تحتاج هذه الحالة إلى نقطتي مسافة فعليتين مختلفتين على الأقل؛ المسجل حاليًا ${distinctGroundTruth}/2. لا تدخل أرقامًا تقديرية.` });
    const device = session.device || {};
    if (!device.manualModel) issues.push({ code: 'device_model_missing', message: 'لم يُسجل طراز الهاتف يدويًا؛ أدخله من بيانات الجهاز قبل اعتماد الجلسة.' });
    return {
      status: issues.length ? 'needs_repeat' : 'complete',
      validForAnalysis: issues.length === 0,
      durationMs, counts: { detections, archResults: arch, targetVisible, frameQuality, motionSamples, orientationSamples, groundTruthDistances: groundTruth, distinctGroundTruthDistances:distinctGroundTruth, speech: count('speech'), markers: count('participant_marker'), lifecycle: count('lifecycle'), detectionErrors: count('detection_error'), archErrors: count('arch_error') },
      issues
    };
  }
  function normalizeBox(bbox, frameWidth, frameHeight) {
    if (!Array.isArray(bbox) || bbox.length < 4 || !frameWidth || !frameHeight) return null;
    return [bbox[0] / frameWidth, bbox[1] / frameHeight, bbox[2] / frameWidth, bbox[3] / frameHeight].map(v => Math.max(0, Math.min(1, Number(v) || 0)));
  }
  return { evaluateSession, normalizeBox, ARCH_SCENES: Array.from(ARCH_SCENES), COCO_SCENES: Array.from(COCO_SCENES), DISTANCE_SCENES: Array.from(DISTANCE_SCENES) };
});
