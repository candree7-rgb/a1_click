FROM mcr.microsoft.com/playwright:v1.55.1-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
