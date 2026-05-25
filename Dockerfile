FROM node:18-alpine

# DNS/HTTPS проверки в entrypoint
RUN apk add --no-cache bind-tools curl openssl

WORKDIR /usr/src/app

# Копируем файлы конфигурации
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
# sql.js не требует нативной компиляции, работает на WebAssembly
RUN npm install

# Копируем исходный код
COPY src ./src

# Компилируем TypeScript
RUN npm run build

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Убираем CRLF (Windows), иначе Alpine: exec ... no such file or directory
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
