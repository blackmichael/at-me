FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/server ./src/server
RUN mkdir -p /app/data && chown -R node:node /app
ENTRYPOINT ["sh", "-c", "mkdir -p /app/data && chown -R node:node /app/data && exec su-exec node \"$@\"", "--"]


EXPOSE 3000
VOLUME ["/app/data"]

CMD ["./node_modules/.bin/tsx", "src/server/index.ts"]
