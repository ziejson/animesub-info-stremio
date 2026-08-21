FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY addon.js ./

ENV NODE_ENV=production
ENV PORT=7000

EXPOSE 7000

CMD ["node", "addon.js"]