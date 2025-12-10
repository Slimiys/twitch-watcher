@echo off
chcp 65001 >nul
title Twitch Watcher - Прямой запуск
setlocal

echo ========================================
echo    Twitch Watcher - Прямой запуск
echo ========================================
echo.

echo [INFO] Устанавливаю зависимости...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] Ошибка при установке зависимостей!
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Зависимости успешно установлены!
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

