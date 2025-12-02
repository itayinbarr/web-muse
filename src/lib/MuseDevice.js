import { MuseCircularBuffer } from "./CircularBuffer.js";

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
  #deviceModel = null;

  /**
   * Constructs a new interface for connecting to a Muse headband.
   *
   * @abstract
   * @constructor
   * @param {Object} options - Configuration options
   * @param {boolean} [options.mock=false] - Enable mock mode to use pre-recorded data instead of real device
   * @param {string} [options.mockDataPath] - Path to mock data CSV file (defaults to assets/resting-state.csv)
   */
  constructor(options = {}) {
    if (new.target === MuseBase) {
      throw new TypeError("Cannot construct MuseBase instances directly");
    }
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
   * The detected device model.
   *
   * @type {string|null} The device model ('MS-03', 'MU-03', or null if not detected).
   */
  get _deviceModel() {
    return this.#deviceModel;
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
   * A method that handles the disconnection event.
   *
   * @abstract
   * @param {void} This function does not take any parameters.
   * @return {void} This function does not return a value.
   */
  disconnected() {}

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
   * Detects the device model from the info object.
   *
   * @param {Object} info - The info object containing device information.
   * @return {string} The detected device model ('MS-03' or 'MU-03').
   */
  #detectDeviceModel(info) {
    const hwString = String(info.hw || info.model || info.mp || "").toUpperCase();
    if (hwString.includes('MS-03') || hwString.includes('CEC3')) {
      console.log('Detected Muse S (MS-03) device');
      return 'MS-03';
    }
    console.log('Detected Muse 2 (MU-03) device or defaulting to MU-03');
    return 'MU-03'; // Default to Muse 2
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
   * Decodes unsigned 14-bit data from the given samples array.
   * 14 bits per sample: 7 bytes encode 4 samples.
   *
   * @param {Array} samples - The array of samples to decode.
   * @return {Array} The decoded 14-bit data array.
   */
  #decodeUnsigned14BitData(samples) {
    const samples14Bit = [];
    // 14 bits per sample: 7 bytes encode 4 samples
    for (let i = 0; i < samples.length; i += 7) {
      if (i + 6 < samples.length) {
        // Sample 0: byte[0] + 6 bits of byte[1]
        samples14Bit.push((samples[i] << 6) | (samples[i + 1] >> 2));
        // Sample 1: 2 bits of byte[1] + byte[2] + 4 bits of byte[3]
        samples14Bit.push(((samples[i + 1] & 0x03) << 12) | (samples[i + 2] << 4) | (samples[i + 3] >> 4));
        // Sample 2: 4 bits of byte[3] + byte[4] + 2 bits of byte[5]
        samples14Bit.push(((samples[i + 3] & 0x0f) << 10) | (samples[i + 4] << 2) | (samples[i + 5] >> 6));
        // Sample 3: 6 bits of byte[5] + byte[6]
        samples14Bit.push(((samples[i + 5] & 0x3f) << 8) | samples[i + 6]);
      }
    }
    return samples14Bit;
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
    const buf = new Uint8Array(data.buffer);
    const str = this.#decodeInfo(buf);
    let info = {};
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      this.#infoFragment = this.#infoFragment + c;
      if (c === "}") {
        const tmp = JSON.parse(this.#infoFragment);
        this.#infoFragment = "";
        for (const key in tmp) {
          info[key] = tmp[key];
        }
        // Detect device model if not already detected and info contains identifying fields
        if (!this.#deviceModel && Object.keys(tmp).length > 0) {
          this.#deviceModel = this.#detectDeviceModel(tmp);
        }
      }
    }
    return info;
  }

  /**
   * Returns the EEG data from a given event.
   *
   * @param {object} event - The event containing the EEG data.
   * @return {number[]} An array of samples, each a number between 0 and 2^12 (Muse 2) or 2^14 (MS-03).
   */
  eventEEGData(event) {
    let data = event.target.value;
    data = data.buffer ? data : new DataView(data);
    const bytes = new Uint8Array(data.buffer).subarray(2);

    // Use appropriate decoder based on device model
    if (this.#deviceModel === 'MS-03') {
      return this.#decodeUnsigned14BitData(bytes);
    } else {
      return this.#decodeUnsigned12BitData(bytes);
    }
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
   * Starts the process by pausing, sending the appropriate preset command,
   * sending a command to start, and resuming.
   *
   * @return {Promise<void>} A promise that resolves when the process is started.
   */
  async #start() {
    await this.#pause();

    // Select preset based on device model
    const preset = this.#deviceModel === 'MS-03' ? 'p1021' : 'p50';
    console.log(`Using preset ${preset} for device model ${this.#deviceModel}`);
    await this.#sendCommand(preset);

    await this.#sendCommand("s");
    await this.#resume();
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
    if (this.#dev) this.#dev["gatt"]["disconnect"]();
    this.#dev = null;
    this.#state = 0;
    this.disconnected();
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
    c["startNotifications"]();
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
   * Starts the mock data streaming.
   *
   * @return {void}
   */
  #startMockDataStream() {
    if (!this.mockData || this.mockData.length === 0) {
      console.error("No mock data available");
      return;
    }

    this.mockDataIndex = 0;
    const that = this;

    // Function to feed the next data point
    const feedNextSample = () => {
      if (!that.mock || that.#state !== 2) {
        return;
      }

      const currentSample = that.mockData[that.mockDataIndex];
      const nextIndex = (that.mockDataIndex + 1) % that.mockData.length;
      const nextSample = that.mockData[nextIndex];

      // Calculate delay to next sample based on timestamps
      let delay = 4; // Default ~250Hz if timestamps are missing
      if (currentSample.timestamp && nextSample.timestamp) {
        delay = nextSample.timestamp - currentSample.timestamp;
        // Wrap around case
        if (delay < 0) {
          delay = 4; // Default delay when looping
        }
      }

      // Feed EEG data to each channel
      for (let i = 0; i < 4; i++) {
        const mockEvent = {
          target: {
            value: that.#createMockEEGData(currentSample.eeg[i]),
          },
        };
        that.eegData(i, mockEvent);
      }

      // Move to next sample
      that.mockDataIndex = nextIndex;

      // Schedule next sample
      that.mockInterval = setTimeout(feedNextSample, delay);
    };

    // Start feeding data
    feedNextSample();
  }

  /**
   * Creates mock EEG data in the format expected by eventEEGData.
   *
   * @param {number} value - The EEG value to encode.
   * @return {DataView} A DataView containing the mock EEG data.
   */
  #createMockEEGData(value) {
    // The eventEEGData method expects 12-bit unsigned data
    // Convert from scaled value back to 12-bit: value = 0.48828125 * (x - 0x800)
    // Therefore: x = (value / 0.48828125) + 0x800
    const unsigned12bit = Math.max(
      0,
      Math.min(0xfff, Math.round(value / 0.48828125 + 0x800))
    );

    // Pack into bytes (12 samples = 18 bytes, we'll create 1 sample for simplicity)
    // Format: each 12-bit sample takes 1.5 bytes
    // For 12 samples: 18 bytes of data + 2 bytes header
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    // Pack 12 identical samples (as the real device sends 12 samples per packet)
    for (let i = 0; i < 12; i++) {
      const byteOffset = 2 + Math.floor(i * 1.5);
      if (i % 2 === 0) {
        uint8[byteOffset] = (unsigned12bit >> 4) & 0xff;
        uint8[byteOffset + 1] =
          ((unsigned12bit & 0x0f) << 4) | ((unsigned12bit >> 8) & 0x0f);
      } else {
        uint8[byteOffset] =
          (uint8[byteOffset] & 0xf0) | ((unsigned12bit >> 8) & 0x0f);
        uint8[byteOffset + 1] = unsigned12bit & 0xff;
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
      clearTimeout(this.mockInterval);
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

    // Real device connection
    try {
      this.#dev = await navigator["bluetooth"]["requestDevice"]({
        filters: [{ services: [this.#SERVICE] }],
      });
    } catch (error) {
      this.#dev = null;
      this.#state = 0;
      return;
    }
    let gatt = undefined;
    try {
      gatt = await this.#dev["gatt"]["connect"]();
    } catch (error) {
      this.#dev = null;
      this.#state = 0;
      return;
    }
    const service = await gatt["getPrimaryService"](this.#SERVICE);
    const that = this;
    this.#dev.addEventListener("gattserverdisconnected", function () {
      this.#dev = null;
      this.#state = 0;
      that.disconnected();
    });

    // Discover all available characteristics
    console.log('Discovering available characteristics...');
    try {
      const allChars = await service.getCharacteristics();
      console.log(`Found ${allChars.length} characteristics:`);
      allChars.forEach((char, idx) => {
        console.log(`  ${idx + 1}. ${char.uuid}`);
      });
    } catch (e) {
      console.warn('Could not enumerate characteristics:', e);
    }

    this.#controlChar = await this.#connectChar(
      service,
      this.#CONTROL_CHARACTERISTIC,
      function (event) {
        that.controlData(event);
      }
    );

    // Wait for device model detection (with timeout)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('Device detection timeout, defaulting to MU-03');
        if (!that.#deviceModel) {
          that.#deviceModel = 'MU-03';
        }
        resolve();
      }, 2000);

      const checkModel = setInterval(() => {
        if (that.#deviceModel) {
          clearTimeout(timeout);
          clearInterval(checkModel);
          console.log(`Device model detected: ${that.#deviceModel}`);
          resolve();
        }
      }, 100);
    });

    // Connect to optional characteristics (may not exist on all devices)
    try {
      await this.#connectChar(
        service,
        this.#BATTERY_CHARACTERISTIC,
        function (event) {
          that.batteryData(event);
        }
      );
      console.log('Battery characteristic connected');
    } catch (e) {
      console.warn('Battery characteristic not available');
    }

    try {
      await this.#connectChar(
        service,
        this.#GYROSCOPE_CHARACTERISTIC,
        function (event) {
          that.gyroscopeData(event);
        }
      );
      console.log('Gyroscope characteristic connected');
    } catch (e) {
      console.warn('Gyroscope characteristic not available');
    }

    try {
      await this.#connectChar(
        service,
        this.#ACCELEROMETER_CHARACTERISTIC,
        function (event) {
          that.accelerometerData(event);
        }
      );
      console.log('Accelerometer characteristic connected');
    } catch (e) {
      console.warn('Accelerometer characteristic not available');
    }

    // Only connect PPG for Muse 2 devices (MS-03 doesn't have PPG)
    if (this.#deviceModel !== 'MS-03') {
      try {
        await this.#connectChar(
          service,
          this.#PPG1_CHARACTERISTIC,
          function (event) {
            that.ppgData(0, event);
          }
        );
        await this.#connectChar(
          service,
          this.#PPG2_CHARACTERISTIC,
          function (event) {
            that.ppgData(1, event);
          }
        );
        await this.#connectChar(
          service,
          this.#PPG3_CHARACTERISTIC,
          function (event) {
            that.ppgData(2, event);
          }
        );
        console.log('PPG characteristics connected');
      } catch (e) {
        console.warn('PPG characteristics not available:', e.message);
      }
    } else {
      console.log('Skipping PPG characteristics for MS-03 device');
    }

    // Connect EEG characteristics (try each one, some may not exist)
    const eegChars = [
      this.#EEG1_CHARACTERISTIC,
      this.#EEG2_CHARACTERISTIC,
      this.#EEG3_CHARACTERISTIC,
      this.#EEG4_CHARACTERISTIC,
      this.#EEG5_CHARACTERISTIC,
    ];

    for (let i = 0; i < eegChars.length; i++) {
      try {
        await this.#connectChar(
          service,
          eegChars[i],
          function (event) {
            that.eegData(i, event);
          }
        );
        console.log(`EEG${i + 1} characteristic connected`);
      } catch (e) {
        console.warn(`EEG${i + 1} characteristic not available`);
      }
    }

    await this.#start();
    await this.#sendCommand("v1");
    this.#state = 2;
  }
}

/**
 * An interface for connecting with a Muse headband based on circular buffers of size 256.
 * Note: EEG data is mapped into the range [-1000, 1000).
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
   */
  constructor(options = {}) {
    super(options);
    const BUFFER_SIZE = 256;
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
   * Gets the detected device model.
   *
   * @return {string|null} The device model ('MS-03', 'MU-03', or null if not detected).
   */
  get deviceModel() {
    return this._deviceModel;
  }

  /**
   * Gets the device capabilities based on the detected model.
   *
   * @return {Object} An object containing device capabilities information.
   */
  get capabilities() {
    const model = this.deviceModel || 'Unknown';
    return {
      model: model,
      eegChannels: 4,
      eegBitDepth: model === 'MS-03' ? 14 : 12,
      hasPPG: model !== 'MS-03',
      hasOptics: false, // Not implemented yet
      preset: model === 'MS-03' ? 'p1021' : 'p50'
    };
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
    const vals = this.eventAccelerometerData(event);
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

    // Determine scaling based on device model
    const is14Bit = this.deviceModel === 'MS-03';
    const offset = is14Bit ? 0x2000 : 0x800;
    const scale = is14Bit ? 0.48828125 / 4 : 0.48828125;

    samples = samples.map(x => scale * (x - offset));

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
