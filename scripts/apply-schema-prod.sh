#!/usr/bin/env bash
set -euo pipefail

# Applies snapshot-prod-bootstrap.yaml to the production Directus.
# Run on droplet from /opt/midnight-be/ after first BE deploy.

cd "$(dirname "$0")/.."

if [ ! -f data/snapshot-prod-bootstrap.yaml ]; then
  echo "data/snapshot-prod-bootstrap.yaml not found - rsync it from local first"
  exit 1
fi

docker compose -f docker-compose.prod.yml exec -T directus mkdir -p /directus/data
docker compose -f docker-compose.prod.yml cp data/snapshot-prod-bootstrap.yaml directus:/directus/data/snapshot.yaml
docker compose -f docker-compose.prod.yml exec -T directus npx directus schema apply --yes /directus/data/snapshot.yaml

echo "Schema applied. Public role permissions still need to be set manually in admin UI (see DEPLOY.md P4.5)."
