#!/bin/bash

# Установка кодировки UTF-8
export LANG=ru_RU.UTF-8

UPDATE_ONLY=false
if [ "${1:-}" = "--update-only" ]; then
  UPDATE_ONLY=true
  shift
fi

echo "========================================"
if [ "$UPDATE_ONLY" = true ]; then
  echo "   Twitch Watcher - Обновление (без запуска)"
else
  echo "   Twitch Watcher - Прямой запуск"
fi
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

if [ "$UPDATE_ONLY" = true ]; then
    echo ""
    echo "[INFO] Режим --update-only: запуск npm start пропущен"
    exit 0
fi

echo ""
echo "[INFO] Запускаю приложение..."
echo ""
npm start

if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Приложение завершилось с ошибкой!"
    exit 1
fi

