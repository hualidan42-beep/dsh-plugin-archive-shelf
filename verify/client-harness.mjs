/**
 * 浏览器半的装配冒烟：不打开浏览器，把 client.js 真跑一遍。
 *
 * 假的在：`window.__ModuleLoader__`、`react`（够用的 hook 运行时）、`document`、
 * `window.setInterval`、`fetch`。真的在：apply 的两处注册、组件本体、行/详情的渲染、
 * 「放出来 → 打开」两次点击落到的宿主动作。
 *
 * 跑法：node verify/client-harness.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  ", typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

// ── 假环境 ───────────────────────────────────────────────────────────────────
const styleTags = [];
const intervals = new Map();
let intervalSeq = 0;

globalThis.document = {
  querySelector: () => null,
  createElement: (tag) => {
    const element = { tagName: tag, dataset: {}, style: {}, textContent: "", appendChild() {} };
    if (tag === "style") styleTags.push(element);
    return element;
  },
  head: { appendChild() {} },
};

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__loaded = definition; } },
  setInterval: (fn) => {
    intervalSeq += 1;
    intervals.set(intervalSeq, fn);
    return intervalSeq;
  },
  clearInterval: (id) => { intervals.delete(id); },
  console: { info() {}, warn() {} },
};

/** 预览接口的假响应：标题 + 两句 + 计数。 */
const previewCalls = [];
globalThis.fetch = async (url) => {
  const target = new URL(String(url), "http://127.0.0.1:3080");
  const sessionId = target.searchParams.get("session");
  previewCalls.push(sessionId);
  const body = {
    ok: true,
    sessionId,
    available: true,
    title: `日志标题 ${sessionId}`,
    cwd: "D:/work/skill",
    createdAt: 1000,
    updatedAt: 2000,
    counts: { events: 9, user: 2, assistant: 3, tools: 4, turns: 2 },
    firstUser: { text: `首句 ${sessionId}`, truncated: false },
    lastUser: { text: `末句 ${sessionId}`, truncated: false },
    lastAssistant: { text: "最后一条回复", truncated: false },
    snippet: `首句 ${sessionId}`,
    truncated: false,
  };
  return { ok: true, status: 200, json: async () => body };
};

// ── 够用的 hook 运行时（与 task-radar 同一套思路） ────────────────────────────
const h = (type, props, ...children) => {
  const merged = { ...(props ?? {}) };
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
};

function sameDeps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function createRuntime() {
  const cells = [];
  const pendingEffects = [];
  let cursor = 0;
  let dirty = false;

  const take = (init) => {
    const index = cursor++;
    if (!cells[index]) cells[index] = init();
    return cells[index];
  };

  const React = {
    createElement: h,
    memo: (component) => component,
    useRef(initial) { return take(() => ({ current: initial })); },
    useState(initial) {
      const slot = take(() => ({ value: typeof initial === "function" ? initial() : initial }));
      const set = (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty = true;
      };
      return [slot.value, set];
    },
    useMemo(factory, deps) {
      const slot = take(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        slot.value = factory();
      }
      return slot.value;
    },
    useCallback(fn, deps) {
      const slot = take(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        slot.value = fn;
      }
      return slot.value;
    },
    useEffect(fn, deps) {
      const slot = take(() => ({ deps: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        pendingEffects.push({ slot, fn });
      }
    },
  };

  const flush = () => {
    for (const { slot, fn } of pendingEffects.splice(0)) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = fn();
      if (typeof cleanup === "function") slot.cleanup = cleanup;
    }
  };

  const render = (component, props) => {
    for (let round = 0; round < 40; round += 1) {
      cursor = 0;
      dirty = false;
      const tree = component(props);
      flush();
      if (!dirty) return tree;
    }
    throw new Error("渲染没有收敛：疑似状态更新死循环");
  };

  return { React, render };
}

// ── 元素树摊平成可断言结构 ───────────────────────────────────────────────────
function hydrate(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    const out = [];
    for (const child of node) {
      const value = hydrate(child);
      if (Array.isArray(value)) out.push(...value);
      else if (value !== null) out.push(value);
    }
    return out;
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return hydrate(node.type(node.props ?? {}));
  const children = hydrate(node.props?.children);
  return { tag: node.type, props: node.props ?? {}, children: children === null ? [] : Array.isArray(children) ? children : [children] };
}

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return node.children ? node.children.map(textOf).join(" ") : "";
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

const isTag = (node, tag) => node?.tag === tag;
const byText = (tree, tag, label) => findAll(tree, (node) => isTag(node, tag) && textOf(node).trim() === label);
/** 根节点可能是一个元素、也可能是数组；统一摊成一维数组再断言。 */
const flatten = (node) => (node === null || node === undefined ? [] : Array.isArray(node) ? node.flat(Infinity) : [node]);

// ── 装载 client.js ───────────────────────────────────────────────────────────
const ReactStub = createRuntime();
await import(pathToFileURL(join(here, "..", "client.js")).href);
const shelf = globalThis.__loaded.factory((name) => {
  if (name === "react") return ReactStub.React;
  throw new Error(`unexpected require: ${name}`);
});

check(shelf.PANEL_KEY === "archive-shelf", "模块导出：PANEL_KEY");
check(shelf.LABEL === "归藏", "模块导出：侧栏标签（产品名「归藏」）");

// ── 宿主侧：槽位服务与宿主动作 ───────────────────────────────────────────────
const unarchived = [];
const opened = [];
const nav = {
  unarchiveSession: async (id) => { unarchived.push(id); },
  openSession: (id) => { opened.push(id); },
};
const captured = { slots: [], main: null, sidebar: null, effects: 0 };
const ctx = {
  logger: { info() {}, warn() {} },
  get: (name) => (name === "uiWorkspace" ? nav : undefined),
  effect: (fn) => { captured.effects += 1; fn(); },
  slots: {
    inject: (name, callback) => { captured.slots.push(name); return callback(); },
    register: (options, component) => {
      if (options.name === "main") { captured.main = { options, component }; return () => {}; }
      if (options.name === "sidebar.panellist") { captured.sidebar = { options, component }; return () => {}; }
      throw new Error(`unexpected slot ${options.name}`);
    },
  },
};

shelf.apply(ctx);

check(captured.slots.join(",") === "main,sidebar.panellist", "apply：等的是 main 与 sidebar.panellist 两个席位", captured.slots);
check(captured.main?.options.key === "archive-shelf", "apply：main 槽的 key = 面板 id", captured.main?.options);
check(captured.sidebar?.options.id === "archive-shelf", "apply：侧栏行 id 与 main key 同一个值（点了才打得开）", captured.sidebar?.options);
check(captured.sidebar?.options.label?.() === shelf.LABEL, "apply：侧栏标签与模块导出的 LABEL 一致（改名不用改两处）");
check(typeof captured.sidebar?.options.order === "number", "apply：带 order，和别的面板一起排");
check(captured.effects === 2, "apply：两处注册都挂在 effect 上（宿主卸载时自动摘）");
check(styleTags.length === 1 && styleTags[0].dataset.pluginCss === "dsh-plugin-archive-shelf/shelf.css", "apply：样式表只注入一次");
check(styleTags[0]?.textContent.includes(".asg-root") && styleTags[0]?.textContent.includes(".asg-row"), "apply：样式里确实画了面板与行");

// ── 造宿主快照 ───────────────────────────────────────────────────────────────
const ARCHIVED = [
  "session-aaaa1111-2222-3333-4444-555566667777",
  "session-bbbb1111-2222-3333-4444-555566667777",
  "session-cccc1111-2222-3333-4444-555566667777",
];
const listState = {
  phase: "ready",
  ids: [...ARCHIVED, "session-dddd1111-2222-3333-4444-555566667777"],
  byId: {
    [ARCHIVED[0]]: { id: ARCHIVED[0], displayTitle: "做归档插件", running: false, updatedAt: 1_700_000_000_000, cwd: "D:/work/skill" },
    [ARCHIVED[1]]: { id: ARCHIVED[1], displayTitle: "公众号工作台改版", running: false, updatedAt: 1_600_000_000_000, cwd: "D:/work/skill" },
    [ARCHIVED[2]]: { id: ARCHIVED[2], displayTitle: "旧活：历史工作台排错", running: false, updatedAt: 1_500_000_000_000, cwd: "D:/work/历史内容生产" },
  },
  projectionsBySession: {},
};
const workspaceState = {
  items: [
    { workspaceId: "w1", title: "skill", path: "D:\\work\\skill", sessionIds: [ARCHIVED[0], ARCHIVED[1]] },
    { workspaceId: "w2", title: "历史内容生产", path: "D:\\work\\历史内容生产", sessionIds: [ARCHIVED[2]] },
  ],
  archivedSessionIds: ARCHIVED,
  pinnedSessionIds: [],
};

const props = {
  useSessions: (selector) => selector(listState),
  useWorkspaces: (selector) => selector(workspaceState),
};

// ── 首屏：三条归档会话、两个工作区、标题都在 ─────────────────────────────────
let tree = flatten(hydrate(ReactStub.render(captured.main.component, props)));
let text = textOf(tree);

check(text.includes(shelf.LABEL), "首屏：面板标题用模块导出的 LABEL");
check(/3\s+条还归着档/.test(text), "首屏：顶部计数是 3 条", text.slice(0, 200));
check(text.includes("做归档插件") && text.includes("公众号工作台改版") && text.includes("旧活：历史工作台排错"), "首屏：三条标题都画出来了");
check(text.includes("全部工作区") && text.includes("历史内容生产"), "首屏：工作区筛选条");
check(findAll(tree, node => node.props?.["data-id"] === ARCHIVED[0]).length >= 1, "首屏：行上带 data-id（便于断言与调试）");

// 预取：等两轮微任务，再渲染一次，首句应该填进来
await new Promise(resolve => setTimeout(resolve, 10));
await new Promise(resolve => setTimeout(resolve, 10));
tree = flatten(hydrate(ReactStub.render(captured.main.component, props)));
text = textOf(tree);
check(previewCalls.length >= 1, "预取：真的打了 /api/archive-shelf.preview", previewCalls.length);
check(text.includes("首句") && text.includes("2 轮"), "预取：首句与轮次填进列表", text.slice(0, 300));

// ── 放出来 ───────────────────────────────────────────────────────────────────
let releaseButton = byText(tree, "button", "放出来")[0];
check(Boolean(releaseButton), "按钮：每行有「放出来」");
releaseButton.props.onClick();
await new Promise(resolve => setTimeout(resolve, 5));
tree = flatten(hydrate(ReactStub.render(captured.main.component, props)));
text = textOf(tree);
check(unarchived.includes(ARCHIVED[0]), "放出来：调了 uiWorkspace.unarchiveSession", unarchived);
check(text.includes("已放出来"), "放出来：行上出现「已放出来」标记", text.slice(0, 300));
check(text.includes("已放出来：做归档插件"), "放出来：有一句回执");

// ── 打开继续聊 ───────────────────────────────────────────────────────────────
const openButtons = byText(tree, "button", "打开继续聊");
check(openButtons.length >= 1, "详情栏：有「打开继续聊」");
openButtons[0].props.onClick();
await new Promise(resolve => setTimeout(resolve, 5));
tree = flatten(hydrate(ReactStub.render(captured.main.component, props)));
check(opened.includes(ARCHIVED[0]), "打开：调了 uiWorkspace.openSession，进去就能接着聊", opened);

// ── 纯函数：过滤 / 排序 / 计数 / 相对时间 ────────────────────────────────────
const rows = shelf.buildRows({ list: listState, workspaces: workspaceState, released: {}, previews: {} });
check(rows.length === 3, "buildRows：只出归档的（非归档的 dddd 不出现）", rows.map(row => row.id));
check(rows.every(row => typeof row.title === "string"), "buildRows：每行都有标题");
check(shelf.filterRows(rows, "公众号").length === 1, "filterRows：按标题过滤");
check(shelf.filterRows(rows, "历史内容生产").length === 1, "filterRows：按工作区过滤");
check(shelf.filterRows(rows, "skill").length === 2, "filterRows：按工作区名过滤");
const sorted = shelf.sortRows(rows, "recent");
check(sorted[0].id === ARCHIVED[0], "sortRows：最近活动优先");
check(shelf.sortRows(rows, "archived")[0].id === ARCHIVED[0], "sortRows：归档顺序保持宿主给的原样");
check(JSON.stringify(shelf.tally(rows)) === JSON.stringify({ archived: 3, released: 0, loaded: 0 }), "tally：三个数");
check(
  shelf.snippetHint({ preview: { status: "idle" } }) === "未读内容（点这一行即读）",
  "snippetHint：没读过的行说「未读」，不假装是空会话",
);
check(
  shelf.snippetHint({ preview: { status: "ready", data: {} }, available: true, events: 0 }) === "这条会话日志是空的（建了就归档了）",
  "snippetHint：日志为空如实说空",
);
check(
  shelf.snippetHint({ preview: { status: "ready", data: {} }, available: true, events: 9, users: 0, notices: 3 }) === "日志里没有你说的话（只有系统通知）",
  "snippetHint：只有通知消息时单独说",
);
check(
  shelf.snippetHint({ preview: { status: "ready", data: {} }, available: false }) === "内容读不到（只有标题和时间）",
  "snippetHint：读不到内容不画成空",
);
check(
  shelf.snippetHint({ preview: { status: "error", error: "x" } }) === "日志读取失败",
  "snippetHint：读失败单独说",
);
check(shelf.relativeTime(Date.now() - 120_000).includes("分钟前"), "relativeTime：分钟前");
check(shelf.relativeTime(Date.now() - 3 * 86_400_000).includes("天前"), "relativeTime：天前");
check(shelf.shortId(ARCHIVED[0]).length === 8, "shortId：取 uuid 前 8 位");
check(shelf.oneLine("  第一行\n\n第二行  ", 40) === "第一行 第二行", "oneLine：压空白");

console.log(`\nclient-harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
