#!/bin/bash

# Установка кодировки UTF-8
export LANG=ru_RU.UTF-8

echo "========================================"
echo "   Twitch Watcher - Прямой запуск"
echo "========================================"
echo ""

echo "[INFO] Устанавливаю зависимости..."
echo ""
npm install
if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Ошибка при установке зависимостей!"
    exit 1
fi

echo ""
echo "[SUCCESS] Зависимости успешно установлены!"
echo ""
echo "[INFO] Собираю проект..."
echo ""
npm run build
if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Ошибка при сборке проекта!"
    exit 1
fi

echo ""
echo "[SUCCESS] Проект успешно собран!"
echo ""
echo "[INFO] Запускаю приложение..."
echo ""
npm start

if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Приложение завершилось с ошибкой!"
    exit 1
fi

