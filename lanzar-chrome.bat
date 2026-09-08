@echo off
echo Iniciando Chrome para Celsia Internet...
echo NO CIERRES esta ventana mientras el servidor este corriendo.
echo.
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%~dp0chrome-celsia" ^
  --no-first-run ^
  --no-default-browser-check ^
  --window-size=900,920 ^
  about:blank
