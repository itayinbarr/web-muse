import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Muse,
  ATHENA_EEG_SCALE,
  ATHENA_DATA_CHARACTERISTIC,
  parseAthenaNotification,
  unpackLE,
} from "../src/lib/MuseDevice.js";

/** Packs unsigned values into a little-endian, LSB-first bitstream. */
function packLE(values, bits, byteLength) {
  const out = new Uint8Array(byteLength);
  let bit = 0;
  for (const v of values) {
    for (let b = 0; b < bits; b++, bit++) {
      if ((v >> b) & 1) out[bit >> 3] |= 1 << (bit & 7);
    }
  }
  return out;
}

/** Builds one subpacket: [tag][index][3 metadata bytes][payload]. */
const subpacket = (tag, index, payload) => [tag, index, 0xaa, 0xbb, 0xcc, ...payload];

/** Builds one packet: a 9-byte header followed by subpackets. */
function packet(counter, ...subpackets) {
  const body = subpackets.flat();
  const length = 9 + body.length;
  return [length, counter & 0xff, counter >> 8, 1, 2, 3, 0x89, 0x93, 0x01, ...body];
}

/** 4-channel EEG subpacket (tag 0x11) from 4 samples x 4 channels of raw values. */
const eeg4 = (index, rows) => subpacket(0x11, index, packLE(rows.flat(), 14, 28));

test("unpackLE reads values LSB first across byte boundaries", () => {
  const values = [0, 1, 8192, 16383, 1234, 5678, 9999, 42];
  assert.deepEqual(unpackLE(packLE(values, 14, 14), 0, 8, 14), values);
  const optics = [0, 1, 0xfffff, 0x12345, 0xabcde, 7];
  assert.deepEqual(unpackLE(packLE(optics, 20, 15), 0, 6, 20), optics);
});

test("EEG subpackets are sample-major, centered at 8192 and scaled to microvolts", () => {
  // Sample s of channel ch has raw value 8192 + 100 * ch + s.
  const rows = [0, 1, 2, 3].map((s) => [0, 1, 2, 3].map((ch) => 8192 + 100 * ch + s));
  const subs = [];
  const result = parseAthenaNotification(Uint8Array.from(packet(7, eeg4(5, rows))), (s) => subs.push(s));
  assert.deepEqual(result, { packets: 1, subpackets: 1, skippedBytes: 0 });
  const [s] = subs;
  assert.equal(s.type, "eeg");
  assert.equal(s.index, 5);
  assert.equal(s.packetCounter, 7);
  assert.deepEqual(s.raw[2], [8392, 8393, 8394, 8395]);
  s.values[2].forEach((v, i) => assert.ok(Math.abs(v - (200 + i) * ATHENA_EEG_SCALE) < 1e-9));
  assert.equal(s.values[0][0], 0);
});

test("all sensors in one packet are decoded, with a 20-byte battery subpacket", () => {
  const optics = subpacket(0x34, 1, packLE(Array.from({ length: 12 }, (_, i) => 1000 * i), 20, 30));
  const motionPayload = new Uint8Array(36);
  const dv = new DataView(motionPayload.buffer);
  for (let s = 0; s < 3; s++) {
    dv.setInt16((s * 6 + 0) * 2, 16384, true); // ax = 1 g
    dv.setInt16((s * 6 + 3) * 2, -100, true); // gx
  }
  const motion = subpacket(0x47, 2, [...motionPayload]);
  const battery = subpacket(0x88, 3, [0x00, 0x3a, ...new Array(18).fill(0xee)]); // 58 %
  const rows = [0, 1, 2, 3].map(() => [8192, 8192, 8192, 8192]);
  const bytes = Uint8Array.from(packet(1, optics, battery, motion, eeg4(9, rows)));

  const types = [];
  let opticsValues, motionValues, percent;
  const result = parseAthenaNotification(bytes, (s) => {
    types.push(s.type);
    if (s.type === "optics") opticsValues = s.values;
    if (s.type === "motion") motionValues = s.values;
    if (s.type === "battery") percent = s.values[0][0];
  });
  assert.deepEqual(types, ["optics", "battery", "motion", "eeg"]);
  assert.equal(result.skippedBytes, 0);
  assert.deepEqual(opticsValues[1], [1000, 5000, 9000]);
  assert.deepEqual(motionValues[0], [1, 1, 1]);
  assert.ok(Math.abs(motionValues[3][0] - 0.74768) < 1e-9);
  assert.equal(percent, 58);
});

test("several packets in one notification are all parsed", () => {
  const rows = [0, 1, 2, 3].map(() => [8192, 8192, 8192, 8192]);
  const bytes = Uint8Array.from([...packet(1, eeg4(0, rows)), ...packet(2, eeg4(1, rows))]);
  const indices = [];
  const result = parseAthenaNotification(bytes, (s) => indices.push(s.index));
  assert.deepEqual(indices, [0, 1]);
  assert.equal(result.packets, 2);
});

test("an unknown tag stops its packet but not the next one", () => {
  const rows = [0, 1, 2, 3].map(() => [8192, 8192, 8192, 8192]);
  const bad = packet(1, subpacket(0x77, 0, [1, 2, 3, 4]), eeg4(0, rows));
  const good = packet(2, eeg4(1, rows));
  const indices = [];
  const result = parseAthenaNotification(Uint8Array.from([...bad, ...good]), (s) => indices.push(s.index));
  assert.deepEqual(indices, [1]);
  assert.equal(result.skippedBytes, 4 + 5 + 28 + 5);
});

test("8-channel EEG (tag 0x12) holds 2 samples per channel", () => {
  const values = Array.from({ length: 16 }, (_, i) => 8192 + i);
  const bytes = Uint8Array.from(packet(1, subpacket(0x12, 0, packLE(values, 14, 28))));
  let sub;
  parseAthenaNotification(bytes, (s) => (sub = s));
  assert.equal(sub.raw.length, 8);
  assert.deepEqual(sub.raw[0], [8192, 8200]);
  assert.deepEqual(sub.raw[7], [8199, 8207]);
});

/** A fake Web Bluetooth Muse S Athena that streams `notifications` once started. */
function fakeAthena(notifications) {
  const written = [];
  const chars = new Map();
  const makeChar = (uuid) => {
    const c = {
      uuid,
      oncharacteristicvaluechanged: null,
      startNotifications: async () => {},
      writeValue: async (bytes) => {
        const cmd = new TextDecoder().decode(bytes.subarray(1, bytes[0]));
        written.push(cmd);
        if (cmd === "L1") {
          const data = chars.get(ATHENA_DATA_CHARACTERISTIC);
          for (const n of notifications) {
            const value = new DataView(Uint8Array.from(n).buffer);
            data.oncharacteristicvaluechanged({ target: { value } });
          }
        }
      },
    };
    chars.set(uuid, c);
    return c;
  };
  const uuids = ["0001", "0013", "0014", "0015"].map((n) => `273e${n}-4c4d-454d-96be-f03bac821358`);
  uuids.forEach(makeChar);
  const service = {
    getCharacteristic: async (uuid) => chars.get(uuid),
    getCharacteristics: async () => [...chars.values()],
  };
  const device = {
    gatt: { connected: true, connect: async () => ({ getPrimaryService: async () => service }), disconnect() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  return { written, bluetooth: { requestDevice: async () => device } };
}

async function withNavigator(bluetooth, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { bluetooth } });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  }
}

test("a Muse S Athena is detected, started with its preset and streams every sample", async () => {
  const rowsFor = (k) => [0, 1, 2, 3].map((s) => [0, 1, 2, 3].map((ch) => 8192 + 16 * k + 4 * s + ch));
  const optics = subpacket(0x34, 0, packLE(new Array(12).fill(500), 20, 30));
  // Subpacket index 2 is missing: one dropped EEG subpacket.
  const notifications = [
    packet(0, eeg4(0, rowsFor(0)), optics),
    packet(1, eeg4(1, rowsFor(1))),
    packet(2, eeg4(3, rowsFor(3))),
  ];
  const fake = fakeAthena(notifications);
  await withNavigator(fake.bluetooth, async () => {
    const muse = new Muse({ preset: "p1041" });
    const packets = [];
    const opticsPackets = [];
    muse.onEEG((p) => packets.push(p));
    muse.onOptics((p) => opticsPackets.push(p));
    await muse.connect();

    assert.equal(muse.state, 2);
    assert.equal(muse.isAthena, true);
    assert.equal(muse.preset, "p1041");
    assert.deepEqual(fake.written, ["v6", "s", "h", "p1041", "s", "dc001", "dc001", "L1", "s"]);
    assert.deepEqual(muse.eegChannelNames, ["TP9", "AF7", "AF8", "TP10"]);
    assert.deepEqual(muse.opticsChannelNames, ["LI_730", "RI_730", "LI_850", "RI_850"]);
    assert.deepEqual(muse.stats, { notifications: 3, droppedSubpackets: 1, skippedBytes: 0 });

    const af7 = packets.filter((p) => p.channel === 1);
    assert.deepEqual(af7.map((p) => p.index), [0, 4, 12]);
    const raw = af7[2].samples.map((v) => Math.round(v / ATHENA_EEG_SCALE) + 8192);
    assert.deepEqual(raw, rowsFor(3).map((row) => row[1]));

    assert.equal(opticsPackets.length, 1);
    assert.deepEqual(opticsPackets[0].channels[0], [500, 500, 500]);

    // The circular buffers keep the existing API working.
    assert.ok(Math.abs(muse.eeg[0].read() - 0) < 1e-9);
    assert.equal(muse.optics[3].read(), 500);
    muse.disconnect();
    assert.equal(muse.state, 0);
  });
});

// Optional: replay raw captures (lines of "timestamp\tuuid\thex", as recorded by
// OpenMuse) from the directory in ATHENA_FIXTURES. Every byte must parse and
// the per-sensor counters must have no gaps.
test("raw Athena captures parse completely", { skip: !process.env.ATHENA_FIXTURES }, async () => {
  const dir = process.env.ATHENA_FIXTURES;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".txt"));
  assert.ok(files.length > 0, `no .txt captures in ${dir}`);
  for (const file of files) {
    const lines = (await readFile(join(dir, file), "utf8")).trim().split("\n");
    const last = new Map();
    let eegSamples = 0;
    for (const line of lines) {
      const [, uuid, hex] = line.split("\t");
      if (uuid !== ATHENA_DATA_CHARACTERISTIC) continue;
      const result = parseAthenaNotification(Buffer.from(hex, "hex"), (s) => {
        if (last.has(s.tag)) assert.equal(s.index, (last.get(s.tag) + 1) & 0xff, `${file}: gap in tag ${s.tag}`);
        last.set(s.tag, s.index);
        if (s.type === "eeg") eegSamples += s.values[0].length;
      });
      assert.equal(result.skippedBytes, 0, `${file}: unparsed bytes`);
    }
    assert.ok(eegSamples > 0, `${file}: no EEG`);
  }
});
