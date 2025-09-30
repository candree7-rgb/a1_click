FROM mcr.microsoft.com/playwright:v1.45.0-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
