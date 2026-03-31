FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    # Playwright Chromium deps
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bot deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
COPY public/ public/

# Ticket-fighter (pre-built dist + deps)
COPY tf/package.json tf/package.json
RUN cd tf && npm install --omit=dev
COPY tf/dist/ tf/dist/

# Install Playwright browsers
RUN cd tf && npx playwright install chromium

RUN mkdir -p data
ENV TF_PATH=/app/tf/dist/index.js
EXPOSE 3003
CMD ["node", "dist/server.js"]
