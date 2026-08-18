# Maintenance Policy

## Default Mode

- Observe, summarize, and recommend.
- Avoid changes unless explicitly approved.
- Prefer read-only APIs and status endpoints.
- Save reports under `reports/` for comparison over time.

## Requires Approval

- Rebooting any device.
- Updating TrueNAS, Home Assistant, Plex, router firmware, or add-ons.
- Restarting critical services.
- Editing router, firewall, DHCP, DNS, VPN, storage, snapshot, or backup settings.
- Deleting files, snapshots, backups, containers, jails, apps, or datasets.

## Escalation Notes

- TrueNAS storage warnings take priority over Plex convenience issues.
- Home Assistant availability takes priority if automations control safety-relevant devices.
- Router/DNS/DHCP issues can look like downstream failures; check gateway and DNS first.
