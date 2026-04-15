FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app/server

COPY server/package*.json ./

RUN npm ci --omit=dev

COPY server/ ./

EXPOSE 8080

CMD ["npm", "start"]