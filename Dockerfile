FROM node:20-alpine AS build
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine
RUN apk add --no-cache tini
COPY --from=build /build/dist /app/dist
COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/package.json /app/
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3030
ENTRYPOINT ["tini", "--", "node", "/app/dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0"]
