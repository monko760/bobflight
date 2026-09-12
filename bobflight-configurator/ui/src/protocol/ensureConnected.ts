import { MOCK_PORT_PATH, type BobFlightHost } from "./index";

/**
 * Ensure mock (or existing) link is up and the fire-and-forget connect banner
 * (`BobFlight … ready`) has been observed so it does not collide with settings
 * get collectors. Register the line listener BEFORE connect.
 *
 * Never auto-arms.
 */
export async function ensureMockConnected(host: BobFlightHost): Promise<void> {
  if (host.getConnectionStatus() === "connected") {
    return;
  }

  const bannerWait = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(
        new Error(
          "connect banner timeout (expected BobFlight … ready before settings)",
        ),
      );
    }, 2000);
    const off = host.onLine((line) => {
      if (line.startsWith("BobFlight") && line.includes("ready")) {
        clearTimeout(t);
        off();
        resolve();
      }
    });
  });
  // Swallow late rejection if connect throws before banner.
  void bannerWait.catch(() => {});

  await host.connect({
    path: MOCK_PORT_PATH,
    baudRate: 115200,
    transport: "mock",
  });
  await bannerWait;
}
