# Install deps on the native build platform
FROM --platform=$BUILDPLATFORM node:25-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

FROM node:25-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY dist/index.js ./index.js
COPY public ./public

EXPOSE 8080

CMD ["node", "index.js"]
