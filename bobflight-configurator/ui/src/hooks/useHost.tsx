import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createHost,
  type BobFlightHost,
  type ConnectionStatus,
  type ParsedStatus,
} from "../protocol";
import { canUnlockPostFlashGate } from "../protocol/postFlashGate";

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
  /** True after a flash until fresh live CDC target/version verification succeeds. */
  postFlashGate: boolean;
  setPostFlashGate: (locked: boolean, expectedBoardId?: string) => void;
  clearPostFlashGateAfterReconnect: () => Promise<boolean>;
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
  const [postFlashGate, setPostFlashGateState] = useState(false);
  const expectedBoardRef = useRef<string | undefined>(undefined);
  const gateLockedRef = useRef(false);

  const connectionGenRef = useRef(0);
  const flashGenRef = useRef(0);

  useEffect(() => {
    const offStatus = host.onStatus((s) => {
      connectionGenRef.current++;
      setConnectionStatus(s);
      if (s !== "connected") {
        setVersion(null);
        setStatus(null);
      }
    });
    const offLine = host.onLine((line) => {
      setCliLines((prev) => [...prev.slice(-499), line]);
    });
    return () => {
      offStatus();
      offLine();
    };
  }, [host]);

  const appendCli = useCallback((line: string) => {
    setCliLines((prev) => [...prev.slice(-499), line]);
  }, []);

  const clearCli = useCallback(() => setCliLines([]), []);

  const setPostFlashGate = useCallback((locked: boolean, boardId?: string) => {
    if (!locked) return; // Prevent set false bypass
    flashGenRef.current++;
    setVersion(null);
    setStatus(null);
    setLastError(null);
    setPostFlashGateState(true);
    expectedBoardRef.current = boardId;
    gateLockedRef.current = true;
  }, []);

  const refreshStatus = useCallback(async () => {
    if (host.getConnectionStatus() !== "connected") return;
    const conn = connectionGenRef.current, flash = flashGenRef.current;
    const current = () => conn === connectionGenRef.current && flash === flashGenRef.current && host.getConnectionStatus() === "connected";
    try {
      const s = await host.getStatus();
      if (current()) setStatus(s);
    } catch (err) {
      if (current()) setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [host]);

  const pollAfterConnect = useCallback(async () => {
    if (host.getConnectionStatus() !== "connected") return;
    const pollConnGen = connectionGenRef.current;
    const pollFlashGen = flashGenRef.current;
    const expectedBoardId = expectedBoardRef.current;

    try {
      const v = await host.getVersion();
      const s = await host.getStatus();

      if (
        connectionGenRef.current === pollConnGen &&
        flashGenRef.current === pollFlashGen &&
        host.getConnectionStatus() === "connected"
      ) {
        setVersion(v);
        setStatus(s);

        if (gateLockedRef.current) {
          const ok = canUnlockPostFlashGate({
            host,
            connectionStatus: host.getConnectionStatus(),
            expectedBoardId,
            version: v,
            status: s,
            pollConnectionGen: pollConnGen,
            currentConnectionGen: connectionGenRef.current,
            pollFlashGen: pollFlashGen,
            currentFlashGen: flashGenRef.current,
          });
          if (ok) {
            setPostFlashGateState(false);
            expectedBoardRef.current = undefined;
          gateLockedRef.current = false;
          }
        }
      }
    } catch (err) {
      if (connectionGenRef.current === pollConnGen && flashGenRef.current === pollFlashGen)
        setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [host]);

  const clearPostFlashGateAfterReconnect = useCallback(async (): Promise<boolean> => {
    if (!gateLockedRef.current) return false;
    if (host.getConnectionStatus() !== "connected") return false;

    const pollConnGen = connectionGenRef.current;
    const pollFlashGen = flashGenRef.current;
    const expectedBoardId = expectedBoardRef.current;

    try {
      const v = await host.getVersion();
      const s = await host.getStatus();

      if (
        connectionGenRef.current === pollConnGen &&
        flashGenRef.current === pollFlashGen &&
        host.getConnectionStatus() === "connected"
      ) {
        setVersion(v);
        setStatus(s);

        const ok = canUnlockPostFlashGate({
          host,
          connectionStatus: host.getConnectionStatus(),
          expectedBoardId,
          version: v,
          status: s,
          pollConnectionGen: pollConnGen,
          currentConnectionGen: connectionGenRef.current,
          pollFlashGen: pollFlashGen,
          currentFlashGen: flashGenRef.current,
        });

        if (ok) {
          setPostFlashGateState(false);
          expectedBoardRef.current = undefined;
          gateLockedRef.current = false;
          return true;
        }
      }
      return false;
    } catch (err) {
      if (connectionGenRef.current === pollConnGen && flashGenRef.current === pollFlashGen)
        setLastError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [host]);

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
