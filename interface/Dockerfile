FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node src ./src
COPY --chown=node:node interface ./interface
RUN mkdir -p /data && chown node:node /data

USER node
ENV PORT=8781
EXPOSE 8781
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8781/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "interface/src/server.mjs"]
