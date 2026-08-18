set -eu
echo '== compose ps =='
cd /mnt/Plex/AppData/Stacks/immich
docker compose ps
echo '== health =='
docker inspect immich_server --format '{{json .State.Health}}'
echo
echo '== host time =='
date '+%F %T %Z %z %s'
ls -l /etc/localtime
readlink -f /etc/localtime || true
echo '== container time/node =='
docker exec immich_server sh -lc 'date "+%F %T %Z %z %s"; ls -l /etc/localtime; ls -lL /etc/localtime; readlink -f /etc/localtime || true; echo TZ=${TZ:-}; node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone); console.log(new Date().toString())"'
echo '== container curls =='
docker exec immich_server sh -lc 'for u in http://localhost:2283/api/server/ping http://127.0.0.1:2283/api/server/ping "http://[::1]:2283/api/server/ping"; do echo url=$u; curl -g -sS -m 5 "$u" || true; echo; done'
