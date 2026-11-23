#!/usr/bin/env python3
# Checks a zip made by a job that ran npm packages before the release workflow uses it in
# a job that doesn't. Every entry must sit inside Depleted.app/, with no absolute paths,
# "..", or control characters (a newline would split a path in a shell loop), every
# symlink must point inside the app without "..", and no entry may go through a symlink.
#
# The zip itself must be plain: nothing before the first entry or after the end record,
# no archive comment, entries that don't overlap, and each entry's local header naming
# the same file as the central directory. Two zip readers can disagree about an archive
# that breaks one of those rules; one that keeps them reads the same either way.
#
# With --extract DEST, the checked zip is also unpacked into DEST (which must not exist
# yet) by this same parser, so what gets unpacked is exactly what was checked: no second
# reader (ditto) sees the zip at all. Files get their permission bits without setuid,
# setgid, sticky or group/other write.
#
# Python's own modules only.
# Usage: python3 -I build/checkZip.py <zip> [--extract <dest>]

import os
import posixpath
import stat
import struct
import sys
import zipfile

ROOT = 'Depleted.app/'
LOCAL_HEADER = struct.Struct('<4sHHHHHIIIHH')
LOCAL_SIGNATURE = b'PK\x03\x04'
DESCRIPTOR_SIGNATURE = b'PK\x07\x08'
END = struct.Struct('<4sHHHHIIH')
END_SIGNATURE = b'PK\x05\x06'
ZIP64_LOCATOR = struct.Struct('<4sIQI')
ZIP64_LOCATOR_SIGNATURE = b'PK\x06\x07'
ZIP64_END = struct.Struct('<4sQHHIIQQQQ')
ZIP64_END_SIGNATURE = b'PK\x06\x06'


def fail(message):
    print(f'::error::checkZip: {message}')
    sys.exit(1)


def has_control_characters(text):
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in text)


def central_directory_bounds(raw, size):
    """Where the central directory starts and where the records after it end, from the
    end record at the very end of the file (so: no comment and no trailing data)."""
    if size < END.size:
        fail('the zip is too short')
    raw.seek(size - END.size)
    signature, disk, cd_disk, _, _, cd_size, cd_offset, comment_length = END.unpack(raw.read(END.size))
    if signature != END_SIGNATURE or comment_length != 0:
        fail('the zip has a comment or data after its end record')
    if disk != 0 or cd_disk != 0:
        fail('the zip spans several disks')
    records_start = size - END.size
    if cd_size == 0xFFFFFFFF or cd_offset == 0xFFFFFFFF:
        # Zip64: the locator sits right before the end record, the zip64 end record right
        # before the locator
        locator_at = records_start - ZIP64_LOCATOR.size
        raw.seek(locator_at)
        signature, _, zip64_end_at, _ = ZIP64_LOCATOR.unpack(raw.read(ZIP64_LOCATOR.size))
        if signature != ZIP64_LOCATOR_SIGNATURE:
            fail('the zip64 locator is missing')
        raw.seek(zip64_end_at)
        fields = ZIP64_END.unpack(raw.read(ZIP64_END.size))
        if fields[0] != ZIP64_END_SIGNATURE or zip64_end_at + 12 + fields[1] != locator_at:
            fail('the zip64 end record is not right before its locator')
        cd_size, cd_offset = fields[8], fields[9]
        records_start = zip64_end_at
    if cd_offset + cd_size != records_start:
        fail('the zip has data between its central directory and its end record')
    return cd_offset


def entry_end(raw, info, data_end):
    """Where an entry ends: after its data, or after its data descriptor if it has one."""
    if not info.flag_bits & 0x08:
        return data_end
    raw.seek(data_end)
    descriptor = raw.read(24)
    offset = 4 if descriptor.startswith(DESCRIPTOR_SIGNATURE) else 0
    if len(descriptor) < offset + 12:
        fail(f'{info.filename!r} has no data descriptor')
    (crc,) = struct.unpack_from('<I', descriptor, offset)
    if crc != info.CRC:
        fail(f'{info.filename!r} has a different CRC in its data descriptor')
    if struct.unpack_from('<II', descriptor, offset + 4) == (info.compress_size, info.file_size):
        return data_end + offset + 12
    if len(descriptor) >= offset + 20 and struct.unpack_from('<QQ', descriptor, offset + 4) == (info.compress_size, info.file_size):
        return data_end + offset + 20
    fail(f'{info.filename!r} has different sizes in its data descriptor')


def check_layout(zip_path, archive, entries):
    """The entries fill the file back to back from byte 0 to the central directory, and
    the central directory runs straight into the end records at the end of the file. Each
    local header matches its central directory entry."""
    if archive.comment:
        fail('the zip has a comment')
    size = os.path.getsize(zip_path)
    with open(zip_path, 'rb') as raw:
        cd_offset = central_directory_bounds(raw, size)
        position = 0
        for info in sorted(entries, key=lambda e: e.header_offset):
            if info.header_offset != position:
                fail(f'{info.filename!r} starts at byte {info.header_offset}, expected {position} (gap, overlap or prepended data)')
            raw.seek(info.header_offset)
            header = raw.read(LOCAL_HEADER.size)
            if len(header) != LOCAL_HEADER.size:
                fail(f'{info.filename!r} has no local header')
            signature, _, flags, method, _, _, crc, compressed, uncompressed, name_length, extra_length = LOCAL_HEADER.unpack(header)
            if signature != LOCAL_SIGNATURE:
                fail(f'{info.filename!r} has no local header')
            local_name = raw.read(name_length)
            central_name = info.orig_filename.encode('utf-8' if info.flag_bits & 0x800 else 'cp437')
            if local_name != central_name:
                fail(f'{info.filename!r} has a different name in its local header ({local_name!r})')
            if method != info.compress_type or flags != info.flag_bits:
                fail(f'{info.filename!r} has different flags or compression in its local header')
            if not flags & 0x08:
                if crc != info.CRC:
                    fail(f'{info.filename!r} has a different CRC in its local header')
                if compressed != 0xFFFFFFFF and (compressed, uncompressed) != (info.compress_size, info.file_size):
                    fail(f'{info.filename!r} has different sizes in its local header')
            data_end = info.header_offset + LOCAL_HEADER.size + name_length + extra_length + info.compress_size
            position = entry_end(raw, info, data_end)
        if position != cd_offset:
            fail(f'the last entry ends at byte {position}, the central directory starts at {cd_offset}')


def check(zip_path):
    archive = zipfile.ZipFile(zip_path)
    entries = archive.infolist()
    if not entries:
        fail('the zip is empty')
    check_layout(zip_path, archive, entries)
    names = set()
    folded = set()
    links = {}
    for info in entries:
        name = info.filename
        if '\\' in name or name.startswith('/') or has_control_characters(name):
            fail(f'bad entry name {name!r}')
        parts = name.rstrip('/').split('/')
        if any(part in ('', '.', '..') for part in parts):
            fail(f'bad entry name {name!r}')
        if not name.startswith(ROOT):
            fail(f'{name!r} is outside Depleted.app')
        if name.casefold() in folded:
            fail(f'{name!r} is in the zip twice')
        names.add(name)
        folded.add(name.casefold())
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            if name.endswith('/'):
                fail(f'symlink {name!r} is named like a folder')
            target = archive.read(info).decode('utf-8')
            # No '..' at all: lexically fine targets like 'up/../..' can still leave the
            # app once 'up' is itself a symlink, and Electron's links never need one
            if target == '' or target.startswith('/') or has_control_characters(target) or '..' in target.split('/'):
                fail(f'symlink {name!r} points at {target!r}')
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if not (resolved == 'Depleted.app' or resolved.startswith('Depleted.app/')):
                fail(f'symlink {name!r} points outside the app ({target!r})')
            # Case-folded: the runners' disks are case-insensitive
            links[name.rstrip('/').casefold()] = target
        elif stat.S_ISDIR(mode):
            if not name.endswith('/'):
                fail(f'folder {name!r} is not named like a folder')
        elif stat.S_ISREG(mode) or mode == 0:
            pass
        else:
            fail(f'{name!r} is not a file, folder or symlink')
    # Nothing may be unpacked through a symlink
    for name in names:
        parts = name.rstrip('/').casefold().split('/')
        for i in range(1, len(parts)):
            if '/'.join(parts[:i]) in links:
                fail(f'{name!r} goes through the symlink {"/".join(parts[:i])!r}')
    print(f'checkZip: {zip_path}: {len(names)} entries, {len(links)} symlinks, all inside Depleted.app')
    return archive, entries


def extract(archive, entries, dest):
    # A fresh folder, so nothing already there (a link planted beforehand) is followed
    os.mkdir(dest, 0o755)
    dest_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY)
    try:
        # Folders first, shallowest first, then files, then symlinks last: no entry goes
        # through a symlink (checked above), and none exists yet while files are written
        def kind(info):
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                return 2
            if stat.S_ISDIR(mode) or info.filename.endswith('/'):
                return 0
            return 1

        def make_parents(name):
            parts = name.rstrip('/').split('/')[:-1]
            for i in range(1, len(parts) + 1):
                try:
                    os.mkdir('/'.join(parts[:i]), 0o755, dir_fd=dest_fd)
                except FileExistsError:
                    pass

        count = 0
        for info in sorted(entries, key=lambda e: (kind(e), e.filename.count('/'), e.filename)):
            name = info.filename.rstrip('/')
            mode = info.external_attr >> 16
            permissions = stat.S_IMODE(mode) & 0o755
            make_parents(name)
            if kind(info) == 0:
                try:
                    os.mkdir(name, 0o755, dir_fd=dest_fd)
                except FileExistsError:
                    pass
                os.chmod(name, permissions or 0o755, dir_fd=dest_fd, follow_symlinks=False)
            elif kind(info) == 1:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dest_fd)
                with os.fdopen(fd, 'wb') as out, archive.open(info) as data:
                    # archive.open checks the local header's name; reading to the end
                    # checks the CRC
                    while True:
                        chunk = data.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                    os.fchmod(out.fileno(), permissions or 0o644)
            else:
                target = archive.read(info).decode('utf-8')
                os.symlink(target, name, dir_fd=dest_fd)
            count += 1
    finally:
        os.close(dest_fd)
    print(f'checkZip: unpacked {count} entries into {dest}')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) == 1:
        check(args[0])
    elif len(args) == 3 and args[1] == '--extract':
        archive, entries = check(args[0])
        extract(archive, entries, args[2])
    else:
        fail('usage: checkZip.py <zip> [--extract <dest>]')
