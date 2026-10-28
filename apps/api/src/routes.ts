import { CATALOG_PLATFORMS, MAX_FILTER_VALUES, SEARCH_GENRES, TRAILERS_ENABLED, t, type SearchFilters } from "@gametracker/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AuthInputError,
  changePassword,
  changeUsername,
  createSession,
  deleteAccount,
  endSession,
  loginUser,
  parseEmail,
  parseLogin,
  parseRegister,
  registerUser,
  userFromRequest,
} from "./auth/service.js";
import { emailConfigured } from "./env.js";
import { finishReset, finishSignup, parseCode, startReset, startSignup } from "./auth/codes.js";
import { EmailSendError } from "./auth/email.js";
import {
  CODE_PER_IP,
  EMAIL_PER_ADDRESS,
  EMAIL_PER_IP,
  LOGIN_PER_ACCOUNT,
  LOGIN_PER_IP,
  REGISTER_PER_IP,
  record,
  reset,
  retryAfter,
} from "./auth/rate-limit.js";
import { clearSessionCookie, sessionCookie } from "./auth/session.js";
import { browseCatalog } from "./games/browse.js";
import { companyGames } from "./games/companies.js";
import { releaseCalendar } from "./games/calendar.js";
import { backlogInMonth, favoritesForUser, listForUser, loadHomeCollections, upcomingFromBacklog } from "./games/collections.js";
import { sitemapPage } from "./games/sitemap.js";
import { getGameBySlug, searchGames } from "./games/service.js";
import { suggestCredits } from "./games/suggest.js";
import {
  LibraryInputError,
  MissingGameError,
  entryForSlug,
  libraryForUsername,
  parseEntryBody,
  removeEntry,
  saveEntry,
  setFavorite,
} from "./library/service.js";
import { importMyGamesList, parseImportRows } from "./library/import.js";
import { SteamError, listSteamWishlistMissing, syncSteamLibrary, syncSteamWishlist } from "./steam/service.js";
import { TrailersUnavailableError, trailersForSlug } from "./rawg/trailers.js";
import { seriesForUsername } from "./library/series.js";
import { activityFeed, followedRatings, listFollows, setFollow } from "./social/service.js";

const searchQuery = z.object({
  q: z.string().trim().max(80).optional(),
  genre: many(z.enum(SEARCH_GENRES.map((item) => item.id) as [string, ...string[]])),
  platform: many(z.enum(CATALOG_PLATFORMS.map((item) => item.id) as [string, ...string[]])),
  year: z.coerce.number().int().min(1970).max(2035).optional(),
  offset: z.coerce.number().int().min(0).max(500).optional(),
  origin: z.enum(["ua", "ru"]).optional(),
  sort: z.enum(["popular", "release", "title"]).optional(),
  developer: many(z.string().trim().max(80)),
  publisher: many(z.string().trim().max(80)),
  series: many(z.string().trim().max(80)),
});

// A repeated query key (?genre=rpg&genre=indie) arrives as an array, a single one as a string.
function many<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(
    (value) => (value == null || value === "" ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).max(MAX_FILTER_VALUES).optional(),
  );
}

function textFilter(values: string[] | undefined): string[] | undefined {
  const texts = [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length >= 2))];
  return texts.length > 0 ? texts : undefined;
}

const slugParams = z.object({
  slug: z.string().trim().min(1),
});

const usernameParams = z.object({
  username: z.string().trim().min(1).max(24),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

  app.get("/collections", async (request) => {
    const user = await userFromRequest(request);
    const [collections, backlog, playing, favorites, upcomingBacklog] = await Promise.all([
      loadHomeCollections(),
      user ? listForUser(user.id, "backlog") : Promise.resolve(null),
      user ? listForUser(user.id, "playing") : Promise.resolve(null),
      user ? favoritesForUser(user.id) : Promise.resolve(null),
      user ? upcomingFromBacklog(user.id) : Promise.resolve(null),
    ]);
    return { collections, backlog, playing, favorites, upcomingBacklog };
  });

  app.get("/companies/:role/:name", async (request, reply) => {
    const parsed = z
      .object({
        role: z.enum(["developer", "publisher"]),
        name: z.string().trim().min(1).max(120),
      })
      .safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badPayload") });
    return { games: await companyGames(parsed.data.role, parsed.data.name) };
  });

  app.get("/browse/:kind/:id", async (request, reply) => {
    const parsed = z
      .object({
        kind: z.enum(["genres", "platforms"]),
        id: z.string().trim().min(1),
      })
      .safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badPayload") });
    const games = await browseCatalog(parsed.data.kind, parsed.data.id);
    if (!games) return reply.code(404).send({ error: t("game.notFound") });
    return { games };
  });

  app.get("/calendar", async (request) => {
    const query = z.object({ month: z.string().optional() }).safeParse(request.query);
    const month = query.success ? query.data.month : undefined;
    const user = await userFromRequest(request);
    const calendar = await releaseCalendar(month);
    const mine = user ? await backlogInMonth(user.id, calendar.month) : [];
    return { ...calendar, mine };
  });

  app.get("/activity", async (request) => {
    const user = await userFromRequest(request);
    const following = z.object({ following: z.string().optional() }).safeParse(request.query);
    const onlyFollowing = following.success && following.data.following === "1" && user != null;
    return { events: await activityFeed(user?.id ?? null, onlyFollowing) };
  });

  app.get("/sitemap", async (request) => {
    const parsed = z.object({ page: z.coerce.number().int().min(1).max(20).optional() }).safeParse(request.query);
    return sitemapPage(parsed.success ? (parsed.data.page ?? 1) : 1);
  });

  app.get("/suggest", async (request, reply) => {
    const parsed = z
      .object({
        field: z.enum(["developer", "publisher", "series"]),
        q: z.string().trim().max(80).optional(),
      })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badPayload") });
    return { names: await suggestCredits(parsed.data.field, parsed.data.q ?? "") };
  });

  app.get("/games", async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: t("api.missingQuery") });
    }
    const query = parsed.data.q ?? "";
    const filters = {
      genre: parsed.data.genre?.length ? (parsed.data.genre as SearchFilters["genre"]) : undefined,
      platform: parsed.data.platform?.length ? (parsed.data.platform as SearchFilters["platform"]) : undefined,
      year: parsed.data.year,
      sort: parsed.data.sort,
      developer: textFilter(parsed.data.developer),
      publisher: textFilter(parsed.data.publisher),
      series: textFilter(parsed.data.series),
    };
    const sortedBrowse = parsed.data.sort === "release" || parsed.data.sort === "title";
    const credit = Boolean(filters.developer || filters.publisher || filters.series);
    if (!query.trim() && !filters.genre?.length && !filters.platform?.length && !filters.year && !credit && parsed.data.origin !== "ua" && parsed.data.origin !== "ru" && !sortedBrowse) {
      return reply.code(400).send({ error: t("api.missingQuery") });
    }

    return searchGames(query, filters, parsed.data.offset ?? 0, parsed.data.origin);
  });

  app.get("/games/:slug", async (request, reply) => {
    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: t("api.badSlug") });
    }

    const game = await getGameBySlug(parsed.data.slug);
    if (!game) {
      return reply.code(404).send({ error: t("game.notFound") });
    }

    return game;
  });

  app.get("/games/:slug/trailers", async (request, reply) => {
    if (!TRAILERS_ENABLED) {
      return reply.code(404).send({ error: t("game.notFound") });
    }

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: t("api.badSlug") });
    }

    try {
      const trailers = await trailersForSlug(parsed.data.slug);
      if (!trailers) {
        return reply.code(404).send({ error: t("game.notFound") });
      }
      return { trailers };
    } catch (error) {
      if (error instanceof TrailersUnavailableError) {
        return reply.code(503).send({ error: t("trailers.unavailable") });
      }
      request.log.error(error);
      return reply.code(502).send({ error: t("trailers.fetchFailed") });
    }
  });

  app.post("/auth/register", async (request, reply) => {
    const ipKey = `register:${request.ip}`;
    const wait = retryAfter(ipKey, REGISTER_PER_IP);
    if (wait > 0) return tooManyAttempts(reply, wait);
    try {
      const input = parseRegister(request.body);
      record(ipKey, REGISTER_PER_IP);
      // Without a mail key the site keeps the old one-step signup instead of locking new users out.
      if (!emailConfigured()) {
        const user = await registerUser(input);
        reply.header("Set-Cookie", sessionCookie(await createSession(user.id)));
        return reply.code(201).send({ user });
      }
      const mailKey = `email:${input.email}`;
      const mailWait = retryAfter(mailKey, EMAIL_PER_ADDRESS);
      if (mailWait > 0) return tooManyAttempts(reply, mailWait);
      record(mailKey, EMAIL_PER_ADDRESS);
      await startSignup(input);
      return reply.code(202).send({ pending: true, email: input.email });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post("/auth/register/verify", async (request, reply) => {
    const ipKey = `code:${request.ip}`;
    const wait = retryAfter(ipKey, CODE_PER_IP);
    if (wait > 0) return tooManyAttempts(reply, wait);
    record(ipKey, CODE_PER_IP);
    const body = (request.body ?? {}) as { email?: unknown; code?: unknown };
    try {
      const user = await finishSignup(parseEmail(body.email), parseCode(body.code));
      reply.header("Set-Cookie", sessionCookie(await createSession(user.id)));
      return reply.code(201).send({ user });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post("/auth/forgot", async (request, reply) => {
    if (!emailConfigured()) return reply.code(503).send({ error: t("auth.emailUnavailable") });
    const ipKey = `forgot:${request.ip}`;
    const body = (request.body ?? {}) as { email?: unknown };
    try {
      const email = parseEmail(body.email);
      const mailKey = `email:${email}`;
      const wait = Math.max(retryAfter(ipKey, EMAIL_PER_IP), retryAfter(mailKey, EMAIL_PER_ADDRESS));
      if (wait > 0) return tooManyAttempts(reply, wait);
      record(ipKey, EMAIL_PER_IP);
      record(mailKey, EMAIL_PER_ADDRESS);
      await startReset(email);
      return { ok: true };
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post("/auth/reset", async (request, reply) => {
    const ipKey = `code:${request.ip}`;
    const wait = retryAfter(ipKey, CODE_PER_IP);
    if (wait > 0) return tooManyAttempts(reply, wait);
    record(ipKey, CODE_PER_IP);
    const body = (request.body ?? {}) as { email?: unknown; code?: unknown; password?: unknown };
    try {
      const user = await finishReset(
        parseEmail(body.email),
        parseCode(body.code),
        typeof body.password === "string" ? body.password : "",
      );
      reply.header("Set-Cookie", sessionCookie(await createSession(user.id)));
      return { user };
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const ipKey = `login:${request.ip}`;
    try {
      const input = parseLogin(request.body);
      const accountKey = `login-account:${input.login.toLowerCase()}`;
      const wait = Math.max(retryAfter(ipKey, LOGIN_PER_IP), retryAfter(accountKey, LOGIN_PER_ACCOUNT));
      if (wait > 0) return tooManyAttempts(reply, wait);
      record(ipKey, LOGIN_PER_IP);

      const user = await loginUser(input.login, input.password);
      if (!user) {
        record(accountKey, LOGIN_PER_ACCOUNT);
        return reply.code(401).send({ error: t("auth.badCredentials") });
      }
      reset(accountKey);
      reply.header("Set-Cookie", sessionCookie(await createSession(user.id)));
      return { user };
    } catch (error) {
      if (error instanceof AuthInputError) {
        return reply.code(401).send({ error: t("auth.badCredentials") });
      }
      throw error;
    }
  });

  app.put("/auth/username", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const body = request.body as { username?: unknown; password?: unknown } | null;
    try {
      const updated = await changeUsername(
        user.id,
        typeof body?.username === "string" ? body.username.trim() : "",
        typeof body?.password === "string" ? body.password : "",
      );
      return { user: updated };
    } catch (error) {
      if (error instanceof AuthInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.put("/auth/password", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const body = request.body as { currentPassword?: unknown; nextPassword?: unknown } | null;
    try {
      await changePassword(
        user.id,
        typeof body?.currentPassword === "string" ? body.currentPassword : "",
        typeof body?.nextPassword === "string" ? body.nextPassword : "",
      );
      reply.header("Set-Cookie", sessionCookie(await createSession(user.id)));
      return { ok: true };
    } catch (error) {
      if (error instanceof AuthInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/auth/account", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const body = request.body as { password?: unknown } | null;
    try {
      await deleteAccount(user.id, typeof body?.password === "string" ? body.password : "");
      reply.header("Set-Cookie", clearSessionCookie());
      return { ok: true };
    } catch (error) {
      if (error instanceof AuthInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    await endSession(request);
    reply.header("Set-Cookie", clearSessionCookie());
    return { ok: true };
  });

  app.post("/me/steam/sync", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const body = request.body as { profile?: unknown } | null;
    try {
      return await syncSteamLibrary(user.id, typeof body?.profile === "string" ? body.profile : "");
    } catch (error) {
      if (error instanceof SteamError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/me/steam/wishlist", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const body = request.body as { profile?: unknown } | null;
    try {
      return await syncSteamWishlist(user.id, typeof body?.profile === "string" ? body.profile : "");
    } catch (error) {
      if (error instanceof SteamError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/me/steam/wishlist/missing", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    return { apps: await listSteamWishlistMissing(user.id) };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    return { user };
  });

  app.get("/users/:username", async (request, reply) => {
    const parsed = usernameParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badUsername") });

    const viewer = await userFromRequest(request);
    const library = await libraryForUsername(parsed.data.username, viewer?.id ?? null);
    if (!library) return reply.code(404).send({ error: t("profile.notFound") });
    return library;
  });

  app.get("/users/:username/series", async (request, reply) => {
    const parsed = usernameParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badUsername") });
    const result = await seriesForUsername(parsed.data.username);
    if (!result) return reply.code(404).send({ error: t("profile.notFound") });
    return result;
  });

  app.get("/users/:username/follows", async (request, reply) => {
    const parsed = usernameParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badUsername") });
    const query = z.object({ kind: z.enum(["followers", "following"]) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: t("api.badPayload") });
    const users = await listFollows(parsed.data.username, query.data.kind);
    if (!users) return reply.code(404).send({ error: t("profile.notFound") });
    return { users };
  });

  app.put("/users/:username/follow", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    const parsed = usernameParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badUsername") });
    const body = request.body as { follow?: unknown } | null;
    if (!body || typeof body.follow !== "boolean") {
      return reply.code(400).send({ error: t("api.badPayload") });
    }
    try {
      const result = await setFollow(user.id, parsed.data.username, body.follow);
      if (!result) return reply.code(404).send({ error: t("profile.notFound") });
      return result;
    } catch (error) {
      if (error instanceof AuthInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/library/import", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });
    try {
      return await importMyGamesList(user.id, parseImportRows(request.body));
    } catch (error) {
      return libraryError(reply, error);
    }
  });

  app.get("/games/:slug/entry", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badSlug") });

    const entry = await entryForSlug(user.id, parsed.data.slug);
    if (!entry) return reply.code(404).send({ error: t("game.notFound") });
    return entry;
  });

  app.get("/games/:slug/following", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badSlug") });

    const ratings = await followedRatings(user.id, parsed.data.slug);
    if (!ratings) return reply.code(404).send({ error: t("game.notFound") });
    return { ratings };
  });

  app.put("/games/:slug/entry", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badSlug") });

    try {
      return await saveEntry(user.id, parsed.data.slug, parseEntryBody(request.body));
    } catch (error) {
      return libraryError(reply, error);
    }
  });

  app.delete("/games/:slug/entry", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badSlug") });

    try {
      await removeEntry(user.id, parsed.data.slug);
      return reply.code(204).send();
    } catch (error) {
      return libraryError(reply, error);
    }
  });

  app.put("/games/:slug/favorite", async (request, reply) => {
    const user = await userFromRequest(request);
    if (!user) return reply.code(401).send({ error: t("auth.signInRequired") });

    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: t("api.badSlug") });

    const favorite = request.body as { favorite?: unknown } | null;
    if (!favorite || typeof favorite.favorite !== "boolean") {
      return reply.code(400).send({ error: t("api.badPayload") });
    }

    try {
      await setFavorite(user.id, parsed.data.slug, favorite.favorite);
      return { favorite: favorite.favorite };
    } catch (error) {
      return libraryError(reply, error);
    }
  });
}

function tooManyAttempts(reply: FastifyReply, seconds: number): FastifyReply {
  return reply.code(429).header("Retry-After", String(seconds)).send({ error: t("auth.tooManyAttempts") });
}

function authError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthInputError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof EmailSendError) {
    reply.log.error(error);
    return reply.code(502).send({ error: t("auth.emailFailed") });
  }
  throw error;
}

function libraryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LibraryInputError) return reply.code(400).send({ error: error.message });
  if (error instanceof MissingGameError) return reply.code(404).send({ error: t("game.notFound") });
  throw error;
}
