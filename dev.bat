@echo off
chcp 65001 >nul
title Twitch Watcher - Режим разработки

echo ========================================
echo    Twitch Watcher - Режим разработки
echo ========================================
echo.

echo [INFO] Запускаю в режиме разработки (без сборки)...
echo.
call npm run dev

if errorlevel 1 (
    echo.
    echo [ERROR] Приложение завершилось с ошибкой!
    pause
    exit /b 1
)

pause

