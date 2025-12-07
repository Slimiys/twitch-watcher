FROM node:18-alpine

# Устанавливаем Chromium и необходимые библиотеки
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/* \
    && ln -s /usr/bin/chromium /usr/bin/chromium-browser || true

# Устанавливаем переменную окружения для Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /usr/src/app

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
