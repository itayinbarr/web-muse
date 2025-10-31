# API Documentation

## Core API

### `connectMuse(options)`

Connects to a Muse device using Web Bluetooth API or uses mock data for development.

**Parameters:**

- `options` (Object, optional) - Configuration options
  - `mock` (boolean, default: false) - Enable mock mode to use pre-recorded data
  - `mockDataPath` (string, optional) - Path to custom CSV file for mock data

**Examples:**

```javascript
// Connect to real device
const muse = await connectMuse();

// Connect with mock data (no device required)
const muse = await connectMuse({ mock: true });

// Connect with custom mock data
const muse = await connectMuse({
  mock: true,
  mockDataPath: "/path/to/custom-data.csv",
});
```

Returns a `Muse` instance.

### Class: `Muse`

The main class for interacting with the Muse device.

#### Constructor

```javascript
new Muse(options);
```

**Parameters:**

- `options` (Object, optional) - Configuration options
  - `mock` (boolean, default: false) - Enable mock mode
  - `mockDataPath` (string, optional) - Path to custom CSV file for mock data

**Example:**

```javascript
// Create Muse instance with mock mode
const muse = new Muse({ mock: true });
await muse.connect();
```

#### Properties

- `eeg`: Array of `MuseCircularBuffer` instances for EEG channels (4-5 channels)
- `ppg`: Array of `MuseCircularBuffer` instances for PPG channels (3 channels)
- `accelerometer`: Array of `MuseCircularBuffer` instances for accelerometer data (3 axes)
- `gyroscope`: Array of `MuseCircularBuffer` instances for gyroscope data (3 axes)
- `batteryLevel`: Current battery level (number, 0-100)
- `state`: Connection state (0: disconnected, 1: connecting, 2: connected)
- `mock`: Boolean indicating if mock mode is enabled

#### Methods

- `connect()`: Initiates connection to the device (or loads mock data in mock mode)
- `disconnect()`: Disconnects from the device (or stops mock data stream)

### EEG Processing

#### `startRecording()`

Starts recording EEG data.

#### `stopRecording()`

Stops recording and returns processed data:

```javascript
const data = await stopRecording();
// Returns:
{
  rawEEG: number[][],       // Raw EEG data
  spectraData: number[][],  // Power spectra
  powerData: object[],      // Power by frequency band
  alphaData: number[]       // Alpha band power
}
```

## React Integration

### `EEGProvider`

React context provider for EEG functionality.

```jsx
<EEGProvider>
  <App />
</EEGProvider>
```

### `useEEG` Hook

React hook for accessing EEG functionality.

```javascript
const {
  muse, // Muse instance
  isConnected, // Connection status
  isMockData, // Whether using mock data
  rawEEG, // Latest EEG readings
  connectMuse, // Function to connect to Muse
  connectMockData, // Function to use mock data
  disconnectEEG, // Function to disconnect
  startRecording, // Start recording function
  stopRecording, // Stop recording function
} = useEEG();
```

## Signal Processing

### Frequency Bands

The library processes EEG data into the following frequency bands:

- Delta: 0.5-4 Hz
- Theta: 4-8 Hz
- Alpha: 8-13 Hz
- Beta: 13-30 Hz
- Gamma: 30-100 Hz

### Data Processing Pipeline

1. Raw data collection (256 Hz sampling rate)
2. Signal filtering and artifact removal
3. Power spectrum calculation using periodogram method
4. Frequency band power extraction
5. Real-time data streaming to application

## Mock Mode

### Overview

Mock mode allows development and testing without a physical Muse device. When enabled, the library loads pre-recorded EEG data from a CSV file and streams it at the correct sample rate, looping continuously.

### Features

- **No device required**: Perfect for development and testing
- **Realistic timing**: Respects original timestamps from recordings
- **Seamless API**: Works identically to real device connection
- **Custom data**: Support for custom CSV files

### Mock Data Format

The CSV file should follow this format:

```csv
Timestamp (ms),TP9 (left ear),AF7 (left forehead),AF8 (right forehead),TP10 (right ear)
5,-0.48828125,0,-0.48828125,-0.48828125
7,0,-0.48828125,-0.48828125,0
10,4.8828125,-0.48828125,2.44140625,3.90625
...
```

**Columns:**

1. `Timestamp (ms)`: Timestamp in milliseconds
2. `TP9`: Left ear electrode data
3. `AF7`: Left forehead electrode data
4. `AF8`: Right forehead electrode data
5. `TP10`: Right ear electrode data

Data values should be in the range of approximately -1000 to 1000 (scaled EEG values).

### Usage Examples

**Basic mock mode:**

```javascript
const muse = await connectMuse({ mock: true });
// Works just like real device!
```

**Custom mock data file:**

```javascript
const muse = await connectMuse({
  mock: true,
  mockDataPath: "/data/my-recording.csv",
});
```

**Switching between real and mock:**

```javascript
const isDevelopment = process.env.NODE_ENV === "development";
const muse = await connectMuse({ mock: isDevelopment });
```

## Error Handling

The library includes comprehensive error handling for:

- Bluetooth connection issues
- Data processing errors
- Device disconnection events
- Mock data loading errors

Errors can be caught using standard try-catch blocks:

```javascript
try {
  await connectMuse();
} catch (error) {
  console.error("Connection error:", error);
}

// With mock mode
try {
  await connectMuse({ mock: true });
} catch (error) {
  console.error("Failed to load mock data:", error);
}
```
