export interface ZipEntry {
  name: string;
  text: string;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const UTF8_NAMES_FLAG = 0x0800;
const STORED_WITHOUT_COMPRESSION = 0;
const DOS_YEAR_ORIGIN = 1980;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let remainder = index;
    for (let bit = 0; bit < 8; bit += 1) remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    table[index] = remainder >>> 0;
  }
  return table;
})();

export function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeAndDateOf(moment: Date): { time: number; date: number } {
  const time = (moment.getHours() << 11) | (moment.getMinutes() << 5) | (moment.getSeconds() >> 1);
  const date = ((moment.getFullYear() - DOS_YEAR_ORIGIN) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate();
  return { time, date };
}

interface EncodedEntry {
  nameBytes: Uint8Array;
  content: Uint8Array;
  crc: number;
  offset: number;
}

/** Builds a zip archive that stores each text file as is (no compression): the readers every OS ships open it. */
export function zipOf(entries: ReadonlyArray<ZipEntry>, modifiedAt: Date): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosTimeAndDateOf(modifiedAt);
  const chunks: Uint8Array[] = [];
  const encodedEntries: EncodedEntry[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };

  for (const { name, text } of entries) {
    const nameBytes = encoder.encode(name);
    const content = encoder.encode(text);
    const entry: EncodedEntry = { nameBytes, content, crc: crc32Of(content), offset };
    encodedEntries.push(entry);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, LOCAL_FILE_HEADER, true);
    header.setUint16(4, VERSION_NEEDED, true);
    header.setUint16(6, UTF8_NAMES_FLAG, true);
    header.setUint16(8, STORED_WITHOUT_COMPRESSION, true);
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, entry.crc, true);
    header.setUint32(18, content.length, true);
    header.setUint32(22, content.length, true);
    header.setUint16(26, nameBytes.length, true);
    push(new Uint8Array(header.buffer));
    push(nameBytes);
    push(content);
  }

  const centralDirectoryOffset = offset;
  for (const { nameBytes, content, crc, offset: entryOffset } of encodedEntries) {
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
    header.setUint16(4, VERSION_NEEDED, true);
    header.setUint16(6, VERSION_NEEDED, true);
    header.setUint16(8, UTF8_NAMES_FLAG, true);
    header.setUint16(10, STORED_WITHOUT_COMPRESSION, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, content.length, true);
    header.setUint32(24, content.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, entryOffset, true);
    push(new Uint8Array(header.buffer));
    push(nameBytes);
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.setUint16(8, encodedEntries.length, true);
  end.setUint16(10, encodedEntries.length, true);
  end.setUint32(12, centralDirectorySize, true);
  end.setUint32(16, centralDirectoryOffset, true);
  push(new Uint8Array(end.buffer));

  const archive = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    archive.set(chunk, cursor);
    cursor += chunk.length;
  }
  return archive;
}
