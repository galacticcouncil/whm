FROM node:25-slim

WORKDIR /app

COPY dist/index.js .
COPY public ./public

EXPOSE 8080

CMD ["node", "index.js"]
