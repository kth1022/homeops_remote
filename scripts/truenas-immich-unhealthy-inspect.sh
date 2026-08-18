set -eu
echo '== server logs recent =='
docker logs --since 20m immich_server 2>&1 | tail -n 220
echo '== process cmdlines =='
docker exec immich_server sh -lc 'for p in /proc/[0-9]*; do pid=${p##*/}; if [ -r "$p/cmdline" ]; then tr "\0" " " < "$p/cmdline" | sed "s/^/$pid /"; echo; fi; done | head -n 80' || true
echo '== docker stats =='
docker stats --no-stream immich_server immich_machine_learning immich_postgres immich_redis
