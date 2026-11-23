/* Sanad ROI research pilot. No network, image storage, or persistent opt-in. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SanadDetectorPilot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const APP_SCORE = 0.56, NMS_IOU = 0.56, MERGE_IOU = 0.5;
  function valid(b) { return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0; }
  function iou(a,b) {
    const area = Math.max(0, Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])) * Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
    return area / (a[2]*a[3]+b[2]*b[3]-area);
  }
  function centralRoi(w,h) { return { x:w*0.25, y:h*0.25, width:w*0.5, height:h*0.5 }; }
  function remap(p,roi,cw,ch,source) {
    if (!valid(p.bbox)) return null;
    const b=p.bbox;
    // Partial objects touching the crop boundary cannot supply safe full-object geometry.
    if (b[0]<=cw*.02 || b[1]<=ch*.02 || b[0]+b[2]>=cw*.98 || b[1]+b[3]>=ch*.98) return null;
    return Object.assign({},p,{bbox:[roi.x+b[0]*roi.width/cw,roi.y+b[1]*roi.height/ch,b[2]*roi.width/cw,b[3]*roi.height/ch],detectionSource:source||'roi',roi:Object.assign({},roi)});
  }
  function merge(full,roi) {
    // Never override a production-qualified full-frame detection with a crop hypothesis.
    // Research-only weak full detections must not suppress qualified crop detections.
    const strong=full.filter(p=>p.score>=APP_SCORE), weak=full.filter(p=>p.score<APP_SCORE);
    const kept=strong.map(p=>Object.assign({},p,{detectionSource:'full'})); let duplicates=0, conflicts=0;
    for (const p of roi.slice().sort((a,b)=>b.score-a.score)) {
      const match=kept.find(q=>iou(p.bbox,q.bbox)>MERGE_IOU);
      if (match) { duplicates++; if (match.class!==p.class) conflicts++; continue; }
      kept.push(p);
    }
    for (const p of weak) {
      if (!kept.some(q=>iou(p.bbox,q.bbox)>MERGE_IOU)) kept.push(Object.assign({},p,{detectionSource:'full'}));
    }
    return {predictions:kept.sort((a,b)=>b.score-a.score),duplicates,conflicts};
  }
  // Aspect-preserving square band through the middle of the frame (no 1.8x horizontal stretch when the model squeezes it to a square).
  function squareRoi(w,h) { const side=Math.min(w,h); return { x:(w-side)/2, y:(h-side)/2, width:side, height:side }; }
  // Square crop around one weak candidate (zoom about 2x of the candidate), clamped inside the frame.
  function focusRoi(w,h,box) {
    const m=Math.min(w,h), side=Math.min(m,Math.max(m*0.35,2.2*Math.max(box[2],box[3])));
    const x=Math.max(0,Math.min(w-side,box[0]+box[2]/2-side/2)), y=Math.max(0,Math.min(h-side,box[1]+box[3]/2-side/2));
    return { x:x, y:y, width:side, height:side };
  }
  function pickWeak(full) {
    let best=null;
    for (const p of full) if (valid(p.bbox) && p.score>=0.25 && p.score<APP_SCORE && (!best || p.score>best.score)) best=p;
    return best;
  }
  function brief(list) { return list.slice(0,6).map(p=>({class:p.class,score:Math.round(p.score*100)/100,bbox:p.bbox.map(v=>Math.round(v))})); }
  function now() { return typeof performance!=='undefined' && performance.now ? performance.now() : Date.now(); }
  function canvas(w,h) { const c=document.createElement('canvas');c.width=w;c.height=h;return c; }
  const KNOWN_PASSES=['roi','square','focus'];
  async function detect(model,video,options) {
    const o=options||{}, floor=o.floor===undefined?.25:o.floor, maxBoxes=o.maxBoxes||50;
    if (!(floor>=0 && floor<=APP_SCORE)) throw Error('Research floor must be between 0 and production score');
    const passes=(Array.isArray(o.passes)?o.passes:['roi']).filter(n=>KNOWN_PASSES.indexOf(n)>=0);
    const meta={revision:o.dual&&passes.length>1?'multi-pass-review-1':'roi-review-1',mode:o.dual?'pilot-full-plus-roi':'research-single',nmsIou:NMS_IOU,scoreFloor:floor,mergeIou:MERGE_IOU,roi:null,roiEdgeRejected:0,duplicates:0,conflicts:0,roiError:null,
      passes:o.dual?passes.slice():[],passMs:{},passBoxes:{},edgeRejectedByPass:{},passErrors:{},focus:null,passSideLengths:{}};
    if (!o.dual) return {predictions:(await model.detect(video,maxBoxes,floor,NMS_IOU)).map(p=>Object.assign({},p,{detectionSource:'full'})),meta};
    const w=video.videoWidth,h=video.videoHeight;
    if (!(w>0 && h>0)) throw Error('Camera frame unavailable');
    // Freeze the frame BEFORE awaiting inference so every pass sees exactly the same instant. Fixed crops are cut now; the focus crop is cut later from this frozen frame.
    const frame=canvas(w,h); frame.getContext('2d').drawImage(video,0,0,w,h);
    const jobs=[]; const made=[frame];
    function addJob(name,roi) {
      const c=canvas(Math.max(1,Math.round(roi.width)),Math.max(1,Math.round(roi.height)));
      c.getContext('2d').drawImage(frame,roi.x,roi.y,roi.width,roi.height,0,0,c.width,c.height); made.push(c);
      jobs.push({name:name,roi:roi,canvas:c}); meta.passSideLengths[name]=[Math.round(roi.width),Math.round(roi.height)];
    }
    if (passes.indexOf('roi')>=0) { const r=centralRoi(w,h); meta.roi=r; addJob('roi',r); }
    if (passes.indexOf('square')>=0) addJob('square',squareRoi(w,h));
    try {
      let t0=now();
      const full=(await model.detect(frame,maxBoxes,floor,NMS_IOU)).filter(p=>valid(p.bbox));
      meta.passMs.full=Math.round(now()-t0); meta.passBoxes.full=brief(full);
      if (passes.indexOf('focus')>=0) {
        const weak=pickWeak(full);
        if (weak) { const r=focusRoi(w,h,weak.bbox); meta.focus={trigger:{class:weak.class,score:Math.round(weak.score*100)/100,bbox:weak.bbox.map(v=>Math.round(v))},roi:{x:Math.round(r.x),y:Math.round(r.y),side:Math.round(r.width)},zoomVsShortSide:Math.round(Math.min(w,h)/r.width*100)/100}; addJob('focus',r); }
      }
      const mappedAll=[];
      for (const job of jobs) {
        t0=now();
        try {
          const cand=await model.detect(job.canvas,maxBoxes,floor,NMS_IOU);
          const mapped=cand.map(p=>remap(p,job.roi,job.canvas.width,job.canvas.height,job.name));
          meta.edgeRejectedByPass[job.name]=mapped.filter(p=>!p).length; meta.roiEdgeRejected+=meta.edgeRejectedByPass[job.name];
          const ok=mapped.filter(Boolean); meta.passBoxes[job.name]=brief(ok); mappedAll.push.apply(mappedAll,ok);
        } catch(e) { meta.passErrors[job.name]='pass_failed'; if (job.name==='roi') meta.roiError='roi_pass_failed'; }
        meta.passMs[job.name]=Math.round(now()-t0);
      }
      if (!mappedAll.length) return {predictions:full.map(p=>Object.assign({},p,{detectionSource:'full'})),meta};
      const joined=merge(full,mappedAll);
      meta.duplicates=joined.duplicates;meta.conflicts=joined.conflicts;
      return {predictions:joined.predictions,meta};
    } finally { for (const c of made) c.width=c.height=1; }
  }
  return {detect,remap,merge,centralRoi,squareRoi,focusRoi,pickWeak,iou,valid};
});
