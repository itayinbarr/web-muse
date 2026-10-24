export declare const EEG_SAMPLE_RATE: 256;
export declare const EEG_SAMPLES_PER_PACKET: 12;
export declare const EEG_CHANNEL_NAMES: readonly ["TP9", "AF7", "AF8", "TP10", "AUX"];

export declare function eegToMicrovolts(x: number): number;

export declare const ATHENA_EEG_SAMPLE_RATE: 256;
export declare const ATHENA_OPTICS_SAMPLE_RATE: 64;
export declare const ATHENA_MOTION_SAMPLE_RATE: 52;
export declare const ATHENA_EEG_SCALE: number;
export declare const ATHENA_EEG_MIDPOINT: 8192;
export declare const ATHENA_EEG_MAX: 16383;
export declare const ATHENA_DATA_CHARACTERISTIC: string;
export declare const ATHENA_DATA2_CHARACTERISTIC: string;
export declare const ATHENA_EEG_CHANNEL_NAMES: readonly string[];
export declare const ATHENA_OPTICS_CHANNEL_NAMES: Readonly<Record<4 | 8 | 16, readonly string[]>>;
export declare const ATHENA_PRESETS: Readonly<Record<string, string>>;
export declare const ATHENA_DEFAULT_PRESET: "p1035";
export declare const ATHENA_TAGS: Readonly<
  Record<number, { type: AthenaSubpacket["type"]; channels: number; samples: number; bytes: number }>
>;

export declare function athenaEegToMicrovolts(x: number): number;
export declare function unpackLE(bytes: Uint8Array, offset: number, count: number, bits: number): number[];

/** One decoded subpacket from the Muse S Athena data stream. */
export interface AthenaSubpacket {
  type: "eeg" | "optics" | "motion" | "drlref" | "battery";
  tag: number;
  /** 8-bit per-sensor subpacket counter. */
  index: number;
  /** 16-bit counter of the packet holding the subpacket. */
  packetCounter: number;
  /** Raw counts per channel (EEG and optics), otherwise null. */
  raw: number[][] | null;
  /** Samples per channel in physical units (µV, raw optics counts, g and deg/s, or %). */
  values: number[][];
}

export declare function parseAthenaNotification(
  bytes: Uint8Array,
  onSubpacket: (subpacket: AthenaSubpacket) => void
): { packets: number; subpackets: number; skippedBytes: number };

/** One EEG packet from one channel, as delivered to `onEEG` subscribers. */
export interface EEGPacket {
  /** EEG channel index: 0=TP9, 1=AF7, 2=AF8, 3=TP10, then AUX. */
  channel: number;
  /** Device packet sequence number (16-bit on the Muse 2, 8-bit on the Athena). */
  seq: number;
  /** Absolute index of samples[0] since connecting; sample i has index index + i. */
  index: number;
  /** Samples in microvolts: 12 on the Muse 2, 4 or 2 on the Athena. */
  samples: number[];
  /** `performance.now()` at packet arrival, in milliseconds. */
  receivedAt: number;
}

/** One optics (fNIRS/PPG) packet from a Muse S Athena. */
export interface OpticsPacket {
  seq: number;
  /** Absolute index of the first sample at 64 Hz. */
  index: number;
  /** Raw 20-bit samples, one array per optics channel. */
  channels: number[][];
  /** Channel names, e.g. "LI_730" (left inner, 730 nm). */
  names: string[];
  receivedAt: number;
}

/** One accelerometer/gyroscope packet from a Muse S Athena. */
export interface MotionPacket {
  seq: number;
  /** Absolute index of the first sample at 52 Hz. */
  index: number;
  /** x, y, z sample arrays in g. */
  accelerometer: number[][];
  /** x, y, z sample arrays in degrees per second. */
  gyroscope: number[][];
  receivedAt: number;
}

export interface MuseOptions {
  /** Use pre-recorded data instead of a real device. */
  mock?: boolean;
  /** URL of the mock data CSV. */
  mockDataPath?: string;
  /** Muse S Athena preset, e.g. "p1035" (default) or "p1041"; ignored by other models. */
  preset?: string;
}

interface MuseCircularBuffer {
  memory: number[];
  length: number;
  isFull: boolean;
  lastwrite: number;
  read(): number | null;
  write(value: number): void;
}

export declare abstract class MuseBase {
  constructor(options?: MuseOptions);
  mock: boolean;
  /** 0 if disconnected, 1 while connecting, 2 if connected. */
  readonly state: 0 | 1 | 2;
  /** Whether the connected headband is a Muse S Athena (MS-03). */
  readonly isAthena: boolean;
  /** The Athena preset in use, or null for other models. */
  readonly preset: string | null;
  readonly eegChannelNames: string[];
  readonly opticsChannelNames: string[];
  /** Athena stream diagnostics, or null for other models. */
  readonly stats: { notifications: number; droppedSubpackets: number; skippedBytes: number } | null;
  connect(): Promise<void>;
  disconnect(): void;
  onEEG(callback: (packet: EEGPacket) => void): () => void;
  offEEG(callback: (packet: EEGPacket) => void): void;
  onDisconnect(callback: () => void): () => void;
  onOptics(callback: (packet: OpticsPacket) => void): () => void;
  onMotion(callback: (packet: MotionPacket) => void): () => void;

  batteryData(event: Event): void;
  accelerometerData(event: Event): void;
  gyroscopeData(event: Event): void;
  controlData(event: Event): void;
  eegData(n: number, event: Event): void;
  ppgData(n: number, event: Event): void;
  disconnected(): void;
  athenaEEGData(channels: number[][]): void;
  opticsData(channels: number[][]): void;
  athenaMotionData(accelerometer: number[][], gyroscope: number[][]): void;
  athenaBatteryData(percent: number): void;

  eventBatteryData(event: Event): number;
  eventAccelerometerData(event: Event): [number[], number[], number[]];
  eventGyroscopeData(event: Event): [number[], number[], number[]];
  eventControlData(event: Event): Record<string, unknown>;
  eventEEGData(event: Event): number[];
  eventEEGSequence(event: Event): number;
  eventPPGData(event: Event): number[];
}

export declare class Muse extends MuseBase {
  batteryLevel: number | null;
  info: Record<string, unknown>;
  eeg: MuseCircularBuffer[];
  ppg: MuseCircularBuffer[];
  /** Muse S Athena optics channels (raw samples at 64 Hz). */
  optics: MuseCircularBuffer[];
  accelerometer: MuseCircularBuffer[];
  gyroscope: MuseCircularBuffer[];
}

export declare function connectMuse(options?: MuseOptions): Promise<Muse>;
