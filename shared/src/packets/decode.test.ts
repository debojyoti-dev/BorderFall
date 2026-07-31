import { describe, expect, it } from 'vitest';
import { asUint8Array, asUint16Array, asUint32Array } from './decode.js';

/**
 * These guard a bug that is invisible without them: Socket.IO delivers typed
 * arrays as `Buffer`/`ArrayBuffer`, and index 0 of the raw buffer coincidentally
 * reads correctly for small little-endian values. Any test that only checked
 * the first element would pass against completely broken data.
 */
describe('typed-array normalisation', () => {
  it('restores a Uint16Array from a byte buffer', () => {
    const original = new Uint16Array([1, 2, 3, 65535]);
    // Exactly what arrives over the wire in Node.
    const asBuffer = new Uint8Array(original.buffer.slice(0));

    const restored = asUint16Array(asBuffer);

    expect(restored).toBeInstanceOf(Uint16Array);
    expect(restored.length).toBe(4);
    expect(Array.from(restored)).toEqual([1, 2, 3, 65535]);
  });

  it('demonstrates why the raw buffer cannot be used directly', () => {
    const original = new Uint16Array([1, 2, 3]);
    const raw = new Uint8Array(original.buffer.slice(0));

    // Byte length, not element count — a loop over this iterates twice over.
    expect(raw.length).toBe(6);
    // Index 0 happens to be right, which is what makes the bug so easy to miss.
    expect(raw[0]).toBe(1);
    // Index 1 is the high byte of element 0, not element 1.
    expect(raw[1]).toBe(0);
    expect(raw[1]).not.toBe(original[1]);
  });

  it('restores a Uint32Array from a byte buffer', () => {
    const original = new Uint32Array([100, 200_000, 4_294_967_295]);
    const raw = new Uint8Array(original.buffer.slice(0));

    const restored = asUint32Array(raw);
    expect(Array.from(restored)).toEqual([100, 200_000, 4_294_967_295]);
  });

  it('restores from a raw ArrayBuffer, as delivered in the browser', () => {
    const original = new Uint16Array([7, 8, 9]);
    const restored = asUint16Array(original.buffer.slice(0));
    expect(Array.from(restored)).toEqual([7, 8, 9]);
  });

  it('passes an already-correct view through untouched', () => {
    const original = new Uint16Array([4, 5]);
    expect(asUint16Array(original)).toBe(original);
  });

  it('handles a misaligned view without throwing', () => {
    // Node Buffers come from a shared pool, so byteOffset is routinely not a
    // multiple of 2 or 4. Wrapping rather than copying would throw here.
    const backing = new ArrayBuffer(16);
    const misaligned = new Uint8Array(backing, 1, 8);
    misaligned.set([1, 0, 2, 0, 3, 0, 4, 0]);

    const restored = asUint16Array(misaligned);
    expect(Array.from(restored)).toEqual([1, 2, 3, 4]);
  });

  it('copies rather than aliasing, so later mutation cannot corrupt it', () => {
    const source = new Uint8Array([1, 0, 2, 0]);
    const restored = asUint16Array(source);
    source[0] = 99;
    expect(restored[0]).toBe(1);
  });

  it('tolerates empty and malformed input', () => {
    expect(asUint16Array(new Uint8Array(0)).length).toBe(0);
    expect(asUint16Array(undefined).length).toBe(0);
    expect(asUint32Array(null).length).toBe(0);
    // An odd byte count truncates rather than producing a partial element.
    expect(asUint16Array(new Uint8Array([1, 0, 2])).length).toBe(1);
  });

  it('returns Uint8Array data unchanged in value', () => {
    const source = new Uint8Array([9, 8, 7]);
    expect(Array.from(asUint8Array(source))).toEqual([9, 8, 7]);
  });
});
