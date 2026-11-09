/**
 * 真日志抽样：拿**这台机器上真实的归档会话**跑一遍 `lib/preview.js`。
 *
 * 合成事件只能证明「按我理解的信封能折」，证明不了「宿主现在写出来的信封还是这个形状」。
 * 这个脚本读 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，找到对应的
 * `session.v4.jsonl.zstd`，解压、解析、送进 `summarizeSessionLog`，把结果打出来。
 *
 * **只读**：不写任何文件、不碰宿主进程、不激活会话。
 *
 * 跑法：node verify/real-log-sample.mjs [--limit 8]
 * 判据：至少一条能读出「首条消息」；一条都读不出来 = 事件形状变了，回去看 extractSessionEventText。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { summarizeSessionLog, oneLine } from "../lib/preview.js";

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) || 8 : 8;

/**
 * 扫出拼接 zstd 容器里的每一帧。
 *
 * 移植自宿主自己的 `session-persistence-jsonl/src/zstd.ts: scanZstdFrames`：
 * 日志是「一帧一批」追加写的，`zstdDecompress` 只会解开**第一帧**，所以不按帧边界
 * 切开就只能读到会话头（195 字节），事件全是零。
 * @param {Buffer} buffer 整个 `.jsonl.zstd`。
 * @returns {Array<{start: number, end: number}>}
 */
function scanZstdFrames(buffer) {
  const ZSTD_MAGIC = 0xfd2fb528;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) { offset = -1; break; }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { offset = -1; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (offset < 0) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 逐帧解压再拼回 JSONL 文本。 */
function decodeZstd(buffer) {
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error("扫不出 zstd 帧（文件损坏或格式变了）");
  return frames
    .map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"))
    .join("");
}

/** 把一行日志解析成 `{ session, events }` 快照。 */
function toSnapshot(text) {
  let header = null;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "session") { header = record; continue; }
    if (record?.type) events.push(record);
  }
  return { session: header, events };
}

const workspaceText = await readFile(join(HOME, "storages", "workspace.json"), "utf8");
const workspace = JSON.parse(workspaceText);
const archived = workspace?.global?.archivedSessionIds ?? [];
if (archived.length === 0) {
  console.log("没有归档会话，跳过。");
  process.exit(0);
}

const sessionsRoot = join(HOME, "sessions");
const workspaces = await readdir(sessionsRoot, { withFileTypes: true });
const wanted = new Set(archived);
const found = [];
for (const entry of workspaces) {
  if (!entry.isDirectory()) continue;
  const dir = join(sessionsRoot, entry.name);
  let children;
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const child of children) {
    if (!child.isDirectory() || !wanted.has(child.name)) continue;
    const file = join(dir, child.name, "session.v4.jsonl.zstd");
    try {
      const info = await stat(file);
      found.push({ id: child.name, file, size: info.size });
    } catch {
      found.push({ id: child.name, file: null, size: 0 });
    }
  }
}

found.sort((left, right) => right.size - left.size);
const sample = found.slice(0, LIMIT);

let withText = 0;
let missing = 0;
console.log(`归档 ${archived.length} 条；找到日志 ${found.length} 条；抽样 ${sample.length} 条（按体积倒序）\n`);

for (const item of sample) {
  if (!item.file) {
    missing += 1;
    console.log(`✗ ${item.id}  —— 目录在，但没有 session.v4.jsonl.zstd`);
    continue;
  }
  const text = decodeZstd(await readFile(item.file));
  const snapshot = toSnapshot(text);
  const summary = summarizeSessionLog(snapshot);
  if (summary.firstUser) withText += 1;
  const title = summary.title ?? "(无标题)";
  const counts = summary.counts;
  console.log(`· ${item.id}`);
  console.log(`  标题   ${title}`);
  console.log(`  体积   ${(item.size / 1024).toFixed(1)} KB  ·  事件 ${counts.events}（用户 ${counts.user} / 助手 ${counts.assistant} / 工具 ${counts.tools} / 回合 ${counts.turns}）`);
  console.log(`  工作区 ${summary.cwd ?? "—"}`);
  console.log(`  首句   ${oneLine(summary.firstUser?.text, 90) || "(读不到文本)"}`);
  console.log("");
}

console.log(`抽样结果：${withText} 条读出首句，${missing} 条日志缺失。`);
if (withText === 0) {
  console.error("✗ 一条都读不出文本：事件形状可能变了（对照 extractSessionEventText 看 user/message 的 data.content）");
  process.exit(1);
}
