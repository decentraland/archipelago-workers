ARG RUN

FROM node:20-slim as builderenv

WORKDIR /app

# Install build dependencies required for native modules (e.g., uWebSockets.js)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libc6-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# build the app
COPY . /app
RUN yarn install --frozen-lockfile
RUN yarn build
RUN yarn test

# remove devDependencies, keep only used dependencies
RUN yarn install --prod --frozen-lockfile


########################## END OF BUILD STAGE ##########################

FROM node:20-slim

RUN apt-get update
RUN apt-get upgrade -y
RUN apt-get -y -qq install tini

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV production

ARG COMMIT_HASH=local
ENV COMMIT_HASH=${COMMIT_HASH:-local}

ARG CURRENT_VERSION=Unknown
ENV CURRENT_VERSION=${CURRENT_VERSION:-Unknown}

WORKDIR /app
COPY --from=builderenv /app /app

# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["tini", "--"]
# Run the program under Tini
CMD [ "/usr/local/bin/node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]
