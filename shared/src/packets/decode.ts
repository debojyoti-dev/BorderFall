/**
 * Typed-array normalisation for received packets.
 *
 * ## Why this is necessary
 *
 * Socket.IO transports typed arrays as binary attachments, but does **not**
 * preserve the view type. A `Uint16Array` sent by the server arrives as a
 * `Buffer` in Node and an `ArrayBuffer` in the browser. The failure mode is
 * vicious rather than obvious:
 *
 * ```
 * server: new Uint16Array([1, 2, 3])      // 3 elements
 * client: <Buffer 01 00 02 00 03 00>      // .length === 6
 *         received[0] === 1               // looks correct!
 *         received[1] === 0               // silently wrong (should be 2)
 * ```
 *
 * Index 0 reads correctly by coincidence for small little-endian values, so a
 * naive smoke test passes while every subsequent element is garbage and every
 * loop over `.length` iterates twice too many times.
 *
 * These helpers restore the intended view. They **copy** rather than wrap:
 * Node `Buffer`s are allocated from a shared pool, so their `byteOffset` is
 * frequently not a multiple of 2 or 4, and `new Uint16Array(buf.buffer,
 * buf.byteOffset, n)` throws on a misaligned offset. Copying a few hundred
 * bytes per network tick is immaterial next to that class of intermittent,
 * allocation-dependent crash.
 *
 * Endianness is assumed to match between peers. Every platform that runs a
 * browser or Node is little-endian; supporting a big-endian peer would require
 * an explicit `DataView` pass on both sides.
 */

/** Reinterprets any binary-ish value as a byte view without copying. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    // Covers Node's Buffer, which is a Uint8Array subclass.
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // Some transports deliver a plain `{0: n, 1: n, length: n}` object.
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  return new Uint8Array(0);
}

export function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.constructor === Uint8Array) return value;
  const bytes = toBytes(value);
  return new Uint8Array(bytes);
}

export function asUint16Array(value: unknown): Uint16Array {
  if (value instanceof Uint16Array) return value;
  const bytes = toBytes(value);
  const out = new Uint16Array(Math.floor(bytes.byteLength / 2));
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}

export function asUint32Array(value: unknown): Uint32Array {
  if (value instanceof Uint32Array) return value;
  const bytes = toBytes(value);
  const out = new Uint32Array(Math.floor(bytes.byteLength / 4));
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}

export function asFloat32Array(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  const bytes = toBytes(value);
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}

import type { WorldDeltaPacket, WorldSnapshotPacket } from './updates.js';

/**
 * Normalises a received delta in place-ish, returning a packet whose arrays are
 * genuinely the declared types.
 *
 * Every consumer must route received packets through this. Skipping it does not
 * fail loudly — it produces a subtly wrong world.
 */
export function decodeDelta(packet: WorldDeltaPacket): WorldDeltaPacket {
  return {
    ...packet,
    ids: asUint16Array(packet.ids),
    fields: asUint8Array(packet.fields),
    owner: asUint16Array(packet.owner),
    population: asUint32Array(packet.population),
    troops: asUint32Array(packet.troops),
    building: asUint8Array(packet.building),
    buildingLevel: asUint8Array(packet.buildingLevel),
    construction: asUint8Array(packet.construction),
    contested: asUint8Array(packet.contested),
  };
}

export function decodeSnapshot(packet: WorldSnapshotPacket): WorldSnapshotPacket {
  return {
    ...packet,
    owner: asUint16Array(packet.owner),
    population: asUint32Array(packet.population),
    troops: asUint32Array(packet.troops),
    building: asUint8Array(packet.building),
    buildingLevel: asUint8Array(packet.buildingLevel),
    construction: asUint8Array(packet.construction),
    contested: asUint8Array(packet.contested),
  };
}
