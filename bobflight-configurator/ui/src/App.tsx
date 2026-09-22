import { useState } from "react";
import { HostProvider, useHost } from "./hooks/useHost";
import { ConnectPage } from "./pages/ConnectPage";
import { StatusPage } from "./pages/StatusPage";
import { RatesPage } from "./pages/RatesPage";
import { PidPage } from "./pages/PidPage";
import { FiltersPage } from "./pages/FiltersPage";
import { CliPage } from "./pages/CliPage";
import { FlasherPage } from "./pages/FlasherPage";
import { SetupPage } from "./pages/SetupPage";
import { PortsPage } from "./pages/PortsPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { PowerBatteryPage } from "./pages/PowerBatteryPage";
import { FailsafePage } from "./pages/FailsafePage";
import { ReceiverPage } from "./pages/ReceiverPage";
import { ModesPage } from "./pages/ModesPage";
import { MotorsPage } from "./pages/MotorsPage";
import { SensorsPage } from "./pages/SensorsPage";
import { BlackboxPage } from "./pages/BlackboxPage";

type Tab =
  | "blackbox"
  | "flasher"
  | "connect"
  | "setup"
  | "ports"
  | "configuration"
  | "power"
  | "failsafe"
  | "receiver"
  | "modes"
  | "motors"
  | "sensors"
  | "status"
  | "rates"
  | "pid"
  | "filters"
  | "cli";

const GATED_TABS: ReadonlySet<Tab> = new Set([
  "blackbox",
  "setup",
  "ports",
  "configuration",
  "power",
  "failsafe",
  "receiver",
  "modes",
  "motors",
  "sensors",
  "status",
  "rates",
  "pid",
  "filters",
  "cli",
]);

function Shell() {
  const [tab, setTab] = useState<Tab>("flasher");
  const { connectionStatus, postFlashGate } = useHost();

  function selectTab(id: Tab) {
    if (postFlashGate && GATED_TABS.has(id)) {
      return;
    }
    setTab(id);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <div>
            <h1>BobFlight Configurator</h1>
            <p className="muted">Clean-room UI · CLI over USB CDC</p>
          </div>
        </div>
        <div
          className={`conn-indicator conn-${connectionStatus}`}
          title={connectionStatus}
        >
          <span className="dot" />
          {connectionStatus}
        </div>
      </header>
      <div className="body">
        <nav className="sidenav" aria-label="Main">
          {(
            [
              ["flasher", "Flasher"],
              ["connect", "Connect"],
              ["setup", "Setup"],
              ["ports", "Ports"],
              ["configuration", "Configuration"],
              ["power", "Power & Battery"],
              ["failsafe", "Failsafe"],
              ["receiver", "Receiver"],
              ["modes", "Modes"],
              ["motors", "Motors"],
              ["sensors", "Sensors"],
              ["blackbox", "Blackbox"],
              ["status", "Status"],
              ["rates", "Rates"],
              ["pid", "PID"],
              ["filters", "Filters"],
              ["cli", "CLI"],
            ] as const
          ).map(([id, label]) => {
            const gated = postFlashGate && GATED_TABS.has(id);
            return (
              <button
                key={id}
                type="button"
                className={tab === id ? "active" : ""}
                disabled={gated}
                title={
                  gated
                    ? "Locked after flash — reconnect CDC and confirm version/status on Flasher"
                    : undefined
                }
                onClick={() => selectTab(id)}
              >
                {label}
                {gated ? " 🔒" : ""}
              </button>
            );
          })}
        </nav>
        <main>
          {postFlashGate && GATED_TABS.has(tab) && (
            <div className="banner-warn" role="status">
              Config tabs locked after firmware flash. Use Connect to reattach
              CDC, then confirm unlock on the Flasher tab.
            </div>
          )}
          {tab === "flasher" && <FlasherPage />}
          {tab === "connect" && <ConnectPage />}
          {tab === "setup" && <SetupPage />}
          {tab === "ports" && <PortsPage />}
          {tab === "configuration" && <ConfigurationPage />}
          {tab === "power" && <PowerBatteryPage />}
          {tab === "failsafe" && <FailsafePage />}
          {tab === "receiver" && <ReceiverPage />}
          {tab === "modes" && <ModesPage />}
          {tab === "motors" && <MotorsPage />}
          {tab === "sensors" && <SensorsPage />}
          <BlackboxPage visible={tab === 'blackbox'} />
          {tab === "status" && <StatusPage />}
          {tab === "rates" && <RatesPage />}
          {tab === "pid" && <PidPage />}
          {tab === "filters" && <FiltersPage />}
          {tab === "cli" && <CliPage />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <HostProvider>
      <Shell />
    </HostProvider>
  );
}
