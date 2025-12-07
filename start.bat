@echo off
chcp 65001 >nul
title Twitch Watcher
setlocal

echo ========================================
echo    Twitch Watcher - Запуск приложения
echo ========================================
echo.

REM Проверяем, существует ли папка dist
if not exist "dist" (
    echo [INFO] Папка dist не найдена. Запускаю сборку проекта...
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
)

REM Запускаем приложение
echo [INFO] Запускаю приложение...
echo.
npm start

REM Если приложение завершилось с ошибкой
if errorlevel 1 (
    echo.
    echo [ERROR] Приложение завершилось с ошибкой!
    exit /b 1
)

