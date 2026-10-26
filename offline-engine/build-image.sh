#!/usr/bin/env bash
# Builds the PartitionForge offline engine as a single UEFI executable
# (a Unified Kernel Image: stub + cmdline + kernel + initramfs in one PE file).
#
# Output: resources/offline/pfengine.efi
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/resources/offline"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STUB="${PF_STUB:-/usr/lib/systemd/boot/efi/linuxx64.efi.stub}"
CMDLINE="${PF_CMDLINE:-console=tty0 console=ttyS0,115200 panic=30 pf.engine=1}"
IMAGE=partitionforge-engine

command -v docker  >/dev/null || { echo "docker is required"; exit 1; }
command -v objcopy >/dev/null || { echo "binutils (objcopy) is required"; exit 1; }
[ -f "$STUB" ] || { echo "EFI stub not found at $STUB (install systemd-boot-efi)"; exit 1; }

mkdir -p "$OUT"

echo "==> Building engine rootfs"
docker build -q -t "$IMAGE" "$HERE" >/dev/null

echo "==> Exporting rootfs"
CID="$(docker create "$IMAGE" /bin/true)"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root"
docker export "$CID" | tar -x -C "$WORK/root"

KERNEL="$(ls "$WORK/root"/boot/vmlinuz-* | head -1)"
[ -f "$KERNEL" ] || { echo "no kernel in the image"; exit 1; }
cp "$KERNEL" "$WORK/vmlinuz"
KVER="$(ls "$WORK/root/lib/modules" | head -1)"
echo "    kernel $KVER ($(du -h "$WORK/vmlinuz" | cut -f1))"

echo "==> Assembling initramfs"
install -m 0755 "$HERE/runner/init" "$WORK/root/init"
rm -rf "$WORK/root/boot"
# initramfs needs these to exist as mount points before /init runs.
mkdir -p "$WORK/root"/{proc,sys,dev,run,tmp,pf}

( cd "$WORK/root" && find . -print0 | cpio --null --create --format=newc --quiet ) \
    | gzip -9 > "$WORK/initramfs.img"
echo "    initramfs $(du -h "$WORK/initramfs.img" | cut -f1)"

echo "==> Linking UEFI image"
printf '%s' "$CMDLINE" > "$WORK/cmdline"
cat > "$WORK/osrel" <<OSREL
NAME="PartitionForge Offline Engine"
ID=partitionforge
VERSION_ID=$(date -u +%Y%m%d)
PRETTY_NAME="PartitionForge Offline Engine"
OSREL

# Section addresses. These are the offsets systemd's own ukify uses, and they
# are load-bearing: packing the sections tightly just past the stub's own
# (which is what the arithmetic below would otherwise produce) yields an image
# whose kernel boots but whose initrd arrives corrupt -- the firmware hands the
# stub the right length at the wrong contents. .initrd is pushed further out if
# the kernel ever grows past the gap.
OFF_OSREL=0x20000
OFF_CMDLINE=0x30000
OFF_LINUX=0x2000000
OFF_INITRD=$(python3 -c "
import os,sys
linux=int('$OFF_LINUX',16); size=os.path.getsize('$WORK/vmlinuz')
end=linux+size
step=0x1000000
print(hex(max(0x3000000, -(-end // step) * step)))
")
echo "    .linux @ $OFF_LINUX  .initrd @ $OFF_INITRD"

objcopy \
    --add-section   .osrel="$WORK/osrel"          --change-section-vma .osrel="$OFF_OSREL" \
    --add-section .cmdline="$WORK/cmdline"        --change-section-vma .cmdline="$OFF_CMDLINE" \
    --add-section   .linux="$WORK/vmlinuz"        --change-section-vma .linux="$OFF_LINUX" \
    --add-section  .initrd="$WORK/initramfs.img"  --change-section-vma .initrd="$OFF_INITRD" \
    "$STUB" "$OUT/pfengine.efi"

# PF_KEEP=1 leaves the kernel and initramfs behind for direct -kernel/-initrd
# testing, which isolates packaging faults from image faults.
if [ "${PF_KEEP:-0}" = "1" ]; then
    mkdir -p "$OUT/.build"
    cp "$WORK/vmlinuz" "$WORK/initramfs.img" "$OUT/.build/"
    echo "    kept $OUT/.build/{vmlinuz,initramfs.img}"
fi

SIZE=$(stat -c%s "$OUT/pfengine.efi")
printf '==> %s  (%s)\n' "$OUT/pfengine.efi" "$(numfmt --to=iec "$SIZE")"
if [ "$SIZE" -gt $((90 * 1024 * 1024)) ]; then
    echo "WARNING: image is large; a 100 MB EFI system partition may not hold it."
fi
