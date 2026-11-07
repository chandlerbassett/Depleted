#!/usr/bin/env python3
# Checks a zip made by a job that ran npm packages before the release workflow unpacks it
# in a job that doesn't. Every entry must sit inside Depleted.app/, with no absolute paths
# or "..", every symlink must point inside the app without "..", and no entry may go
# through a symlink. So unpacking it can't write outside the folder it's unpacked into. Python's own modules only.
# Usage: python3 -I build/checkZip.py <zip>

import posixpath
import stat
import sys
import zipfile

ROOT = 'Depleted.app/'


def fail(message):
    print(f'::error::checkZip: {message}')
    sys.exit(1)


def check(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        entries = archive.infolist()
        if not entries:
            fail('the zip is empty')
        names = set()
        folded = set()
        links = {}
        for info in entries:
            name = info.filename
            if '\\' in name or '\0' in name or name.startswith('/'):
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
                target = archive.read(info).decode('utf-8')
                # No '..' at all: lexically fine targets like 'up/../..' can still leave the
                # app once 'up' is itself a symlink, and Electron's links never need one
                if target.startswith('/') or '\0' in target or '..' in target.split('/'):
                    fail(f'symlink {name!r} points at {target!r}')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if not (resolved == 'Depleted.app' or resolved.startswith('Depleted.app/')):
                    fail(f'symlink {name!r} points outside the app ({target!r})')
                # Case-folded: the runners' disks are case-insensitive
                links[name.rstrip('/').casefold()] = resolved
            elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or mode == 0):
                fail(f'{name!r} is not a file, folder or symlink')
        # Nothing may be unpacked through a symlink
        for name in names:
            parts = name.rstrip('/').casefold().split('/')
            for i in range(1, len(parts)):
                if '/'.join(parts[:i]) in links:
                    fail(f'{name!r} goes through the symlink {"/".join(parts[:i])!r}')
    print(f'checkZip: {zip_path}: {len(names)} entries, {len(links)} symlinks, all inside Depleted.app')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        fail('usage: checkZip.py <zip>')
    check(sys.argv[1])
