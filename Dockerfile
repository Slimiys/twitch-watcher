FROM node:18-alpine

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
