# Sanad detection pilot, review package

Built against V20.19 / SW v28. Nothing has been deployed. This is an opt-in experiment, not a guarantee of detection or navigation safety.

## Does the crop change distance accuracy?

The crop must NOT be treated as a new full camera frame. This implementation maps every crop box back to the original 720×1280-style full-frame coordinate system before the existing distance function sees it. The regression proves identical object edges give identical raw distance, even when the crop canvas is scaled.

That prevents a coordinate error. It does not guarantee identical real-world accuracy: the model may put different edges around an object or assign a different class in the enlarged crop. Those changes affect the current size-based estimate. A crop touching an object is rejected near the crop boundary, rather than estimating distance from a partial body. Existing full-frame clipped-box limitations remain outside this patch.

## What changes

1. `coco_ssd_fixed_nms.js`: local, attributed fork of the exact COCO-SSD 2.2.3 library. An optional fourth `detect` argument separates NMS IoU from the score floor. Calls without that argument retain upstream semantics. TensorFlow and model weights are unchanged.
2. Normal operation: still full-frame only, same model, 0.56 score/IoU, maximum 10 boxes. No crop or research frame canvas is created.
3. Research recording, checkbox off: full-frame only, score floor 0.25, fixed IoU 0.56, maximum 50 retained boxes. High-score decisions are then limited to 10 as before. This corrects the old research IoU mismatch.
4. Research recording, checkbox on: freeze one full-resolution frame, then run that same frame and its central 50%-width × 50%-height crop sequentially. No image is stored or uploaded. The crop occupies 25% of frame area and gives central objects roughly 2× linear scale within the same internal 300×300 model input.
5. Crop boxes are rejected within 2% of any crop boundary; accepted boxes are remapped to original-frame pixels before merging, logging, ranking and distance geometry.
6. Merge uses IoU >0.5. Production-qualified full-frame boxes win overlapping crop hypotheses, even if the crop assigns a higher score or different class. Remaining crop candidates are processed by descending score. Weak full-frame boxes do not block qualified crop hypotheses. Conflicting class overlaps are counted, not silently renamed. Non-overlapping crop false positives remain possible.
7. If the crop pass fails, retain full-frame predictions and log a generic ROI failure marker. A full-frame inference failure still follows the existing failure handler.
8. The opt-in is latched into session metadata when recording starts. Changing the checkbox later does not change that session. It is not a saved preference and normal operation ignores it.
9. Each detection log includes mode, score floor, fixed NMS IoU, crop geometry, merge threshold, crop-edge rejection count, duplicate count, class-conflict count and ROI failure marker. Each retained box includes `detectionSource` and optional ROI geometry.
10. SW cache advances to v29 and includes both new JS assets. Title remains V20.19, with `detectorPilot.revision=roi-review-1` distinguishing these exports. Choose an official release version before any deployment.

## Install for review

Use a copy/branch of the exact baseline, not your only working project.

- `patched/` contains complete copies of every added or changed file, not the entire application. Overlay them together onto the original V20.19 project. Do not copy only index.html.
- Alternatively apply `patches/01-fixed-nms-library.patch` and then `patches/02-opt-in-roi-pilot.patch`, in that order, from the repository root using `git apply`.
- Stop if your baseline hashes differ. Rebase and review instead of forcing patches onto newer source.
- The dependency package includes only TensorFlow.js 4.20.0 for the new real-NMS Node regression. Run `npm ci` (or `npm ci --include=dev` if your environment excludes development dependencies), then `node detector_pilot_test.js`, and the existing tests via `run_tests.cmd` or `sh run_tests.sh`.
- Existing `placetest.js` had a frozen v28 assertion. It now accepts a valid version literal; `fieldtest.js` integration assertions now recognize the wrapper path. No behavioral test was removed.
- Review the mobile checkbox screenshot. Browser styling there was checked without CDN Tailwind, so it shows the readable fallback layout.
- Preserve `COCO_SSD_LICENSE.txt` and upstream attribution when redistributing the local library. `UPSTREAM.md` records exact provenance and the tiny vendor modification.

## Field validation with static_object_range

Stationary indoor testing only. Do not walk using this experiment, and do not use the crop as a substitute for the full-frame hazard pass.

1. Use a single current patched build for BOTH modes. Same phone/rear camera/zoom 1, same chair, pose, lighting and measured floor marks. Note chair dimensions and phone orientation. Calibrated marks or tape only for analysis.
2. Run `static_object_range` with the new checkbox OFF, then ON, then alternate order on a repeat to reduce fatigue/order effects. That scene already tests 3.5/3/2.5 m twice. Add a separate 2 m static-object control in the same build, because the range scene has no 2 m checkpoint.
3. Keep all windows, including misses. Export each session. Compare `detectorPilot.dualPass` in appConfig and per-detection mode/revision before pooling results. Mixed old/new NMS runs are not a controlled comparison.
4. Report per distance and mode: all processed frames, processing gaps/skipped ticks, chair candidates, chair >=0.56 frames, wrong-class bench/bed outputs, actual spoken decisions, ROI-edge rejections/conflicts, and raw distance errors only for matched, correct-class, uncut targets. A high-score box is not itself proof of correct class.
5. Check whether extra central detections are actually the chair using a sighted facilitator's observations. These exports contain no imagery and cannot alone prove object identity. Do not infer that all bench boxes are chair boxes.
6. Evaluate false positives and compute/heat/battery as well as recall. Sequential passes cost more inference time and can reduce frame cadence. No speed/range improvement is claimed until measured. Watch app inference durations and detection gaps.
7. Keep the feature OFF for ordinary use until repeated sessions show useful gain without extra wrong alerts or unacceptable latency. No universal success threshold is selected by this package.

## Test scope and caveats

The new suite runs the actual forked vendor inference postprocessing with real TensorFlow.js CPU NMS and mocked network outputs. It tests an overlap where old research IoU drops a production-qualified box. It checks fixed-IoU equivalence and tensor cleanup, remapping and distance invariance, scaled crop coordinates, dedup/class conflicts, boundary and malformed-box rejection, off-by-default wiring and ROI-failure fallback. The existing 12 suites also pass.

This is not a real-phone performance, accuracy or accessibility certification. No new training, no model replacement, no 0.92 tuning, no lowered production score, no raw images, and no modification of your supplied field-session exports. General clipped-distance handling and the older progress/documentation issues from the review are not bundled here.
