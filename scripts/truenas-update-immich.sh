set -eu
cd /mnt/Plex/AppData/Stacks/immich
echo "== before =="
docker compose ps
echo "== pull =="
docker compose pull
echo "== up =="
docker compose up -d --remove-orphans
echo "== after =="
docker compose ps
echo "== images =="
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}' | grep -E 'immich|valkey|REPOSITORY' || true
