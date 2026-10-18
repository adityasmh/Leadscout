# Leadscout container image (OPTIONAL: plain `npm install && npm start` is the primary way to run it).
# Uses node:24-alpine and runs the TypeScript sources directly with tsx (no build step).
# tsx is installed globally because the sources import ".js" specifiers that point at ".ts" files.

FROM node:24-alpine

WORKDIR /app

# Install tsx globally (pinned) so we can run the TypeScript sources without a build step.
RUN npm install -g tsx@4.23.15

# Copy application source, static files and manifest. No build step.
COPY package.json ./
COPY src ./src
COPY plugins ./plugins
COPY adapters ./adapters
COPY data ./data
COPY public ./public

# Create the persistent data directory and make it writable by the non-root node user.
RUN mkdir -p /data && chown -R node:node /data

# Default runtime environment.
ENV LEADSCOUT_DB=/data/leadscout.db
ENV LEADSCOUT_PORT=8790
ENV LEADSCOUT_HOST=0.0.0.0

# Declare the persistent database volume.
VOLUME /data

# Run as the non-root node user.
USER node

# Expose the default Leadscout port.
EXPOSE 8790

# Health check: hit the local health endpoint. Does not use any external integration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LEADSCOUT_PORT||8790)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Start the server (matches package.json "start" script).
CMD ["tsx", "src/server.ts"]
