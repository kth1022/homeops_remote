# TrueNAS Drive Inventory

Generated: 2026-08-01T20:06:27Z

Last updated after replacement start: 2026-08-01T21:09:12Z

Last updated after resilver completion: 2026-08-02T11:20:16Z

Purpose: map every TrueNAS pool vdev member to its serial number, model, and future physical bay position for drive replacement.

Verification sources:
- TrueNAS `pool.query` for pool, vdev, status, and ZFS GUID topology.
- TrueNAS `disk.query` for current disk serial, model, size, type, and LUN ID.
- Raw snapshot: `reports\truenas-drive-inventory-20260801T200627Z.json`.
- Post-swap raw snapshot: `reports\truenas-post-swap-inventory-20260801T210401Z.json`.

All bay positions provided so far have been recorded.

## Pool: Plex

Status: ONLINE (CORRUPT_DATA)
Detail: Replacement/resilver finished, but the scan reported 5 errors and TrueNAS reports data corruption; applications may be affected.

### Data vdevs

#### raidz1-0 (RAIDZ1, ONLINE)

| Bay | Disk | Status | Read Err | Write Err | Checksum Err | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Part path |
|---|---|---|---:|---:|---:|---|---|---:|---|---:|---|---|---|
| Bay 3 Slot 2 | sde | ONLINE | 0 | 0 | 0 | ST4000LM016-1N2170 | W801CTSX | 4.00 TB | HDD | 5400 | 61268382269324563 | 5000c5009c20363d | /dev/disk/by-partuuid/45ec3eba-579d-4f1d-b91e-33fbe53692cf |
| Bay 2 Slot 2 | sdc | ONLINE | 0 | 0 | 0 | WDC_WD40EZRZ-00GXCB0 | WD-WCC7K7TN6D4X | 4.00 TB | HDD | 5400 | 2039440071734523585 | 50014ee26549bc27 | /dev/disk/by-partuuid/dadbe384-1a08-4a0e-9785-df44affb8942 |
| Bay 3 Slot 3 | sda | ONLINE | 0 | 0 | 0 | ST4000LM024-2AN17V | WCK0VA4C | 4.00 TB | HDD | 5526 | 16089504853745623728 | 5000c500a9a8380d | /dev/disk/by-partuuid/e2b4d257-a8b9-455e-92e5-98f64c0bbea9 |

#### raidz1-1 (RAIDZ1, ONLINE)

| Bay | Disk | Status | Read Err | Write Err | Checksum Err | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Part path |
|---|---|---|---:|---:|---:|---|---|---:|---|---:|---|---|---|
| Bay 2 Slot 4 | sdi | ONLINE | 0 | 0 | 10 | HGST_HUS726040ALE610 | K3GRM6NL | 4.00 TB | HDD | 7200 | 3217438235617855646 | 5000cca25cca484b | /dev/disk/by-partuuid/81d4ddbe-95f4-4257-88b6-14c085e7d148 |
| Bay 3 Slot 4 | sdb | ONLINE | 0 | 0 | 0 | ST6000NM0115-1YZ110 | ZAD383P8 | 6.00 TB | HDD | 7200 | 16157668949035937306 | 5000c500af635c24 | /dev/disk/by-partuuid/a7b6277e-d15d-4e1e-9e07-906d656ee0ad |
| Bay 2 Slot 3 | sdg | ONLINE | 0 | 0 | 10 | HGST_HUS726040ALE610 | K3G7U93B | 4.00 TB | HDD | 7200 | 16515198987898439548 | 5000cca25cc38d8c | /dev/disk/by-partuuid/d3181e2b-deb4-4dd1-a61f-db918bb46c70 |

## Pool: PicCloud

Status: ONLINE (FEAT_DISABLED)
Detail: Some supported and requested features are not enabled on the pool. The pool can still be used, but some features are unavailable.

### Data vdevs

#### raidz1-0 (RAIDZ1, ONLINE)

| Bay | Disk | Status | Read Err | Write Err | Checksum Err | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Part path |
|---|---|---|---:|---:|---:|---|---|---:|---|---:|---|---|---|
| Bay 1 Slot 3 | sdk | ONLINE | 0 | 0 | 0 | WDC_WD30EZRX-00D8PB0 | WD-WMC4N0190712 | 3.00 TB | HDD |  | 5642822215483264126 | 50014ee603a1d91f | /dev/disk/by-partuuid/67a7881c-60a1-4cd6-9352-75ee34793545 |
| Bay 1 Slot 2 | sdj | ONLINE | 0 | 0 | 0 | WDC_WD30EZRX-00MMMB0 | WD-WCAWZ1608444 | 3.00 TB | HDD |  | 11466059954700775948 | 50014ee20668c53d | /dev/disk/by-partuuid/36a454a9-74e1-40e9-9cb9-460a80905390 |
| Bay 1 Slot 4 | sdf | ONLINE | 0 | 0 | 0 | ST3000DM001-1CH166 | W1F12V35 | 3.00 TB | HDD | 7200 | 16975227305337999510 | 5000c50051e56b54 | /dev/disk/by-partuuid/0bf07b31-9b69-4ec5-8118-f17511a6efb0 |

## Detected Disks Not In Current Pool Topology

| Bay | Disk | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Notes |
|---|---|---|---|---:|---|---:|---|---|---|
| Bay 3 Slot 1 | sdd | Micron_1100_SATA_256GB | 1744199FF55C | 0.26 TB | SSD |  |  | 500a0751199ff55c | Boot pool disk. |
| Bay 3 Slot 5 | sdh | ST4000VN008-2DR166 | ZGY40WTY | 4.00 TB | HDD | 5980 | 11894525610072226813 | 5000c500b4bd6468 | Visible in `disk.query` but no longer listed as a current pool vdev member in `pool.query`; old degraded member replaced by `ZAD383P8`. |

## Removed Drives

| Former Disk | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Notes |
|---|---|---|---:|---|---:|---|---|---|
| sdi | WDC_WD4000FYYZ-01UL1B1 | WD-WCC131436736 | 4.00 TB | HDD | 7200 | 5239645730310720278 | 50014ee20973c38f | Removed from chassis during failing-drive replacement prep. |
| sdh | ST4000VN008-2DR166 | ZGY40WTY | 4.00 TB | HDD | 5980 | 11894525610072226813 | 5000c500b4bd6468 | Old degraded Plex member replaced by `ZAD383P8`; still visible in `disk.query` but no longer active in `pool.query`. |

## Physical Bay Notes

| Bay | Slot | Model | Serial | Status | Notes |
|---|---:|---|---|---|---|
| Bay 1 | 1 |  |  | Empty |  |
| Bay 1 | 2 | WDC_WD30EZRX-00MMMB0 | WD-WCAWZ1608444 | Occupied | PicCloud `sdj` |
| Bay 1 | 3 | WDC_WD30EZRX-00D8PB0 | WD-WMC4N0190712 | Occupied | PicCloud `sdk` |
| Bay 1 | 4 | ST3000DM001-1CH166 | W1F12V35 | Occupied | PicCloud `sdf` |
| Bay 1 | 5 |  |  | Empty |  |
| Bay 2 | 1 |  |  | Empty |  |
| Bay 2 | 2 | WDC_WD40EZRZ-00GXCB0 | WD-WCC7K7TN6D4X | Occupied | Plex `sdc` |
| Bay 2 | 3 | HGST_HUS726040ALE610 | K3G7U93B | Occupied | Plex `sdg` |
| Bay 2 | 4 | HGST_HUS726040ALE610 / white-label WL4000GSA6472E | K3GRM6NL | Occupied | Plex `sdi`; user saw white-label model with serial covered |
| Bay 2 | 5 |  |  | Empty |  |
| Bay 3 | 1 | Micron_1100_SATA_256GB | 1744199FF55C | Occupied | Boot pool `sdd` |
| Bay 3 | 2 | ST4000LM016-1N2170 | W801CTSX | Occupied | Plex `sde` |
| Bay 3 | 3 | ST4000LM024-2AN17V | WCK0VA4C | Occupied | Plex `sda` |
| Bay 3 | 4 | ST6000NM0115-1YZ110 | ZAD383P8 | Occupied | Plex `sdb`; replacement member now active after resilver |
| Bay 3 | 5 | ST4000VN008-2DR166 | ZGY40WTY | Occupied | Visible as disk `sdh`; no longer active in Plex topology; former degraded/failing member |

## Verification Notes

- Pool vdev leaves found: 9 after replacement/resilver completion.
- Vdev leaves matched to model/serial data: 9.
- Unmatched vdev leaves: 0.
- Replacement started on 2026-08-01 at 21:08-21:09Z: `pool.replace` job 112 succeeded using replacement disk identifier `{serial_lunid}ZAD383P8_5000c500af635c24`.
- Replacement/resilver scan finished on 2026-08-02 at 06:01Z. TrueNAS reports `scan.errors = 5` and `status_code = CORRUPT_DATA`; do not treat the pool as clean until the affected files/data are investigated.
- First replacement attempt job 108 failed because the API rejected kernel disk name `sdb`; no resilver was started by that failed attempt.

The replaced `ZGY40WTY` member has been removed from the active Plex vdev table and preserved in replacement history.
