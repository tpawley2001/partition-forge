# Build environment for the PartitionForge offline engine rootfs.
FROM alpine:3.20

RUN apk add --no-cache \
        linux-lts \
        busybox \
        coreutils \
        util-linux \
        util-linux-misc \
        blkid \
        sfdisk \
        lsblk \
        e2fsprogs e2fsprogs-extra \
        ntfs-3g ntfs-3g-progs \
        dosfstools \
        exfatprogs \
        gptfdisk \
        jq \
        kmod \
        parted

# Keep only the drivers that can expose a disk; the full module tree would
# triple the image. Pruning by directory alone is not enough -- nvme_core pulls
# t10-pi, crc64, hwmon and configfs from elsewhere in the tree, and a module
# whose dependencies were pruned loads with "Unknown symbol" and no device. So
# the wanted set is expanded to its full dependency closure via modprobe before
# anything is deleted. modprobe needs -S: a container shares the host kernel, so
# it would otherwise resolve against the host's uname -r, not Alpine's.
RUN set -eux; \
    KV="$(ls /lib/modules | head -1)"; \
    cd "/lib/modules/$KV"; \
    find kernel/drivers/nvme kernel/drivers/ata kernel/drivers/scsi \
         kernel/drivers/usb kernel/drivers/virtio kernel/drivers/block \
         kernel/drivers/md kernel/drivers/mmc kernel/drivers/firewire \
         kernel/drivers/message kernel/fs kernel/lib kernel/crypto kernel/block \
         -name '*.ko*' 2>/dev/null \
      | sed 's|.*/||; s|\.ko.*$||' | sort -u > /tmp/wanted; \
    : > /tmp/keep.list; \
    while read -r m; do \
        modprobe -S "$KV" --show-depends --ignore-install "$m" 2>/dev/null \
          | awk '/^insmod /{print $2}' >> /tmp/keep.list || true; \
    done < /tmp/wanted; \
    sort -u /tmp/keep.list -o /tmp/keep.list; \
    echo "keeping $(wc -l < /tmp/keep.list) modules of $(find . -name '*.ko*' | wc -l)"; \
    mkdir -p /tmp/keep; \
    while read -r f; do \
        rel="${f#/lib/modules/$KV/}"; \
        mkdir -p "/tmp/keep/$(dirname "$rel")"; \
        cp -a "$f" "/tmp/keep/$rel"; \
    done < /tmp/keep.list; \
    rm -rf kernel; \
    cp -a /tmp/keep/kernel .; \
    rm -rf /tmp/keep /tmp/keep.list /tmp/wanted; \
    depmod -a "$KV"

# Trim things an initramfs will never touch. linux-lts drags in the whole
# linux-firmware set (~1.1 GB of GPU, wifi and NIC blobs); storage controllers
# that matter here -- AHCI, NVMe, USB mass storage, virtio -- need none of it.
RUN rm -rf /lib/firmware /usr/share/man /usr/share/doc /usr/share/info \
           /usr/share/zoneinfo /usr/share/terminfo \
           /var/cache/apk /usr/lib/python* /boot/System.map* /boot/config-*
