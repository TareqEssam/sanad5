# V20.21 — multi-pass research detector + far-range scene (SW v31)

Production behaviour is unchanged: normal operation is still one full-frame pass, same model, 0.56 score/IoU, max 10 boxes. Everything below runs only while recording a field session with the research checkbox ON. Not a navigation feature, not field-validated.

## Why
Hypothesis (user): COCO-SSD lite squeezes the whole 720x1280 frame to 300x300, so distant objects become small and the portrait frame is stretched about 1.8x horizontally (x 0.42, y 0.23), which can make a chair look like a bench. The old 50%x50% crop (360x640) enlarges ~2x but is squeezed the same way, so it does not remove the stretch. Not proven: the internal resize could not be inspected here, and the one "chair at 4 m" observation is not a controlled comparison.

## What the checkbox now does (revision `multi-pass-review-1`)
On ONE frozen frame, sequentially: full frame, then
1. `roi`: central 50%x50% crop (as in the previous pilot; still stretched).
2. `square`: min(w,h) square through the frame centre (720x720 of 720x1280). No stretch; the object is ~1.8x taller in model input than in the full pass.
3. `focus`: only when the full pass has a WEAK box (0.25 <= score < 0.56): one square crop around the best weak box (side ~2.2x the object, at least 35% of the short side, clamped to the frame). Skipped otherwise, so no extra cost when the full pass is already confident.

Every crop box is mapped back to full-frame pixels before merging and before the distance function; boxes within 2% of a crop edge are rejected. Merge rules are unchanged: production-qualified full-frame boxes win; weak full boxes do not block qualified crop boxes. A failing pass is isolated (`passErrors`), full-frame predictions always survive. CORRECTION (found in field review): decisions and speech during recording use the MERGED predictions >= 0.56, which include crop-derived boxes (`rawPreds = detectionRun.predictions`), not only full-frame boxes. With the checkbox ON the app therefore behaves differently from normal operation (e.g. it can announce 'chair' where the full pass only gave 'bench' or nothing).

Logs per detection (`detectorPilot`): `passes`, `passMs` per pass, `passBoxes` (pre-merge boxes per pass, top 6, full-frame coordinates), `edgeRejectedByPass`, `passErrors`, `focus` (trigger box, crop, zoom), `passSideLengths`. This gives a paired comparison on identical frames.

## How to read a session
`node analyze_multipass.js export.json [chair,bench,couch]` — per checkpoint window and pass: frames, frames with the seat family >=0.25 and >=0.56, labels, mean raw distance error, average ms. Same distance math as the app (loaded from index.html). The "family" is a convenience grouping; confirm with a sighted facilitator that those boxes are the chair.

## Caveats
- Up to 4 sequential inferences per tick; expect lower cadence while the checkbox is on. Check `passMs` and `gapSincePreviousDetectMs`.
- Mixed builds are not comparable (older logs used NMS IoU = score floor 0.25).
- A crop can change box edges or class; distance error must be judged per pass, on correct-class, uncut targets only.
- Keep the checkbox OFF for ordinary use.

## V20.21 addition
New scene `static_object_far`: chair at 6 m, 5 m, 4 m (two trials, 10 s fixed windows, floor marks measured from the lens to the front of the seat). Purpose: V20.20 field data (static_object_range, 2.5-3.5 m) showed crop passes finding the chair in 52/52 frames vs 18/52 for the full pass; this scene tests whether that holds farther and which crop (rectangular centre `roi` vs aspect-preserving `square`) holds up longer. Not a negative control: for that, run an existing range scene with the chair out of the frame and count extra boxes per pass.
