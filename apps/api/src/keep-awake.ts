const INTERVAL_MS = 4 * 60 * 1000;
const HEALTH_URL = "https://game-tracker-coreAPI.onrender.com/health";

export function startKeepAwake(log: {
  info: (message: string) => void;
  warn: (obj: object, message: string) => void;
}): void {
  if (process.env.RENDER !== "true") return;

  const ping = () => {
    const fresh = `${HEALTH_URL}?t=${Date.now()}`;
    void fetch(`https://r.jina.ai/${fresh}`, {
      signal: AbortSignal.timeout(25_000),
      headers: { Accept: "text/plain" },
    })
      .then((response) => {
        if (!response.ok) log.warn({ status: response.status }, "keep-awake ping failed");
      })
      .catch((error: unknown) => {
        log.warn({ err: error }, "keep-awake ping failed");
      });
  };

  const first = setTimeout(ping, 15_000);
  const timer = setInterval(ping, INTERVAL_MS);
  first.unref();
  timer.unref();
  log.info("keep-awake scheduled");
}
