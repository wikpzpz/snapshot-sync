@echo off
REM One push, for Windows Task Scheduler.
REM   schtasks /create /tn "the API push" /sc minute /mo 3 /tr "\"%CD%\scripts\push-once.cmd\"" /f
REM   schtasks /delete /tn "the API push" /f
cd /d "%~dp0.."
node --experimental-strip-types src/push.ts >> .watch.log 2>&1
