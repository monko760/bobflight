import { useCallback, useEffect, useMemo, useState } from "react";
import { useHost } from "../hooks/useHost";
import {
  getDefaultBaudRates,
  isWebSerialAvailable,
  MOCK_PORT_PATH,
  type PortInfo,
} from "../protocol";

function filterPorts(list: PortInfo[], mock: boolean): PortInfo[] {
  return mock
    ? list.filter((p) => p.path.startsWith("mock"))
    : list.filter((p) => p.path.startsWith("webserial:"));
}

export function ConnectPage() {
  const {
    host,
    connectionStatus,
    lastError,
    setLastError,
    pollAfterConnect,
    clearCli,
  } = useHost();
  const webSerialOk = useMemo(() => isWebSerialAvailable(), []);
  // When Web Serial is available, default to USB mode so the path is hard to miss.
  const [useMock, setUseMock] = useState(() => !isWebSerialAvailable());
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [path, setPath] = useState(() =>
    isWebSerialAvailable() ? "" : MOCK_PORT_PATH,
  );
  const [baud, setBaud] = useState(115200);
  const [busy, setBusy] = useState(false);

  const applyPortList = useCallback((list: PortInfo[], mock: boolean) => {
    const filtered = filterPorts(list, mock);
    setPorts(filtered);
    if (mock) {
      setPath(MOCK_PORT_PATH);
    } else if (filtered.length === 0) {
      setPath("");
    } else {
      setPath((cur) =>
        filtered.some((p) => p.path === cur) ? cur : filtered[0].path,
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void host.enumeratePorts().then((list) => {
      if (cancelled) return;
      applyPortList(list, useMock);
    });
    return () => {
      cancelled = true;
    };
  }, [host, useMock, applyPortList]);

  const connected = connectionStatus === "connected";
  const connecting = connectionStatus === "connecting";

  async function onRequestUsbPort() {
    setBusy(true);
    setLastError(null);
    try {
      const info = await host.requestPort();
      setUseMock(false);
      // Refresh via getPorts() so already-permitted devices stay listed.
      const list = await host.enumeratePorts();
      const web = filterPorts(list, false);
      const merged = web.some((p) => p.path === info.path)
        ? web
        : [info, ...web];
      setPorts(merged);
      setPath(info.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onConnect() {
    setBusy(true);
    setLastError(null);
    try {
      clearCli();
      if (useMock) {
        await host.connect({
          path: path || MOCK_PORT_PATH,
          baudRate: baud,
          transport: "mock",
        });
      } else {
        if (!path) {
          throw new Error("Click Request USB port… first");
        }
        await host.connect({
          path,
          baudRate: baud,
          transport: "webserial",
        });
      }
      await pollAfterConnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    setLastError(null);
    try {
      await host.disconnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Connect</h2>
      <p className="muted">
        Connect over USB CDC (Web Serial) or use demo mode without hardware.
        Connection never arms the craft.
      </p>
      <p className="muted" style={{ marginTop: "-0.25rem" }}>
        Chrome must run on the computer with the USB flight controller.
      </p>

      <div className="row" style={{ alignItems: "center" }}>
        <label htmlFor="use-mock" style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="use-mock"
            type="checkbox"
            checked={useMock}
            disabled={connected || busy}
            onChange={(e) => setUseMock(e.target.checked)}
          />
          Demo mode (mock CDC — no USB)
        </label>
      </div>

      {!useMock && (
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="primary primary-lg"
            disabled={connected || busy || !webSerialOk}
            onClick={() => void onRequestUsbPort()}
            title={
              webSerialOk
                ? "navigator.serial.requestPort (user gesture)"
                : "Web Serial needs Chrome/Edge on localhost or https"
            }
          >
            Request USB port…
          </button>
          {!webSerialOk && (
            <span className="muted">
              Web Serial unavailable in this browser/context
            </span>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <div>
          <label htmlFor="port">Port</label>
          <select
            id="port"
            value={path}
            disabled={connected || busy || (!useMock && ports.length === 0)}
            onChange={(e) => setPath(e.target.value)}
          >
            {ports.length === 0 && (
              <option value="">
                {useMock
                  ? "No mock ports"
                  : "Click Request USB port…"}
              </option>
            )}
            {ports.map((p) => (
              <option key={p.path} value={p.path}>
                {p.friendlyName ? `${p.friendlyName} (${p.path})` : p.path}
              </option>
            ))}
          </select>
          {!useMock && ports.length === 0 && (
            <p className="muted" style={{ marginTop: "0.35rem" }}>
              No USB port granted yet. Click Request USB port… above, then
              Connect.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="baud">Baud</label>
          <select
            id="baud"
            value={baud}
            disabled={connected || busy}
            onChange={(e) => setBaud(Number(e.target.value))}
          >
            {getDefaultBaudRates().map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        {!connected ? (
          <button
            type="button"
            className="primary"
            disabled={busy || connecting || !path}
            onClick={() => void onConnect()}
          >
            {connecting || busy ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void onDisconnect()}
          >
            Disconnect
          </button>
        )}
      </div>

      <dl className="kv">
        <div>
          <dt>State</dt>
          <dd>
            <span className={`pill pill-${connectionStatus}`}>
              {connectionStatus}
            </span>
          </dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{useMock ? "mock" : "webserial"}</dd>
        </div>
        <div>
          <dt>Last error</dt>
          <dd>{lastError ?? host.getLastError() ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
