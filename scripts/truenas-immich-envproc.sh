set -eu
cd /mnt/Plex/AppData/Stacks/immich
echo '== compose redacted =='
sed -E 's/(PASSWORD|PASS|SECRET|KEY|TOKEN):.*/\1: <redacted>/I; s/(PASSWORD|PASS|SECRET|KEY|TOKEN)=.*/\1=<redacted>/I' compose.yaml .env
echo '== proc cmdlines =='
docker exec immich_server sh -lc 'for p in /proc/[0-9]*; do pid=${p##*/}; if [ -r "$p/cmdline" ]; then tr "\0" " " < "$p/cmdline" | sed "s/^/$pid /"; echo; fi; done | head -n 120'
echo '== proc status names =='
docker exec immich_server sh -lc 'for p in /proc/[0-9]*; do pid=${p##*/}; if [ -r "$p/status" ]; then awk -v pid="$pid" "/^(Name|State|VmRSS|Threads):/{print pid, \$0}" "$p/status"; fi; done | head -n 160'
