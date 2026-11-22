# Pilot fixes (review package applied)

Applied on top of sanad5-main (V20.14, SW v23). Release bumped to V20.18 and SW v27 so installed copies update. Not field-tested on a real phone.

1. Collection validity separated from detection success (protocol -> field-protocol-v4). A model miss is recorded as `target_not_observed`, not a failed collection.
2. Unknown counts are kept in the export but not counted as usable reference answers.
3. Export state unified: `protocolComplete`/`completionStatus` (protocol) vs `sessionEnded`/`lifecycleStatus` (lifecycle).
4. Exported `appVersion` is parsed from the page title instead of hardcoded V20.12.
5. Camera startup returns explicit readiness; denied camera or video failure no longer announces "ready".
6. Stale exact SW v22 assertion replaced by a version-syntax check.

Known follow-ups: patch 5 needs a real-phone test (videoWidth can be 0 right after play() on some devices); do not mix protocol v3 and v4 results; bump release/SW version when deploying.

7. New scene `static_object` (indoor chair calibration): one chair, two trials, checkpoints at 4 m then 2 m, 10 s fixed window each, tape/floor-mark reference required. Uses the existing COCO rule; a missed chair is a valid `target_not_observed` result.

8. `estimateObjectDistance`: a box touching one frame edge (vertically) no longer yields a numeric distance from its clipped height. Hazard classes (priority 3) are announced as near without a number (`clipped:true`); lower-priority classes return no distance. Motivation: field session on V20.16 announced "bed ahead, about 1.5 m" for a rug/table at the bottom of the frame while the real nearest object (a chair) was 4 m away. Boxes spanning the whole frame height keep the existing 0.7 m behaviour. Known trade-off: a real object cropped at the frame edge that is not a hazard class now gets no distance.

9. `estimateObjectDistance`: a box spanning >=90% of frame width gets no numeric distance (hazard classes: "near", no number; others: none). Covers the case missed by item 8 (box not touching top/bottom but spanning the full width, e.g. a rug/table labelled "bed" estimated at 1.4-1.5 m in a V20.17 field session). Not changed: the 0.92 factor, the 0.56 threshold, and the area-based wall alert (all need more field data).
