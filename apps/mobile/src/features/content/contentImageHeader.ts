import { CONTENT_LIMITS, type MediaReference } from '@cookmate/catalogue/content';
import {
  CONTENT_BROWSER_MAX_IMAGE_PIXELS,
  ContentVerificationCapabilityError,
} from './contentVerificationTypes';

export interface ImageHeader {
  mimeType: MediaReference['mimeType'];
  width: number;
  height: number;
}
const tag = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

/** Allocation preflight only; the browser must still decode and agree with these dimensions.
 * PNG: https://www.w3.org/TR/png-3/#11IHDR
 * JPEG: https://www.w3.org/Graphics/JPEG/itu-t81.pdf B.2.2
 * WebP: https://developers.google.com/speed/webp/docs/riff_container and RFC6386 §9.1.
 */
export function readContentImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 12 || bytes.length > CONTENT_LIMITS.mediaBytes) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result: ImageHeader | null = null;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || data.getUint32(8) !== 13 || !tag(bytes, 12, 'IHDR')) return null;
    result = { mimeType: 'image/png', width: data.getUint32(16), height: data.getUint32(20) };
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const size = data.getUint32(offset),
        next = offset + 12 + size;
      if (
        next > bytes.length ||
        tag(bytes, offset + 4, 'acTL') ||
        tag(bytes, offset + 4, 'fcTL') ||
        tag(bytes, offset + 4, 'fdAT')
      )
        return null;
      if (tag(bytes, offset + 4, 'IEND')) {
        end = size === 0 && next === bytes.length;
        break;
      }
      offset = next;
    }
    if (!end) return null;
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let scan = false,
      end = false;
    for (let offset = 2; offset < bytes.length; ) {
      if (bytes[offset++] !== 0xff) {
        if (scan) continue;
        return null;
      }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (scan && (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)))
        continue;
      if (marker === 0xd9) {
        end = offset === bytes.length;
        break;
      }
      // DNL can redefine height after compressed data; this bounded still-image adapter does not support it.
      if (marker === undefined || marker === 0xdc || marker === 0xd8 || offset + 2 > bytes.length)
        return null;
      const size = data.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) return null;
      // Baseline/extended/progressive Huffman DCT; other JPEG processes are explicitly unsupported.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (
          ![0xc0, 0xc1, 0xc2].includes(marker) ||
          result ||
          size < 11 ||
          bytes[offset + 2] !== 8 ||
          size !== 8 + 3 * bytes[offset + 7]!
        )
          return null;
        result = {
          mimeType: 'image/jpeg',
          width: data.getUint16(offset + 5),
          height: data.getUint16(offset + 3),
        };
      }
      if (marker === 0xda) {
        if (!result) return null;
        scan = true;
      }
      offset += size;
    }
    if (!end || !scan) return null;
  } else if (tag(bytes, 0, 'RIFF') && tag(bytes, 8, 'WEBP')) {
    if (data.getUint32(4, true) + 8 !== bytes.length) return null;
    let frame = false;
    let offset = 12;
    for (; offset + 8 <= bytes.length; ) {
      const size = data.getUint32(offset + 4, true),
        start = offset + 8,
        next = start + size + (size % 2);
      if (next > bytes.length || tag(bytes, offset, 'ANIM') || tag(bytes, offset, 'ANMF'))
        return null;
      if (tag(bytes, offset, 'VP8X')) {
        if (offset !== 12 || size !== 10 || bytes[start]! & 2) return null;
        const uint24 = (at: number) => bytes[at]! + bytes[at + 1]! * 256 + bytes[at + 2]! * 65536;
        result = {
          mimeType: 'image/webp',
          width: uint24(start + 4) + 1,
          height: uint24(start + 7) + 1,
        };
      } else if (tag(bytes, offset, 'VP8 ')) {
        if (
          frame ||
          size < 10 ||
          bytes[start]! & 1 ||
          ![0x9d, 1, 0x2a].every((v, i) => bytes[start + 3 + i] === v)
        )
          return null;
        const width = data.getUint16(start + 6, true) & 0x3fff,
          height = data.getUint16(start + 8, true) & 0x3fff;
        if (result && (result.width !== width || result.height !== height)) return null;
        result = { mimeType: 'image/webp', width, height };
        frame = true;
      } else if (tag(bytes, offset, 'VP8L')) {
        // https://chromium.googlesource.com/webm/libwebp/+/refs/heads/main/doc/webp-lossless-bitstream-spec.txt §3.
        if (frame || size < 5 || bytes[start] !== 0x2f || bytes[start + 4]! >> 5 !== 0) return null;
        const bits = data.getUint32(start + 1, true),
          width = (bits & 0x3fff) + 1,
          height = ((bits >>> 14) & 0x3fff) + 1;
        if (result && (result.width !== width || result.height !== height)) return null;
        result = { mimeType: 'image/webp', width, height };
        frame = true;
      }
      offset = next;
      if (offset === bytes.length && !frame) return null;
    }
    if (!frame || offset !== bytes.length) return null;
  }
  if (!result || result.width < 1 || result.height < 1) return null;
  if (
    result.width > CONTENT_LIMITS.imageDimension ||
    result.height > CONTENT_LIMITS.imageDimension ||
    result.width * result.height > CONTENT_BROWSER_MAX_IMAGE_PIXELS
  )
    throw new ContentVerificationCapabilityError('image_limit');
  return result;
}
