/**
 * Decoder for the Muse S Athena (MS-03, 2025) Bluetooth protocol.
 *
 * Unlike the Muse 2, which sends each sensor on its own characteristic, the
 * Athena multiplexes every sensor onto characteristic 273e0013. Each
 * notification holds one or more packets:
 *
 *   [0]      packet length, including this header
 *   [1..2]   16-bit little-endian packet counter
 *   [3..8]   device clock and session constants (not used here)
 *   [9..]    subpackets: [tag][index][3 metadata bytes][payload]
 *
 * The tag says which sensor a subpacket holds and so how long its payload is.
 * EEG and optics samples are bit-packed little-endian (LSB first), sample-major.
 *
 * Sources: OpenMuse (DominiqueMakowski/OpenMuse), BrainFlow muse_athena.cpp and
 * Polobase/muse.js docs/protocol.md, cross-checked against raw captures.
 */

/** EEG sampling rate of the Athena, in Hz. */
export const ATHENA_EEG_SAMPLE_RATE = 256;
/** Optics (fNIRS/PPG) sampling rate of the Athena, in Hz. */
export const ATHENA_OPTICS_SAMPLE_RATE = 64;
/** Accelerometer/gyroscope sampling rate of the Athena, in Hz. */
export const ATHENA_MOTION_SAMPLE_RATE = 52;

/** Microvolts per count of a 14-bit EEG sample (1.45 mV full scale). */
export const ATHENA_EEG_SCALE = 1450 / 16383;
/** Raw EEG value corresponding to 0 µV. */
export const ATHENA_EEG_MIDPOINT = 8192;
/** Largest raw EEG value; off-head channels rail at 0 or this value. */
export const ATHENA_EEG_MAX = 16383;

/** Characteristic carrying all Athena sensor data. */
export const ATHENA_DATA_CHARACTERISTIC = "273e0013-4c4d-454d-96be-f03bac821358";
/** Secondary characteristic; usually silent, subscribed to when available. */
export const ATHENA_DATA2_CHARACTERISTIC = "273e0014-4c4d-454d-96be-f03bac821358";

/** EEG channel names, by channel index. Channels 4-7 exist in 8-channel presets. */
export const ATHENA_EEG_CHANNEL_NAMES = [
  "TP9",
  "AF7",
  "AF8",
  "TP10",
  "AUX1",
  "AUX2",
  "AUX3",
  "AUX4",
];

/**
 * Optics channel names, by channel count. NIR is 730 nm, IR is 850 nm;
 * L/R is left/right and I/O is the inner/outer detector (see IXNOptics.h).
 */
export const ATHENA_OPTICS_CHANNEL_NAMES = {
  4: ["LI_730", "RI_730", "LI_850", "RI_850"],
  8: ["LO_730", "RO_730", "LO_850", "RO_850", "LI_730", "RI_730", "LI_850", "RI_850"],
  16: [
    "LO_730", "RO_730", "LO_850", "RO_850", "LI_730", "RI_730", "LI_850", "RI_850",
    "LO_RED", "RO_RED", "LO_AMB", "RO_AMB", "LI_RED", "RI_RED", "LI_AMB", "RI_AMB",
  ],
};

/**
 * Athena presets. EEG-only legacy presets (p21) carry no optics.
 * The device does not acknowledge presets; check which data arrives instead.
 */
export const ATHENA_PRESETS = {
  p21: "4 ch EEG, motion, battery",
  p1021: "4 ch EEG, motion, battery, DRL/REF",
  p1035: "4 ch EEG + 4 ch optics (low power)",
  p1036: "4 ch EEG + 4 ch optics (high power)",
  p1033: "4 ch EEG + 8 ch optics (low power)",
  p1034: "4 ch EEG + 8 ch optics (high power)",
  p1045: "8 ch EEG + 4 ch optics (low power)",
  p1043: "8 ch EEG + 8 ch optics (low power)",
  p1041: "8 ch EEG + 16 ch optics (low power)",
  p1042: "8 ch EEG + 16 ch optics (high power)",
};

/** Default preset: 4 EEG channels plus 4 optics channels. */
export const ATHENA_DEFAULT_PRESET = "p1035";

const PACKET_HEADER_SIZE = 9;
const SUBPACKET_HEADER_SIZE = 5;

/**
 * Subpacket layouts by tag: sensor type, channels, samples per channel, payload bytes.
 */
export const ATHENA_TAGS = {
  0x11: { type: "eeg", channels: 4, samples: 4, bytes: 28 },
  0x12: { type: "eeg", channels: 8, samples: 2, bytes: 28 },
  0x34: { type: "optics", channels: 4, samples: 3, bytes: 30 },
  0x35: { type: "optics", channels: 8, samples: 2, bytes: 40 },
  0x36: { type: "optics", channels: 16, samples: 1, bytes: 40 },
  0x47: { type: "motion", channels: 6, samples: 3, bytes: 36 },
  0x53: { type: "drlref", channels: 2, samples: 6, bytes: 24 },
  0x88: { type: "battery", channels: 1, samples: 1, bytes: 20 },
  0x98: { type: "battery", channels: 1, samples: 1, bytes: 20 },
};

const ACCELEROMETER_SCALE = 1 / 16384; // g per count
const GYROSCOPE_SCALE = -0.0074768; // degrees/s per count

/**
 * Unpacks unsigned integers from a little-endian bitstream, LSB first.
 *
 * @param {Uint8Array} bytes - The bytes holding the bitstream.
 * @param {number} offset - Index of the first byte.
 * @param {number} count - Number of values to unpack.
 * @param {number} bits - Width of each value, at most 24.
 * @return {number[]} The unpacked values.
 */
export function unpackLE(bytes, offset, count, bits) {
  const values = new Array(count);
  const mask = (1 << bits) - 1;
  let acc = 0;
  let accBits = 0;
  let pos = offset;
  for (let i = 0; i < count; i++) {
    while (accBits < bits) {
      acc |= bytes[pos++] << accBits;
      accBits += 8;
    }
    values[i] = acc & mask;
    acc >>>= bits;
    accBits -= bits;
  }
  return values;
}

/**
 * Converts a raw 14-bit Athena EEG sample to microvolts.
 *
 * @param {number} x - A raw sample between 0 and 16383.
 * @return {number} The sample in microvolts, in the range [-725, 725].
 */
export const athenaEegToMicrovolts = (x) =>
  (x - ATHENA_EEG_MIDPOINT) * ATHENA_EEG_SCALE;

/**
 * Splits sample-major values into one array per channel.
 *
 * @param {number[]} values - Values ordered sample by sample.
 * @param {number} channels - Number of channels.
 * @param {number} samples - Number of samples per channel.
 * @return {number[][]} One array of samples per channel.
 */
function deinterleave(values, channels, samples) {
  const out = [];
  for (let ch = 0; ch < channels; ch++) {
    const column = new Array(samples);
    for (let s = 0; s < samples; s++) column[s] = values[s * channels + ch];
    out.push(column);
  }
  return out;
}

/**
 * Decodes a subpacket payload.
 *
 * @param {Object} spec - The tag's layout from ATHENA_TAGS.
 * @param {Uint8Array} bytes - The notification bytes.
 * @param {number} p - Index of the first payload byte.
 * @return {{raw: number[][]|null, values: number[][]}} Per-channel raw counts
 *   (EEG and optics only) and values in physical units.
 */
function decodePayload(spec, bytes, p) {
  const n = spec.channels * spec.samples;
  switch (spec.type) {
    case "eeg": {
      const raw = deinterleave(unpackLE(bytes, p, n, 14), spec.channels, spec.samples);
      return { raw, values: raw.map((ch) => ch.map(athenaEegToMicrovolts)) };
    }
    case "optics": {
      const raw = deinterleave(unpackLE(bytes, p, n, 20), spec.channels, spec.samples);
      return { raw, values: raw };
    }
    case "motion": {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + p, spec.bytes);
      const values = [];
      for (let i = 0; i < n; i++) {
        const v = dv.getInt16(i * 2, true);
        values.push(i % 6 < 3 ? v * ACCELEROMETER_SCALE : v * GYROSCOPE_SCALE);
      }
      // Channels: accelerometer x, y, z (g), then gyroscope x, y, z (deg/s).
      return { raw: null, values: deinterleave(values, spec.channels, spec.samples) };
    }
    case "drlref": {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + p, spec.bytes);
      const values = [];
      for (let i = 0; i < n; i++) values.push(dv.getUint16(i * 2, true));
      return { raw: null, values: deinterleave(values, spec.channels, spec.samples) };
    }
    case "battery": {
      const percent = (bytes[p] | (bytes[p + 1] << 8)) / 256;
      return { raw: null, values: [[percent]] };
    }
  }
}

/**
 * Parses one notification from the Athena data characteristic and calls
 * `onSubpacket` for every subpacket it contains, in order.
 *
 * Each subpacket is passed as `{ type, tag, index, packetCounter, raw, values }`:
 * - `type`: "eeg", "optics", "motion", "drlref" or "battery"
 * - `index`: the 8-bit per-sensor subpacket counter, for detecting gaps
 * - `values`: one array of samples per channel, in microvolts (EEG), raw counts
 *   (optics), g and deg/s (motion), or percent (battery)
 * - `raw`: raw counts per channel for EEG and optics, otherwise null
 *
 * Parsing a packet stops at an unknown tag, since its length is unknown, and
 * continues with the next packet.
 *
 * @param {Uint8Array} bytes - The notification bytes.
 * @param {Function} onSubpacket - Called with each decoded subpacket.
 * @return {{packets: number, subpackets: number, skippedBytes: number}} Counts
 *   for diagnostics; `skippedBytes` is nonzero if anything could not be parsed.
 */
export function parseAthenaNotification(bytes, onSubpacket) {
  let packets = 0;
  let subpackets = 0;
  let skippedBytes = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length < PACKET_HEADER_SIZE + SUBPACKET_HEADER_SIZE || offset + length > bytes.length) {
      skippedBytes += bytes.length - offset;
      break;
    }
    const end = offset + length;
    const packetCounter = bytes[offset + 1] | (bytes[offset + 2] << 8);
    let i = offset + PACKET_HEADER_SIZE;
    while (i + SUBPACKET_HEADER_SIZE <= end) {
      const tag = bytes[i];
      const spec = ATHENA_TAGS[tag];
      if (!spec || i + SUBPACKET_HEADER_SIZE + spec.bytes > end) break;
      const p = i + SUBPACKET_HEADER_SIZE;
      const { raw, values } = decodePayload(spec, bytes, p);
      onSubpacket({ type: spec.type, tag, index: bytes[i + 1], packetCounter, raw, values });
      subpackets++;
      i = p + spec.bytes;
    }
    skippedBytes += end - i;
    packets++;
    offset = end;
  }
  return { packets, subpackets, skippedBytes };
}
