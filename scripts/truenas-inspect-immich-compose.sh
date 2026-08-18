set -eu
cd /mnt/Plex/AppData/Stacks/immich
echo '== pwd =='
pwd
echo '== files =='
ls -la
echo '== compose images/version vars =='
grep -nE 'image:|IMMICH_VERSION|DB_VECTOR_EXTENSION|machine-learning|postgres|redis|immich-server|restart:' compose.yaml .env 2>/dev/null | sed -E 's/(PASSWORD|PASS|SECRET|KEY|TOKEN)=.*/\1=<redacted>/I'
echo '== compose config services =='
docker compose config --services
echo '== compose ps =='
docker compose ps
echo '== disk =='
df -h /mnt/Plex /mnt/PicCloud
