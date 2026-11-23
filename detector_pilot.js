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
  function remap(p,roi,cw,ch) {
    if (!valid(p.bbox)) return null;
    const b=p.bbox;
    // Partial objects touching the crop boundary cannot supply safe full-object geometry.
    if (b[0]<=cw*.02 || b[1]<=ch*.02 || b[0]+b[2]>=cw*.98 || b[1]+b[3]>=ch*.98) return null;
    return Object.assign({},p,{bbox:[roi.x+b[0]*roi.width/cw,roi.y+b[1]*roi.height/ch,b[2]*roi.width/cw,b[3]*roi.height/ch],detectionSource:'roi',roi:Object.assign({},roi)});
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
  function canvas(w,h) { const c=document.createElement('canvas');c.width=w;c.height=h;return c; }
  async function detect(model,video,options) {
    const o=options||{}, floor=o.floor===undefined?.25:o.floor, maxBoxes=o.maxBoxes||50;
    if (!(floor>=0 && floor<=APP_SCORE)) throw Error('Research floor must be between 0 and production score');
    const meta={revision:'roi-review-1',mode:o.dual?'pilot-full-plus-roi':'research-single',nmsIou:NMS_IOU,scoreFloor:floor,mergeIou:MERGE_IOU,roi:null,roiEdgeRejected:0,duplicates:0,conflicts:0,roiError:null};
    if (!o.dual) return {predictions:(await model.detect(video,maxBoxes,floor,NMS_IOU)).map(p=>Object.assign({},p,{detectionSource:'full'})),meta};
    const w=video.videoWidth,h=video.videoHeight;
    if (!(w>0 && h>0)) throw Error('Camera frame unavailable');
    // Freeze BOTH inputs before awaiting inference so passes see exactly the same instant.
    const frame=canvas(w,h),roi=centralRoi(w,h),crop=canvas(Math.round(roi.width),Math.round(roi.height));
    frame.getContext('2d').drawImage(video,0,0,w,h);
    crop.getContext('2d').drawImage(frame,roi.x,roi.y,roi.width,roi.height,0,0,crop.width,crop.height);
    meta.roi=roi;
    try {
      const full=await model.detect(frame,maxBoxes,floor,NMS_IOU);
      try {
        const candidates=await model.detect(crop,maxBoxes,floor,NMS_IOU);
        const mapped=candidates.map(p=>remap(p,roi,crop.width,crop.height));meta.roiEdgeRejected=mapped.filter(p=>!p).length;
        const joined=merge(full.filter(p=>valid(p.bbox)),mapped.filter(Boolean));
        meta.duplicates=joined.duplicates;meta.conflicts=joined.conflicts;
        return {predictions:joined.predictions,meta};
      } catch(e) {meta.roiError='roi_pass_failed';return {predictions:full.map(p=>Object.assign({},p,{detectionSource:'full'})),meta};}
    } finally { frame.width=frame.height=crop.width=crop.height=1; }
  }
  return {detect,remap,merge,centralRoi,iou,valid};
});
