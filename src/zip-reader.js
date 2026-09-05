import { inflateRawSync } from 'node:zlib';

const DEFAULT_MAX_ENTRY_BYTES = 24 * 1024 * 1024;

function labelText(label, message) {
  return `${label} ${message}`.trim();
}

/**
 * Read the small, non-ZIP64 subset shared by XLSX and DOCX containers.
 * The reader only exposes named entries and never writes extracted files.
 */
export function zipReader(input, { label = 'ZIP', maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < 1) throw new Error('ZIP 单文件大小限制无效');
  if (buffer.length < 22) throw new Error(labelText(label, '文件太小，无法读取'));
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buffer.lastIndexOf(eocdSignature, Math.max(0, buffer.length - 22));
  if (eocd < 0) throw new Error(labelText(label, '文件不是有效的 ZIP 容器'));
  const entries = new Map();
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) throw new Error('暂不支持 ZIP64 文件');
  if (directoryOffset + directorySize > buffer.length || directoryOffset < 0) throw new Error(labelText(label, '压缩目录已经损坏'));
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(labelText(label, '压缩目录格式无效'));
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    const recordEnd = nameEnd + extraLength + commentLength;
    if (recordEnd > buffer.length) throw new Error(labelText(label, '压缩目录内容已经损坏'));
    const name = buffer.toString('utf8', cursor + 46, nameEnd);
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(labelText(label, '内含无效路径'));
    if (flags & 0x1) throw new Error(labelText(label, '包含加密文件，无法读取'));
    entries.set(name, { flags, method, compressedSize, uncompressedSize, localOffset });
    cursor = recordEnd;
  }
  return {
    has(name) { return entries.has(name); },
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.uncompressedSize > maxEntryBytes || entry.compressedSize > buffer.length) throw new Error(labelText(label, '单个文件过大'));
      const { localOffset } = entry;
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(labelText(label, '本地文件头无效'));
      const nameLength = buffer.readUInt16LE(localOffset + 26);
      const extraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + nameLength + extraLength;
      const end = start + entry.compressedSize;
      if (start > buffer.length || end > buffer.length) throw new Error(labelText(label, '文件内容已经损坏'));
      const compressed = buffer.subarray(start, end);
      let result;
      if (entry.method === 0) result = compressed;
      else if (entry.method === 8) result = inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
      else throw new Error(labelText(label, '使用了不支持的压缩方式'));
      if (result.length > maxEntryBytes || result.length !== entry.uncompressedSize) throw new Error(labelText(label, '解压结果大小无效'));
      return result;
    }
  };
}
