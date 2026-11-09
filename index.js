/**
 * 归档库 · 宿主半。
 *
 * 浏览器半只知道「哪些会话被归档了」（宿主的 `useWorkspaces().archivedSessionIds`）和
 * 标题、时间。它不知道这些会话**聊了什么**——那要看日志。所以宿主半只干一件事：
 * 把一条归档会话的日志折成能人眼认人的摘要，挂在 `/api/archive-shelf.*` 下。
 *
 * # 边界
 *
 * - **只读**：日志从 `ctx.sessionQuery.readSession()` 读，冷读，不让会话变活。
 *   归档库不归档、不删除、不写盘——归档集合的写口仍是宿主自己的「放出来」。
 * - **不猜**：sessionQuery 没挂上、日志读不出来，就如实回 `available:false`，
 *   面板显示「只看到标题」，而不是画一份假的「空会话」。
 * - **一条路径注册一次**：DSH 的 fetch 注册表按路径去重，同一路径注册两次会当场抛，
 *   整个插件激活失败（history-studio 踩过）。两条路由各注册一次，不多挂。
 *
 * 无第三方依赖；标准 Cordis 插件面：`name` / `inject` / `apply`。
 * @module dsh-plugin-archive-shelf
 */

import { summarizeSessionLog, oneLine, TEXT_LIMIT } from "./lib/preview.js";

/** 稳定 Cordis 插件名（与 cordis.patch.yml 里的 id 对齐）。 */
export const name = "archive-shelf";

/**
 * 激活前需要的服务。
 *
 * 只要 `connection`（注册路由用）。`sessionQuery` **不在 inject 里**：它是可选的，
 * 没挂上也得让插件活着（标题列表仍然有用），所以运行期用 `ctx.get()` 探。
 */
export const inject = ["connection"];

/** 路由表（全部位于 /api 下，走 Connection 的浏览器信任栅栏）。 */
export const ROUTES = {
  preview: "/api/archive-shelf.preview",
  batch: "/api/archive-shelf.batch",
};

/** 会话 id 的形状：宿主是 `session-<uuid>`，但别把格式写死，宽松到「不像路径」即可。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** 一次批量预览最多几条（再多就让浏览器分批来，别把一次请求拖成几十秒）。 */
export const MAX_BATCH = 24;

/** 批量预览的并发度：冷读日志是 I/O + 回放，串行太慢、全开会把磁盘打满。 */
export const BATCH_CONCURRENCY = 3;

/** 摘要缓存的条数上限（FIFO 淘汰）。日志是只读的，缓存按会话 id 存一份就够。 */
export const CACHE_LIMIT = 200;

/**
 * 校验一个会话 id。
 * @param {unknown} value 待校验值。
 * @returns {boolean} 形状合法返回 true。
 */
export function validSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** JSON 响应。 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 失败响应（带机器可读的 code，面板据此区分「参数错了」和「日志读不出来」）。
 * @param {string} code 机器可读的代码。
 * @param {string} message 给人看的一句话。
 * @param {number} status HTTP 状态码。
 */
function failure(code, message, status) {
  return json({ ok: false, code, error: message }, status);
}

/**
 * 造一份预览服务。
 *
 * 把「怎么拿 sessionQuery」做成注入的 `resolveQuery`，这样 `verify/host-smoke.mjs`
 * 能用假对象把每条分支都走一遍，不需要真宿主。
 *
 * @param {{
 *   resolveQuery: () => ({ readSession: (id: string) => Promise<unknown> } | null | undefined),
 *   logger?: { warn?: (message: string) => void },
 *   cacheLimit?: number,
 * }} options 依赖与配置。
 * @returns {{ preview: (sessionId: string) => Promise<object>, batch: (ids: readonly string[]) => Promise<object> }} 服务。
 */
export function createShelf(options) {
  const resolveQuery = typeof options?.resolveQuery === "function" ? options.resolveQuery : () => null;
  const logger = options?.logger ?? {};
  const cacheLimit = Number.isFinite(options?.cacheLimit) && options.cacheLimit > 0
    ? Math.floor(options.cacheLimit)
    : CACHE_LIMIT;

  /** 会话 id → 摘要。插入序即淘汰序（刷新一遍就重新取）。 */
  const cache = new Map();

  /** 取缓存；命中时把这一条挪到队尾，淘汰的永远是「最久没人问」的那条。 */
  const cacheGet = (sessionId) => {
    if (!cache.has(sessionId)) return undefined;
    const value = cache.get(sessionId);
    cache.delete(sessionId);
    cache.set(sessionId, value);
    return value;
  };

  const cacheSet = (sessionId, value) => {
    cache.delete(sessionId);
    cache.set(sessionId, value);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  /**
   * 一条会话的摘要。
   *
   * 三种「看不到内容」必须分开说：
   *   - 参数不像会话 id → 400（调用方写错了）
   *   - sessionQuery 没挂上 → `available:false, code:"session-query-unavailable"`
   *   - 日志读失败/回放校验不过 → `available:false, code:"read-failed"`
   * @param {string} sessionId 会话 id。
   * @returns {Promise<object>} 摘要。
   */
  async function preview(sessionId) {
    const cached = cacheGet(sessionId);
    if (cached) return cached;

    const query = (() => {
      try {
        return resolveQuery();
      } catch (error) {
        logger.warn?.(`archive-shelf: sessionQuery 取不到: ${error?.message ?? error}`);
        return null;
      }
    })();

    if (!query || typeof query.readSession !== "function") {
      return {
        ok: true,
        sessionId,
        available: false,
        code: "session-query-unavailable",
        error: "这个 profile 没有挂 sessionQuery，只能看到标题与时间",
      };
    }

    let snapshot;
    try {
      snapshot = await query.readSession(sessionId);
    } catch (error) {
      const message = String(error?.message ?? error);
      logger.warn?.(`archive-shelf: 读日志失败 ${sessionId}: ${message}`);
      return { ok: true, sessionId, available: false, code: "read-failed", error: message };
    }

    const summary = summarizeSessionLog(snapshot, { limit: TEXT_LIMIT });
    const payload = {
      ok: true,
      sessionId,
      available: true,
      ...summary,
      // 列表里那一行灰字：首句压成一行，省得浏览器再算一遍。
      snippet: oneLine(summary.firstUser?.text),
    };
    cacheSet(sessionId, payload);
    return payload;
  }

  /**
   * 批量摘要（小并发池）。
   * @param {readonly string[]} ids 会话 id（去重、跳过非法值、最多 MAX_BATCH 条）。
   * @returns {Promise<{ ok: boolean, items: object[], skipped: number }>} 摘要列表。
   */
  async function batch(ids) {
    const unique = [];
    const seen = new Set();
    let skipped = 0;
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw ?? "").trim();
      if (!validSessionId(id) || seen.has(id)) {
        skipped += 1;
        continue;
      }
      if (unique.length >= MAX_BATCH) {
        skipped += 1;
        continue;
      }
      seen.add(id);
      unique.push(id);
    }

    const items = new Array(unique.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < unique.length) {
        const index = cursor;
        cursor += 1;
        items[index] = await preview(unique[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, unique.length) }, worker));
    return { ok: true, items, skipped };
  }

  return { preview, batch };
}

/**
 * 注册路由。标准 Cordis apply。
 * @param {any} ctx Cordis 上下文。
 */
export function apply(ctx) {
  const logger = ctx.logger ?? {};
  const shelf = createShelf({
    resolveQuery: () => {
      // 有的组合里服务挂在 ctx 上、有的要用 get 取；两种都试，取不到就当没有。
      if (typeof ctx.get === "function") {
        try {
          return ctx.get("sessionQuery");
        } catch {
          return null;
        }
      }
      return ctx.sessionQuery ?? null;
    },
    logger,
  });

  const disposers = [];

  /**
   * 注册一条 GET 路由。
   *
   * `requestBody: "buffered"` 跟其它插件（gzh-studio / history-studio）保持同一形状：
   * 路由表要求每条精确路由声明「body 怎么给」，不写会让注册表拿到一个未声明的条目。
   * @param {string} path 绝对路径（`/api/...`）。
   * @param {(url: URL) => Promise<Response>} handler 处理函数。
   */
  const routeGet = (path, handler) => {
    disposers.push(ctx.connection.fetch.register({
      path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          return await handler(new URL(request.url));
        } catch (error) {
          logger.warn?.(`archive-shelf: ${path} failed: ${error?.message ?? error}`);
          return failure("internal", String(error?.message ?? error), 500);
        }
      },
    }));
  };

  routeGet(ROUTES.preview, async (url) => {
    const sessionId = url.searchParams.get("session") ?? "";
    if (!validSessionId(sessionId)) {
      return failure("bad-session", "session 参数缺失或不像一个会话 id", 400);
    }
    return json(await shelf.preview(sessionId));
  });

  routeGet(ROUTES.batch, async (url) => {
    const raw = url.searchParams.get("ids") ?? "";
    const ids = raw.split(",").map(part => part.trim()).filter(Boolean);
    if (ids.length === 0) {
      return failure("bad-ids", "ids 参数为空（逗号分隔的会话 id）", 400);
    }
    return json(await shelf.batch(ids));
  });

  ctx.on?.("dispose", () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch (error) {
        logger.warn?.(`archive-shelf: 卸载路由失败: ${error?.message ?? error}`);
      }
    }
  });

  logger.info?.("archive-shelf host: ready");
}
