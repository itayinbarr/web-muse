import React, { createContext, useContext, useState, useEffect } from "react";
import { connectMuse as connectMuseLib } from "../../lib/MuseDevice";
import { setupPipeline } from "../../lib/eeg";

const EEGContext = createContext();

export const useEEG = () => useContext(EEGContext);

export const EEGProvider = ({ children }) => {
  const [muse, setMuse] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMockData, setIsMockData] = useState(false);
  const [rawEEG, setRawEEG] = useState([]);

  /**
   * Connects to a Muse device (real or mock).
   * 
   * @param {Object} options - Connection options
   * @param {boolean} [options.mock=false] - Enable mock mode
   * @param {string} [options.mockDataPath] - Path to custom CSV file for mock data
   */
  const connectMuse = async (options = {}) => {
    try {
      const museDevice = await connectMuseLib(options);
      setMuse(museDevice);
      setIsConnected(true);
      setIsMockData(options.mock || false);
    } catch (error) {
      console.error("Error connecting to Muse:", error);
      throw error;
    }
  };

  useEffect(() => {
    if (muse) {
      const cleanup = setupPipeline(muse, setRawEEG);
      return cleanup;
    }
  }, [muse]);

  /**
   * Legacy method for mock data connection.
   * @deprecated Use connectMuse({ mock: true }) instead
   */
  const connectMockData = async () => {
    console.warn('connectMockData is deprecated. Use connectMuse({ mock: true }) instead.');
    return connectMuse({ mock: true });
  };

  const disconnectEEG = () => {
    if (muse) {
      muse.disconnect();
    }
    setMuse(null);
    setIsConnected(false);
    setIsMockData(false);
  };

  const value = {
    muse,
    isConnected,
    isMockData,
    rawEEG,
    connectMuse,
    connectMockData, // Keep for backward compatibility
    disconnectEEG,
  };

  return <EEGContext.Provider value={value}>{children}</EEGContext.Provider>;
};
