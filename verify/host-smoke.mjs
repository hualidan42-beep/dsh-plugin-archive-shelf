/**
 * 宿主路由冒烟：假 ctx 把 `apply()` 真跑一遍，逐条打路由。
 *
 * 验证的是同一份代码路径——不碰正在跑的 `dsh web`（重启会打断所有会话）。
 *
 * 必查的六件事：
 *   1. 两条路由各注册一次，路径与 method 对得上；
 *   2. **同路径重复注册必须抛**（DSH 的注册表按路径去重，真宿主会整份插件激活失败）；
 *   3. 非法 session id → 400，不能拿去读；
 *   4. sessionQuery 没挂上 → `available:false`，不画成空会话；
 *   5. 日志读失败 → `available:false` + `read-failed`；
 *   6. 批量：去重、跳过非法、超上限截断，并且**摘要缓存命中时不再读日志**。
 *
 * 跑法：node verify/host-smoke.mjs
 */
import assert from "node:assert/strict";

const { apply, ROUTES, createShelf, validSessionId, MAX_BATCH, BATCH_CONCURRENCY } = await import("../index.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

/** 假日志：一条用户消息 + 一条助手回复 + 一个标题。 */
function fakeSnapshot(sessionId) {
  return {
    session: { id: sessionId, createdAt: 1000, cwd: "D:/work/skill" },
    events: [
      { type: "user/message", time: 1100, data: { content: [{ type: "text", text: `问：${sessionId}` }] } },
      { type: "session/title", time: 1200, data: { title: `标题 ${sessionId}` } },
      { type: "assistant/message", time: 1300, data: { message: { content: [{ type: "text", text: "答：在做" }] } } },
      { type: "tool/call", time: 1400, data: { name: "read" } },
      { type: "turn/end", time: 1500, data: { reason: { kind: "completed" } } },
    ],
  };
}

/**
 * 假 Cordis ctx。
 * @param {{ sessionQuery?: any }} [options] 要挂的服务。
 */
function makeCtx(options = {}) {
  const routes = new Map();
  const logs = [];
  const disposers = [];
  const ctx = {
    connection: {
      fetch: {
        register(config) {
          if (routes.has(config.path)) {
            throw new Error(`exact Fetch route "${config.path}" is already registered`);
          }
          routes.set(config.path, { methods: config.methods, requestBody: config.requestBody, fetch: config.fetch });
          return () => { routes.delete(config.path); };
        },
      },
    },
    get(name) {
      if (name === "sessionQuery" && options.sessionQuery) return options.sessionQuery;
      return undefined;
    },
    logger: {
      info: (message) => logs.push(["info", String(message)]),
      warn: (message) => logs.push(["warn", String(message)]),
    },
    on: (_event, fn) => { disposers.push(fn); },
  };
  return { ctx, routes, logs, disposers };
}

async function callGet(routes, path, params = {}) {
  const entry = routes.get(path);
  if (!entry) throw new Error(`没有注册 ${path}`);
  if (!entry.methods.includes("GET")) throw new Error(`${path} 不接受 GET`);
  const url = new URL(`http://127.0.0.1:3080${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await entry.fetch({ method: "GET", url: url.toString() });
  return { status: response.status, body: await response.json() };
}

const ID_A = "session-aaaa1111-2222-3333-4444-555566667777";
const ID_B = "session-bbbb1111-2222-3333-4444-555566667777";

await test("注册：两条 GET 路由，路径与 method 对", async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.deepEqual([...routes.keys()].sort(), [ROUTES.batch, ROUTES.preview].sort());
  for (const path of routes.keys()) {
    assert.deepEqual(routes.get(path).methods, ["GET"]);
    assert.equal(routes.get(path).requestBody, "buffered", "路由表要求声明 body 处理方式");
  }
});

await test("注册：同路径重复注册必须抛（宿主会整份插件激活失败）", async () => {
  const { ctx } = makeCtx();
  apply(ctx);
  // 同一份 ctx 上再 apply 一次 = 同路径登记第二遍；假注册表照真宿主那样抛。
  assert.throws(() => apply(ctx), /already registered/);
});

await test("preview：正常一条，摘要有首句 / 标题 / 计数 / 轮次", async () => {
  const { ctx, routes } = makeCtx({ sessionQuery: { readSession: async id => fakeSnapshot(id) } });
  apply(ctx);
  const { status, body } = await callGet(routes, ROUTES.preview, { session: ID_A });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
  assert.equal(body.sessionId, ID_A);
  assert.equal(body.title, `标题 ${ID_A}`);
  assert.equal(body.snippet, `问：${ID_A}`);
  assert.equal(body.firstUser.text, `问：${ID_A}`);
  assert.equal(body.lastAssistant.text, "答：在做");
  assert.equal(body.counts.tools, 1);
  assert.equal(body.counts.turns, 1);
});

await test("preview：缓存命中不再读日志", async () => {
  let reads = 0;
  const { ctx, routes } = makeCtx({
    sessionQuery: { readSession: async (id) => { reads += 1; return fakeSnapshot(id); } },
  });
  apply(ctx);
  await callGet(routes, ROUTES.preview, { session: ID_A });
  await callGet(routes, ROUTES.preview, { session: ID_A });
  assert.equal(reads, 1, "第二条必须走缓存");
});

await test("preview：非法 id → 400，且不去读日志", async () => {
  let reads = 0;
  const { ctx, routes } = makeCtx({ sessionQuery: { readSession: async () => { reads += 1; return null; } } });
  apply(ctx);
  for (const bad of ["", "..\\..\\etc\\passwd", "D:/x", "a".repeat(400)]) {
    const { status, body } = await callGet(routes, ROUTES.preview, { session: bad });
    assert.equal(status, 400, `应拒绝 ${bad}`);
    assert.equal(body.code, "bad-session");
  }
  const missing = await callGet(routes, ROUTES.preview);
  assert.equal(missing.status, 400);
  assert.equal(reads, 0);
});

await test("preview：sessionQuery 没挂上 → available:false，不画成空会话", async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const { status, body } = await callGet(routes, ROUTES.preview, { session: ID_A });
  assert.equal(status, 200);
  assert.equal(body.available, false);
  assert.equal(body.code, "session-query-unavailable");
  assert.equal(body.snippet, undefined);
});

await test("preview：读日志失败 → available:false + read-failed", async () => {
  const { ctx, routes, logs } = makeCtx({
    sessionQuery: { readSession: async () => { throw new Error("SESSION_QUERY_CORRUPT_SESSION"); } },
  });
  apply(ctx);
  const { body } = await callGet(routes, ROUTES.preview, { session: ID_A });
  assert.equal(body.available, false);
  assert.equal(body.code, "read-failed");
  assert.match(body.error, /CORRUPT/);
  assert.ok(logs.some(([level, message]) => level === "warn" && message.includes("读日志失败")));
});

await test("batch：去重 / 跳过非法 / 顺序对齐输入", async () => {
  const { ctx, routes } = makeCtx({ sessionQuery: { readSession: async id => fakeSnapshot(id) } });
  apply(ctx);
  const { status, body } = await callGet(routes, ROUTES.batch, {
    ids: `${ID_A},${ID_B},${ID_A},bad/id`,
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].sessionId, ID_A);
  assert.equal(body.items[1].sessionId, ID_B);
  assert.equal(body.skipped, 2, "重复 + 非法各跳一条");
});

await test(`batch：超过 ${MAX_BATCH} 条按上限截断`, async () => {
  const ids = Array.from({ length: MAX_BATCH + 6 }, (_, index) => `session-${String(index).padStart(4, "0")}x`);
  const { ctx, routes } = makeCtx({ sessionQuery: { readSession: async id => fakeSnapshot(id) } });
  apply(ctx);
  const { body } = await callGet(routes, ROUTES.batch, { ids: ids.join(",") });
  assert.equal(body.items.length, MAX_BATCH);
  assert.equal(body.skipped, 6);
});

await test("batch：空 ids → 400", async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const { status, body } = await callGet(routes, ROUTES.batch, { ids: "" });
  assert.equal(status, 400);
  assert.equal(body.code, "bad-ids");
});

await test("createShelf：并发度不超过 BATCH_CONCURRENCY", async () => {
  let live = 0;
  let peak = 0;
  const shelf = createShelf({
    resolveQuery: () => ({
      readSession: async (id) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise(resolve => setTimeout(resolve, 5));
        live -= 1;
        return fakeSnapshot(id);
      },
    }),
  });
  const ids = Array.from({ length: 9 }, (_, index) => `session-${index}`);
  await shelf.batch(ids);
  assert.ok(peak <= BATCH_CONCURRENCY, `并发峰值为 ${peak}，上限 ${BATCH_CONCURRENCY}`);
  assert.ok(peak > 1, "完全串行说明池子没生效");
});

await test("createShelf：resolveQuery 抛错也当没有服务", async () => {
  const shelf = createShelf({ resolveQuery: () => { throw new Error("boom"); } });
  const body = await shelf.preview(ID_A);
  assert.equal(body.available, false);
  assert.equal(body.code, "session-query-unavailable");
});

await test("dispose：卸载时把路由撤掉", async () => {
  const { ctx, routes, disposers } = makeCtx();
  apply(ctx);
  assert.equal(routes.size, 2);
  for (const dispose of disposers) dispose?.();
  assert.equal(routes.size, 0);
});

await test("validSessionId：真 id 过，路径形状不过", () => {
  assert.equal(validSessionId(ID_A), true);
  assert.equal(validSessionId("session-abc"), true);
  assert.equal(validSessionId("../x"), false);
  assert.equal(validSessionId("C:/x"), false);
  assert.equal(validSessionId(""), false);
  assert.equal(validSessionId(null), false);
});

console.log(`\nhost-smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
