set -eu
echo '== docker stats =='
docker stats --no-stream immich_server immich_machine_learning immich_postgres immich_redis
echo '== postgres activity summary =='
docker exec immich_postgres psql -U postgres -d immich -c "select state, wait_event_type, wait_event, count(*) from pg_stat_activity group by 1,2,3 order by count(*) desc;"
echo '== longest active queries =='
docker exec immich_postgres psql -U postgres -d immich -c "select pid, state, wait_event_type, wait_event, now()-query_start as age, left(query,160) as query from pg_stat_activity where state <> 'idle' order by age desc limit 10;"
echo '== locks waiting =='
docker exec immich_postgres psql -U postgres -d immich -c "select pid, locktype, relation::regclass, mode, granted from pg_locks where not granted limit 20;"
