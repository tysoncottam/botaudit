FROM node:22-slim

WORKDIR /app

# Refresh apt so Playwright's --with-deps can install system libraries
RUN apt-get update

COPY package*.json ./
RUN npm ci && rm -rf /var/lib/apt/lists/*

COPY . .

CMD ["node", "server.js"]
