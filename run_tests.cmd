@echo off
setlocal
cd /d "%~dp0"
for %%F in (pilot_regression.js placetest.js placeflowtest.js loadtest.js livetest.js fieldtest.js framingtest.js voicetest.js micstest.js objtest.js stagestest.js phase0test.js) do (
  echo.
  echo ===== Running %%F =====
  node "%%F"
  if errorlevel 1 (
    echo.
    echo FAILED: %%F
    exit /b 1
  )
)
echo.
echo All automated tests passed.
exit /b 0
