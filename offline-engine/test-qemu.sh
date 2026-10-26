#!/usr/bin/env bash
# End-to-end test of the offline engine: builds a GPT disk with an ESP and an
# NTFS volume holding known data, stages a shrink + move, boots the engine
# under OVMF, then verifies the table moved and the data survived intact.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EFI="$ROOT/resources/offline/pfengine.efi"
WORK="$(mktemp -d "${PF_TESTDIR:-/tmp}/partitionforge-qemu.XXXXXX")"
IMG="$WORK/disk.img"
MNT="$WORK/mnt"
MIB=1048576

[ -f "$EFI" ] || { echo "build the engine first: ./offline-engine/build-image.sh"; exit 1; }

cleanup() {
    sudo umount "$MNT" 2>/dev/null || true
    [ -n "${LOOP:-}" ] && sudo losetup -d "$LOOP" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$MNT"
echo "Test artifacts: $WORK"

echo "==> Creating a 4 GiB GPT test disk"
truncate -s 4G "$IMG"

# ESP at 1 MiB (260 MiB), NTFS at 261 MiB (1024 MiB), the rest unallocated.
ESP_OFF=$((1 * MIB));            ESP_SZ=$((260 * MIB))
NT_OFF=$((261 * MIB));           NT_SZ=$((1024 * MIB))

sudo sgdisk --clear \
    --new=1:$((ESP_OFF/512)):+$((ESP_SZ/512)) --typecode=1:ef00 --change-name=1:ESP \
    --new=2:$((NT_OFF/512)):+$((NT_SZ/512))  --typecode=2:0700 --change-name=2:DATA \
    "$IMG" >/dev/null

LOOP="$(sudo losetup --find --partscan --show "$IMG")"
echo "    loop $LOOP"
sleep 1

echo "==> Formatting"
sudo mkfs.vfat -F 32 -n ESP "${LOOP}p1" >/dev/null
sudo mkfs.ntfs -Q -L DATA "${LOOP}p2" >/dev/null

echo "==> Writing known payload to the NTFS volume"
sudo mount "${LOOP}p2" "$MNT"
sudo mkdir -p "$MNT/payload"
for i in $(seq 1 24); do
    sudo dd if=/dev/urandom of="$MNT/payload/file$i.bin" bs=1M count=6 status=none
done
sudo sh -c "find '$MNT/payload' -type f -exec md5sum {} + | sed 's|$MNT/||' | sort -k2" > "$WORK/before.md5"
BEFORE_COUNT=$(wc -l < "$WORK/before.md5")
sudo umount "$MNT"
echo "    $BEFORE_COUNT files checksummed"

DISK_GUID="$(sudo blkid -p -o value -s PTUUID "$LOOP" | tr 'A-Z' 'a-z')"
echo "    disk PTUUID $DISK_GUID"

# The plan: shrink DATA 1024 -> 700 MiB, then slide it 1 GiB further along.
NEW_SZ=$((700 * MIB))
NEW_OFF=$((1285 * MIB))

echo "==> Staging job.json on the ESP"
sudo mount "${LOOP}p1" "$MNT"
sudo mkdir -p "$MNT/EFI/BOOT" "$MNT/EFI/PartitionForge"
sudo cp "$EFI" "$MNT/EFI/BOOT/BOOTX64.EFI"
sudo tee "$MNT/EFI/PartitionForge/job.json" >/dev/null <<JSON
{
  "version": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "operations": [
    {
      "id": "op-shrink",
      "kind": "resize",
      "description": "Shrink DATA to 700 MB",
      "disk":      { "id": "$DISK_GUID", "size": $(stat -c%s "$IMG") },
      "partition": { "offset": $NT_OFF, "size": $NT_SZ },
      "params":    { "newSize": $NEW_SZ }
    },
    {
      "id": "op-move",
      "kind": "move",
      "description": "Move DATA to the 1285 MB mark",
      "disk":      { "id": "$DISK_GUID", "size": $(stat -c%s "$IMG") },
      "partition": { "offset": $NT_OFF, "size": $NEW_SZ },
      "params":    { "newOffset": $NEW_OFF }
    }
  ]
}
JSON
sudo umount "$MNT"
sudo losetup -d "$LOOP"; LOOP=""

echo "==> Booting the engine under OVMF (this takes a minute)"
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$WORK/vars.fd"
set +e
timeout 300 qemu-system-x86_64 \
    -machine q35,accel=tcg -m 2048 -smp 2 -no-reboot -nographic \
    -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,unit=1,file="$WORK/vars.fd" \
    -drive file="$IMG",format=raw,if=none,id=hd0 \
    -device virtio-blk-pci,drive=hd0 \
    > "$WORK/serial.log" 2>&1
QEMU_RC=$?
set -e
echo "    qemu exited $QEMU_RC"

echo
echo "==> Engine output"
sed -n '/Scanning for staged work/,$p' "$WORK/serial.log" | tail -60 || true

echo
echo "==> Verifying result"
LOOP="$(sudo losetup --find --partscan --show "$IMG")"
sleep 1

FAILED=0
sudo mount "${LOOP}p1" "$MNT"
sudo cp "$MNT/EFI/PartitionForge/result.json" "$WORK/result.json"
sudo cp "$MNT/EFI/PartitionForge/engine.log" "$WORK/engine.log"
if jq -e '.aborted == 0 and (.results | length == 2) and all(.results[]; .status == "done")' "$WORK/result.json" >/dev/null; then
    echo '    engine result:      all operations done'
else
    echo '    engine result:      FAILED'; cat "$WORK/result.json"; FAILED=1
fi
sudo umount "$MNT"
ACTUAL_OFF=$(( $(sudo cat /sys/block/$(basename "$LOOP")/$(basename "$LOOP")p2/start) * 512 ))
ACTUAL_SZ=$(( $(sudo cat /sys/block/$(basename "$LOOP")/$(basename "$LOOP")p2/size) * 512 ))
printf '    partition 2 offset: %s (expected %s) ' "$ACTUAL_OFF" "$NEW_OFF"
[ "$ACTUAL_OFF" -eq "$NEW_OFF" ] && echo "OK" || { echo "MISMATCH"; FAILED=1; }
printf '    partition 2 size:   %s (expected %s) ' "$ACTUAL_SZ" "$NEW_SZ"
[ "$ACTUAL_SZ" -eq "$NEW_SZ" ] && echo "OK" || { echo "MISMATCH"; FAILED=1; }

printf '    filesystem:         '
if sudo mount -o ro "${LOOP}p2" "$MNT" 2>/dev/null; then
    echo "mounts OK"
    sudo sh -c "find '$MNT/payload' -type f -exec md5sum {} + | sed 's|$MNT/||' | sort -k2" > "$WORK/after.md5"
    AFTER_COUNT=$(wc -l < "$WORK/after.md5")
    printf '    payload:            %s of %s files, ' "$AFTER_COUNT" "$BEFORE_COUNT"
    if diff -q "$WORK/before.md5" "$WORK/after.md5" >/dev/null; then
        echo "all checksums match OK"
    else
        echo "CHECKSUM MISMATCH"; diff "$WORK/before.md5" "$WORK/after.md5" | head; FAILED=1
    fi
    sudo umount "$MNT"
else
    echo "WILL NOT MOUNT"; FAILED=1
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit $FAILED
