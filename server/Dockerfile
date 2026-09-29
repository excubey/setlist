FROM node:24-alpine

# The static site, exactly the files the server serves. .well-known is copied
# by name: a dotdir is the one a wildcard COPY would be easiest to lose.
COPY index.html app.js styles.css /site/
COPY assets /site/assets
COPY .well-known /site/.well-known

COPY server /app

# The volume mounts over /data; creating it here, owned by node, is what lets a
# non-root process write to a fresh named volume on a read-only container.
RUN mkdir -p /data && chown node:node /data

USER node
ENV PORT=8080 DB_PATH=/data/links.db STATIC_ROOT=/site
CMD ["node","/app/server.js"]
