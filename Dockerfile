# syntax = docker/dockerfile:1

ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DIR=/data

COPY package-lock.json package.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data
VOLUME /data

EXPOSE 3000

CMD ["npm", "run", "start"]
