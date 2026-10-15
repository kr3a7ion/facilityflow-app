/**
 * Which version of the alert app an APK is, read from the APK itself.
 *
 * The installer is a file an administrator copies into the data folder, renamed to
 * app.apk on the way. Nothing else on the host knows which build it is — and a phone cannot
 * be told "a newer one is waiting" by a host that does not know what it has. So the host
 * reads the version out of the file: an APK is a zip, and its AndroidManifest.xml is
 * Android's binary XML, whose first element carries versionCode and versionName.
 *
 * Only what that needs: the zip's central directory, one stored or deflated entry, and the
 * string pool and first start tag of the binary XML. Anything unexpected is "unknown",
 * never a throw — a damaged installer must not take the host down with it.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface ApkVersion {
  /** "1.0.0" — pubspec's version name. */
  name: string | null;
  /** The build number; CI's run number, so it only ever goes up. */
  code: number | null;
}

/** Android's resource ids for the two attributes, for an APK whose attribute names were stripped. */
const VERSION_CODE_ID = 0x0101021b;
const VERSION_NAME_ID = 0x0101021c;

/** Read just the manifest entry out of the zip, without loading the whole file. */
function manifestBytes(fd: number, size: number): Buffer | null {
  // End of central directory: 22 bytes plus a comment of up to 64 KiB, at the very end.
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > size) return null;

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'AndroidManifest.xml') {
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, local);
      if (head.readUInt32LE(0) !== 0x04034b50) return null;
      const start = local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      if (start + compressed > size) return null;
      const data = Buffer.alloc(compressed);
      fs.readSync(fd, data, 0, compressed, start);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** The strings of a binary XML string pool chunk starting at [at]. */
function stringPool(x: Buffer, at: number): string[] {
  const headerSize = x.readUInt16LE(at + 2);
  const count = x.readUInt32LE(at + 8);
  const utf8 = (x.readUInt32LE(at + 16) & 0x100) !== 0;
  const stringsStart = at + x.readUInt32LE(at + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + x.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      // Length in UTF-16 units, then in bytes; each one or two bytes.
      p += (x.readUInt8(p) & 0x80) ? 2 : 1;
      let bytes = x.readUInt8(p);
      if (bytes & 0x80) { bytes = ((bytes & 0x7f) << 8) | x.readUInt8(p + 1); p += 2; } else { p += 1; }
      out.push(x.toString('utf8', p, p + bytes));
    } else {
      let units = x.readUInt16LE(p);
      if (units & 0x8000) { units = ((units & 0x7fff) << 16) | x.readUInt16LE(p + 2); p += 4; } else { p += 2; }
      out.push(x.toString('utf16le', p, p + units * 2));
    }
  }
  return out;
}

/** versionCode and versionName from a binary AndroidManifest.xml. */
export function manifestVersion(x: Buffer): ApkVersion | null {
  if (x.length < 8 || x.readUInt16LE(0) !== 0x0003) return null;
  let strings: string[] = [];
  let resIds: number[] = [];
  for (let p = x.readUInt16LE(2); p + 8 <= x.length;) {
    const type = x.readUInt16LE(p);
    const chunkSize = x.readUInt32LE(p + 4);
    if (chunkSize < 8) return null;
    if (type === 0x0001) strings = stringPool(x, p);
    else if (type === 0x0180) {
      resIds = [];
      for (let i = p + 8; i < p + chunkSize; i += 4) resIds.push(x.readUInt32LE(i));
    } else if (type === 0x0102) {
      // The first start tag is <manifest>, which is where both attributes live.
      const ext = p + x.readUInt16LE(p + 2);
      const attrStart = x.readUInt16LE(ext + 8);
      const attrSize = x.readUInt16LE(ext + 10);
      const attrCount = x.readUInt16LE(ext + 12);
      const v: ApkVersion = { name: null, code: null };
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = x.readUInt32LE(a + 4);
        const raw = x.readUInt32LE(a + 8);
        const dataType = x.readUInt8(a + 15);
        const data = x.readUInt32LE(a + 16);
        const attr = strings[nameIdx];
        const id = resIds[nameIdx];
        if (attr === 'versionCode' || id === VERSION_CODE_ID) {
          // TYPE_INT_DEC or TYPE_INT_HEX.
          if (dataType === 0x10 || dataType === 0x11) v.code = data;
        } else if (attr === 'versionName' || id === VERSION_NAME_ID) {
          const idx = raw !== 0xffffffff ? raw : dataType === 0x03 ? data : -1;
          v.name = idx >= 0 ? strings[idx] ?? null : null;
        }
      }
      return v;
    }
    p += chunkSize;
  }
  return null;
}

/** The version of the APK at [file], or null if it is missing or cannot be read. */
export function apkVersion(file: string): ApkVersion | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = manifestBytes(fd, fs.fstatSync(fd).size);
    return bytes ? manifestVersion(bytes) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
