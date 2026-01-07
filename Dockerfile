FROM node:18-alpine

WORKDIR /usr/src/app

# Устанавливаем зависимости для сборки нативных модулей (better-sqlite3)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev

# Копируем файлы конфигурации
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY src ./src

# Компилируем TypeScript
RUN npm run build

# Запускаем приложение
CMD ["npm","start"]
