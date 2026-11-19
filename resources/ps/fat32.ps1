# FAT32 formatter for volumes over 32 GB.
#
# Windows' own formatter (Format-Volume, format.com, the Explorer dialog)
# refuses FAT32 above 32 GB, but cameras, consoles, 3D printers and car stereos
# often accept nothing else on large SD cards. FAT32 itself goes to 2 TB with
# 512-byte sectors, so this writes the on-disk structures directly, following
# Microsoft's FAT specification (fatgen103): a 3-sector boot record plus FSInfo
# with backups at sectors 6-7, two FATs, and a single root directory cluster.
#
# Dot-source this file, then call
#   [PartitionForge.Fat32Formatter]::Format('\\?\Volume{guid}', 'LABEL', $expectedBytes, 32768)
# The volume must be a freshly created partition. It is locked for exclusive
# access, checked against the expected size, written, then dismounted so
# Windows mounts it again as FAT32.
#
# The C# below must compile under PowerShell 5.1's Add-Type (C# 5): no string
# interpolation, no ?. operator, no expression-bodied members.

if (-not ('PartitionForge.Fat32Formatter' -as [type])) {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PartitionForge {
public static class Fat32Formatter {
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const uint FSCTL_LOCK_VOLUME = 0x00090018;
    const uint FSCTL_UNLOCK_VOLUME = 0x0009001C;
    const uint FSCTL_DISMOUNT_VOLUME = 0x00090020;
    const uint FSCTL_ALLOW_EXTENDED_DASD_IO = 0x00090083;
    const uint IOCTL_DISK_GET_DRIVE_GEOMETRY = 0x00070000;
    const uint IOCTL_DISK_GET_PARTITION_INFO_EX = 0x00070048;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize,
        byte[] outBuf, uint outSize, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFilePointerEx(SafeFileHandle h, long distance, IntPtr newPos, uint method);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(SafeFileHandle h, byte[] buf, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FlushFileBuffers(SafeFileHandle h);

    static bool Ioctl(SafeFileHandle h, uint code, byte[] outBuf) {
        uint ret;
        return DeviceIoControl(h, code, IntPtr.Zero, 0, outBuf, outBuf == null ? 0 : (uint)outBuf.Length, out ret, IntPtr.Zero);
    }

    static void Fail(string what) {
        int err = Marshal.GetLastWin32Error();
        throw new Win32Exception(err, what + " (" + new Win32Exception(err).Message + ")");
    }

    static void WriteAt(SafeFileHandle h, long byteOffset, byte[] buf, int count) {
        if (!SetFilePointerEx(h, byteOffset, IntPtr.Zero, 0)) Fail("Seek failed");
        uint written;
        if (!WriteFile(h, buf, (uint)count, out written, IntPtr.Zero) || written != (uint)count) Fail("Write failed");
    }

    static void PutU16(byte[] b, int at, uint v) { b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); }
    static void PutU32(byte[] b, int at, uint v) {
        b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); b[at + 2] = (byte)(v >> 16); b[at + 3] = (byte)(v >> 24);
    }

    /** FAT sectors needed for one FAT (fatgen103's FAT32 formula, rounded up). */
    public static uint FatSectors(ulong totalSectors, uint reserved, uint sectorsPerCluster, uint bytesPerSector) {
        ulong numerator = 4UL * (totalSectors - reserved);
        ulong denominator = (ulong)sectorsPerCluster * bytesPerSector + 4UL * 2;
        return (uint)(numerator / denominator + 1);
    }

    /** 11-byte FAT label: upper case ASCII, illegal characters replaced, space padded. */
    public static byte[] FatLabel(string label) {
        byte[] b = Encoding.ASCII.GetBytes("NO NAME    ");
        if (string.IsNullOrEmpty(label)) return b;
        string bad = "\"*+,./:;<=>?[\\]|";
        string up = label.ToUpperInvariant();
        for (int i = 0; i < 11; i++) {
            if (i >= up.Length) { b[i] = 0x20; continue; }
            char c = up[i];
            b[i] = (c < 0x20 || c > 0x7E || bad.IndexOf(c) >= 0) ? (byte)'_' : (byte)c;
        }
        return b;
    }

    public static string Format(string volumePath, string label, long expectedBytes, int clusterBytes) {
        SafeFileHandle h = CreateFileW(volumePath, GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h.IsInvalid) Fail("Cannot open " + volumePath);
        bool locked = false;
        try {
            for (int i = 0; i < 20 && !locked; i++) {
                locked = Ioctl(h, FSCTL_LOCK_VOLUME, null);
                if (!locked) Thread.Sleep(500);
            }
            if (!locked) Fail("The new volume is in use by another program and could not be locked");
            Ioctl(h, FSCTL_ALLOW_EXTENDED_DASD_IO, null);

            byte[] geo = new byte[24];
            if (!Ioctl(h, IOCTL_DISK_GET_DRIVE_GEOMETRY, geo)) Fail("Cannot read the disk geometry");
            uint bps = BitConverter.ToUInt32(geo, 20);
            uint tracksPerCyl = BitConverter.ToUInt32(geo, 12);
            uint sectorsPerTrack = BitConverter.ToUInt32(geo, 16);

            byte[] pi = new byte[144];
            if (!Ioctl(h, IOCTL_DISK_GET_PARTITION_INFO_EX, pi)) Fail("Cannot read the partition geometry");
            long start = BitConverter.ToInt64(pi, 8);
            long length = BitConverter.ToInt64(pi, 16);

            // Refuse to touch anything other than the partition that was just made.
            if (length != expectedBytes)
                throw new InvalidOperationException("The volume is " + length + " bytes but the new partition is " +
                    expectedBytes + " bytes; refusing to write.");
            if (bps != 512 && bps != 1024 && bps != 2048 && bps != 4096)
                throw new InvalidOperationException("Unsupported sector size " + bps + ".");

            ulong totalSectors = (ulong)length / bps;
            if (totalSectors > 0xFFFFFFFFUL)
                throw new InvalidOperationException("FAT32 cannot address a volume this large.");
            uint spc = (uint)Math.Max(1, clusterBytes / (int)bps);
            if (spc > 128 || (spc & (spc - 1)) != 0)
                throw new InvalidOperationException("Invalid cluster size " + clusterBytes + ".");

            // Start the data area on a 4 MiB boundary (the SD erase-block size),
            // padding the reserved area to get there. A FAT sized for the smaller
            // reserved count is always big enough for the larger one.
            uint reserved = 32;
            uint fatSz = FatSectors(totalSectors, reserved, spc, bps);
            uint align = (uint)(4 * 1024 * 1024 / bps);
            uint rem = (reserved + 2 * fatSz) % align;
            if (rem != 0) reserved += align - rem;
            if (reserved > 0xFFFF) throw new InvalidOperationException("Reserved area too large.");

            ulong dataStart = reserved + 2UL * fatSz;
            ulong clusters = (totalSectors - dataStart) / spc;
            if (clusters < 65525) throw new InvalidOperationException("The volume is too small for FAT32.");
            if (clusters > 0x0FFFFFF5) throw new InvalidOperationException("Too many clusters for FAT32; use a larger cluster size.");
            if ((ulong)fatSz * bps / 4 < clusters + 2) throw new InvalidOperationException("FAT size calculation error.");

            // Clear the reserved area, both FATs and the root directory cluster.
            byte[] zero = new byte[1024 * 1024];
            long clearBytes = (long)(dataStart + spc) * bps;
            for (long off = 0; off < clearBytes; off += zero.Length)
                WriteAt(h, off, zero, (int)Math.Min(zero.Length, clearBytes - off));

            // --- boot sector
            byte[] bs = new byte[bps];
            bs[0] = 0xEB; bs[1] = 0x58; bs[2] = 0x90;
            Encoding.ASCII.GetBytes("MSWIN4.1").CopyTo(bs, 3);
            PutU16(bs, 11, bps);
            bs[13] = (byte)spc;
            PutU16(bs, 14, reserved);
            bs[16] = 2;                                   // FAT copies
            bs[21] = 0xF8;                                // fixed media
            PutU16(bs, 24, Math.Min(sectorsPerTrack == 0 ? 63u : sectorsPerTrack, 0xFFFFu));
            PutU16(bs, 26, Math.Min(tracksPerCyl == 0 ? 255u : tracksPerCyl, 0xFFFFu));
            PutU32(bs, 28, (uint)Math.Min((ulong)start / bps, 0xFFFFFFFFUL));  // hidden sectors
            PutU32(bs, 32, (uint)totalSectors);
            PutU32(bs, 36, fatSz);
            PutU32(bs, 44, 2);                            // root directory cluster
            PutU16(bs, 48, 1);                            // FSInfo sector
            PutU16(bs, 50, 6);                            // backup boot sector
            bs[64] = 0x80;                                // drive number
            bs[66] = 0x29;                                // extended boot signature
            DateTime now = DateTime.Now;
            uint volId = (uint)((now.Month << 8 | now.Day) + (now.Second << 8 | now.Millisecond / 10)) << 16
                       | (uint)((now.Hour << 8 | now.Minute) + now.Year);
            PutU32(bs, 67, volId);
            byte[] lab = FatLabel(label);
            lab.CopyTo(bs, 71);
            Encoding.ASCII.GetBytes("FAT32   ").CopyTo(bs, 82);
            bs[510] = 0x55; bs[511] = 0xAA;

            // --- FSInfo
            byte[] fsi = new byte[bps];
            PutU32(fsi, 0, 0x41615252);
            PutU32(fsi, 484, 0x61417272);
            PutU32(fsi, 488, (uint)(clusters - 1));       // root dir uses one cluster
            PutU32(fsi, 492, 3);                          // next free cluster hint
            PutU32(fsi, 508, 0xAA550000);

            // --- third boot sector: only its signature
            byte[] bs3 = new byte[bps];
            bs3[510] = 0x55; bs3[511] = 0xAA;

            foreach (uint baseSec in new uint[] { 0, 6 }) {
                WriteAt(h, (long)baseSec * bps, bs, (int)bps);
                WriteAt(h, (long)(baseSec + 1) * bps, fsi, (int)bps);
                WriteAt(h, (long)(baseSec + 2) * bps, bs3, (int)bps);
            }

            // --- first sector of each FAT: media, reserved, root dir end-of-chain
            byte[] fat = new byte[bps];
            PutU32(fat, 0, 0x0FFFFFF8);
            PutU32(fat, 4, 0x0FFFFFFF);
            PutU32(fat, 8, 0x0FFFFFFF);
            WriteAt(h, (long)reserved * bps, fat, (int)bps);
            WriteAt(h, (long)(reserved + fatSz) * bps, fat, (int)bps);

            // --- root directory: volume label entry (Windows reads the label here)
            if (!string.IsNullOrEmpty(label)) {
                byte[] root = new byte[bps];
                lab.CopyTo(root, 0);
                root[11] = 0x08;
                uint t = (uint)(now.Hour << 11 | now.Minute << 5 | now.Second / 2);
                uint d = (uint)((now.Year - 1980) << 9 | now.Month << 5 | now.Day);
                PutU16(root, 22, t); PutU16(root, 24, d);
                WriteAt(h, (long)dataStart * bps, root, (int)bps);
            }

            if (!FlushFileBuffers(h)) Fail("Flush failed");
            Ioctl(h, FSCTL_DISMOUNT_VOLUME, null);
            return "FAT32: " + clusters + " clusters of " + (spc * bps) + " bytes, " + fatSz + " sectors per FAT, " + reserved + " reserved";
        } finally {
            if (locked) Ioctl(h, FSCTL_UNLOCK_VOLUME, null);
            h.Dispose();
        }
    }
}
}
'@
}
