set -eu
cd /mnt/Plex/AppData/Stacks/immich
echo '== compose ps =='
docker compose ps
echo '== health =='
docker inspect immich_server --format '{{json .State.Health}}'
echo
echo '== db active =='
docker exec immich_postgres psql -U postgres -d immich -c "select pid, state, wait_event_type, wait_event, now()-query_start as age, left(query,120) as query from pg_stat_activity where state <> 'idle' order by age desc limit 8;"
echo '== logs =='
docker logs --since 8m immich_server 2>&1 | grep -E 'listening|schema drift|vchord|ERROR|Machine learning|migrations' | tail -n 120 || true
