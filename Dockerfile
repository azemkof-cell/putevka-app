FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Moscow DB_PATH=/app/data/putevka.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
VOLUME /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
