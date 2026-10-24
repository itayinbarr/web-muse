import { MuseCircularBuffer } from "./CircularBuffer.js";
import {
  ATHENA_DATA_CHARACTERISTIC,
  ATHENA_DATA2_CHARACTERISTIC,
  ATHENA_DEFAULT_PRESET,
  ATHENA_EEG_CHANNEL_NAMES,
  ATHENA_OPTICS_CHANNEL_NAMES,
  parseAthenaNotification,
} from "./athena.js";

export * from "./athena.js";

/** EEG sampling rate of Muse headbands, in Hz. */
export const EEG_SAMPLE_RATE = 256;
/** Number of samples per channel in each EEG packet. */
export const EEG_SAMPLES_PER_PACKET = 12;
/** EEG channel names, by characteristic index. */
export const EEG_CHANNEL_NAMES = ["TP9", "AF7", "AF8", "TP10", "AUX"];

/**
 * Converts a raw unsigned 12-bit EEG sample to microvolts.
 *
 * @param {number} x - A raw sample between 0 and 2^12.
 * @return {number} The sample in microvolts, in the range [-1000, 1000).
 */
export const eegToMicrovolts = (x) => 0.48828125 * (x - 0x800);

/**
 * An abstract base class for interfaces that connect to a Muse headband.
 * Subclasses can implement any of the following abstract methods:
 * - batteryData       - called when an event with battery data is received (use eventBatteryData to get it)
 * - accelerometerData - called when an event with accelerometer data is received (use eventAccelerometerData to get it)
 * - gyroscopeData     - called when an event with gyroscope data is received (use eventGyroscopeData to get it)
 * - controlData       - called when an event with control data is received (use eventControlData to get it)
 * - eegData           - called when an event with EEG data is received (use eventEegData to get it)
 * - ppgData           - called when an event with PPG data is received (use eventPpgData to get it)
 * - disconnected      - called when the Muse headband is disconnected
 *
 * Consumers that need every EEG sample with timing information can instead
 * subscribe with `onEEG(callback)`, which receives one packet per call.
 *
 * The Muse S Athena (MS-03) sends all sensors over one characteristic and is
 * detected automatically. Its data reaches subclasses through these hooks:
 * - athenaEEGData     - called with one array of samples (µV) per EEG channel
 * - opticsData        - called with one array of raw samples per optics channel
 * - athenaMotionData  - called with accelerometer (g) and gyroscope (deg/s) samples
 * - athenaBatteryData - called with the battery level in percent
 * and to consumers through `onEEG`, `onOptics` and `onMotion`.
 */
export class MuseBase {
  #SERVICE = 0xfe8d;
  #CONTROL_CHARACTERISTIC = "273e0001-4c4d-454d-96be-f03bac821358";
  #BATTERY_CHARACTERISTIC = "273e000b-4c4d-454d-96be-f03bac821358";
  #GYROSCOPE_CHARACTERISTIC = "273e0009-4c4d-454d-96be-f03bac821358";
  #ACCELEROMETER_CHARACTERISTIC = "273e000a-4c4d-454d-96be-f03bac821358";
  #PPG1_CHARACTERISTIC = "273e000f-4c4d-454d-96be-f03bac821358";
  #PPG2_CHARACTERISTIC = "273e0010-4c4d-454d-96be-f03bac821358";
  #PPG3_CHARACTERISTIC = "273e0011-4c4d-454d-96be-f03bac821358";
  #EEG1_CHARACTERISTIC = "273e0003-4c4d-454d-96be-f03bac821358";
  #EEG2_CHARACTERISTIC = "273e0004-4c4d-454d-96be-f03bac821358";
  #EEG3_CHARACTERISTIC = "273e0005-4c4d-454d-96be-f03bac821358";
  #EEG4_CHARACTERISTIC = "273e0006-4c4d-454d-96be-f03bac821358";
  #EEG5_CHARACTERISTIC = "273e0007-4c4d-454d-96be-f03bac821358";
  #state = 0;
  #dev = null;
  #controlChar = null;
  #infoFragment = "";
  #eegListeners = new Set();
  #disconnectListeners = new Set();
  #onGattDisconnected = null;
  #mockSeq = 0;
  #seqTracker = new Map();
  #isAthena = false;
  #preset = ATHENA_DEFAULT_PRESET;
  #opticsListeners = new Set();
  #motionListeners = new Set();
  #athenaStats = null;
  #eegChannelCount = 4;
  #opticsChannelCount = 0;

  /**
   * Constructs a new interface for connecting to a Muse headband.
   *
   * @abstract
   * @constructor
   * @param {Object} options - Configuration options
   * @param {boolean} [options.mock=false] - Enable mock mode to use pre-recorded data instead of real device
   * @param {string} [options.mockDataPath] - Path to mock data CSV file (defaults to assets/resting-state.csv)
   * @param {string} [options.preset="p1035"] - Muse S Athena preset (see ATHENA_PRESETS); ignored by other models
   */
  constructor(options = {}) {
    if (new.target === MuseBase) {
      throw new TypeError("Cannot construct MuseBase instances directly");
    }
    if (options.preset) this.#preset = options.preset;
    this.mock = options.mock || false;
    this.mockDataPath =
      options.mockDataPath ||
      new URL("../../assets/resting-state.csv", import.meta.url).href;
    this.mockDataIndex = 0;
    this.mockInterval = null;
    this.mockData = null;
  }

  /**
   * The current state of the headband.
   *
   * @type {number} 0 if disconnected, 1 if in the process of connecting, or 2 if connected.
   */
  get state() {
    return this.#state;
  }

  /**
   * Whether the connected headband is a Muse S Athena (MS-03).
   *
   * @type {boolean}
   */
  get isAthena() {
    return this.#isAthena;
  }

  /**
   * The Athena preset in use, or null for other models.
   *
   * @type {string|null}
   */
  get preset() {
    return this.#isAthena ? this.#preset : null;
  }

  /**
   * Names of the EEG channels the headband is streaming, by channel index.
   *
   * @type {string[]}
   */
  get eegChannelNames() {
    return this.#isAthena
      ? ATHENA_EEG_CHANNEL_NAMES.slice(0, this.#eegChannelCount)
      : EEG_CHANNEL_NAMES.slice(0, 4);
  }

  /**
   * Names of the optics channels the headband is streaming (empty if none).
   *
   * @type {string[]}
   */
  get opticsChannelNames() {
    return ATHENA_OPTICS_CHANNEL_NAMES[this.#opticsChannelCount] || [];
  }

  /**
   * Athena stream diagnostics: notifications received, subpackets lost
   * (from gaps in the per-sensor counters) and bytes that could not be parsed.
   * Null for other models.
   *
   * @type {{notifications: number, droppedSubpackets: number, skippedBytes: number}|null}
   */
  get stats() {
    return this.#athenaStats ? { ...this.#athenaStats } : null;
  }

  /**
   * Processes the battery level data from the given event.
   *
   * @abstract
   * @param {Event} event - The event containing the battery data.
   * @return {void} This function does not return a value.
   */
  batteryData(event) {}
  /**
   * Processes the accelerometer data from the given event.
   *
   * @abstract
   * @param {Event} event - The event containing the accelerometer data.
   * @return {void} This function does not return a value.
   */
  accelerometerData(event) {}
  /**
   * Processes the gyroscope data from the given event.
   *
   * @abstract
   * @param {Event} event - The event containing the gyroscope data.
   * @return {void} This function does not return a value.
   */
  gyroscopeData(event) {}
  /**
   * A function that processes control data from the given event.
   *
   * @abstract
   * @param {Event} event - The event containing the control data.
   * @return {void} This function does not return a value.
   */
  controlData(event) {}
  /**
   * Processes EEG data from the given event.
   *
   * @abstract
   * @param {number} n - The index of the EEG channel.
   * @param {Event} event - The event containing the EEG data.
   * @return {void} This function does not return a value.
   */
  eegData(n, event) {}
  /**
   * Processes PPG data from the given event.
   *
   * @abstract
   * @param {number} n - The index of the PPG circular buffer to write to.
   * @param {Event} event - The event containing the PPG data.
   * @return {void} This function does not return a value.
   */
  ppgData(n, event) {}
  /**
   * Processes Muse S Athena EEG samples.
   *
   * @abstract
   * @param {number[][]} channels - One array of samples in microvolts per EEG channel.
   * @return {void} This function does not return a value.
   */
  athenaEEGData(channels) {}
  /**
   * Processes Muse S Athena optics (fNIRS/PPG) samples.
   *
   * @abstract
   * @param {number[][]} channels - One array of raw 20-bit samples per optics channel.
   * @return {void} This function does not return a value.
   */
  opticsData(channels) {}
  /**
   * Processes Muse S Athena accelerometer and gyroscope samples.
   *
   * @abstract
   * @param {number[][]} accelerometer - x, y and z sample arrays, in g.
   * @param {number[][]} gyroscope - x, y and z sample arrays, in degrees per second.
   * @return {void} This function does not return a value.
   */
  athenaMotionData(accelerometer, gyroscope) {}
  /**
   * Processes the Muse S Athena battery level.
   *
   * @abstract
   * @param {number} percent - The battery level, between 0 and 100.
   * @return {void} This function does not return a value.
   */
  athenaBatteryData(percent) {}
  /**
   * A method that handles the disconnection event.
   *
   * @abstract
   * @param {void} This function does not take any parameters.
   * @return {void} This function does not return a value.
   */
  disconnected() {}

  /**
   * Subscribes to EEG packets. The callback is called once per packet and
   * channel with `{ channel, seq, index, samples, receivedAt }`:
   * - `channel`: the EEG channel index (0=TP9, 1=AF7, 2=AF8, 3=TP10, then
   *   AUX; see `eegChannelNames`)
   * - `seq`: the device's packet sequence number (16-bit on the Muse 2,
   *   8-bit on the Muse S Athena)
   * - `index`: the absolute index of `samples[0]` since connecting, with the
   *   sequence wraparound removed; gaps mean dropped packets
   * - `samples`: values in microvolts (12 per packet on the Muse 2; 4 or 2
   *   on the Athena, depending on the preset)
   * - `receivedAt`: the `performance.now()` arrival time
   *
   * Sample `i` of a packet has the absolute index `index + i`, which lets
   * consumers reconstruct sample timing independently of Bluetooth jitter.
   *
   * @param {Function} callback - Called with each EEG packet.
   * @return {Function} A function that removes the subscription.
   */
  onEEG(callback) {
    this.#eegListeners.add(callback);
    return () => this.offEEG(callback);
  }

  /**
   * Removes a callback previously registered with `onEEG`.
   *
   * @param {Function} callback - The callback to remove.
   * @return {void} This function does not return a value.
   */
  offEEG(callback) {
    this.#eegListeners.delete(callback);
  }

  /**
   * Subscribes to disconnection, whether requested with `disconnect()` or
   * caused by the headband going away.
   *
   * @param {Function} callback - Called with no arguments on disconnection.
   * @return {Function} A function that removes the subscription.
   */
  onDisconnect(callback) {
    this.#disconnectListeners.add(callback);
    return () => this.#disconnectListeners.delete(callback);
  }

  /**
   * Subscribes to Muse S Athena optics (fNIRS/PPG) packets. The callback is
   * called once per packet with `{ seq, index, channels, names, receivedAt }`,
   * where `channels` holds one array of raw 20-bit samples per optics channel
   * (named by `names`, see `opticsChannelNames`), `index` is the absolute
   * index of the first sample at 64 Hz, and `receivedAt` is the
   * `performance.now()` arrival time.
   *
   * @param {Function} callback - Called with each optics packet.
   * @return {Function} A function that removes the subscription.
   */
  onOptics(callback) {
    this.#opticsListeners.add(callback);
    return () => this.#opticsListeners.delete(callback);
  }

  /**
   * Subscribes to Muse S Athena motion packets. The callback is called once
   * per packet with `{ seq, index, accelerometer, gyroscope, receivedAt }`,
   * where `accelerometer` (g) and `gyroscope` (deg/s) each hold x, y and z
   * sample arrays, and `index` is the absolute index of the first sample at 52 Hz.
   *
   * @param {Function} callback - Called with each motion packet.
   * @return {Function} A function that removes the subscription.
   */
  onMotion(callback) {
    this.#motionListeners.add(callback);
    return () => this.#motionListeners.delete(callback);
  }

  /**
   * Calls each listener with a packet, isolating listener errors.
   *
   * @param {Set<Function>} listeners - The listeners to call.
   * @param {Object} packet - The packet to deliver.
   * @param {string} kind - The packet kind, for error messages.
   * @return {void} This function does not return a value.
   */
  #emit(listeners, packet, kind) {
    for (const listener of listeners) {
      try {
        listener(packet);
      } catch (error) {
        console.error(`${kind} listener failed:`, error);
      }
    }
  }

  /**
   * Advances the unwrapped packet count of a stream from its wrapping
   * sequence number.
   *
   * @param {string} key - Identifies the stream.
   * @param {number} seq - The packet's sequence number.
   * @param {number} modulo - The value at which the sequence number wraps.
   * @return {{count: number, dropped: number}} The packet's position since
   *   connecting, and how many packets were lost before it.
   */
  #trackSequence(key, seq, modulo) {
    const last = this.#seqTracker.get(key);
    let count = 0;
    let dropped = 0;
    if (last) {
      const step = (seq - last.seq + modulo) % modulo || 1;
      count = last.count + step;
      dropped = step - 1;
    }
    this.#seqTracker.set(key, { seq, count });
    return { count, dropped };
  }

  /**
   * Dispatches an EEG event to `eegData` and to `onEEG` subscribers.
   *
   * @param {number} n - The index of the EEG channel.
   * @param {Event} event - The event containing the EEG data.
   * @return {void} This function does not return a value.
   */
  #handleEEG(n, event) {
    const receivedAt = performance.now();
    this.eegData(n, event);
    if (this.#eegListeners.size === 0) return;
    const seq = this.eventEEGSequence(event);
    const { count } = this.#trackSequence(`eeg${n}`, seq, 0x10000);
    const packet = {
      channel: n,
      seq,
      index: count * EEG_SAMPLES_PER_PACKET,
      samples: this.eventEEGData(event).map(eegToMicrovolts),
      receivedAt,
    };
    this.#emit(this.#eegListeners, packet, "EEG");
  }

  /**
   * Parses a notification from the Muse S Athena data characteristic and
   * dispatches each sensor's samples to the subclass hooks and subscribers.
   *
   * @param {Event} event - The characteristic value changed event.
   * @return {void} This function does not return a value.
   */
  #handleAthenaData(event) {
    const receivedAt = performance.now();
    const view = event.target.value;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const stats = this.#athenaStats;
    stats.notifications++;
    const result = parseAthenaNotification(bytes, (sub) => {
      const nSamples = sub.values[0].length;
      const { count, dropped } = this.#trackSequence(`athena${sub.tag}`, sub.index, 0x100);
      stats.droppedSubpackets += dropped;
      const index = count * nSamples;
      switch (sub.type) {
        case "eeg": {
          this.#eegChannelCount = sub.values.length;
          this.athenaEEGData(sub.values);
          for (let ch = 0; ch < sub.values.length; ch++) {
            this.#emit(
              this.#eegListeners,
              { channel: ch, seq: sub.index, index, samples: sub.values[ch], receivedAt },
              "EEG"
            );
          }
          break;
        }
        case "optics": {
          this.#opticsChannelCount = sub.values.length;
          this.opticsData(sub.values);
          this.#emit(
            this.#opticsListeners,
            {
              seq: sub.index,
              index,
              channels: sub.values,
              names: this.opticsChannelNames,
              receivedAt,
            },
            "Optics"
          );
          break;
        }
        case "motion": {
          const accelerometer = sub.values.slice(0, 3);
          const gyroscope = sub.values.slice(3, 6);
          this.athenaMotionData(accelerometer, gyroscope);
          this.#emit(
            this.#motionListeners,
            { seq: sub.index, index, accelerometer, gyroscope, receivedAt },
            "Motion"
          );
          break;
        }
        case "battery":
          this.athenaBatteryData(sub.values[0][0]);
          break;
      }
    });
    stats.skippedBytes += result.skippedBytes;
  }

  /**
   * Resets the connection state after the headband went away, and notifies
   * subclasses through `disconnected`.
   *
   * @return {void} This function does not return a value.
   */
  #handleDisconnect() {
    if (this.#dev && this.#onGattDisconnected) {
      this.#dev.removeEventListener(
        "gattserverdisconnected",
        this.#onGattDisconnected
      );
    }
    this.#onGattDisconnected = null;
    this.#dev = null;
    this.#controlChar = null;
    this.#state = 0;
    this.disconnected();
    for (const listener of this.#disconnectListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Disconnect listener failed:", error);
      }
    }
  }

  /**
   * Decodes information from the given bytes array.
   *
   * @param {Uint8Array} bytes - The array of bytes containing information to decode.
   * @return {string} The decoded information as a string.
   */
  #decodeInfo(bytes) {
    return new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0]));
  }

  /**
   * Decodes unsigned 24-bit data from the given samples array.
   *
   * @param {Array} samples - The array of samples to decode.
   * @return {Array} The decoded 24-bit data array.
   */
  #decodeUnsigned24BitData(samples) {
    const samples24Bit = [];
    for (let i = 0; i < samples.length; i += 3) {
      samples24Bit.push(
        (samples[i] << 16) | (samples[i + 1] << 8) | samples[i + 2]
      );
    }
    return samples24Bit;
  }

  /**
   * Decodes unsigned 12-bit data from the given samples array.
   *
   * @param {Array} samples - The array of samples to decode.
   * @return {Array} The decoded 12-bit data array.
   */
  #decodeUnsigned12BitData(samples) {
    const samples12Bit = [];
    for (let i = 0; i < samples.length; i++) {
      if (i % 3 === 0) {
        samples12Bit.push((samples[i] << 4) | (samples[i + 1] >> 4));
      } else {
        samples12Bit.push(((samples[i] & 0xf) << 8) | samples[i + 1]);
        i++;
      }
    }
    return samples12Bit;
  }

  /**
   * Encodes a command by converting it to bytes and adding a length prefix.
   *
   * @param {string} cmd - The command to encode.
   * @return {Uint8Array} The encoded command as bytes.
   */
  #encodeCommand(cmd) {
    const encoded = new TextEncoder().encode(`X${cmd}\n`);
    encoded[0] = encoded.length - 1;
    return encoded;
  }

  /**
   * Returns the battery level from a given event.
   *
   * @param {object} event - The event containing the battery data.
   * @return {number} A number between 0 and 100.
   */
  eventBatteryData(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    return data.getUint16(2) / 512;
  }

  /**
   * Returns an array of motion data based on the DataView, scale, and offset provided.
   *
   * @param {DataView} dv - The DataView containing the motion data.
   * @param {number} scale - The scale factor to apply to the motion data.
   * @param {number} ofs - The offset for accessing motion data within the DataView.
   * @return {[number, number, number]} An triple of scaled motion data values.
   */
  motionData(dv, scale, ofs) {
    return [
      scale * dv.getInt16(ofs),
      scale * dv.getInt16(ofs + 2),
      scale * dv.getInt16(ofs + 4),
    ];
  }

  /**
   * Returns the accelerometer data from a given event.
   *
   * @param {object} event - The event containing the accelerometer data.
   * @return {[number[], number[], number[]]} An triple of accelerometer sample arrays,
   *                                          each sample a number between 0 and 1.
   */
  eventAccelerometerData(event) {
    const scale = 0.0000610352; // 1 / 2^14
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    let accelerometer = [[], [], []];
    for (let ofs = 2; ofs <= 14; ofs += 6) {
      const vals = this.motionData(data, scale, ofs);
      accelerometer[0].push(vals[0]);
      accelerometer[1].push(vals[1]);
      accelerometer[2].push(vals[2]);
    }
    return accelerometer;
  }

  /**
   * Returns the gyroscope data from a given event.
   *
   * @param {object} event - The event containing the gyroscope data.
   * @return {[number[], number[], number[]]} An triple of gyroscope sample arrays,
   *                                          each sample a number between 0 and 1.
   */
  eventGyroscopeData(event) {
    const scale = 0.0074768; // 1 / 2^7
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    let gyroscope = [[], [], []];
    for (let ofs = 2; ofs <= 14; ofs += 6) {
      const vals = this.motionData(data, scale, ofs);
      gyroscope[0].push(vals[0]);
      gyroscope[1].push(vals[1]);
      gyroscope[2].push(vals[2]);
    }
    return gyroscope;
  }

  /**
   * Returns the control data from a given event.
   *
   * @param {object} event - The event containing the control data.
   * @return {object} A dictionary of control data values.
   */
  eventControlData(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    const buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const str = this.#decodeInfo(buf);
    let info = {};
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      this.#infoFragment = this.#infoFragment + c;
      if (c === "}") {
        let tmp;
        try {
          tmp = JSON.parse(this.#infoFragment);
        } catch (error) {
          // A fragment was lost; drop the partial message and resynchronise.
          console.warn("Discarding malformed control message:", this.#infoFragment);
          this.#infoFragment = "";
          continue;
        }
        this.#infoFragment = "";
        for (const key in tmp) {
          info[key] = tmp[key];
        }
      }
    }
    return info;
  }

  /**
   * Returns the EEG data from a given event.
   *
   * @param {object} event - The event containing the EEG data.
   * @return {number[]} An array of samples, each a number between 0 and 2^12.
   */
  eventEEGData(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    return this.#decodeUnsigned12BitData(
      new Uint8Array(data.buffer).subarray(2)
    );
  }

  /**
   * Returns the packet sequence number from a given EEG event.
   *
   * @param {object} event - The event containing the EEG data.
   * @return {number} The 16-bit packet sequence number.
   */
  eventEEGSequence(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    return data.getUint16(0);
  }

  /**
   * Returns the PPG data from a given event.
   *
   * @param {object} event - The event containing the PPG data.
   * @return {number[]} An array of samples, each a number between 0 and 2^24.
   */
  eventPPGData(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    return this.#decodeUnsigned24BitData(
      new Uint8Array(data.buffer).subarray(2)
    );
  }

  /**
   * Asynchronously sends a command to the control character.
   *
   * @param {string} cmd - The command to send.
   * @return {Promise<void>} A promise that resolves when the command has been sent.
   */
  async #sendCommand(cmd) {
    await this.#controlChar["writeValue"](this.#encodeCommand(cmd));
  }
  /**
   * Pauses the operation by sending a command.
   *
   * @return {Promise<void>} A promise that resolves when the pause command is sent.
   */
  async #pause() {
    await this.#sendCommand("h");
  }
  /**
   * Resumes the operation by sending a command to the control character.
   *
   * @return {Promise<void>} A promise that resolves when the command to resume has been sent.
   */
  async #resume() {
    await this.#sendCommand("d");
  }
  /**
   * Starts the process by pausing, sending a command to set the priority to 50,
   * sending a command to start, and resuming.
   *
   * @return {Promise<void>} A promise that resolves when the process is started.
   */
  async #start() {
    await this.#pause();
    await this.#sendCommand("p50");
    await this.#sendCommand("s");
    await this.#resume();
  }
  /**
   * Starts streaming on a Muse S Athena: selects the preset and starts data
   * transmission. The headband does not acknowledge presets, so this waits for
   * EEG to arrive and retries the start command with "d" if it does not.
   *
   * @return {Promise<void>} A promise that resolves when the stream is started.
   */
  async #startAthena() {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const sequence = [
      ["v6", 200],
      ["s", 200],
      ["h", 200],
      [this.#preset, 200],
      ["s", 200],
      ["dc001", 50],
      ["dc001", 100],
      ["L1", 300],
      ["s", 200],
    ];
    for (const [cmd, delay] of sequence) {
      await this.#sendCommand(cmd);
      await wait(delay);
    }
    // EEG subpackets are tagged 0x11 (4 channels) or 0x12 (8 channels).
    const receivingEEG = () =>
      this.#seqTracker.has(`athena${0x11}`) || this.#seqTracker.has(`athena${0x12}`);
    for (let waited = 0; waited < 2000 && !receivingEEG(); waited += 100) await wait(100);
    if (!receivingEEG()) {
      // Some firmware versions reject dc001 and need the classic resume command.
      await this.#sendCommand("d");
      for (let waited = 0; waited < 2000 && !receivingEEG(); waited += 100) await wait(100);
      if (!receivingEEG()) console.warn("Muse S Athena connected but no EEG data arrived yet");
    }
  }
  /**
   * Disconnects from the device by calling the `disconnect` method on the `gatt` object of the `dev` property.
   * In mock mode, stops the data streaming.
   * Sets the `dev` property to `null` and the `state` property to `0`.
   *
   * @return {void} This function does not return a value.
   */
  disconnect() {
    if (this.mock) {
      this.#stopMockDataStream();
    }
    const dev = this.#dev;
    if (this.#isAthena && this.#controlChar) {
      // Halt streaming; the headband also stops once the link is closed.
      this.#sendCommand("h").catch(() => {});
    }
    // Detach the listener first so `disconnected` is called exactly once.
    this.#handleDisconnect();
    if (dev && dev["gatt"]["connected"]) dev["gatt"]["disconnect"]();
  }
  /**
   * Asynchronously connects to a characteristic in a BLE service and sets up a hook for characteristic value changes.
   *
   * @param {Object} service - The BLE service to connect to.
   * @param {string} cid - The UUID of the characteristic to connect to.
   * @param {Function} hook - The function to call when the characteristic value changes.
   * @return {Promise<Object>} A promise that resolves to the connected characteristic.
   */
  async #connectChar(service, cid, hook) {
    const c = await service["getCharacteristic"](cid);
    c["oncharacteristicvaluechanged"] = hook;
    await c["startNotifications"]();
    return c;
  }
  /**
   * Loads and parses the mock CSV data file.
   *
   * @return {Promise<Array>} A promise that resolves to parsed CSV data.
   */
  async #loadMockData() {
    try {
      const response = await fetch(this.mockDataPath);
      const text = await response.text();
      const lines = text.trim().split("\n");

      // Skip header line and parse CSV
      const data = [];
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",");
        if (values.length >= 5) {
          data.push({
            timestamp: parseFloat(values[0]),
            eeg: [
              parseFloat(values[1]), // TP9 (left ear)
              parseFloat(values[2]), // AF7 (left forehead)
              parseFloat(values[3]), // AF8 (right forehead)
              parseFloat(values[4]), // TP10 (right ear)
            ],
          });
        }
      }
      return data;
    } catch (error) {
      console.error("Failed to load mock data:", error);
      throw error;
    }
  }

  /**
   * Starts the mock data streaming. Like the real device, it emits one packet
   * of 12 consecutive samples per channel every 12/256 s, with an
   * incrementing sequence number. The CSV is assumed to be sampled at 256 Hz
   * and is looped.
   *
   * @return {void}
   */
  #startMockDataStream() {
    if (!this.mockData || this.mockData.length === 0) {
      console.error("No mock data available");
      return;
    }

    this.mockDataIndex = 0;
    this.#mockSeq = 0;
    const packetMs = (1000 * EEG_SAMPLES_PER_PACKET) / EEG_SAMPLE_RATE;
    const startedAt = performance.now();
    let packetsSent = 0;

    // Timers are coarse and throttled in background tabs, so on each tick
    // send every packet that is due rather than assuming one per tick.
    const feedDuePackets = () => {
      if (!this.mock || this.#state !== 2) return;
      const due = Math.floor((performance.now() - startedAt) / packetMs);
      while (packetsSent < due) {
        this.#feedMockPacket();
        packetsSent++;
      }
    };
    this.mockInterval = setInterval(feedDuePackets, packetMs);
  }

  /**
   * Sends one mock packet per EEG channel, taken from the next 12 CSV rows.
   *
   * @return {void}
   */
  #feedMockPacket() {
    const rows = [];
    for (let i = 0; i < EEG_SAMPLES_PER_PACKET; i++) {
      rows.push(this.mockData[this.mockDataIndex]);
      this.mockDataIndex = (this.mockDataIndex + 1) % this.mockData.length;
    }
    for (let ch = 0; ch < 4; ch++) {
      const mockEvent = {
        target: {
          value: this.#createMockEEGData(
            this.#mockSeq,
            rows.map((row) => row.eeg[ch])
          ),
        },
      };
      this.#handleEEG(ch, mockEvent);
    }
    this.#mockSeq = (this.#mockSeq + 1) & 0xffff;
  }

  /**
   * Creates a mock EEG packet in the format expected by eventEEGData.
   *
   * @param {number} seq - The 16-bit packet sequence number.
   * @param {number[]} values - 12 EEG values in microvolts.
   * @return {DataView} A DataView containing the mock EEG packet.
   */
  #createMockEEGData(seq, values) {
    // 2 bytes of sequence number, then 12 samples of 12 bits (18 bytes).
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    view.setUint16(0, seq);

    for (let i = 0; i < values.length; i++) {
      // Inverse of eegToMicrovolts: x = value / 0.48828125 + 0x800
      const x = Math.max(
        0,
        Math.min(0xfff, Math.round(values[i] / 0.48828125 + 0x800))
      );
      const byteOffset = 2 + Math.floor(i * 1.5);
      if (i % 2 === 0) {
        // High 8 bits, then low 4 bits in the high nibble of the next byte.
        uint8[byteOffset] = (x >> 4) & 0xff;
        uint8[byteOffset + 1] = (x & 0x0f) << 4;
      } else {
        // High 4 bits in the low nibble, then the low 8 bits.
        uint8[byteOffset] |= (x >> 8) & 0x0f;
        uint8[byteOffset + 1] = x & 0xff;
      }
    }

    return view;
  }

  /**
   * Stops the mock data streaming.
   *
   * @return {void}
   */
  #stopMockDataStream() {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
  }

  /**
   * Asynchronously connects to a BLE device and sets up characteristic value change hooks.
   * In mock mode, loads pre-recorded data instead of connecting to a real device.
   *
   * @return {Promise<void>} A promise that resolves when the connection is established.
   * @throws {Error} If the connection fails at any step.
   */
  async connect() {
    if (this.#dev || this.#state !== 0) {
      return;
    }
    this.#state = 1;

    // Mock mode: load CSV data and simulate streaming
    if (this.mock) {
      try {
        console.log("Connecting in mock mode...");
        this.mockData = await this.#loadMockData();
        console.log(`Loaded ${this.mockData.length} samples from mock data`);
        this.#state = 2;
        this.#startMockDataStream();
        return;
      } catch (error) {
        console.error("Failed to connect in mock mode:", error);
        this.#state = 0;
        throw error;
      }
    }

    // Real device connection. Failures (including a cancelled device picker)
    // reset the state and are rethrown so callers can tell they happened.
    this.#seqTracker.clear();
    this.#isAthena = false;
    this.#athenaStats = null;
    try {
      // Match by name as well, in case a headband does not advertise the service.
      this.#dev = await navigator["bluetooth"]["requestDevice"]({
        filters: [{ services: [this.#SERVICE] }, { namePrefix: "Muse" }],
        optionalServices: [this.#SERVICE],
      });
      const gatt = await this.#dev["gatt"]["connect"]();
      const service = await gatt["getPrimaryService"](this.#SERVICE);
      this.#onGattDisconnected = () => this.#handleDisconnect();
      this.#dev.addEventListener(
        "gattserverdisconnected",
        this.#onGattDisconnected
      );
      this.#controlChar = await this.#connectChar(
        service,
        this.#CONTROL_CHARACTERISTIC,
        (event) => this.controlData(event)
      );

      // The Muse S Athena has a single data characteristic instead of the
      // per-sensor characteristics of earlier models.
      const uuids = (await service["getCharacteristics"]()).map((c) =>
        c["uuid"].toLowerCase()
      );
      if (
        uuids.includes(ATHENA_DATA_CHARACTERISTIC) &&
        !uuids.includes(this.#EEG1_CHARACTERISTIC)
      ) {
        this.#isAthena = true;
        this.#athenaStats = { notifications: 0, droppedSubpackets: 0, skippedBytes: 0 };
        const onData = (event) => this.#handleAthenaData(event);
        await this.#connectChar(service, ATHENA_DATA_CHARACTERISTIC, onData);
        if (uuids.includes(ATHENA_DATA2_CHARACTERISTIC)) {
          try {
            await this.#connectChar(service, ATHENA_DATA2_CHARACTERISTIC, onData);
          } catch (error) {
            // Usually silent, and subscribing fails on some platforms.
          }
        }
        await this.#startAthena();
        this.#state = 2;
        return;
      }

      await this.#connectChar(service, this.#BATTERY_CHARACTERISTIC, (event) =>
        this.batteryData(event)
      );
      await this.#connectChar(
        service,
        this.#GYROSCOPE_CHARACTERISTIC,
        (event) => this.gyroscopeData(event)
      );
      await this.#connectChar(
        service,
        this.#ACCELEROMETER_CHARACTERISTIC,
        (event) => this.accelerometerData(event)
      );
      const ppgChars = [
        this.#PPG1_CHARACTERISTIC,
        this.#PPG2_CHARACTERISTIC,
        this.#PPG3_CHARACTERISTIC,
      ];
      for (let n = 0; n < ppgChars.length; n++) {
        await this.#connectChar(service, ppgChars[n], (event) =>
          this.ppgData(n, event)
        );
      }
      const eegChars = [
        this.#EEG1_CHARACTERISTIC,
        this.#EEG2_CHARACTERISTIC,
        this.#EEG3_CHARACTERISTIC,
        this.#EEG4_CHARACTERISTIC,
        this.#EEG5_CHARACTERISTIC,
      ];
      for (let n = 0; n < eegChars.length; n++) {
        await this.#connectChar(service, eegChars[n], (event) =>
          this.#handleEEG(n, event)
        );
      }
      await this.#start();
      await this.#sendCommand("v1");
    } catch (error) {
      const dev = this.#dev;
      if (this.#onGattDisconnected && dev) {
        dev.removeEventListener(
          "gattserverdisconnected",
          this.#onGattDisconnected
        );
      }
      this.#onGattDisconnected = null;
      this.#dev = null;
      this.#controlChar = null;
      this.#state = 0;
      if (dev && dev["gatt"]["connected"]) dev["gatt"]["disconnect"]();
      throw error;
    }
    this.#state = 2;
  }
}

/**
 * An interface for connecting with a Muse headband based on circular buffers of size 256.
 * Note: EEG data is in microvolts, in the range [-1000, 1000) on the Muse 2 and
 * [-725, 725] on the Muse S Athena.
 *
 * @extends MuseBase
 */
export class Muse extends MuseBase {
  /**
   * Constructs a new instance of the Muse class.
   *
   * @constructor
   * @param {Object} options - Configuration options
   * @param {boolean} [options.mock=false] - Enable mock mode to use pre-recorded data instead of real device
   * @param {string} [options.mockDataPath] - Path to mock data CSV file (defaults to assets/resting-state.csv)
   * @param {string} [options.preset="p1035"] - Muse S Athena preset (see ATHENA_PRESETS); ignored by other models
   */
  constructor(options = {}) {
    super(options);
    const BUFFER_SIZE = 256;
    // Muse S Athena optics channels (up to 16), raw 20-bit samples at 64 Hz.
    this.optics = Array.from({ length: 16 }, () => new MuseCircularBuffer(BUFFER_SIZE));
    this.batteryLevel = null;
    this.info = {};
    this.eeg = [
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
    ];
    this.ppg = [
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
    ];
    this.accelerometer = [
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
    ];
    this.gyroscope = [
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
      new MuseCircularBuffer(BUFFER_SIZE),
    ];
  }
  /**
   * Updates the battery level based on the received event.
   *
   * @param {Event} event - The event containing the battery data.
   * @return {void} This function does not return a value.
   */
  batteryData(event) {
    this.batteryLevel = this.eventBatteryData(event);
  }
  /**
   * Processes the accelerometer data from the given event.
   *
   * @param {Event} event - The event containing the accelerometer data.
   * @return {void} This function does not return a value.
   */
  accelerometerData(event) {
    const vals = this.eventAccelerometerData(event);
    for (let i = 0; i < 3; i++) {
      this.accelerometer[0].write(vals[0][i]);
      this.accelerometer[1].write(vals[1][i]);
      this.accelerometer[2].write(vals[2][i]);
    }
  }
  /**
   * Processes the gyroscope data from the given event.
   *
   * @param {Event} event - The event containing the gyroscope data.
   * @return {void} This function does not return a value.
   */
  gyroscopeData(event) {
    const vals = this.eventGyroscopeData(event);
    for (let i = 0; i < 3; i++) {
      this.gyroscope[0].write(vals[0][i]);
      this.gyroscope[1].write(vals[1][i]);
      this.gyroscope[2].write(vals[2][i]);
    }
  }
  /**
   * A function that processes control data from the given event.
   *
   * @param {Event} event - The event containing the control data.
   * @return {void} This function does not return a value.
   */
  controlData(event) {
    const tmp = this.eventControlData(event);
    for (const key in tmp) {
      this.info[key] = tmp[key];
    }
  }
  /**
   * Processes EEG data from the given event, scales it to the range [-1000, 1000),
   * and writes it to the corresponding EEG circular buffer.
   *
   * @param {number} n - The index of the EEG channel.
   * @param {Event} event - The event containing the EEG data.
   * @return {void} This function does not return a value.
   */
  eegData(n, event) {
    let samples = this.eventEEGData(event);
    samples = samples.map(eegToMicrovolts);
    for (let i = 0; i < samples.length; i++) {
      this.eeg[n].write(samples[i]);
    }
  }
  /**
   * Processes PPG data received from the event and writes it to the corresponding PPG circular buffer.
   *
   * @param {number} n - The index of the PPG circular buffer to write to.
   * @param {Event} event - The event containing the PPG data.
   * @return {void} This function does not return a value.
   */
  ppgData(n, event) {
    const samples = this.eventPPGData(event);
    for (let i = 0; i < samples.length; i++) {
      this.ppg[n].write(samples[i]);
    }
  }
  /**
   * Writes Muse S Athena EEG samples to the EEG circular buffers. In
   * 8-channel presets, only the first auxiliary channel fits in `eeg[4]`.
   *
   * @param {number[][]} channels - One array of samples in microvolts per EEG channel.
   * @return {void} This function does not return a value.
   */
  athenaEEGData(channels) {
    const n = Math.min(channels.length, this.eeg.length);
    for (let ch = 0; ch < n; ch++) {
      for (const sample of channels[ch]) this.eeg[ch].write(sample);
    }
  }
  /**
   * Writes Muse S Athena optics samples to the optics circular buffers.
   *
   * @param {number[][]} channels - One array of raw samples per optics channel.
   * @return {void} This function does not return a value.
   */
  opticsData(channels) {
    for (let ch = 0; ch < channels.length; ch++) {
      for (const sample of channels[ch]) this.optics[ch].write(sample);
    }
  }
  /**
   * Writes Muse S Athena motion samples to the accelerometer and gyroscope buffers.
   *
   * @param {number[][]} accelerometer - x, y and z sample arrays, in g.
   * @param {number[][]} gyroscope - x, y and z sample arrays, in degrees per second.
   * @return {void} This function does not return a value.
   */
  athenaMotionData(accelerometer, gyroscope) {
    for (let axis = 0; axis < 3; axis++) {
      for (const sample of accelerometer[axis]) this.accelerometer[axis].write(sample);
      for (const sample of gyroscope[axis]) this.gyroscope[axis].write(sample);
    }
  }
  /**
   * Updates the battery level from the Muse S Athena.
   *
   * @param {number} percent - The battery level, between 0 and 100.
   * @return {void} This function does not return a value.
   */
  athenaBatteryData(percent) {
    this.batteryLevel = percent;
  }
}

/**
 * Connects to a Muse device and returns the connected Muse object.
 *
 * @param {Object} options - Configuration options
 * @param {boolean} [options.mock=false] - Enable mock mode to use pre-recorded data instead of real device
 * @param {string} [options.mockDataPath] - Path to mock data CSV file (defaults to assets/resting-state.csv)
 * @return {Muse} The connected Muse object.
 */
export const connectMuse = async (options = {}) => {
  const muse = new Muse(options);
  if (options.mock) {
    console.log("Attempting to connect to Muse in mock mode...");
  } else {
    console.log("Attempting to connect to Muse...");
  }
  await muse.connect();
  console.log("Muse connected:", muse);
  return muse;
};
