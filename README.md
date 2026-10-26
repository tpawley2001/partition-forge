# PartitionForge

> **Beta.** PartitionForge changes partition tables and moves data. Back up
> anything you care about first, and read `REVIEW.md` for what is and is not
> tested yet.

Open source disk and partition manager for Windows (Electron + React). Changes
are queued and previewed first; Windows applies what it can online, and work
that needs an unmounted volume (moves, deep shrinks) runs from a small Linux
UEFI engine on the next restart.

Download the installer from
[Releases](https://github.com/tpawley2001/partition-forge/releases/latest).
It is unsigned, so Windows SmartScreen warns on first run. The engine is not
signed for Secure Boot either, so restart-time operations need Secure Boot
turned off while they run.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check main and renderer |
| `npm test` | Planner/validation JS tests and offline-engine Python tests |
| `npm run mock` | Run against built-in sample disks (read-only) |
| `xvfb-run -a node scripts/smoke.mjs <dir>` | Drive the UI in sample mode and screenshot each step |
| `npm run dist:win` | Build the NSIS installer into `release/` |
| `tools/publish.sh "notes"` | Test, build, tag `v<version>` and create the GitHub release |
| `offline-engine/build-image.sh` | Rebuild `resources/offline/pfengine.efi` (not in git) |
| `offline-engine/test-qemu.sh` | Boot the engine in QEMU against a scratch disk image |

## Updates

Installed copies update from this repository's GitHub Releases (the `publish`
entry in `electron-builder.yml`). To release, bump `version` in `package.json`,
commit, then run `tools/publish.sh`.

The app checks 10 s after launch and every 6 h, downloads in the background,
and shows **Restart to update** in the toolbar. It never installs on its own.
The install is refused while a queue is executing or an offline job is staged:
an upgrade runs the old uninstaller, and the uninstaller removes
PartitionForge's firmware boot entry. From 0.2.0 on, the uninstaller skips that
step during an upgrade (`${isUpdated}` in `build/installer.nsh`).
`PF_UPDATE_URL` points a build at a generic feed instead, for testing.

## Resize limits

Windows' online shrink/grow limits (`Get-PartitionSupportedSize`) take
25–30 s per large NTFS volume. They are therefore not part of the disk list.
`supported-size.ps1` asks for them when the Resize dialog opens, and again for
each queued resize at Apply time.

## License

Copyright (c) 2026 Hillyard Tech. Licensed under GPL-3.0-or-later; see
`LICENSE`.
