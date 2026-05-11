#!/usr/bin/env bash
set -euo pipefail

# Exports Directus schema snapshot from local dev → midnight-be/data/snapshot-prod-bootstrap.yaml
# Run from midnight-be/ directory with docker compose up running.

cd "$(dirname "$0")/.."

if ! curl -sf http://localhost:8055/server/health > /dev/null; then
  echo "Local Directus not reachable at http://localhost:8055"
  echo "   Run: docker compose up -d"
  exit 1
fi

mkdir -p data

# Detect compose service name
SERVICE=$(docker compose ps --services | grep -i directus | head -1)
if [ -z "$SERVICE" ]; then
  echo "No directus service in docker compose ps"
  exit 1
fi

echo "Exporting schema snapshot via $SERVICE..."
docker compose exec -T "$SERVICE" npx directus schema snapshot --yes /tmp/snapshot.yaml
docker compose cp "$SERVICE":/tmp/snapshot.yaml data/snapshot-prod-bootstrap.yaml

echo "Saved -> midnight-be/data/snapshot-prod-bootstrap.yaml"
echo "On production: scp it up + docker compose exec directus npx directus schema apply --yes /directus/data/snapshot-prod-bootstrap.yaml"
ls -lh data/snapshot-prod-bootstrap.yaml
