# PartitionForge review — 2026-10-26

Reviewed the Electron main process and preload, operation planner and simulation,
React UI and dialogs, PowerShell enumeration/application/staging/collection,
Linux offline engine, build scripts, installer configuration, and dependency tree.
The working tree was entirely untracked when the review began. No commits,
publishing, installer deployment, or operations on personal data disks were performed.
Integration tests use newly created virtual disk images.

**Assessment:** the project has a useful separation between planning, execution,
and presentation, but it needs further work before release for general use on
real disks. Several paths previously advertised capabilities the engine does
not implement. Those paths now fail with explicit blockers.

## Implemented improvements

| Finding | Change |
| --- | --- |
| Overlapping moves can corrupt unread source bytes inside a `dd` chunk. | Limit chunks to the distance moved, preserve copy direction, and read full buffers. Test both directions with shifts smaller than a buffer. |
| A combined grow and move reads beyond the original partition. | Copy the smaller of the source and destination sizes, then grow the filesystem. |
| ext shrink uses a 4096-byte divisor with a 512-byte sector suffix. | Use explicit KiB sizes and stop when filesystem checks report uncorrected errors. |
| Partition-table rereads fail while the staging ESP is mounted. | Update the target kernel partition using `partx`, propagating failures. The QEMU test exposed this issue when a later operation saw stale geometry. |
| Offline moves/resizes trust stale partition and destination geometry. | Verify source size, logical sector size, destination bounds, and overlaps against the live table before writing. |
| Cloned disk IDs and sizes silently select the first drive. | Refuse ambiguous matches. |
| Resize-and-move bypasses overlap/bounds checks; malformed IPC can produce NaN/invalid targets. | Validate operation shapes, IDs, numeric ranges, target kinds, filesystem options, and actual geometry in the main process. |
| Online operations can target a replaced disk at the same Windows disk number. | Compare disk identity and partition geometry with the displayed snapshot before execution. Disable manual refresh while a queue holds that snapshot. |
| Renderer-supplied execution/defer flags influence scheduling. | Recompute execution metadata, status, and errors in the planner. |
| Repeated Apply calls and concurrent ESP mount/unmount operations can race. | Guard execution and serialize staging prechecks, execution, and result collection. |
| Mock mode enumerates sample disks but can still invoke real PowerShell or shutdown on Windows. | Refuse apply/reboot in the main process and return a read-only staging precheck. |
| Online work can complete before discovering an offline job cannot be staged. | Build the offline job and check prerequisites first; refuse another queue while a job is already staged. |
| Partially completed or staged work stays in the UI queue and can be replayed. | Clear attempted queues, retain results for inspection, refresh the live layout, and prevent further editing while work is staged. |
| Pending drive-letter work replays at startup without proving offline success or target identity. | Remove automatic replay; require explicit assignment after restart. Existing legacy files are left untouched and are not executed. |
| Populated-disk conversion changes identity without updating later job targets; boot moves promise nonexistent BCD repair. | Block populated-disk conversion and boot-disk moves until those capabilities are implemented. |
| 4Kn offline geometry is interpreted using hard-coded 512-byte units. | Refuse offline operations on disks with other logical sector sizes in both planner and engine. |
| Offline formatter silently ignores options or cannot provide the requested filesystem/letter. | Block ReFS formatting, full format/custom allocation size, and drive-letter assignment for offline creation. |
| Unknown filesystem shrinking can truncate data. | Refuse unknown filesystem shrink; offline resizing requires a supported filesystem. Preserve NTFS consistency/hibernation checks instead of clearing flags and forcing writes. |
| Simulation loses used-space accounting and reuses synthetic partition numbers. | Preserve used bytes, allocate unique preview IDs, clear wiped filesystem previews, and require creating partitions before editing them further. |
| Several UI actions can use stale state. | Wait for a matching plan/precheck before Apply; open double-click dialogs using the clicked target; handle reboot errors. |
| New-partition size can extend past an unaligned free region. | Compute capacity from the aligned start and end. Clamp resize minimum for small/full partitions. |
| PowerShell grow unnecessarily pipes a volume into another resize; RAW initialization uses the wrong command. | Remove the second resize and use `Initialize-Disk` for RAW disks. |
| Precheck accepts missing images or unknown/zero ESP free space. | Fail with explicit reasons; detect pending jobs and check firmware registration failures. |
| Offline result JSON does not escape control characters; fatal errors may report success; log is written to RAM. | Encode records with jq, mark fatal exits aborted, and persist engine.log beside result.json on the ESP. |
| Elevated Electron accepts arbitrary external URL schemes and IPC senders. | Allow HTTP(S) external links, deny renderer navigation/permission requests, and restrict IPC to the app's main frame. |
| Test scripts use a fixed scratch directory and recursively delete its contents. | Use a unique temporary directory; retain logs, result JSON, and virtual disk artifacts for diagnosis. |
| Dependency audit reports 22 vulnerable packages. | Apply fixes within existing version ranges; 14 findings remain (13 high, 1 critical), requiring major migrations. Vite is now 6.4.5 in the lockfile. |

## Remaining work, in priority order

1. **Upgrade and validate Electron and electron-builder.** The remaining audit
   findings include Electron itself and packaging dependencies, including tar.
   Electron is declared as a development dependency but supplies the shipped
   runtime, so these findings must not be dismissed as development-only. The
   audit proposes major upgrades; these were not forced into a disk-safety fix.
2. **Run native Windows integration and installer tests.** This review runs on
   Linux. PowerShell disk writes, UAC behavior, BCD/firmware registration,
   BitLocker/Fast Startup handling, signed installation, and reboot result
   collection need disposable Windows VMs and representative hardware. QEMU
   validates the Linux engine, not Windows' launch/staging path.
3. **Provide a recoverable offline-job lifecycle.** Staging writes job.json
   before all firmware setup finishes. A later failure can leave staged work
   requiring manual inspection. Add explicit inspect/cancel/re-arm actions,
   durable phase records, table backups, verified result persistence, and
   recovery instructions. In-place relocation is not power-loss atomic.
4. **Protect execution from application shutdown and ambiguous timeouts.** The
   app can close while changes are executing; killing a PowerShell host does
   not establish whether a Windows storage operation completed. Add a main
   process execution lifecycle, close prevention, and disk reconciliation
   after interruption before permitting another queue.
5. **Repair the installer cleanup.** The uninstall macro searches the
   description line from `bcdedit` rather than reliably resolving the boot
   entry's GUID, and does not remove staged job files on the ESP. Track the
   actual entry identity and clean up explicitly. Test localized Windows output.
6. **Implement disabled capabilities before re-enabling them.** Populated table
   conversion needs preserved/updated disk and partition identities and boot
   migration. Boot-disk relocation needs actual BCD/filesystem boot-reference
   repair. Deferred letter assignment needs successful job correlation and
   stable target resolution. 4Kn support needs sector-aware geometry throughout.
7. **Harden and document filesystem/platform support.** Surface encryption,
   dirty/hibernated state, unsupported filesystem growth, dynamic/LDM disks,
   RAID/storage spaces, MBR extended/logical partitions, label limits, and
   multiple ESPs. Test refusal paths as well as success paths. Overwrite passes
   cannot guarantee erasure of SSD remapped cells or snapshots.
8. **Improve the development workflow and automation.** `npm run dev` starts
   Vite but does not set PF_VITE_URL for Electron; a fresh checkout may load a
   missing or stale built renderer. Configure a ready-checked development URL
   and development CSP. Add CI for typecheck, build, regression tests, Windows
   packaging, and VM tests. Bundle the preload before enabling Electron sandbox.
9. **Improve accessibility and feedback.** Dialogs need focus trapping and
   restoration, form labels need associated controls, and map/table selection
   needs keyboard access. Show per-operation execution results and useful
   engine errors after the attempted queue has cleared. Buffer partial stdout
   lines in the PowerShell progress parser.

## Verification

Final results: typecheck and production build pass; 11 JavaScript and 6 Python
regression tests pass; the Electron smoke test passes; and the final QEMU run
passes with both operations done and all 24 file checksums preserved. The final
VM artifacts are at `/tmp/partitionforge-qemu.zkraWA`.

- `npm run typecheck` and `npm run build`.
- `npm test`: planner, validation, simulation, snapshot identity, offline job
  preparation, mixed-queue preflight, partial completion, and actual shell
  helper tests against ordinary temporary files.
- `xvfb-run -a node scripts/smoke.mjs /tmp/partitionforge-review-shots`:
  Electron UI selection, dialogs, preview, queue, staging refusal, confirmation
  gates, and main-process sample-mode apply/reboot refusal.
- `offline-engine/build-image.sh`: rebuilt resources/offline/pfengine.efi from
  the reviewed runner. This image is excluded by the existing .gitignore.
- `offline-engine/test-qemu.sh`: UEFI boot, NTFS shrink from 1024 to 700 MiB,
  move to offset 1285 MiB, result JSON, persisted engine log, and checksums of
  24 randomly generated files. Test artifacts are retained under
  `/tmp/partitionforge-qemu.*`.
- `npm audit fix`: 22 findings reduced to 14. No claim of a clean security audit.

No physical-disk destructive testing or native Windows packaging certification
is included in these checks.
