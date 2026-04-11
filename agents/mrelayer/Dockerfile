FROM node:21-alpine AS builder
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build

FROM node:21-alpine
WORKDIR /app
COPY --from=builder /app/build .
COPY package.json .
COPY package-lock.json .
RUN npm install --production
ENTRYPOINT [ "npm", "run" ]
CMD [ "start" ]