FROM node:18-alpine

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

# Запускаем приложение
CMD ["npm","start"]
