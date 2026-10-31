import { AsyncLocalStorage } from "node:async_hooks";
import { bindLocale, isLocale, type Locale } from "@gametracker/shared";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { readCookie } from "./auth/session.js";
import { sql } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { env } from "./env.js";
import { startKeepAwake } from "./keep-awake.js";
import { startPriceSweeps } from "./prices/sweep.js";
import { registerRoutes } from "./routes.js";
import { startCuratorRefresh } from "./steam/curators.js";

const requestLocale = new AsyncLocalStorage<Locale>();
bindLocale(() => requestLocale.getStore());

const app = Fastify({ logger: true, trustProxy: env.trustProxy });

app.addHook("onRequest", (request, _reply, done) => {
  const value = readCookie(request.headers.cookie, "locale");
  requestLocale.run(isLocale(value) ? value : "uk", done);
});

await connect();
await migrate(sql);
await app.register(cors, {
  origin: env.webOrigin,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
});
await registerRoutes(app);

const address = await app.listen({ port: env.port, host: "0.0.0.0" });
app.log.info(`API listening on ${address}`);
startCuratorRefresh();
startKeepAwake(app.log);
if (process.env.RENDER === "true") startPriceSweeps(app.log);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

async function connect(): Promise<void> {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      if (attempt === 15) throw error;
      app.log.warn({ err: error }, `Database is not ready (attempt ${attempt})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function shutdown(): Promise<void> {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
