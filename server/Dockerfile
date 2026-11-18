FROM node:22-alpine
WORKDIR /app
COPY server ./server
RUN mkdir -p /data /app/.local && chown -R node:node /data /app/.local
USER node
ENV HOST=0.0.0.0 PORT=8787 RELAY_STATE_FILE=/data/relay-state.json
EXPOSE 8787
CMD ["node", "server/index.mjs"]
