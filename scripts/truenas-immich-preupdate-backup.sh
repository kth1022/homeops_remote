set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stack=/mnt/Plex/AppData/Stacks/immich
backup="$stack/immich-db-preupdate-$stamp.dump"
snap="manual-immich-preupdate-$stamp"
echo "== database dump =="
docker exec immich_postgres pg_dump -U postgres -d immich -Fc > "$backup"
ls -lh "$backup"
echo "== snapshots =="
zfs snapshot -r "Plex@$snap"
zfs snapshot -r "PicCloud@$snap"
zfs list -t snapshot -o name,creation | grep "$snap"
echo "backup_file=$backup"
echo "snapshot_suffix=$snap"
