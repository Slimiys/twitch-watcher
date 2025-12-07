@echo off
chcp 65001 >nul
title Twitch Watcher - Сборка и запуск

echo ========================================
echo    Twitch Watcher - Сборка и запуск
echo ========================================
echo.

echo [INFO] Собираю проект...
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Ошибка при сборке проекта!
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Проект успешно собран!
echo.
echo [INFO] Запускаю приложение...
echo.
call npm start

if errorlevel 1 (
    echo.
    echo [ERROR] Приложение завершилось с ошибкой!
    pause
    exit /b 1
)

pause

