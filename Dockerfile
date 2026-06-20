FROM node:20-alpine

# Build-time deps for native modules (Baileys uses libssl / canvas)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .
RUN npm run build

# Sessions are stored on a Railway persistent volume mounted at /data/sessions
VOLUME ["/data/sessions"]

ENV NODE_ENV=production
ENV PORT=3001
ENV SESSIONS_DIR=/data/sessions

EXPOSE 3001

CMD ["node", "dist/index.js"]
