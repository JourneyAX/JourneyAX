import { inflateRawSync } from 'node:zlib';
import { compareKnowledgeKeys } from './checksum';

export type OkfBundleFiles = Record<string, Uint8Array>;

export const OKF_ARCHIVE_LIMITS = {
  files: 2000,
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  archiveBytes: 72 * 1024 * 1024,
  ratio: 100,
  depth: 12,
} as const;

const decoder = new TextDecoder('utf-8', { fatal: true });

export function safeOkfPath(input: string): string {
  if (!input || input.includes('\\') || input.includes('\0') || input.startsWith('/') || /^[a-z]:/i.test(input)) {
    throw new Error(`Unsafe OKF path: ${input}`);
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || parts.length > OKF_ARCHIVE_LIMITS.depth) {
    throw new Error(`Unsafe OKF path: ${input}`);
  }
  return input;
}

export function validateOkfFiles(files: OkfBundleFiles): OkfBundleFiles {
  const entries = Object.entries(files);
  if (entries.length > OKF_ARCHIVE_LIMITS.files) throw new Error('OKF bundle exceeds file-count limit');
  let total = 0;
  const result: OkfBundleFiles = Object.create(null);
  for (const [name, bytes] of entries) {
    safeOkfPath(name);
    if (!(bytes instanceof Uint8Array)) throw new Error(`Invalid OKF file: ${name}`);
    if (bytes.length > OKF_ARCHIVE_LIMITS.fileBytes) throw new Error(`OKF file exceeds size limit: ${name}`);
    total += bytes.length;
    if (total > OKF_ARCHIVE_LIMITS.totalBytes) throw new Error('OKF bundle exceeds total size limit');
    if (/\.(?:zip|tar|gz|tgz|7z|rar)$/i.test(name) ||
        (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) {
      throw new Error(`Nested archive prohibited: ${name}`);
    }
    result[name] = bytes;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Deterministic store-only ZIP: stable order, flags and DOS timestamp. */
export function archiveOkfBundle(files: OkfBundleFiles): Uint8Array {
  const valid = validateOkfFiles(files);
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(valid).sort(([a], [b]) => compareKnowledgeKeys(a, b))) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    locals.push(local, bytes);

    const record = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 0x0314, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);
    offset += local.length + bytes.length;
  }
  const directory = concatenate(central);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, directory.length, true);
  e.setUint32(16, offset, true);
  return concatenate([...locals, directory, end]);
}

/** Reads ZIP without extracting to disk. Checks central and local headers before bounded inflation. */
export function readOkfZip(archive: Uint8Array): OkfBundleFiles {
  if (archive.length > OKF_ARCHIVE_LIMITS.archiveBytes) throw new Error('OKF archive exceeds size limit');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === archive.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP end record');
  const count = view.getUint16(end + 10, true);
  if (count !== view.getUint16(end + 8, true) || count > OKF_ARCHIVE_LIMITS.files ||
      view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new Error('ZIP spanning or file-count limit is not supported');
  }
  const directorySize = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (cursor + directorySize !== end) throw new Error('Invalid ZIP directory bounds');
  const files: OkfBundleFiles = Object.create(null);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || expanded === 0xffffffff || compressed === 0xffffffff) {
      throw new Error('Unsupported or encrypted ZIP entry');
    }
    const mode = view.getUint32(cursor + 38, true) >>> 16;
    if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symlink prohibited');
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    safeOkfPath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (name.endsWith('/')) { cursor = next; continue; }
    if (Object.prototype.hasOwnProperty.call(files, name)) throw new Error(`Duplicate ZIP path: ${name}`);
    if (expanded > OKF_ARCHIVE_LIMITS.fileBytes || (compressed === 0 ? expanded > 0 : expanded / compressed > OKF_ARCHIVE_LIMITS.ratio)) {
      throw new Error(`ZIP entry exceeds limits: ${name}`);
    }
    total += expanded;
    if (total > OKF_ARCHIVE_LIMITS.totalBytes) throw new Error('ZIP exceeds total uncompressed size limit');
    const localOffset = view.getUint32(cursor + 42, true);
    if (localOffset + 30 > archive.length || view.getUint32(localOffset, true) !== 0x04034b50 ||
        view.getUint16(localOffset + 8, true) !== method) throw new Error('Invalid ZIP local header');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new Error('ZIP path mismatch');
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressed > cursor) throw new Error('ZIP entry overlaps directory');
    const raw = archive.subarray(start, start + compressed);
    const bytes = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: OKF_ARCHIVE_LIMITS.fileBytes + 1 });
    if (bytes.length !== expanded || crc32(bytes) !== crc) throw new Error(`ZIP checksum or size mismatch: ${name}`);
    files[name] = bytes;
    cursor = next;
  }
  if (cursor !== end) throw new Error('Unexpected ZIP directory data');
  return validateOkfFiles(files);
}
