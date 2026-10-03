export declare const EEG_SAMPLE_RATE: 256;
export declare const EEG_SAMPLES_PER_PACKET: 12;
export declare const EEG_CHANNEL_NAMES: readonly ["TP9", "AF7", "AF8", "TP10", "AUX"];

export declare function eegToMicrovolts(x: number): number;

/** One EEG packet from one channel, as delivered to `onEEG` subscribers. */
export interface EEGPacket {
  /** EEG characteristic index: 0=TP9, 1=AF7, 2=AF8, 3=TP10, 4=AUX. */
  channel: number;
  /** 16-bit packet sequence number; sample i has index seq * 12 + i. */
  seq: number;
  /** 12 samples in microvolts. */
  samples: number[];
  /** `performance.now()` at packet arrival, in milliseconds. */
  receivedAt: number;
}

export interface MuseOptions {
  /** Use pre-recorded data instead of a real device. */
  mock?: boolean;
  /** URL of the mock data CSV. */
  mockDataPath?: string;
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
  connect(): Promise<void>;
  disconnect(): void;
  onEEG(callback: (packet: EEGPacket) => void): () => void;
  offEEG(callback: (packet: EEGPacket) => void): void;
  onDisconnect(callback: () => void): () => void;

  batteryData(event: Event): void;
  accelerometerData(event: Event): void;
  gyroscopeData(event: Event): void;
  controlData(event: Event): void;
  eegData(n: number, event: Event): void;
  ppgData(n: number, event: Event): void;
  disconnected(): void;

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
  accelerometer: MuseCircularBuffer[];
  gyroscope: MuseCircularBuffer[];
}

export declare function connectMuse(options?: MuseOptions): Promise<Muse>;
