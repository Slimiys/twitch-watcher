#!/bin/bash

# Установка кодировки UTF-8
export LANG=ru_RU.UTF-8

echo "========================================"
echo "   Twitch Watcher - Перезапуск Docker"
echo "========================================"
echo ""

echo "[INFO] Останавливаю контейнеры..."
echo ""
docker-compose down
if [ $? -ne 0 ]; then
    echo ""
    echo "[WARNING] Ошибка при остановке контейнеров (возможно, они уже остановлены)"
    echo ""
fi

echo ""
echo "[INFO] Собираю Docker образ..."
echo ""
docker-compose build
if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Ошибка при сборке Docker образа!"
    exit 1
fi

echo ""
echo "[SUCCESS] Docker образ успешно собран!"
echo ""
echo "[INFO] Запускаю контейнеры..."
echo ""
docker-compose up -d
if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Ошибка при запуске контейнеров!"
    exit 1
fi

echo ""
echo "[SUCCESS] Docker контейнеры успешно запущены!"
echo ""
echo "[INFO] Логи можно просмотреть в приложении Docker Desktop"
echo ""

