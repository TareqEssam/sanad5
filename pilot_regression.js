'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('./field_core.js');
const ui = fs.readFileSync(__dirname + '/field_ui.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');

// Valid observation windows remain usable when the detector misses the known target.
const cp = F.plan('parked_vehicle').trials[0].checkpoints[0];
const ticks = Array.from({length: 9}, (_, i) => ({t:i*1200,type:'detection',data:{predictions:[]}}));
const evs = [{t:0,type:'checkpoint_start',data:{actualDistanceM:6,distanceMethod:'tape'}},...ticks];
const miss = F.evaluateCheckpoint(cp,evs,0,10500);
assert.equal(miss.ok,true); assert.equal(miss.detectionOutcome,'target_not_observed');
assert.equal(F.evaluateCheckpoint(cp,evs.slice(0,2),0,10500).ok,false);
assert.equal(F.evaluateCheckpoint(cp,evs,0,2000).ok,false);
assert.ok(!ui.includes('el >= cp.minHoldMs && prog.ok'));
console.log('PASS: fixed-window collection and preserved detection misses');

const allCountTrials = [1,2,3].flatMap(trial => [
 {t:1,type:'checkpoint_end',data:{trial,cp:'pass',attempt:1,status:'ok'}},
 {t:2,type:'trial_answer',data:{trial,answers:{vehicles:null},unsure:{vehicles:true}}}
]);
const uncertain = F.summarizeSession('approaching_vehicle',allCountTrials);
assert.equal(uncertain.validAnswers,0); assert.notEqual(uncertain.status,'complete');
allCountTrials.filter(e=>e.type==='trial_answer').forEach(e=>e.data.answers.vehicles=2);
assert.equal(F.summarizeSession('approaching_vehicle',allCountTrials).status,'complete');
console.log('PASS: unknown counts retained but never counted as usable references');

const snapshotCode = ui.slice(ui.indexOf('function stampSession('),ui.indexOf('async function saveSession('));
const fieldRecording = {scene:'approaching_vehicle',events:allCountTrials};
const ctx = {fieldRecording,FC:F,now:()=>100,fieldStartedAt:0};
vm.createContext(ctx); vm.runInContext(snapshotCode,ctx);
const running = vm.runInContext('stampSession(false)',ctx);
const ended = vm.runInContext('stampSession(true)',ctx);
assert.equal(running.protocolComplete,true); assert.equal(running.sessionEnded,false);
assert.equal(running.lifecycleStatus,'in_progress'); assert.equal(running.completed,false);
assert.equal(ended.sessionEnded,true); assert.equal(ended.lifecycleStatus,'ended');
assert.equal(ended.completionStatus,'complete');
assert.ok(!ui.includes('snap.completed = true; download'));
console.log('PASS: snapshot lifecycle is separate from protocol completion');

assert.ok(!ui.includes("appVersion: 'V20.12'"));
assert.ok(ui.includes('document.title.match'));
console.log('PASS: export version derives from displayed release');

const cameraCode = html.slice(html.indexOf('async function startCamera()'),html.indexOf('function stopCamera()'));
(async () => {
 const permissionFailure = {videoStream:null,videoElement:{},navigator:{mediaDevices:{getUserMedia:async()=>{throw Error('denied')}}}, updateStatus:()=>{},speak:()=>{}};
 vm.createContext(permissionFailure); vm.runInContext(cameraCode,permissionFailure);
 assert.equal(await vm.runInContext('startCamera()',permissionFailure),false);
 const startCode = html.slice(html.indexOf('async function startApp('),html.indexOf('/* ============================================================================',html.indexOf('async function startApp(')));
 let monitorStarts=0, messages=[];
 const startup = {settingsScreen:{classList:{add(){}}},mainScreen:{classList:{remove(){}}},ensureAudioContext(){},initOrientationSensor(){},navigator:{},restoreCachedTransformersFlags:async()=>{},loadInstalledPacks:async()=>{},lifeMode:'walk',startCamera:async()=>false,stopLiveMonitoring(){},navHint:{},updateStatus:t=>messages.push(t),speak:t=>messages.push(t),keepScreenAwake(){throw Error('must not run')},startLiveMonitoring(){monitorStarts++}};
 vm.createContext(startup); vm.runInContext(startCode,startup);
 assert.equal(await vm.runInContext('startApp(true)',startup),false);
 assert.equal(monitorStarts,0); assert.ok(messages.every(t=>!t.includes('سند جاهز')));
 console.log('PASS: denied camera never starts monitoring or announces ready');
})().catch(e=>{console.error(e);process.exitCode=1;});

// Indoor calibration scene: chair at 4 m and 2 m, two trials; a missed chair stays a valid collection.
const so = F.plan('static_object');
assert.equal(so.trials.length, 2); assert.deepEqual(so.trials[0].checkpoints.map(c => c.distanceM), [4, 2]);
assert.equal(so.needsSeg, false); assert.equal(so.trials[0].checkpoints[0].minHoldMs, 10000);
const soCp = so.trials[0].checkpoints[0];
const soMiss = F.evaluateCheckpoint(soCp, [{t:0,type:'checkpoint_start',data:{actualDistanceM:4,distanceMethod:'tape'}},...Array.from({length:9},(_, i)=>({t:i*1200,type:'detection',data:{predictions:[]}}))], 0, 10500);
assert.equal(soMiss.ok, true); assert.equal(soMiss.detectionOutcome, 'target_not_observed');
assert.ok(html.includes('value="static_object"'));
console.log('PASS: indoor chair calibration scene');

// Edge-clipped boxes must not produce an invented numeric distance (field session V20.16: rug/table labelled "bed").
{
  const src = html, map = src.slice(src.indexOf('const LOCAL_OBJECT_MAP ='), src.indexOf('const ADE20K_CRITICAL ='));
  const fn = src.slice(src.indexOf('function estimateObjectDistance('), src.indexOf('function notifyCocoLoadFailure('));
  const sb = {}; vm.createContext(sb); vm.runInContext('const STEP_METERS=0.70;\n' + map + '\n' + fn, sb);
  const est = (p) => sb.estimateObjectDistance(p, 720, 1280);
  assert.equal(est({ class: 'bed', bbox: [24.5, 621.3, 684.3, 644.4] }), null);
  assert.equal(est({ class: 'bed', bbox: [-1.7, 691.6, 711.8, 566.9] }), null);
  const near = est({ class: 'dog', bbox: [200, 300, 250, 975] });
  assert.ok(near && near.clipped && !/\d/.test(near.text) && near.steps <= 2);
  assert.equal(est({ class: 'person', bbox: [200, 0, 250, 1280] }).raw, 0.7);
  const chair = est({ class: 'chair', bbox: [300, 440, 120, 399] });
  assert.ok(chair && !chair.clipped && Math.abs(chair.raw - 1.93) < 0.1);
  console.log('PASS: clipped boxes give no invented distance');
}
{
  // Unclipped person still uses the width-based estimate (unchanged behaviour).
  const sb2 = {}; vm.createContext(sb2);
  vm.runInContext('const STEP_METERS=0.70;\n' + html.slice(html.indexOf('const LOCAL_OBJECT_MAP ='), html.indexOf('const ADE20K_CRITICAL =')) + '\n' + html.slice(html.indexOf('function estimateObjectDistance('), html.indexOf('function notifyCocoLoadFailure(')), sb2);
  const p = sb2.estimateObjectDistance({ class: 'person', bbox: [200, 300, 250, 975] }, 720, 1280);
  assert.ok(p && !p.clipped && Number.isFinite(p.raw));
  console.log('PASS: width-based estimate for clipped-vertical person unchanged');
}

// Boxes spanning >=90% of frame width: no invented distance (field session V20.17: rug labelled "bed" estimated at 1.4-1.5 m).
{
  const sb3 = {}; vm.createContext(sb3);
  vm.runInContext('const STEP_METERS=0.70;\n' + html.slice(html.indexOf('const LOCAL_OBJECT_MAP ='), html.indexOf('const ADE20K_CRITICAL =')) + '\n' + html.slice(html.indexOf('function estimateObjectDistance('), html.indexOf('function notifyCocoLoadFailure(')), sb3);
  const e3 = p => sb3.estimateObjectDistance(p, 720, 1280);
  assert.equal(e3({ class: 'bed', bbox: [18, 703, 689, 382] }), null);
  assert.equal(e3({ class: 'bed', bbox: [16, 695, 692, 426] }), null);
  assert.equal(e3({ class: 'bed', bbox: [28, 684, 674, 582] }), null);
  const wideDog = e3({ class: 'dog', bbox: [20, 400, 690, 300] });
  assert.ok(wideDog && wideDog.clipped && !/\d/.test(wideDog.text));
  assert.ok(!e3({ class: 'chair', bbox: [300, 440, 120, 399] }).clipped);
  assert.equal(e3({ class: 'person', bbox: [200, 0, 250, 1280] }).raw, 0.7);
  console.log('PASS: full-width boxes give no invented distance');
}

// Range scene: chair at 3.5, 3 and 2.5 m, two trials, 10 s fixed windows; a miss stays valid.
{
  const rg = F.plan('static_object_range');
  assert.equal(rg.trials.length, 2); assert.deepEqual(rg.trials[0].checkpoints.map(c => c.distanceM), [3.5, 3, 2.5]);
  assert.equal(rg.totalCheckpoints, 6); assert.equal(rg.needsSeg, false);
  assert.ok(rg.trials[0].checkpoints.every(c => c.minHoldMs === 10000 && c.rule.classes[0] === 'chair'));
  const c0 = rg.trials[0].checkpoints[0];
  const miss = F.evaluateCheckpoint(c0, [{t:0,type:'checkpoint_start',data:{actualDistanceM:3.5,distanceMethod:'marks'}},...Array.from({length:9},(_, i)=>({t:i*1200,type:'detection',data:{predictions:[]}}))], 0, 10500);
  assert.equal(miss.ok, true); assert.equal(miss.detectionOutcome, 'target_not_observed');
  assert.ok(html.includes('value="static_object_range"'));
  console.log('PASS: range scene (2.5/3/3.5 m)');
}
