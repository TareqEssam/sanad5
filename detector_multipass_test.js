'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const P = require('./detector_pilot');
const h = fs.readFileSync(__dirname + '/index.html', 'utf8'), geo = {}; vm.createContext(geo);
vm.runInContext('const STEP_METERS=.7;' + h.slice(h.indexOf('const LOCAL_OBJECT_MAP ='), h.indexOf('const ADE20K_CRITICAL =')) + h.slice(h.indexOf('function estimateObjectDistance('), h.indexOf('function notifyCocoLoadFailure(')), geo);
const near = (a, b, e = 1.01) => assert.ok(Math.abs(a - b) <= e, a + ' vs ' + b);

// Geometry of the aspect-preserving passes
assert.deepEqual(P.squareRoi(720, 1280), { x: 0, y: 280, width: 720, height: 720 });
assert.deepEqual(P.squareRoi(1280, 720), { x: 280, y: 0, width: 720, height: 720 });
const chair4m = [300, 540, 125, 190];
const fr = P.focusRoi(720, 1280, chair4m);
assert.equal(fr.width, fr.height); near(fr.width, 418); assert.ok(fr.x >= 0 && fr.y >= 0 && fr.x + fr.width <= 720 && fr.y + fr.height <= 1280);
const corner = P.focusRoi(720, 1280, [0, 0, 60, 80]); assert.ok(corner.x === 0 && corner.y === 0 && corner.width >= 720 * 0.35 - 1);
const huge = P.focusRoi(720, 1280, [10, 10, 700, 1200]); assert.equal(huge.width, 720);
assert.equal(P.pickWeak([{ score: .9, bbox: [1, 1, 5, 5] }, { score: .3, bbox: [1, 1, 5, 5] }, { score: .45, bbox: [1, 1, 5, 5] }, { score: .2, bbox: [1, 1, 5, 5] }, { score: .5, bbox: [1, 1, -5, 5] }]).score, .45);
assert.equal(P.pickWeak([{ score: .7, bbox: [1, 1, 5, 5] }]), null);

// Distance invariance for scaled square and focus crops (canvas smaller than the cut region)
for (const [name, roi] of [['square', P.squareRoi(720, 1280)], ['focus', fr]]) {
  const cs = Math.round(roi.width * 0.8);                      // canvas is a scaled copy
  const k = cs / roi.width, local = { class: 'chair', score: .9, bbox: [(chair4m[0] - roi.x) * k, (chair4m[1] - roi.y) * k, chair4m[2] * k, chair4m[3] * k] };
  const m = P.remap(local, roi, cs, cs, name);
  assert.equal(m.detectionSource, name);
  near(m.bbox[0], chair4m[0]); near(m.bbox[3], chair4m[3]);
  near(geo.estimateObjectDistance(m, 720, 1280).raw, geo.estimateObjectDistance({ class: 'chair', bbox: chair4m }, 720, 1280).raw, 0.05);
}
// Boxes touching the band edge are rejected (square band cuts the top/bottom of tall objects)
assert.equal(P.remap({ bbox: [100, 0, 100, 300] }, P.squareRoi(720, 1280), 720, 720, 'square'), null);

// Multi-pass flow with a fake model, all passes on frozen canvases
const made = []; global.document = { createElement: () => { const c = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) }; made.push(c); return c; } };
function fakeModel(spec) {
  const calls = [];
  return { calls, detect: async (input) => { calls.push([input.width, input.height]); const key = input.width + 'x' + input.height; if (spec.fail && spec.fail.includes(key)) throw Error('x'); return (spec.out[key] || []).map(p => ({ ...p })); } };
}
(async () => {
  const roi = P.centralRoi(720, 1280), sq = P.squareRoi(720, 1280);
  const toLocal = (r, scale = 1) => [(chair4m[0] - r.x) * scale, (chair4m[1] - r.y) * scale, chair4m[2] * scale, chair4m[3] * scale];
  const side = Math.round(fr.width);
  const model = fakeModel({ out: {
    '720x1280': [{ class: 'bench', score: .45, bbox: chair4m.slice() }],
    '360x640': [], ['720x720']: [{ class: 'bench', score: .5, bbox: toLocal(sq) }],
    [side + 'x' + side]: [{ class: 'chair', score: .83, bbox: toLocal(fr) }] } });
  const r = await P.detect(model, { videoWidth: 720, videoHeight: 1280 }, { dual: true, passes: ['roi', 'square', 'focus'] });
  assert.equal(model.calls.length, 4);
  assert.deepEqual(model.calls[0], [720, 1280]); assert.deepEqual(model.calls[1], [360, 640]); assert.deepEqual(model.calls[2], [720, 720]); assert.deepEqual(model.calls[3], [side, side]);
  assert.equal(r.meta.revision, 'multi-pass-review-1'); assert.deepEqual(r.meta.passes, ['roi', 'square', 'focus']);
  assert.equal(r.meta.focus.trigger.class, 'bench'); assert.ok(r.meta.focus.zoomVsShortSide > 1.5);
  assert.ok(['full', 'roi', 'square', 'focus'].every(k => k in r.meta.passMs));
  assert.equal(r.meta.passBoxes.focus[0].class, 'chair'); assert.equal(r.meta.passBoxes.full[0].class, 'bench');
  assert.equal(r.predictions[0].class, 'chair'); assert.equal(r.predictions[0].detectionSource, 'focus'); assert.equal(r.predictions.length, 1);   // focus chair (0.83) replaces the weak full/square bench for the same object
  assert.ok(made.every(c => c.width === 1 && c.height === 1), 'canvases released');

  // No weak candidate => no focus pass (a strong full box never triggers extra work)
  const strong = fakeModel({ out: { '720x1280': [{ class: 'chair', score: .9, bbox: chair4m.slice() }] } });
  const s = await P.detect(strong, { videoWidth: 720, videoHeight: 1280 }, { dual: true, passes: ['roi', 'square', 'focus'] });
  assert.equal(strong.calls.length, 3); assert.equal(s.meta.focus, null); assert.equal(s.predictions[0].detectionSource, 'full');

  // One failing pass does not lose the others; full predictions always survive
  const part = fakeModel({ fail: ['720x720'], out: { '720x1280': [{ class: 'chair', score: .9, bbox: chair4m.slice() }], '360x640': [] } });
  const pr = await P.detect(part, { videoWidth: 720, videoHeight: 1280 }, { dual: true, passes: ['roi', 'square'] });
  assert.equal(pr.meta.passErrors.square, 'pass_failed'); assert.equal(pr.predictions.length, 1); assert.equal(pr.meta.roiError, null);

  // Default stays the original behaviour: one extra central crop
  const def = fakeModel({ out: { '720x1280': [{ class: 'chair', score: .9, bbox: chair4m.slice() }] } });
  await P.detect(def, { videoWidth: 720, videoHeight: 1280 }, { dual: true }); assert.equal(def.calls.length, 2);
  // Not dual: one full-frame call, no canvas
  const n0 = made.length, one = fakeModel({ out: {} }); await P.detect(one, { videoWidth: 720, videoHeight: 1280 }, { dual: false, passes: ['roi', 'square', 'focus'] });
  assert.equal(one.calls.length, 1); assert.equal(made.length, n0);

  // Wiring: normal operation untouched, opt-in only
  assert.match(h, /passes: pilot && pilot\.passes/);
  assert.ok(h.includes('objectModel.detect(videoElement, COCO_MAX_BOXES, 0.56)'));
  const ui = fs.readFileSync(__dirname + '/field_ui.js', 'utf8'); assert.match(ui, /passes: dual \? \['roi', 'square', 'focus'\] : \[\]/);
  assert.ok(!h.includes('id="field-detector-dual" type="checkbox" checked'));
  console.log('PASS multi-pass research detector: aspect-preserving crops, focus trigger only on weak candidates, distance invariance, pass isolation, release, wiring');
})().catch(e => { console.error(e); process.exitCode = 1; });
