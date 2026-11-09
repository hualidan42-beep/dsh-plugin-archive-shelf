/**
 * `lib/preview.js` 的单元测试：拿合成事件把「日志 → 一屏摘要」的每条判定走一遍。
 *
 * 跑法：node verify/parse-unit.mjs
 */
import assert from "node:assert/strict";

const { summarizeSessionLog, blocksText, clip, oneLine, TEXT_LIMIT } = await import("../lib/preview.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

const text = (value) => ({ type: "text", text: value });
const image = { type: "image", attachment: "x" };

test("clip：按码点截断，不劈开代理对", () => {
  assert.deepEqual(clip("abc"), { text: "abc", truncated: false });
  const emoji = "🙂".repeat(5);
  const cut = clip(emoji, 3);
  assert.equal(cut.text, "🙂🙂🙂");
  assert.equal(cut.truncated, true);
  assert.equal([...cut.text].length, 3);
});

test("clip：空值与数字不炸", () => {
  assert.deepEqual(clip(null), { text: "", truncated: false });
  assert.deepEqual(clip(12), { text: "12", truncated: false });
});

test("blocksText：只取 text 块，图片块不进来", () => {
  assert.equal(blocksText([text("第一段"), image, text("第二段")]), "第一段\n\n第二段");
  assert.equal(blocksText([image]), "");
  assert.equal(blocksText(null), "");
});

test("summarizeSessionLog：首条 / 末条 / 计数 / 标题", () => {
  const snapshot = {
    session: { id: "session-1", createdAt: 1000, cwd: "D:/work/skill" },
    events: [
      { type: "user/message", time: 1100, data: { content: [text("我想做个归档插件")] } },
      { type: "session/title", time: 1200, data: { title: "做归档插件" } },
      { type: "step/start", time: 1300, data: {} },
      { type: "assistant/message", time: 1400, data: { message: { content: [text("先看归档集合在哪")] } } },
      { type: "tool/call", time: 1500, data: { name: "grep" } },
      { type: "tool/call", time: 1600, data: { name: "read" } },
      { type: "assistant/message", time: 1700, data: { message: { content: [image] } } },
      { type: "assistant/message", time: 1800, data: { message: { content: [text("改完了，跑 verify")] } } },
      { type: "user/message", time: 1900, data: { content: [text("装进 profile")] } },
      { type: "turn/end", time: 2000, data: { reason: { kind: "completed" } } },
    ],
  };
  const summary = summarizeSessionLog(snapshot);
  assert.equal(summary.title, "做归档插件");
  assert.equal(summary.cwd, "D:/work/skill");
  assert.equal(summary.createdAt, 1000);
  assert.equal(summary.updatedAt, 2000);
  assert.deepEqual(summary.counts, { events: 10, user: 2, notices: 0, assistant: 2, tools: 2, turns: 1 });
  assert.equal(summary.firstUser.text, "我想做个归档插件");
  assert.equal(summary.lastUser.text, "装进 profile");
  assert.equal(summary.lastAssistant.text, "改完了，跑 verify");
  assert.equal(summary.truncated, false);
});

test("summarizeSessionLog：通知类用户消息不当成「首句」", () => {
  const summary = summarizeSessionLog({
    session: { id: "s" },
    events: [
      { type: "user/message", time: 1, data: { content: [text("The approval policy changed from \"ask\" to \"never\".")], source: { kind: "user-approval" } } },
      { type: "user/message", time: 2, data: { content: [text("这段会话是我真的在问：插件怎么做")], source: { kind: "user" } } },
      { type: "user/message", time: 3, data: { content: [text("自动续跑提示")], source: { kind: "schedule" } } },
    ],
  });
  assert.equal(summary.firstUser.text, "这段会话是我真的在问：插件怎么做");
  assert.equal(summary.lastUser.text, "这段会话是我真的在问：插件怎么做");
  assert.equal(summary.counts.user, 1, "只有人话算「你」");
  assert.equal(summary.counts.notices, 2, "通知单独计");
});

test("summarizeSessionLog：整条日志没有人话时退到通知，不画成空", () => {
  const summary = summarizeSessionLog({
    session: { id: "s" },
    events: [
      { type: "user/message", time: 1, data: { content: [text("审批策略变更")], source: { kind: "user-approval" } } },
    ],
  });
  assert.equal(summary.counts.user, 0);
  assert.equal(summary.counts.notices, 1);
  assert.equal(summary.firstUser.text, "审批策略变更");
});

test("summarizeSessionLog：只有工具调用的助手轮不算说过话", () => {
  const summary = summarizeSessionLog({
    session: { id: "s" },
    events: [{ type: "assistant/message", time: 5, data: { message: { content: [{ type: "tool_use" }] } } }],
  });
  assert.equal(summary.counts.assistant, 0);
  assert.equal(summary.lastAssistant, null);
});

test("summarizeSessionLog：超长首句截断并如实标记", () => {
  const summary = summarizeSessionLog({
    session: { id: "s" },
    events: [{ type: "user/message", time: 1, data: { content: [text("汉".repeat(TEXT_LIMIT + 50))] } }],
  });
  assert.equal(summary.truncated, true);
  assert.equal([...summary.firstUser.text].length, TEXT_LIMIT);
  assert.equal(summary.firstUser.truncated, true);
});

test("summarizeSessionLog：认不出来的事件只计数，不抛", () => {
  const summary = summarizeSessionLog({
    session: {},
    events: [{ type: "future/event", time: 9, data: null }, null, { type: "user/message" }],
  });
  assert.equal(summary.counts.events, 2, "null 也要跳过，但真实事件要计数");
  assert.equal(summary.updatedAt, 9);
  assert.equal(summary.firstUser, null);
});

test("summarizeSessionLog：空快照不炸", () => {
  const summary = summarizeSessionLog(null);
  assert.equal(summary.counts.events, 0);
  assert.equal(summary.updatedAt, null);
  assert.equal(summary.firstUser, null);
});

test("oneLine：压空白、截断补省略号", () => {
  assert.equal(oneLine("  第一行\n\n第二行  "), "第一行 第二行");
  assert.equal(oneLine("", 10), "");
  assert.equal([...oneLine("字".repeat(30), 10)].length, 11, "10 个字 + 一个省略号");
});

console.log(`\nparse-unit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
