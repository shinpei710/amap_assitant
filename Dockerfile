FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=5173
ENV CHROMIUM_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5173

CMD ["npm", "start"]
