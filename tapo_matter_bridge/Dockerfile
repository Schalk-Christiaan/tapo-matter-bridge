FROM node:22.11.0-alpine3.20
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.mjs ./
ENV MATTER_STORAGE_PATH=/data MATTER_LOG_LEVEL=notice
CMD ["node", "main.mjs"]
