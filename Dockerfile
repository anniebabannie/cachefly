ARG NODE_ENV=production
FROM node:12-alpine

RUN apk update && apk add imagemagick && rm -rf /var/cache/apk/*
# RUN npm install -g yarn

WORKDIR /app

COPY package.json .
COPY yarn.lock .

RUN yarn install --production
#RUN npm install --production

COPY . .

EXPOSE 8000

CMD ["yarn", "ts-node", "index.ts"]