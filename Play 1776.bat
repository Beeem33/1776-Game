@echo off
title 1776 - game server
echo Starting the 1776 battlefield server...
start "1776 server" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port 7761
timeout /t 2 /nobreak >nul
start "" http://localhost:7761
echo.
echo Game opened at http://localhost:7761
echo Keep the server window open while playing. Close it when done.
