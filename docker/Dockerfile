FROM node:20-alpine

WORKDIR /app

# better-sqlite3 需要编译依赖
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "start"]
