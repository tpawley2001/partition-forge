"""Exercise actual init functions against ordinary temporary files, never disks."""
import pathlib
import subprocess
import tempfile
import unittest

SOURCE = (pathlib.Path(__file__).resolve().parents[1] / 'offline-engine/runner/init').read_text()


def function(name):
    start = SOURCE.index(name + '() {')
    end = SOURCE.index('\n}\n', start) + 3
    return SOURCE[start:end]


class OfflineTests(unittest.TestCase):
    def test_overlapping_copy_preserves_every_byte(self):
        # Covers shifts below dd's 1 MiB buffer, partial final chunks, both
        # directions, unchanged position and non-overlapping relocation.
        payload = bytes(range(256)) * (12 * 1024)
        for src, dst, size in [(0, 512, 2**21 + 123), (512, 0, 2**21 + 123),
                               (0, 0, 1024), (0, 2**21, 2**19)]:
            with self.subTest(src=src, dst=dst), tempfile.TemporaryDirectory() as tmp:
                path = pathlib.Path(tmp) / 'disk.bin'
                path.write_bytes(payload)
                subprocess.run(['sh', '-c', 'say() { :; }; sayn() { :; };\n' + function('copy_region') +
                                '\ncopy_region "$1" "$2" "$3" "$4"', 'test', str(path), str(src), str(dst), str(size)], check=True)
                expected = bytearray(payload)
                expected[dst:dst + size] = payload[src:src + size]
                self.assertEqual(path.read_bytes(), expected)

    def test_resize_move_copies_only_existing_data(self):
        script = '''
shrink_fs() { echo shrink "$2"; }
copy_region() { echo copy "$4"; }
set_part_geometry() { :; }
resolve_part() { echo /fake; }
grow_fs() { echo grow; }
''' + function('do_resize')
        for new_size, expected in [(2048, 'copy 1024\ngrow\n'), (512, 'shrink 512\ncopy 512\n')]:
            result = subprocess.run(['sh', '-c', script + f'\ndo_resize /fake /part 1 0 1024 4096 {new_size}'], capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, expected)

    def test_ext_shrink_uses_kibibytes(self):
        script = '''
fs_of() { echo ext4; }
e2fsck() { return 0; }
resize2fs() { echo "$2"; }
''' + function('shrink_fs') + '\nshrink_fs /fake 1048576'
        result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '1024K\n')

    def test_destination_validation_checks_live_neighbours(self):
        table = '{"partitiontable":{"sectorsize":512,"lastlba":16350,"partitions":[{"node":"/fake1","start":2048,"size":4096},{"node":"/fake2","start":8192,"size":2048}]}}'
        script = 'blockdev() { echo 8388608; }; sfdisk() { printf \'%s\\n\' \'' + table + '\'; };\n' + function('valid_geometry')
        for start, size, expected in [(1048576, 1048576, 0), (4194304, 1048576, 1), (1048577, 1048576, 1), (7340032, 2097152, 1)]:
            result = subprocess.run(['sh', '-c', script + f'\nvalid_geometry /fake {start} {size} /fake1'])
            self.assertEqual(result.returncode, expected)

    def test_duplicate_disk_identities_are_refused(self):
        script = '''
all_disks() { printf '/dev/fake1\\n/dev/fake2\\n'; }
disk_id() { echo same-id; }
cat() { echo 8192; }
''' + function('resolve_disk') + '\nresolve_disk same-id 4194304'
        result = subprocess.run(['sh', '-c', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')

    def test_result_json_escapes_all_strings(self):
        script = 'RESULTS=""; ABORTED=0;\n' + function('record') + '\nrecord \'id"\\test\' failed \'line1\nline2\'; printf \'[%s]\' "$RESULTS"'
        import json
        result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(data[0]['error'], 'line1\nline2')


if __name__ == '__main__':
    unittest.main()
