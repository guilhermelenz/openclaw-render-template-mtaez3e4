"""Offline full-directory backup and restore verification. Requires cryptography.
Stop every source writer before backup; --source-quiesced is an operator assertion,
not a process stopper. Include SQLite DB/WAL/SHM together. Never run backup against
an active disk. Optional --workspace creates ONLY source/.retirement-export and
excludes that newly created backup-output directory; no existing directory may
be excluded. A failed run leaves its partial encrypted output for inspection.
The random key is separate: keep it off Render in protected storage.
Only restore into a NEW directory. File modes and symlink targets are retained;
restored ownership belongs to the local user (original UID/GID remain in archive). Symlinks are preserved but created LAST so no
archive content is written through them. Absolute symlinks remain absolute; do not
run restored programs until deciding their target-host path mapping.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import struct
import tarfile
import tempfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding

MAGIC = b'S11FULLBACKUP01'
CHUNK = 1024 * 1024


def create_private(path):
    return os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb')


class EncryptWriter:
    def __init__(self, out, key, public):
        self.out, self.aes, self.number = out, AESGCM(key), 0
        wrapped = public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=MAGIC))
        self.header = MAGIC + struct.pack('>I', len(wrapped)) + wrapped + os.urandom(8)
        out.write(self.header)

    def _record(self, payload):
        counter = struct.pack('>I', self.number)
        encrypted = self.aes.encrypt(self.header[-8:] + counter, payload, self.header + counter)
        self.out.write(struct.pack('>I', len(encrypted)))
        self.out.write(encrypted)
        self.number += 1

    def write(self, data):
        for start in range(0, len(data), CHUNK):
            self._record(b'\x01' + data[start:start + CHUNK])
        return len(data)

    def finish(self):
        self._record(b'\x00')


class DecryptReader(io.RawIOBase):
    def __init__(self, source, private):
        self.source, self.number = source, 0
        prefix = source.read(len(MAGIC) + 4)
        if len(prefix) != len(MAGIC) + 4 or not prefix.startswith(MAGIC):
            raise ValueError('Invalid backup format')
        size = struct.unpack('>I', prefix[-4:])[0]
        if size != 384:
            raise ValueError('Invalid wrapped key')
        wrapped = source.read(size)
        self.header = prefix + wrapped + source.read(8)
        key = private.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=MAGIC))
        self.aes = AESGCM(key)
        self.buffer, self.finished = bytearray(), False

    def readable(self):
        return True

    def readinto(self, output):
        if not self.buffer and not self.finished:
            length = self.source.read(4)
            if len(length) != 4:
                raise ValueError('Truncated backup')
            size = struct.unpack('>I', length)[0]
            if not 17 <= size <= CHUNK + 17:
                raise ValueError('Invalid encrypted record')
            ciphertext = self.source.read(size)
            if len(ciphertext) != size:
                raise ValueError('Truncated backup')
            counter = struct.pack('>I', self.number)
            plain = self.aes.decrypt(self.header[-8:] + counter, ciphertext, self.header + counter)
            self.number += 1
            if plain == b'\x00':
                self.finished = True
                if self.source.read(1):
                    raise ValueError('Trailing backup content')
            elif plain[:1] == b'\x01' and len(plain) > 1:
                self.buffer.extend(plain[1:])
            else:
                raise ValueError('Invalid encrypted payload')
        size = min(len(output), len(self.buffer))
        output[:size] = self.buffer[:size]
        del self.buffer[:size]
        return size


def entries(root, exclude=None):
    yield root
    def walk(directory):
        for child in sorted(directory.iterdir()):
            if exclude is not None and child == exclude:
                continue
            yield child
            if child.is_dir() and not child.is_symlink():
                yield from walk(child)
    yield from walk(root)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK), b''):
            h.update(chunk)
    return h.hexdigest()


def metadata(path, name):
    s = path.lstat()
    item = {'name': name, 'mode': stat.S_IMODE(s.st_mode), 'mtime_ns': s.st_mtime_ns}
    if stat.S_ISLNK(s.st_mode):
        item.update(type='symlink', target=os.readlink(path))
    elif stat.S_ISREG(s.st_mode):
        item.update(type='file', size=s.st_size, sha256=digest(path))
    elif stat.S_ISDIR(s.st_mode):
        item.update(type='directory')
    elif stat.S_ISFIFO(s.st_mode):
        item.update(type='fifo')
    else:
        raise ValueError('Unsupported special file; stop runtime and inspect source')
    return item


def backup(source, output, public_key, source_quiesced=False, workspace=None):
    if not source_quiesced:
        raise ValueError('All source writers must be stopped first')
    source = Path(source).absolute()
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Source must be a directory, not a symlink')
    excluded = None
    if workspace is not None:
        excluded = Path(workspace).absolute()
        # One reserved top-level directory, created exclusively by this operation.
        # Never accept pre-existing directories: they may contain real user data.
        if excluded != source / '.retirement-export' or excluded.exists() or excluded.is_symlink():
            raise ValueError('Workspace must be the new reserved source/.retirement-export directory')
        if not Path(output).absolute().is_relative_to(excluded):
            raise ValueError('Output must be inside the reserved workspace')
    for path in (output, public_key):
        absolute = Path(path).absolute()
        if '..' in absolute.parts:
            raise ValueError('Parent traversal is forbidden')
        if absolute.is_relative_to(source) and not (excluded is not None and path == output and absolute.is_relative_to(excluded)):
            raise ValueError('Backup and key must be outside source except the reserved workspace')
    if excluded is not None:
        excluded.mkdir(mode=0o700)
    key = AESGCM.generate_key(bit_length=256)
    public = serialization.load_pem_public_key(Path(public_key).read_bytes())
    manifest = []
    with create_private(output) as out:
        encrypted = EncryptWriter(out, key, public)
        with tarfile.open(fileobj=encrypted, mode='w|gz', dereference=False, compresslevel=1) as archive:
            for path in entries(source, exclude=excluded):
                name = 'data' + ('/' + path.relative_to(source).as_posix() if path != source else '')
                before = metadata(path, name)
                info = archive.gettarinfo(str(path), arcname=name)
                # Store hardlinked regular files independently; no external link resolution.
                if before['type'] == 'file':
                    info.type, info.linkname, info.size = tarfile.REGTYPE, '', before['size']
                    with path.open('rb') as contents:
                        archive.addfile(info, contents)
                else:
                    archive.addfile(info)
                if metadata(path, name) != before:
                    raise ValueError('Source changed during backup')
                manifest.append(before)
            payload = json.dumps(manifest).encode()
            info = tarfile.TarInfo('backup-manifest.json')
            info.size, info.mode = len(payload), 0o600
            archive.addfile(info, io.BytesIO(payload))
        encrypted.finish()
        out.flush()
        os.fsync(out.fileno())
    return {'entries': len(manifest), 'encrypted_bytes': Path(output).stat().st_size, 'excluded_generated_workspace': '.retirement-export' if excluded is not None else None}


def safe_name(name):
    p = PurePosixPath(name)
    return p.parts and p.parts[0] == 'data' and not p.is_absolute() and '..' not in p.parts and str(p) == name


def restore_verify(backup_file, key_file, destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('Restore destination must not exist')
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.restore-', dir=destination.parent))
    manifest, names, links = None, set(), []
    try:
        with open(backup_file, 'rb') as source:
            decryptor = DecryptReader(source, serialization.load_pem_private_key(Path(key_file).read_bytes(), password=None))
            plain = io.BufferedReader(decryptor)
            with tarfile.open(fileobj=plain, mode='r|gz') as archive:
                for member in archive:
                    if member.name == 'backup-manifest.json':
                        if manifest is not None or not member.isfile() or member.size > 128 * CHUNK:
                            raise ValueError('Invalid backup manifest')
                        manifest = json.load(archive.extractfile(member))
                        continue
                    if manifest is not None or not safe_name(member.name) or member.name in names:
                        raise ValueError('Unsafe archive path or ordering')
                    names.add(member.name)
                    target = staging / member.name
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if member.isdir():
                        target.mkdir(exist_ok=True, mode=0o700)
                    elif member.isfile():
                        with create_private(target) as out:
                            shutil.copyfileobj(archive.extractfile(member), out, CHUNK)
                    elif member.issym():
                        links.append((target, member.linkname))
                    elif member.isfifo():
                        os.mkfifo(target, 0o600)
                    else:
                        raise ValueError('Unsupported archive entry')
            # tar EOF is not the authenticated envelope EOF. Drain to verify final tag.
            while plain.read(CHUNK):
                pass
            if not decryptor.finished:
                raise ValueError('Missing authenticated end marker')
        if manifest is None or len(manifest) != len(names) or {item['name'] for item in manifest} != names:
            raise ValueError('Archive inventory mismatch')
        for target, link in links:
            target.symlink_to(link)
        sqlite_verified = 0
        for item in manifest:
            path = staging / item['name']
            if item['type'] != 'file':
                continue
            with path.open('rb') as candidate:
                if candidate.read(16) != b'SQLite format 3\x00':
                    continue
            # Integrity checks use throwaway copies so WAL recovery cannot alter restore.
            with tempfile.TemporaryDirectory() as checkdir:
                check = Path(checkdir) / 'database'
                shutil.copyfile(path, check)
                for suffix in ('-wal', '-shm', '-journal'):
                    companion = Path(str(path) + suffix)
                    if companion.is_file() and not companion.is_symlink():
                        shutil.copyfile(companion, str(check) + suffix)
                with sqlite3.connect(check) as db:
                    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise ValueError('Restored SQLite integrity verification failed')
            sqlite_verified += 1
        for item in reversed(manifest):
            if not safe_name(item['name']):
                raise ValueError('Unsafe manifest path')
            path = staging / item['name']
            actual = metadata(path, item['name'])
            for key in ('type', 'size', 'sha256', 'target'):
                if actual.get(key) != item.get(key):
                    raise ValueError('Restored content does not match manifest')
            if not path.is_symlink():
                os.chmod(path, item['mode'])
                os.utime(path, ns=(item['mtime_ns'], item['mtime_ns']))
        if destination.exists():
            raise ValueError('Destination appeared during restore')
        staging.rename(destination)
        return {'verified_entries': len(names), 'restore_complete': True, 'sqlite_verified': sqlite_verified}
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def keygen(private_key, public_key):
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    with create_private(private_key) as out:
        out.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    with create_private(public_key) as out:
        out.write(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    return {'key_created': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest='command', required=True)
    b = commands.add_parser('backup')
    for name in ('source', 'output', 'public_key'):
        b.add_argument(name)
    b.add_argument('--source-quiesced', action='store_true', required=True)
    b.add_argument('--workspace', help='Create and exclude ONLY source/.retirement-export; directory must not exist')
    r = commands.add_parser('restore-verify')
    for name in ('backup_file', 'key_file', 'destination'):
        r.add_argument(name)
    k = commands.add_parser('keygen')
    k.add_argument('private_key'); k.add_argument('public_key')
    args = vars(p.parse_args())
    command = args.pop('command')
    try:
        result = {'backup': backup, 'restore-verify': restore_verify, 'keygen': keygen}[command](**args)
    except Exception:
        raise SystemExit('Backup operation failed; source unchanged. No private data displayed.')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
