FROM node:20-alpine AS builder

# Build-time deps for native modules (Baileys uses libssl / canvas)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps) so tsc is available
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3001
ENV SESSIONS_DIR=/data/sessions

EXPOSE 3001

CMD ["node", "dist/index.js"]
