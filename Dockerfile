FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8780
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8780/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
