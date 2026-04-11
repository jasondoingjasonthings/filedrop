@echo off
setlocal

echo [FileDrop] Building TypeScript...
call npm run build
if errorlevel 1 ( echo Build failed & exit /b 1 )

echo [FileDrop] Packaging exes...
cd build
call npm install
if errorlevel 1 ( echo npm install in build/ failed & exit /b 1 )

call npm run pkg:jason
if errorlevel 1 ( echo pkg:jason failed & exit /b 1 )

call npm run pkg:editor
if errorlevel 1 ( echo pkg:editor failed & exit /b 1 )

cd ..
echo.
echo Done.
echo   build\FileDrop-Jason-Setup.exe
echo   build\FileDrop-Editor-Setup.exe
