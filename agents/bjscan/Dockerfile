FROM node:23-slim

WORKDIR /app

COPY dist/index.js .
COPY public ./public

EXPOSE 8080

CMD ["node", "index.js"]
