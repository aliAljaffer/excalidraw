FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile --network-timeout 600000 \
    && yarn cache clean

COPY --from=build /app/dist ./dist

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://localhost:8080/ || exit 1

CMD ["node", "dist/index.js"]
