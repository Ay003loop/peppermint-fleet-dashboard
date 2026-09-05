FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding on install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080

# Runs the backend. Start the simulator as a second process/service pointed at
# this one via BACKEND_INGEST_URL / BACKEND_HTTP_URL (see docker-compose.yml
# and README.md) -- keeping them as separate containers matches the
# producer/consumer split the challenge asks for and means either can restart
# independently.
CMD ["node", "simulator.js"]
