#!/bin/sh
set -eu
cd "$(dirname "$0")"
node detector_pilot_test.js
node pilot_regression.js
node placetest.js
node placeflowtest.js
node loadtest.js
node livetest.js
node fieldtest.js
node framingtest.js
node voicetest.js
node micstest.js
node objtest.js
node stagestest.js
node phase0test.js
