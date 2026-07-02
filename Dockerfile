FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY drizzle.config.js ./

CMD ["node", "src/app.js"]
