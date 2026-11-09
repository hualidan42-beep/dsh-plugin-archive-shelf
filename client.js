/**
 * 归档库 · 浏览器半。
 *
 * ## 它解决的是哪一步
 *
 * 宿主本来就有「归档」：侧栏会话行 → `归档`，会话从所有分组里消失，集合落在
 * `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`（本机现在 43 条）。
 * 但归档之后要把它找回来，宿主只给了三段路：视图选项里的「筛选已归档会话」、
 * 行菜单的「取消归档」、以及点归档行时一句「已归档，打不开」的提示。
 * 也就是说：**能藏，不好找；找着了也打不开**——必须先取消归档，再回去翻侧栏。
 *
 * 这个面板把这三步合成一屏：列表（谁在哪、什么时候、聊了几句）→ 看内容（首句、
 * 最后一句）→ `放出来`（取消归档，回到原工作区）→ `打开继续聊`（直接进对话）。
 *
 * ## 数据从哪来（以及为什么不自己算一份）
 *
 * - 归档集合、会话清单、工作区名：宿主 root 作用域的 `useWorkspaces()` / `useSessions()`。
 * - 会话**聊了什么**：宿主半 `GET /api/archive-shelf.preview`（只读日志，冷读，不激活会话）。
 * - 放出来 / 打开：`ctx.get("uiWorkspace")` 的 `unarchiveSession` / `openSession`。
 *   归档集合的写口永远在宿主那边，本插件不写 workspace.json。
 *
 * 面板**不 retain 会话**：只读快照，别为了看一眼目录就把 43 条会话拉成活的。
 *
 * ## 边界（如实记一笔）
 *
 * - 宿主没挂 sessionQuery、或某条日志读不出来：行还在，只是没有首句——标「内容读不到」，
 *   不画成「空会话」。
 * - 「放出来」之后这一行不会立刻消失，会留在列表里变成「已放出来」并给一个「打开」；
 *   想让它消失，点一下刷新即可（刷新背后是宿主快照，插件不自己维护归档集合）。
 * - 文案只有中文；不注册 locale 命名空间，避免和宿主版本耦合。
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-archive-shelf",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    // ── 常量 ────────────────────────────────────────────────────────────────
    /** 插件 id（与 package.json / cordis.patch.yml 对齐）。 */
    const PLUGIN_ID = "dsh-plugin-archive-shelf";
    /** 面板 id：既是 main 槽的 key，也是侧栏行的 id —— 两边必须同一个值。 */
    const PANEL_KEY = "archive-shelf";
    /** 侧栏上那一行叫什么。 */
    const LABEL = "归藏";
    /** 样式表 tag 的 id，重复加载时用来去重。 */
    const STYLE_ID = PLUGIN_ID + "/shelf.css";
    /** 宿主半的两条只读路由。 */
    const ROUTES = Object.freeze({
      preview: "/api/archive-shelf.preview",
      batch: "/api/archive-shelf.batch",
    });
    /** 预取并发：冷读日志是回放，一次开太多会把磁盘和主线程都拖住。 */
    const PREFETCH_CONCURRENCY = 3;
    /** 一次预取最多排几条：冷读是回放，先读一屏，剩下点开时补读。 */
    const PREFETCH_LIMIT = 24;
    /** 列表里那行灰字的长度上限。 */
    const SNIPPET_LIMIT = 110;

    /** 宿主还没接上时的兜底快照：宁可画空，不能崩。 */
    const EMPTY_LIST = Object.freeze({ ids: [], byId: {}, phase: "ready", projectionsBySession: {} });
    const EMPTY_WORKSPACES = Object.freeze({ items: [], archivedSessionIds: [], pinnedSessionIds: [] });

    // ── 纯函数（verify/client-harness.mjs 直接断言这些） ──────────────────────
    /**
     * 拼 class。
     * @param {...unknown} parts 字符串 / 数组 / `{类名: 布尔}`。
     * @returns {string}
     */
    function cn(...parts) {
      const out = [];
      for (const part of parts) {
        if (!part) continue;
        if (typeof part === "string") out.push(part);
        else if (Array.isArray(part)) { const nested = cn(...part); if (nested) out.push(nested); }
        else if (typeof part === "object") for (const key of Object.keys(part)) if (part[key]) out.push(key);
      }
      return out.join(" ");
    }

    const pad = (value) => String(value).padStart(2, "0");

    /**
     * 绝对时间 `YYYY-MM-DD HH:mm`。
     * @param {number} ms 时间戳。
     * @returns {string}
     */
    function stamp(ms) {
      if (!Number.isFinite(ms)) return "—";
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /**
     * 相对时间：一周内说「几分钟 / 几小时 / 几天前」，更早的给日期。
     * @param {number} ms 时间戳。
     * @param {number} [now] 现在。
     * @returns {string}
     */
    function relativeTime(ms, now = Date.now()) {
      if (!Number.isFinite(ms)) return "—";
      const diff = now - ms;
      if (diff < 0) return stamp(ms);
      if (diff < 60_000) return "刚刚";
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
      const d = new Date(ms);
      const year = new Date(now).getFullYear();
      return d.getFullYear() === year ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : stamp(ms).slice(0, 10);
    }

    /**
     * 会话 id 的短形（`session-7105fde4-…` → `7105fde4`）。
     * @param {string} id 会话 id。
     * @returns {string}
     */
    function shortId(id) {
      if (typeof id !== "string") return "";
      const raw = id.startsWith("session-") ? id.slice(8) : id;
      return raw.slice(0, 8);
    }

    /**
     * 压成一行，超长补省略号（按码点截，不会劈开 emoji）。
     * @param {unknown} text 原文。
     * @param {number} [limit] 上限。
     * @returns {string}
     */
    function oneLine(text, limit = SNIPPET_LIMIT) {
      const flat = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!flat) return "";
      const points = [...flat];
      return points.length <= limit ? flat : `${points.slice(0, limit).join("")}…`;
    }

    /**
     * 这条会话属于哪个工作区。
     * @param {string} sessionId 会话 id。
     * @param {readonly any[]} items 宿主工作区列表。
     * @returns {{ workspaceId?: string, title?: string, path?: string } | null}
     */
    function workspaceOf(sessionId, items) {
      for (const item of Array.isArray(items) ? items : []) {
        if (item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) return item;
      }
      return null;
    }

    /**
     * 把宿主的三份快照折成行。
     *
     * 行的来源是「归档集合 ∪ 本次刚放出来的」：放出来之后宿主快照会把这 id 移走，
     * 但用户还想点它去继续聊，所以插件自己留一张小卡片，直到刷新。
     *
     * @param {{
     *   list?: any,
     *   workspaces?: any,
     *   released?: Record<string, { title?: string, at?: number }>,
     *   previews?: Record<string, { status?: string, data?: any, error?: string }>,
     * }} input 三份快照 + 本地状态。
     * @returns {Array<Record<string, any>>}
     */
    function buildRows(input) {
      const list = input?.list ?? EMPTY_LIST;
      const workspaces = input?.workspaces ?? EMPTY_WORKSPACES;
      const released = input?.released ?? {};
      const previews = input?.previews ?? {};
      const byId = list.byId ?? {};

      const ids = [];
      const seen = new Set();
      for (const id of Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []) {
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      for (const id of Object.keys(released)) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }

      return ids.map((id) => {
        const summary = byId[id] ?? null;
        const entry = previews[id] ?? null;
        const data = entry?.status === "ready" ? entry.data ?? null : null;
        const workspace = workspaceOf(id, workspaces.items);
        const title = summary?.displayTitle
          || (typeof summary?.title === "string" && summary.title)
          || data?.title
          || shortId(id);
        return {
          id,
          title,
          workspace: workspace?.title ?? (typeof summary?.cwd === "string" ? summary.cwd.split(/[\\/]/).filter(Boolean).pop() : null),
          cwd: typeof summary?.cwd === "string" ? summary.cwd : data?.cwd ?? null,
          updatedAt: Number.isFinite(summary?.updatedAt) ? summary.updatedAt : (Number.isFinite(data?.updatedAt) ? data.updatedAt : null),
          running: Boolean(summary?.running),
          blank: Boolean(summary?.blank),
          origin: summary?.origin ?? null,
          released: Boolean(released[id]),
          preview: entry ?? { status: "idle" },
          snippet: entry?.status === "ready"
            ? String(entry.data?.snippet ?? oneLine(entry.data?.firstUser?.text ?? ""))
            : "",
          turns: entry?.status === "ready" && Number.isFinite(entry.data?.counts?.turns) ? entry.data.counts.turns : null,
          users: entry?.status === "ready" && Number.isFinite(entry.data?.counts?.user) ? entry.data.counts.user : null,
          notices: entry?.status === "ready" && Number.isFinite(entry.data?.counts?.notices) ? entry.data.counts.notices : null,
          events: entry?.status === "ready" && Number.isFinite(entry.data?.counts?.events) ? entry.data.counts.events : null,
          tools: entry?.status === "ready" && Number.isFinite(entry.data?.counts?.tools) ? entry.data.counts.tools : null,
          available: entry?.status === "ready" ? entry.data?.available !== false : null,
        };
      });
    }

    /**
     * 关键词过滤：标题、工作区、首句、工作区路径都算。
     * @param {readonly any[]} rows 行。
     * @param {string} query 关键词（空白切开，全部命中才算）。
     * @returns {any[]}
     */
    function filterRows(rows, query) {
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [...rows];
      return rows.filter((row) => {
        const haystack = `${row.title} ${row.workspace ?? ""} ${row.cwd ?? ""} ${row.snippet} ${shortId(row.id)}`.toLowerCase();
        return words.every(word => haystack.includes(word));
      });
    }

    /**
     * 排序：`recent` 按最近活动，`archived` 按宿主给的归档顺序（原样）。
     * @param {readonly any[]} rows 行。
     * @param {"recent" | "archived"} order 排序口径。
     * @returns {any[]}
     */
    function sortRows(rows, order) {
      const copy = [...rows];
      if (order === "archived") return copy;
      copy.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      return copy;
    }

    /**
     * 面板顶部的三个数：还在归档里几条、本次放出来几条、内容读到了几条。
     * @param {readonly any[]} rows 行。
     * @returns {{ archived: number, released: number, loaded: number }}
     */
    function tally(rows) {
      let archived = 0;
      let released = 0;
      let loaded = 0;
      for (const row of rows) {
        if (row.released) released += 1;
        else archived += 1;
        if (row.preview?.status === "ready") loaded += 1;
      }
      return { archived, released, loaded };
    }

    /**
     * 没有首句可显示时，那一行灰字该说什么。
     *
     * 「还没读」「读不到」「读到了但没有你说的话」是三件不同的事，
     * 全都画成「空会话」会骗人——所以分开说。
     * @param {Record<string, any>} row 行。
     * @returns {string} 一句提示。
     */
    function snippetHint(row) {
      const status = row?.preview?.status ?? "idle";
      if (status === "loading") return "正在读日志…";
      if (status === "error") return "日志读取失败";
      if (status !== "ready") return "未读内容（点这一行即读）";
      if (row.available === false) return "内容读不到（只有标题和时间）";
      if (row.events === 0) return "这条会话日志是空的（建了就归档了）";
      if (row.users === 0) return "日志里没有你说的话（只有系统通知）";
      return "日志里没有可显示的首句";
    }

    // ── 网络 ────────────────────────────────────────────────────────────────
    /**
     * 取一条会话的摘要。
     * @param {string} sessionId 会话 id。
     * @param {AbortSignal} [signal] 取消信号。
     * @returns {Promise<any>}
     */
    async function fetchPreview(sessionId, signal) {
      const response = await fetch(`${ROUTES.preview}?session=${encodeURIComponent(sessionId)}`, {
        signal,
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok === false) {
        throw new Error(body?.error || body?.code || `HTTP ${response.status}`);
      }
      return body;
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    /** 全部走宿主的主题 token（`--dsw-*`），每个都带兜底值：明暗主题自动跟随。 */
    const CSS = `
      .asg-root {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        background: var(--dsw-alias-bg-layer-1, #fbfbfa);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
      }
      .asg-head { padding: 18px 22px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
      .asg-titlebar { display: flex; align-items: center; gap: 10px; }
      .asg-title { font-size: 16px; font-weight: 650; letter-spacing: .01em; }
      .asg-tally { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
      .asg-tally b { font-weight: 650; color: var(--dsw-alias-label-primary, #1f2328); }
      .asg-hint { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #6b7280); }
      .asg-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
      .asg-search { flex: 1 1 220px; min-width: 180px; display: flex; align-items: center; gap: 6px;
        padding: 6px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.03));
        border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1)); }
      .asg-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; }
      .asg-search svg { opacity: .55; flex: none; }
      .asg-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
        font-size: 12px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1));
        background: transparent; color: var(--dsw-alias-label-secondary, #374151); }
      .asg-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.045)); }
      .asg-chip[data-on="true"] { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05));
        border-color: var(--dsw-alias-border-l4, rgba(0,0,0,.16)); color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; }
      .asg-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 7px; font: inherit;
        font-size: 12px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
        background: transparent; color: var(--dsw-alias-label-secondary, #374151); white-space: nowrap; }
      .asg-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.045)); }
      .asg-btn:disabled { opacity: .5; cursor: default; }
      .asg-btn[data-tone="primary"] { background: var(--dsw-alias-state-business-primary, #2563eb);
        border-color: transparent; color: #fff; }
      .asg-btn[data-tone="primary"]:hover { filter: brightness(1.06); }
      .asg-btn[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
      .asg-btn[data-tone="danger"] { color: var(--dsw-alias-state-danger-primary, #b91c1c);
        border-color: var(--dsw-alias-state-danger-primary, #b91c1c); }

      .asg-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 372px); }
      .asg-list { overflow: auto; padding: 12px 14px 20px 22px; display: flex; flex-direction: column; gap: 8px; }
      .asg-row { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1, #fff); padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
      .asg-row:hover { border-color: var(--dsw-alias-border-l3, rgba(0,0,0,.14)); }
      .asg-row[data-selected="true"] { border-color: var(--dsw-alias-state-business-primary, #2563eb);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 16%, transparent); }
      .asg-row[data-released="true"] { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.025)); }
      .asg-row-main { flex: 1; min-width: 0; cursor: pointer; }
      .asg-row-title { font-size: 13.5px; font-weight: 600; line-height: 1.45; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .asg-row-sub { margin-top: 3px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
        font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #6b7280); }
      .asg-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #9ca3af); }
      .asg-dot[data-running="true"] { background: var(--dsw-alias-state-success-primary, #16a34a); }
      .asg-tag { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05)); }
      .asg-tag[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #15803d); }
      .asg-snip { margin-top: 4px; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #4b5563);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .asg-snip[data-muted="true"] { color: var(--dsw-alias-label-tertiary, #9ca3af); font-style: italic; }
      .asg-row-actions { display: flex; flex-direction: column; gap: 5px; flex: none; }

      .asg-detail { border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); overflow: auto;
        padding: 16px 18px 24px; background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.015)); }
      .asg-detail-title { font-size: 14.5px; font-weight: 650; line-height: 1.5; }
      .asg-meta { margin-top: 12px; display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; font-size: 12px; }
      .asg-meta dt { color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; }
      .asg-meta dd { margin: 0; color: var(--dsw-alias-label-secondary, #374151); word-break: break-all; }
      .asg-block { margin-top: 14px; }
      .asg-block > h4 { margin: 0 0 5px; font-size: 11.5px; font-weight: 650; letter-spacing: .04em;
        text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #6b7280); }
      .asg-quote { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.7;
        white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-layer-1, #fff);
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.07)); max-height: 260px; overflow: auto; }
      .asg-quote[data-role="assistant"] { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.02)); }
      .asg-more { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
      .asg-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
      .asg-empty { margin: 40px auto; max-width: 420px; text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 13px; line-height: 1.8; }
      .asg-empty b { display: block; margin-bottom: 6px; font-size: 14px; color: var(--dsw-alias-label-secondary, #374151); }
      .asg-empty kbd { padding: 1px 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.15));
        font-family: inherit; font-size: 11.5px; }
      .asg-loading { margin: 30px auto; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
      .asg-foot { padding: 8px 22px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
        font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #9ca3af); display: flex; gap: 10px; align-items: center; }
      .asg-notice { margin: 0 22px 10px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.03)); }
      .asg-notice[data-kind="error"] { color: var(--dsw-alias-state-danger-primary, #b91c1c);
        border-color: color-mix(in srgb, var(--dsw-alias-state-danger-primary, #b91c1c) 35%, transparent); }
      @media (max-width: 860px) {
        .asg-body { grid-template-columns: minmax(0, 1fr); }
        .asg-detail { border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
        .asg-row-actions { flex-direction: row; }
      }
    `;

    /**
     * 注入样式表（重复加载只留一份）。
     */
    function injectStylesheet() {
      const doc = typeof document === "undefined" ? null : document;
      if (!doc) return;
      const existing = typeof doc.querySelector === "function" ? doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) : null;
      if (existing) return;
      const tag = doc.createElement("style");
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      doc.head.appendChild(tag);
    }

    // ── 图标（16px，跟文字同色） ─────────────────────────────────────────────
    function icon(paths, extra) {
      return h("svg", {
        width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
        stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", ...(extra ?? {}),
      }, paths.map((d, index) => h("path", { key: index, d })));
    }

    const ICON_ARCHIVE = () => h("svg", {
      width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
    }, [
      h("rect", { key: "box", x: 2, y: 3, width: 12, height: 4, rx: 1 }),
      h("path", { key: "lid", d: "M3.2 7v5.2c0 .5.4.8.8.8h8c.4 0 .8-.3.8-.8V7" }),
      h("path", { key: "line", d: "M6.4 10.2h3.2" }),
    ]);

    const ICON_SEARCH = () => icon(["M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Z", "m11 11 3 3"]);

    // ── 组件 ────────────────────────────────────────────────────────────────
    /**
     * 造主区面板。
     *
     * `actions` 由 `apply` 闭包给出（组件拿不到 ctx）：
     * `release(id)` = 取消归档；`open(id)` = 进那个会话。
     * @param {{ release: (id: string) => Promise<void>, open: (id: string) => void }} actions 宿主动作。
     * @returns {(props: any) => any} 面板组件。
     */
    function createPanel(actions) {
      function Row(props) {
        const { row, selected, busy, onSelect, onRelease, onOpen } = props;
        const releasing = busy === "release";
        const opening = busy === "open";
        return h("article", {
          className: "asg-row",
          "data-selected": selected ? "true" : "false",
          "data-released": row.released ? "true" : "false",
          "data-id": row.id,
        }, [
          h("div", {
            key: "main",
            className: "asg-row-main",
            role: "button",
            tabIndex: 0,
            onClick: () => onSelect(row.id),
            onDoubleClick: () => onOpen(row),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.id); }
            },
          }, [
            h("div", { key: "title", className: "asg-row-title", title: row.title }, row.title),
            h("div", { key: "sub", className: "asg-row-sub" }, [
              h("span", { key: "dot", className: "asg-dot", "data-running": row.running ? "true" : "false" }),
              row.workspace ? h("span", { key: "ws" }, row.workspace) : null,
              h("span", { key: "time" }, relativeTime(row.updatedAt)),
              row.turns !== null ? h("span", { key: "turns" }, `${row.turns} 轮`) : null,
              row.released ? h("span", { key: "rel", className: "asg-tag", "data-tone": "ok" }, "已放出来") : null,
              row.available === false ? h("span", { key: "na", className: "asg-tag" }, "内容读不到") : null,
            ].filter(Boolean)),
            h("div", {
              key: "snip",
              className: "asg-snip",
              "data-muted": row.snippet ? "false" : "true",
            }, row.snippet || snippetHint(row)),
          ]),
          h("div", { key: "actions", className: "asg-row-actions" }, [
            h("button", {
              key: "release",
              type: "button",
              className: "asg-btn",
              disabled: row.released || releasing || opening,
              onClick: () => onRelease(row),
              title: row.released ? "已经放出来了" : "取消归档，让它回到原工作区",
            }, opening ? "打开中…" : releasing ? "放出来中…" : row.released ? "已放出" : "放出来"),
            h("button", {
              key: "open",
              type: "button",
              className: "asg-btn",
              "data-tone": row.released ? "primary" : undefined,
              disabled: opening,
              onClick: () => onOpen(row),
              title: row.released ? "进这个会话接着聊" : "先放出来，再进这个会话",
            }, "打开"),
          ]),
        ]);
      }

      function Detail(props) {
        const { row, busy, onRelease, onOpen } = props;
        if (!row) {
          return h("aside", { className: "asg-detail" },
            h("div", { className: "asg-empty" }, "选一条会话，这里显示它聊了什么。"));
        }
        const data = row.preview?.status === "ready" ? row.preview.data : null;
        const counts = data?.counts ?? null;
        return h("aside", { className: "asg-detail", "data-id": row.id }, [
          h("div", { key: "title", className: "asg-detail-title" }, row.title),
          h("dl", { key: "meta", className: "asg-meta" }, [
            h("dt", { key: "ws-dt" }, "工作区"),
            h("dd", { key: "ws-dd" }, row.workspace || "（未登记工作区）"),
            h("dt", { key: "path-dt" }, "路径"),
            h("dd", { key: "path-dd" }, row.cwd || "—"),
            h("dt", { key: "time-dt" }, "最后活动"),
            h("dd", { key: "time-dd" }, `${stamp(row.updatedAt)} · ${relativeTime(row.updatedAt)}`),
            counts ? h("dt", { key: "msg-dt" }, "消息") : null,
            counts
              ? h("dd", { key: "msg-dd" },
                `你 ${counts.user} 条 · 助手 ${counts.assistant} 条 · 工具 ${counts.tools} 次 · ${counts.turns} 轮`
                + (counts.notices > 0 ? `（另有 ${counts.notices} 条系统通知类消息）` : ""))
              : null,
            h("dt", { key: "id-dt" }, "会话 id"),
            h("dd", { key: "id-dd" }, row.id),
          ].filter(Boolean)),
          data?.available === false
            ? h("div", { key: "na", className: "asg-block" },
              h("h4", null, "内容"),
              h("div", { className: "asg-quote" }, `读不到日志内容：${data.error ?? "未知原因"}。标题和时间仍然有效。`))
            : null,
          data && data.available !== false && !data.firstUser && !data.lastAssistant
            ? h("div", { key: "blank", className: "asg-block" },
              h("h4", null, "内容"),
              h("div", { className: "asg-quote" },
                counts?.events === 0
                  ? "这条会话的日志是空的：建完之后没有聊就归档了。"
                  : `日志里有 ${counts?.events ?? 0} 个事件，但没有可显示的用户消息或助手回复（只有工具调用 / 系统通知）。`))
            : null,
          data?.firstUser
            ? h("div", { key: "first", className: "asg-block" }, [
              h("h4", { key: "h" }, "首条消息"),
              h("pre", { key: "q", className: "asg-quote" }, data.firstUser.text),
              data.firstUser.truncated ? h("div", { key: "m", className: "asg-more" }, "（只显示前 1200 字）") : null,
            ])
            : null,
          data?.lastAssistant
            ? h("div", { key: "last", className: "asg-block" }, [
              h("h4", { key: "h" }, "最后一条助手回复"),
              h("pre", { key: "q", className: "asg-quote", "data-role": "assistant" }, data.lastAssistant.text),
              data.lastAssistant.truncated ? h("div", { key: "m", className: "asg-more" }, "（只显示前 1200 字）") : null,
            ])
            : null,
          data?.lastUser && data?.lastUser.text !== data?.firstUser?.text
            ? h("div", { key: "lastuser", className: "asg-block" }, [
              h("h4", { key: "h" }, "最后一条消息（你）"),
              h("pre", { key: "q", className: "asg-quote" }, data.lastUser.text),
            ])
            : null,
          row.preview?.status === "loading"
            ? h("div", { key: "loading", className: "asg-more" }, "正在冷读会话日志…")
            : null,
          row.preview?.status === "error"
            ? h("div", { key: "err", className: "asg-notice", "data-kind": "error" }, `日志读取失败：${row.preview.error ?? "未知原因"}`)
            : null,
          h("div", { key: "actions", className: "asg-actions" }, [
            h("button", {
              key: "release",
              type: "button",
              className: "asg-btn",
              "data-tone": row.released ? undefined : "primary",
              disabled: row.released || busy !== null,
              onClick: () => onRelease(row),
            }, row.released ? "已放出来" : busy === "release" ? "放出来中…" : "放出来"),
            h("button", {
              key: "open",
              type: "button",
              className: "asg-btn",
              "data-tone": row.released ? "warn" : undefined,
              disabled: busy !== null,
              onClick: () => onOpen(row),
            }, "打开继续聊"),
          ]),
        ]);
      }

      function ShelfPanel(props) {
        const given = props ?? {};
        const list = typeof given.useSessions === "function" ? given.useSessions(state => state) ?? EMPTY_LIST : EMPTY_LIST;
        const workspaces = typeof given.useWorkspaces === "function" ? given.useWorkspaces(state => state) ?? EMPTY_WORKSPACES : EMPTY_WORKSPACES;

        const [query, setQuery] = React.useState("");
        const [workspaceFilter, setWorkspaceFilter] = React.useState("");
        const [order, setOrder] = React.useState("recent");
        const [selected, setSelected] = React.useState(null);
        const [released, setReleased] = React.useState({});
        const [previews, setPreviews] = React.useState({});
        const [busy, setBusy] = React.useState({});
        const [notice, setNotice] = React.useState(null);
        const [reload, setReload] = React.useState(0);
        const [prefetchCap, setPrefetchCap] = React.useState(PREFETCH_LIMIT);
        const [now, setNow] = React.useState(Date.now());
        const inflight = React.useRef(new Set());

        const rows = React.useMemo(
          () => sortRows(buildRows({ list, workspaces, released, previews }), order),
          [list, workspaces, released, previews, order],
        );
        const visible = React.useMemo(() => filterRows(rows, query), [rows, query]);
        const filtered = React.useMemo(
          () => (workspaceFilter ? visible.filter(row => row.workspace === workspaceFilter) : visible),
          [visible, workspaceFilter],
        );
        const counts = React.useMemo(() => tally(rows), [rows]);

        /** 工作区筛选条：只列真有归档会话的那些工作区。 */
        const workspaceNames = React.useMemo(() => {
          const names = [];
          for (const row of rows) {
            if (row.workspace && !names.includes(row.workspace)) names.push(row.workspace);
          }
          return names;
        }, [rows]);

        // 每分钟刷新一次相对时间（不重建整棵树，只让「几分钟前」跟上）。
        React.useEffect(() => {
          const timer = window.setInterval(() => setNow(Date.now()), 60_000);
          return () => window.clearInterval(timer);
        }, []);

        // 选中的那条没了（刷新 / 放出来之后被宿主摘掉）就落到第一条。
        React.useEffect(() => {
          if (filtered.length === 0) { if (selected !== null) setSelected(null); return; }
          if (selected === null || !filtered.some(row => row.id === selected)) setSelected(filtered[0].id);
        }, [filtered, selected]);

        // 预取日志摘要：并 3 条，**只读前 prefetchCap 条**。
        // 冷读一条几 MB 的日志要整段回放（本机最大那条 11 MB / 1 万个事件），
        // 42 条一次铺开会把宿主拖住；剩下的等你点开那一行时单条补读。
        const idsSignature = rows.map(row => row.id).join("|");
        React.useEffect(() => {
          const controller = new AbortController();
          let cancelled = false;
          const queue = rows
            .filter(row => !previews[row.id] && !inflight.current.has(row.id))
            .map(row => row.id)
            .slice(0, prefetchCap);
          if (queue.length === 0) return undefined;

          const worker = async () => {
            while (!cancelled && queue.length > 0) {
              const id = queue.shift();
              if (!id || inflight.current.has(id)) continue;
              inflight.current.add(id);
              setPreviews(prev => ({ ...prev, [id]: { status: "loading" } }));
              try {
                const data = await fetchPreview(id, controller.signal);
                if (cancelled) return;
                setPreviews(prev => ({ ...prev, [id]: { status: "ready", data } }));
              } catch (error) {
                if (cancelled || controller.signal.aborted) return;
                setPreviews(prev => ({ ...prev, [id]: { status: "error", error: String(error?.message ?? error) } }));
              } finally {
                inflight.current.delete(id);
              }
            }
          };
          for (let index = 0; index < PREFETCH_CONCURRENCY; index += 1) void worker();
          return () => { cancelled = true; controller.abort(); };
        }, [idsSignature, reload, prefetchCap]);

        // 单条补读：选中一行而它不在预取范围里（或在「读取全部」之前就点了）时用。
        React.useEffect(() => {
          if (!selected || previews[selected] || inflight.current.has(selected)) return undefined;
          let cancelled = false;
          inflight.current.add(selected);
          setPreviews(prev => ({ ...prev, [selected]: { status: "loading" } }));
          fetchPreview(selected)
            .then((data) => {
              if (!cancelled) setPreviews(prev => ({ ...prev, [selected]: { status: "ready", data } }));
            })
            .catch((error) => {
              if (!cancelled) setPreviews(prev => ({ ...prev, [selected]: { status: "error", error: String(error?.message ?? error) } }));
            })
            .finally(() => { inflight.current.delete(selected); });
          return () => { cancelled = true; };
        }, [selected, previews]);

        const release = React.useCallback(async (row) => {
          if (!row || row.released || busy[row.id]) return;
          setBusy(prev => ({ ...prev, [row.id]: "release" }));
          try {
            await actions.release(row.id);
            setReleased(prev => ({ ...prev, [row.id]: { title: row.title, at: Date.now() } }));
            setNotice({ kind: "ok", text: `已放出来：${row.title}（回到「${row.workspace ?? "原工作区"}」）` });
          } catch (error) {
            setNotice({ kind: "error", text: `放出来失败：${String(error?.message ?? error)}` });
          } finally {
            setBusy((prev) => {
              const next = { ...prev };
              delete next[row.id];
              return next;
            });
          }
        }, [actions, busy]);

        const open = React.useCallback(async (row) => {
          if (!row) return;
          setBusy(prev => ({ ...prev, [row.id]: "open" }));
          try {
            if (!row.released) {
              await actions.release(row.id);
              setReleased(prev => ({ ...prev, [row.id]: { title: row.title, at: Date.now() } }));
            }
            actions.open(row.id);
            setNotice({ kind: "ok", text: `正在打开：${row.title}` });
          } catch (error) {
            setNotice({ kind: "error", text: `打开失败：${String(error?.message ?? error)}` });
          } finally {
            setBusy((prev) => {
              const next = { ...prev };
              delete next[row.id];
              return next;
            });
          }
        }, [actions]);

        const selectedRow = filtered.find(row => row.id === selected) ?? rows.find(row => row.id === selected) ?? null;

        return h("div", { className: "asg-root" }, [
          h("header", { key: "head", className: "asg-head" }, [
            h("div", { key: "titlebar", className: "asg-titlebar" }, [
              h("span", { key: "icon", className: "asg-title-icon" }, ICON_ARCHIVE()),
              h("span", { key: "title", className: "asg-title" }, LABEL),
              h("span", { key: "tally", className: "asg-tally" }, [
                h("span", { key: "a" }, [h("b", { key: "b" }, String(counts.archived)), " 条还归着档"]),
                counts.released > 0 ? h("span", { key: "r" }, ` · 本次放出来 ${counts.released} 条`) : null,
                h("span", { key: "l" }, ` · 内容已读 ${counts.loaded}/${rows.length}`),
              ].filter(Boolean)),
            ]),
            h("div", { key: "hint", className: "asg-hint" },
              "归档的会话不显示在左侧栏，也不能直接点开。放出来 → 回到原工作区；再点打开，就在对话里接着聊。"),
            h("div", { key: "tools", className: "asg-tools" }, [
              h("label", { key: "search", className: "asg-search" }, [
                h("span", { key: "i" }, ICON_SEARCH()),
                h("input", {
                  key: "input",
                  type: "search",
                  value: query,
                  placeholder: "搜标题、工作区、首句",
                  "aria-label": "搜归档会话",
                  onChange: event => setQuery(event.target.value),
                }),
              ]),
              h("button", {
                key: "order",
                type: "button",
                className: "asg-chip",
                "data-on": order === "recent" ? "true" : "false",
                onClick: () => setOrder(order === "recent" ? "archived" : "recent"),
                title: "在「最近活动」和「归档顺序」之间切换",
              }, order === "recent" ? "最近活动" : "归档顺序"),
              h("button", {
                key: "refresh",
                type: "button",
                className: "asg-chip",
                onClick: () => { setPreviews({}); setReload(value => value + 1); },
                title: "重新读一遍日志（归档集合本身由宿主维护）",
              }, "刷新"),
              rows.length > prefetchCap
                ? h("button", {
                  key: "readall",
                  type: "button",
                  className: "asg-chip",
                  onClick: () => setPrefetchCap(rows.length),
                  title: "把剩下的日志也读出来（每条都要回放，会慢一点）",
                }, `读取全部 ${rows.length} 条`)
                : null,
            ].filter(Boolean)),
            workspaceNames.length > 1
              ? h("div", { key: "wsfilter", className: "asg-tools" }, [
                h("button", {
                  key: "all",
                  type: "button",
                  className: "asg-chip",
                  "data-on": workspaceFilter === "" ? "true" : "false",
                  onClick: () => setWorkspaceFilter(""),
                }, "全部工作区"),
                ...workspaceNames.map(name => h("button", {
                  key: `ws-${name}`,
                  type: "button",
                  className: "asg-chip",
                  "data-on": workspaceFilter === name ? "true" : "false",
                  onClick: () => setWorkspaceFilter(workspaceFilter === name ? "" : name),
                }, name)),
              ])
              : null,
          ].filter(Boolean)),
          notice
            ? h("div", {
              key: "notice",
              className: "asg-notice",
              "data-kind": notice.kind,
              onClick: () => setNotice(null),
              role: "status",
            }, notice.text)
            : null,
          h("div", { key: "body", className: "asg-body" }, [
            h("section", { key: "list", className: "asg-list" },
              rows.length === 0
                ? h("div", { key: "empty", className: "asg-empty" }, [
                  h("b", { key: "b" }, "还没有归档的会话"),
                  h("div", { key: "d" }, "在左侧栏的会话行上打开菜单，选「归档」，它就会出现在这里。"),
                ])
                : filtered.length === 0
                  ? h("div", { key: "nomatch", className: "asg-empty" }, [
                    h("b", { key: "b" }, "没有匹配的会话"),
                    h("div", { key: "d" }, "换个关键词，或点「全部工作区」把筛选清掉。"),
                  ])
                  : filtered.map(row => h(Row, {
                    key: row.id,
                    row,
                    selected: row.id === selected,
                    busy: busy[row.id] ?? null,
                    onSelect: setSelected,
                    onRelease: release,
                    onOpen: open,
                  }))),
            h(Detail, { key: "detail", row: selectedRow, busy: selectedRow ? busy[selectedRow.id] ?? null : null, onRelease: release, onOpen: open }),
          ]),
          h("footer", { key: "foot", className: "asg-foot" }, [
            h("span", { key: "text" }, `归档集合在宿主里（${rows.length} 条）；本插件只读，只调「取消归档 / 打开」。`),
            counts.loaded < rows.length
              ? h("span", { key: "unread" }, `· 还有 ${rows.length - counts.loaded} 条没读内容（点行即读）`)
              : null,
            h("span", { key: "time" }, `· 相对时间基准 ${stamp(now)}`),
          ].filter(Boolean)),
        ]);
      }

      return ShelfPanel;
    }

    // ── 插件装配 ──────────────────────────────────────────────────────────────
    /**
     * 装插件。
     *
     * 入口是**主区面板**（`main` + `sidebar.panellist`），不是右栏：归档库要一屏看全
     * 43 条、点开看内容，右栏放不下；而且宿主右栏只在主区是对话时存在。
     *
     * @param {any} ctx 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      injectStylesheet();

      /** 宿主动作。`ctx.get` 是运行期取服务：宿主没给也不至于把插件炸掉。 */
      const uiWorkspace = () => {
        try {
          if (typeof ctx.get === "function") return ctx.get("uiWorkspace") ?? null;
        } catch {
          /* 没有就是没有 */
        }
        return ctx.uiWorkspace ?? null;
      };

      const actions = {
        async release(sessionId) {
          const service = uiWorkspace();
          if (!service || typeof service.unarchiveSession !== "function") {
            throw new Error("宿主没有 uiWorkspace.unarchiveSession");
          }
          await service.unarchiveSession(sessionId);
        },
        open(sessionId) {
          const service = uiWorkspace();
          if (!service || typeof service.openSession !== "function") {
            throw new Error("宿主没有 uiWorkspace.openSession");
          }
          service.openSession(sessionId);
        },
      };

      const Panel = createPanel(actions);

      ctx.effect(
        () => ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_KEY }, Panel)),
        "archive-shelf: main panel",
      );
      ctx.effect(
        () => ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register({ name: "sidebar.panellist", id: PANEL_KEY, order: 40, label: () => LABEL }, ICON_ARCHIVE)),
        "archive-shelf: sidebar row",
      );
      ctx.logger?.info?.("archive-shelf client: ready");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.PLUGIN_ID = PLUGIN_ID;
    exports.PANEL_KEY = PANEL_KEY;
    exports.LABEL = LABEL;
    exports.ROUTES = ROUTES;
    exports.CSS = CSS;
    // 可测面（verify/client-harness.mjs 直接断言）
    exports.createPanel = createPanel;
    exports.buildRows = buildRows;
    exports.filterRows = filterRows;
    exports.sortRows = sortRows;
    exports.tally = tally;
    exports.snippetHint = snippetHint;
    exports.workspaceOf = workspaceOf;
    exports.relativeTime = relativeTime;
    exports.stamp = stamp;
    exports.oneLine = oneLine;
    exports.shortId = shortId;
    exports.cn = cn;
    exports.Icon = ICON_ARCHIVE;
    return module.exports;
  },
});
