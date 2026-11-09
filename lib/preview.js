/**
 * 会话日志 → 一屏摘要。
 *
 * 归档库要回答的是「这条会话到底聊了什么」，而宿主的会话清单只给标题、时间、工作区。
 * 所以这里把 `ctx.sessionQuery.readSession()` 拿到的完整日志折成四样人眼能认的东西：
 *
 *   - 首条用户消息（第一句问的什么）
 *   - 最后一条用户消息 / 最后一条助手回复（聊到哪儿停的）
 *   - 计数（用户条数 / 助手条数 / 工具调用 / 回合数 / 非人类的用户消息条数）
 *   - 标题与时间跨度（日志里自带的那份，和清单里的可能不完全一致）
 *
 * **纯函数，不碰 ctx、不碰磁盘**：`verify/parse-unit.mjs` 直接拿合成事件跑它。
 * 所有文本都截断，`truncated` 如实回报——面板不能把「只读到前 1200 字」画成「就这么多」。
 *
 * @module dsh-plugin-archive-shelf/lib/preview
 */

/** 每段文本最多回多少字符（Unicode 码点，不是 UTF-16 单元）。 */
export const TEXT_LIMIT = 1200;

/** 一屏摘要里最多带多少条「最后消息」以外的内容 —— 现在只留摘要，不留正文列表。 */
export const SNIPPET_LIMIT = 160;

/**
 * 按码点截断，并如实报告截没截。
 *
 * 不用 `String#slice`：那会从中间劈开代理对（emoji / 生僻字），回给浏览器就是半个字符。
 * @param {unknown} value 任意值。
 * @param {number} limit 最多多少个码点。
 * @returns {{ text: string, truncated: boolean }} 截断后的文本与截断标记。
 */
export function clip(value, limit = TEXT_LIMIT) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const points = [...text];
  if (points.length <= limit) return { text, truncated: false };
  return { text: points.slice(0, limit).join(""), truncated: true };
}

/**
 * 从一个内容块数组里抽纯文本。
 *
 * 只认 `type === "text"`：图片、文档、思考块都不是「聊了什么」的证据，把它们拼进摘要
 * 只会让首句变成一串占位符。
 * @param {unknown} content 内容块数组（`user/message.data.content` 或 `assistant/message.data.message.content`）。
 * @returns {string} 用空行拼好的文本；没有文本块时是空串。
 */
export function blocksText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/**
 * 这条 `user/message` 是不是「你亲手打的」。
 *
 * 宿主会把一堆东西塞进 `user/message`：审批策略变更通知（`source.kind: "user-approval"`）、
 * 运行上下文（`"runtime-context"`）、定时任务（`"schedule"`）、别的 agent 的消息
 * （`"agent-message"`）……**它们都长着用户消息的样子**，拿去做「首句」会让人以为
 * 那条会话是这么开的。所以只有 `source.kind === "user"` 才算你本人说的；
 * 老日志不带 `source` 时按「算」处理（那时候还没有这套标记，不能因此丢掉内容）。
 * @param {unknown} data `user/message` 的 `data`。
 * @returns {boolean} 是否当作人说的话。
 */
export function isHumanUserMessage(data) {
  const kind = data && typeof data === "object" ? data.source?.kind : null;
  if (typeof kind !== "string") return true;
  return kind === "user";
}

/**
 * 把一条会话日志折成摘要。
 *
 * 事件信封按宿主 `SessionEvent` 的现状读：`{ type, seq, time, data }`。认不出来的事件
 * 一律只记进 `events` 计数，不猜、不抛——宿主加一个新事件类型不该让归档库白屏。
 *
 * @param {{ session?: Record<string, unknown>, events?: readonly unknown[] }} snapshot
 *   `ctx.sessionQuery.readSession()` 的返回值（`session` 是 SessionHeader，`events` 是原始日志）。
 * @param {{ limit?: number }} [options] 文本截断长度。
 * @returns {{
 *   title: string | null,
 *   cwd: string | null,
 *   createdAt: number | null,
 *   updatedAt: number | null,
 *   counts: { events: number, user: number, notices: number, assistant: number, tools: number, turns: number },
 *   firstUser: { text: string, truncated: boolean } | null,
 *   lastUser: { text: string, truncated: boolean } | null,
 *   lastAssistant: { text: string, truncated: boolean } | null,
 *   truncated: boolean,
 * }} 摘要。`firstUser` / `lastUser` 优先是你本人说的话；一个日志里没有人话时才退到通知类消息。
 */
export function summarizeSessionLog(snapshot, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : TEXT_LIMIT;
  const session = snapshot && typeof snapshot === "object" ? snapshot.session : null;
  const events = snapshot && typeof snapshot === "object" && Array.isArray(snapshot.events) ? snapshot.events : [];

  const counts = { events: 0, user: 0, notices: 0, assistant: 0, tools: 0, turns: 0 };
  let title = null;
  /** 你本人说的：优先拿它当首句 / 末句。 */
  let firstHuman = null;
  let lastHuman = null;
  /** 不管来源的第一条 / 最后一条用户消息：真没有「人话」时退到它，不画成空。 */
  let firstUser = null;
  let lastUser = null;
  let lastAssistant = null;
  let lastTime = null;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    counts.events += 1;
    if (Number.isFinite(event.time)) lastTime = event.time;

    switch (event.type) {
      case "user/message": {
        const text = blocksText(event.data?.content);
        if (text) {
          const clipd = clip(text, limit);
          if (isHumanUserMessage(event.data)) {
            counts.user += 1;
            if (firstHuman === null) firstHuman = clipd;
            lastHuman = clipd;
          } else {
            counts.notices += 1;
          }
          if (firstUser === null) firstUser = clipd;
          lastUser = clipd;
        }
        break;
      }
      case "assistant/message": {
        // 只有工具调用的那一轮没有文本块，不算「说过话」。
        const text = blocksText(event.data?.message?.content);
        if (text) {
          counts.assistant += 1;
          lastAssistant = clip(text, limit);
        }
        break;
      }
      case "tool/call":
        counts.tools += 1;
        break;
      case "turn/end":
        counts.turns += 1;
        break;
      case "session/title": {
        const next = typeof event.data?.title === "string" ? event.data.title.trim() : "";
        if (next) title = next;
        break;
      }
      default:
        break;
    }
  }

  const createdAt = Number.isFinite(session?.createdAt) ? session.createdAt : null;
  const cwd = typeof session?.cwd === "string" && session.cwd ? session.cwd : null;

  return {
    title,
    cwd,
    createdAt,
    updatedAt: lastTime ?? createdAt,
    counts,
    firstUser: firstHuman ?? firstUser,
    lastUser: lastHuman ?? lastUser,
    lastAssistant,
    truncated: Boolean(
      firstHuman?.truncated || lastHuman?.truncated || firstUser?.truncated || lastUser?.truncated || lastAssistant?.truncated,
    ),
  };
}

/**
 * 首句裁成一行（列表里那一行灰字）。
 *
 * 换行、连续空白压成单个空格；长度按 `SNIPPET_LIMIT` 码点截，末尾补省略号。
 * @param {string | null | undefined} text 原文。
 * @param {number} [limit] 最多多少个码点。
 * @returns {string} 一行文本；没有内容时是空串。
 */
export function oneLine(text, limit = SNIPPET_LIMIT) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const points = [...flat];
  return points.length <= limit ? flat : `${points.slice(0, limit).join("")}…`;
}
