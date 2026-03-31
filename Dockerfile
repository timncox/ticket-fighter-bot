FROM node:24-slim AS build
WORKDIR /app

# Build the bot
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Build ticket-fighter (copy from sibling)
COPY ticket-fighter/package.json ticket-fighter/package-lock.json ticket-fighter/
RUN cd ticket-fighter && npm ci
COPY ticket-fighter/tsconfig.json ticket-fighter/
COPY ticket-fighter/src/ ticket-fighter/src/
RUN cd ticket-fighter && npm run build

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

# Ticket-fighter deps + dist
COPY ticket-fighter/package.json ticket-fighter/package-lock.json ticket-fighter/
RUN cd ticket-fighter && npm ci --omit=dev
COPY --from=build /app/ticket-fighter/dist ticket-fighter/dist/

# Install Playwright browsers
RUN cd ticket-fighter && npx playwright install chromium

RUN mkdir -p data
ENV TF_PATH=/app/ticket-fighter/dist/index.js
EXPOSE 3003
CMD ["node", "dist/server.js"]
