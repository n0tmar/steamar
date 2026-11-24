@echo off
rem Build the native shell into native\build\Release\SteaMar.exe
setlocal
cd /d "%~dp0.."
cmake -S native -B native\build -G "Visual Studio 17 2022" -A x64 || exit /b 1
cmake --build native\build --config Release || exit /b 1
echo.
echo built native\build\Release\SteaMar.exe
