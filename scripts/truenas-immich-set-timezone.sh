set -eu
cd /mnt/Plex/AppData/Stacks/immich
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp .env ".env.pre-tz-$stamp"
if grep -q '^TZ=' .env; then
  sed -i 's#^TZ=.*#TZ=America/New_York#' .env
else
  printf '\nTZ=America/New_York\n' >> .env
fi
echo '== redacted env =='
sed -E 's/(PASSWORD|PASS|SECRET|KEY|TOKEN)=.*/\1=<redacted>/I' .env
echo '== recreate immich-server =='
docker compose up -d --force-recreate immich-server
echo '== ps after recreate =='
docker compose ps
