const INTERVAL_MS = 8 * 60 * 1000;

export function startKeepAwake(log: {
  info: (message: string) => void;
  warn: (obj: object, message: string) => void;
}): void {
  const base = process.env.RENDER_EXTERNAL_URL?.trim().replace(/\/$/, "");
  if (!base) return;

  const url = `${base}/health`;
  const ping = () => {
    void fetch(url, { signal: AbortSignal.timeout(20_000) })
      .then((response) => {
        if (!response.ok) log.warn({ status: response.status }, "keep-awake ping failed");
      })
      .catch((error: unknown) => {
        log.warn({ err: error }, "keep-awake ping failed");
      });
  };

  const first = setTimeout(ping, 60_000);
  const timer = setInterval(ping, INTERVAL_MS);
  first.unref();
  timer.unref();
  log.info("keep-awake scheduled");
}
