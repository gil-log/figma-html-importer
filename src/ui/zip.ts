/**
 * zip.ts — 브라우저 내장 기능만으로 zip 을 푼다 (저장·deflate 방식, ZIP64 제외)
 *
 * 중앙 디렉터리의 크기·위치를 기준으로 읽으므로 데이터 디스크립터(크기를 뒤에 적는 zip)도 읽힌다.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 경로 → 내용. 폴더 항목은 넣지 않는다 */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 끝에서부터 중앙 디렉터리 끝 레코드를 찾는다 (뒤에 최대 64KB 주석이 붙을 수 있다)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 파일을 읽지 못했습니다. 내려받은 파일이 손상됐을 수 있습니다.');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff) throw new Error('4GB 이상(ZIP64) zip 은 지원하지 않습니다.');

  const utf8 = new TextDecoder('utf-8');
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) throw new Error('zip 목록이 올바르지 않습니다.');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;

    if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new Error(`zip 항목을 읽지 못했습니다: ${name}`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
    else throw new Error(`지원하지 않는 압축 방식입니다 (${method}): ${name}`);
  }
  return files;
}
