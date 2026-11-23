# Upstream library

COCO-SSD 2.2.3, Apache License 2.0, copyright Google LLC.

Original exact source: https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.js
Original readme: https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/README.md
License text: https://www.apache.org/licenses/LICENSE-2.0.txt

Modified for this review: add optional nmsIou fourth argument to detect/infer and pass it as the IoU threshold, independently of minScore, to TensorFlow NMS. Calls omitting the fourth argument retain the original behavior. The original copyright/license header is retained. This is not an official upstream release. All model weights, labels and other library logic remain unchanged.

SHA256 of original source is recorded in UPSTREAM_SHA256.txt. The complete local fork is included for audit and to avoid patching minified CDN code or changing a global TensorFlow function.
