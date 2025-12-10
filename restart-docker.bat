@echo off
chcp 65001 >nul
title Twitch Watcher - Перезапуск Docker
setlocal

echo ========================================
echo    Twitch Watcher - Перезапуск Docker
echo ========================================
echo.

echo [INFO] Останавливаю контейнеры...
echo.
docker-compose down
if errorlevel 1 (
    echo.
    echo [WARNING] Ошибка при остановке контейнеров (возможно, они уже остановлены)
    echo.
)

echo.
echo [INFO] Собираю Docker образ...
echo.
docker-compose build
if errorlevel 1 (
    echo.
    echo [ERROR] Ошибка при сборке Docker образа!
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Docker образ успешно собран!
echo.
echo [INFO] Запускаю контейнеры...
echo.
docker-compose up -d
if errorlevel 1 (
    echo.
    echo [ERROR] Ошибка при запуске контейнеров!
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Docker контейнеры успешно запущены!
echo.
echo [INFO] Логи можно просмотреть в приложении Docker Desktop
echo.

pause

