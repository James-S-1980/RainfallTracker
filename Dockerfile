FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8768

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8768

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8768) + '/api/version').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
