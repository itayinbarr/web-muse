import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { Muse, EEG_SAMPLES_PER_PACKET } from "../src/lib/MuseDevice.js";

const CSV_URL = new URL("../assets/resting-state.csv", import.meta.url);

// Node's fetch does not read file:// URLs, so serve the mock CSV over HTTP.
async function serveCsv() {
  const csv = await readFile(CSV_URL);
  const server = createServer((req, res) => res.end(csv));
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, url: `http://localhost:${server.address().port}/` };
}

async function readCsvRows(n) {
  const lines = (await readFile(CSV_URL, "utf8")).trim().split("\n");
  return lines.slice(1, n + 1).map((line) => line.split(",").slice(1, 5).map(Number));
}

test("mock mode streams distinct samples in packets with sequence numbers", async () => {
  const { server, url } = await serveCsv();
  const muse = new Muse({ mock: true, mockDataPath: url });
  const packets = [];
  muse.onEEG((packet) => packets.push(packet));
  await muse.connect();
  await new Promise((resolve) => setTimeout(resolve, 300));
  muse.disconnect();
  server.close();

  // ~300 ms at 256 Hz / 12 samples per packet is ~6 packets per channel.
  const tp9 = packets.filter((p) => p.channel === 0);
  assert.ok(tp9.length >= 4, `expected >= 4 TP9 packets, got ${tp9.length}`);
  assert.deepEqual(
    tp9.map((p) => p.seq),
    tp9.map((_, i) => i)
  );
  for (const p of packets) assert.equal(p.samples.length, EEG_SAMPLES_PER_PACKET);

  // Samples round-trip through the 12-bit packing within one quantisation step.
  const rows = await readCsvRows(2 * EEG_SAMPLES_PER_PACKET);
  const firstTwo = packets.filter((p) => p.seq < 2);
  for (const p of firstTwo) {
    p.samples.forEach((v, i) => {
      const expected = rows[p.seq * EEG_SAMPLES_PER_PACKET + i][p.channel];
      assert.ok(Math.abs(v - expected) <= 0.25, `ch${p.channel}[${i}]: ${v} vs ${expected}`);
    });
  }
});

test("disconnect notifies subscribers exactly once and stops the stream", async () => {
  const { server, url } = await serveCsv();
  const muse = new Muse({ mock: true, mockDataPath: url });
  let disconnects = 0;
  muse.onDisconnect(() => disconnects++);
  await muse.connect();
  muse.disconnect();
  server.close();

  assert.equal(disconnects, 1);
  assert.equal(muse.state, 0);
  let packetsAfter = 0;
  muse.onEEG(() => packetsAfter++);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(packetsAfter, 0);
});

test("a cancelled device picker rejects instead of resolving", async () => {
  globalThis.navigator ??= {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      bluetooth: {
        requestDevice: async () => {
          throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
        },
      },
    },
  });
  try {
    const muse = new Muse();
    await assert.rejects(muse.connect(), { name: "NotFoundError" });
    assert.equal(muse.state, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  }
});
