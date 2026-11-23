'use strict';
// Usage: node analyze_multipass.js export.json [family=chair,bench,couch]
// Per checkpoint window and per pass (full / roi / square / focus), computed on the SAME frames: how often the seat family is found at >=0.25 and >=0.56, labels, and raw distance error.
const fs = require('node:fs'), vm = require('node:vm');
const file = process.argv[2]; if (!file) { console.error('usage: node analyze_multipass.js export.json [chair,bench,couch]'); process.exit(1); }
const family = (process.argv[3] || 'chair,bench,couch').split(',');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8'), g = {}; vm.createContext(g);
vm.runInContext('const STEP_METERS=.7;' + html.slice(html.indexOf('const LOCAL_OBJECT_MAP ='), html.indexOf('const ADE20K_CRITICAL =')) + html.slice(html.indexOf('function estimateObjectDistance('), html.indexOf('function notifyCocoLoadFailure(')), g);
const d = JSON.parse(fs.readFileSync(file, 'utf8')), ev = d.events || [];
const win = {}; for (const e of ev) { if (e.type === 'checkpoint_start') win[e.data.segment] = { a: e.t, truth: e.data.actualDistanceM }; if (e.type === 'checkpoint_end' && win[e.data.segment]) win[e.data.segment].b = e.t; }
console.log('appVersion', d.appConfig && d.appConfig.appVersion, '| pilot', JSON.stringify((d.appConfig && d.appConfig.detectorPilot && { rev: d.appConfig.detectorPilot.revision, passes: d.appConfig.detectorPilot.passes }) || null));
const rows = [];
for (const [seg, w] of Object.entries(win)) {
  const D = ev.filter(e => e.type === 'detection' && e.t >= w.a && e.t <= w.b && e.data.detectorPilot && e.data.detectorPilot.passBoxes);
  if (!D.length) { console.log(seg, 'no multi-pass data (checkbox was off or old build)'); continue; }
  const names = ['full', 'roi', 'square', 'focus'];
  for (const n of names) {
    let ticksRun = 0, t25 = 0, t56 = 0, ms = 0, errs = []; const labels = {};
    for (const e of D) {
      const m = e.data.detectorPilot, list = m.passBoxes[n]; if (!list && !(n === 'full')) continue; ticksRun++; ms += (m.passMs && m.passMs[n]) || 0;
      const fam = (list || []).filter(p => family.includes(p.class));
      if (fam.length) t25++; if (fam.some(p => p.score >= 0.56)) t56++;
      for (const p of fam) { labels[p.class] = (labels[p.class] || 0) + 1; const est = g.estimateObjectDistance({ class: p.class, bbox: p.bbox }, e.data.frameWidth, e.data.frameHeight); if (est && Number.isFinite(est.raw) && w.truth) errs.push(est.raw - w.truth); }
    }
    if (!ticksRun) continue;
    const mean = errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : null;
    rows.push({ segment: seg, truth: w.truth, pass: n, frames: ticksRun, 'family>=0.25': t25, 'family>=0.56': t56, labels: JSON.stringify(labels), 'meanErr(m)': mean === null ? '-' : mean.toFixed(2), 'avgMs': Math.round(ms / ticksRun) });
  }
}
if (rows.length) console.table(rows);
