FROM oven/bun:1

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy application code
COPY src/ ./src/

# Runtime defaults for the long-running worker
ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.json
ENV DATABASE_PATH=/data/amc-monitor.db
ENV PORT=8080

# Expose a persistent volume for config and SQLite state
VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["bun", "src/cli.ts", "monitor", "--config", "/data/config.json", "--database", "/data/amc-monitor.db"]
