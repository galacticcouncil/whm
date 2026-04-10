FROM node:23-slim

WORKDIR /app

COPY dist/index.js .
COPY db.json ./data/db.json

CMD ["node", "index.js"]
