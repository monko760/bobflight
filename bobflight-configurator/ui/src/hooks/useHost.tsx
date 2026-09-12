import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createHost,
  type BobFlightHost,
  type ConnectionStatus,
  type ParsedStatus,
} from "../protocol";

interface HostContextValue {
  host: BobFlightHost;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  setLastError: (msg: string | null) => void;
  version: string | null;
  status: ParsedStatus | null;
  cliLines: string[];
  appendCli: (line: string) => void;
  clearCli: () => void;
  refreshStatus: () => Promise<void>;
  pollAfterConnect: () => Promise<void>;
  /** True after a flash until user confirms CDC reconnect / version OK. */
  postFlashGate: boolean;
  setPostFlashGate: (locked: boolean) => void;
  clearPostFlashGateAfterReconnect: () => void;
}

const HostContext = createContext<HostContextValue | null>(null);

export function HostProvider({ children }: { children: ReactNode }) {
  const host = useMemo(() => createHost(), []);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<ParsedStatus | null>(null);
  const [cliLines, setCliLines] = useState<string[]>([]);
  const [postFlashGate, setPostFlashGate] = useState(false);

  useEffect(() => {
    const offStatus = host.onStatus(setConnectionStatus);
    const offLine = host.onLine((line) => {
      setCliLines((prev) => [...prev.slice(-499), line]);
    });
    return () => {
      offStatus();
      offLine();
    };
  }, [host]);

  useEffect(() => {
    if (connectionStatus === "disconnected" || connectionStatus === "error") {
      setVersion(null);
      setStatus(null);
    }
  }, [connectionStatus]);

  const appendCli = useCallback((line: string) => {
    setCliLines((prev) => [...prev.slice(-499), line]);
  }, []);

  const clearCli = useCallback(() => setCliLines([]), []);

  const refreshStatus = useCallback(async () => {
    if (host.getConnectionStatus() !== "connected") return;
    const s = await host.getStatus();
    setStatus(s);
  }, [host]);

  const pollAfterConnect = useCallback(async () => {
    if (host.getConnectionStatus() !== "connected") return;
    const v = await host.getVersion();
    setVersion(v);
    const s = await host.getStatus();
    setStatus(s);
    // Auto-clear gate when post-flash reconnect yields version+status.
    if (v && s) {
      setPostFlashGate(false);
    }
  }, [host]);

  const clearPostFlashGateAfterReconnect = useCallback(() => {
    setPostFlashGate(false);
  }, []);

  const value: HostContextValue = {
    host,
    connectionStatus,
    lastError,
    setLastError,
    version,
    status,
    cliLines,
    appendCli,
    clearCli,
    refreshStatus,
    pollAfterConnect,
    postFlashGate,
    setPostFlashGate,
    clearPostFlashGateAfterReconnect,
  };

  return (
    <HostContext.Provider value={value}>{children}</HostContext.Provider>
  );
}

export function useHost(): HostContextValue {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error("useHost requires HostProvider");
  return ctx;
}
