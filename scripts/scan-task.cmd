@echo off
rem Execução agendada do Free API Radar (Task Scheduler chama este arquivo).
setlocal
cd /d "%~dp0.."

set "NODE=node"
where node >nul 2>nul || set "NODE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"

"%NODE%" cli.js scan --notify >> "reports\task.log" 2>&1
exit /b %ERRORLEVEL%
