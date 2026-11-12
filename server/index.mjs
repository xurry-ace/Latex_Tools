import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Shared contract with src/main.js — keep in sync (see docs/round-2026-11-12-contract.md §7).
// Both wall clocks may be shortened through the environment: the test suite (and anyone debugging the cancel or
// timeout path) needs to watch an engine being killed without waiting three minutes.
const COMPILE_TIMEOUT_MS = Number(process.env.YANTAI_COMPILE_TIMEOUT_MS) || 180_000;
const SNIPPET_TIMEOUT_MS = Number(process.env.YANTAI_SNIPPET_TIMEOUT_MS) || 120_000;

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distRoot = path.join(appRoot, 'dist');
const port = Number(process.env.PORT || 3210);
const editableExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.txt']);
const textExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.txt']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg']);
const ignoredNames = new Set(['.git', '.latex-tools', 'node_modules', '.DS_Store']);
const tokenPattern = /^[A-Za-z0-9._-]{1,64}$/;
// Cancelling a compile asks the engine to stop the way TeX does it interactively: SIGINT makes Tectonic/XeTeX
// wrap up and flush a readable .log, while SIGTERM would cut it off mid-write. A *timeout* keeps SIGTERM, because
// a wedged engine can sit on SIGINT waiting for terminal input that never comes — see `run`.
const engineCancelSignal = 'SIGINT';
// The server holds exactly one opened project, but requests are served concurrently. A request snapshots the
// project it started against (see `requestProject`) so an `/api/project/open` landing mid-request — typically
// while a compile waits on the TeX engine — can never make the running request read or write another folder.
let activeProjectRoot = null;
const requestProject = new AsyncLocalStorage();
function currentProjectRoot() {
  const scoped = requestProject.getStore();
  return scoped === undefined ? activeProjectRoot : scoped;
}
/** @type {{kind: string, token: string|null, child: import('node:child_process').ChildProcess|null, cancelled: boolean, cancel: (function(): void)|null}|null} */
let compileJob = null;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // §9.2: never let a browser guess a different type for what we just serialised as JSON.
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function relativePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\0') || path.isAbsolute(input)) fail(400, '文件路径无效');
  const normalized = input.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) fail(400, '不能访问项目目录之外的文件');
  return normalized;
}

async function projectFile(input, { create = false, extensions = editableExtensions } = {}) {
  if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
  const rel = relativePath(input);
  if (!extensions.has(path.extname(rel).toLowerCase())) fail(400, '不支持这个文件类型');
  const absolute = path.resolve(currentProjectRoot(), rel);
  if (!inside(currentProjectRoot(), absolute)) fail(400, '不能访问项目目录之外的文件');
  if (create) {
    let probe = path.dirname(absolute);
    while (inside(currentProjectRoot(), probe)) {
      try {
        const realProbe = await fs.realpath(probe);
        if (!inside(currentProjectRoot(), realProbe)) fail(400, '不能访问项目目录之外的文件');
        break;
      } catch (error) {
        if (error.status) throw error;
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const checked = await fs.realpath(path.dirname(absolute));
    if (!inside(currentProjectRoot(), checked)) fail(400, '不能访问项目目录之外的文件');
  } else {
    const checked = await fs.realpath(absolute);
    if (!inside(currentProjectRoot(), checked)) fail(400, '不能访问项目目录之外的文件');
    if (!(await fs.stat(checked)).isFile()) fail(400, '这不是文件');
  }
  return { absolute, rel };
}

async function body(req, limit = 5_000_000, { timeoutMs = 30_000 } = {}) {
  // A half-open upload (no more chunks, no FIN) used to keep this request alive forever, holding its buffers.
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => setTimeout(() => reject(httpError(408, '请求超时')), timeoutMs).unref())
    : null;
  let stream;
  try {
    stream = (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) fail(413, '文件太大');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();
    // The stream keeps its own buffer while the timeout races; swallow a later failure so it is never unhandled.
    stream.catch(() => {});
    return timeout ? await Promise.race([stream, timeout]) : await stream;
  } finally {
    req.destroy();
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '需要 JSON 请求');
  let raw;
  try { raw = await body(req); }
  catch (error) { if (error.status) throw error; throw httpError(400, 'JSON 格式无效'); }
  try { return JSON.parse(raw.toString('utf8')); }
  catch { fail(400, 'JSON 格式无效'); }
}

// Tectonic spawns xelatex / xdvipdfmx / biber of its own. Putting the engine in its own process group lets
// `killTree` reach the whole tree: `child.kill()` only ever stops the direct child and leaves grandchildren
// running on — and writing into — `.latex-tools/build/`.
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    try { child.kill(signal); } catch {}
  }
}

/**
 * Spawn a command with the argument-array API (never a shell string).
 * Always resolves: a spawn failure resolves with `spawnFailed: true` instead of rejecting, so callers keep
 * their `finally` and the compile slot is never left locked.
 * @returns {Promise<{code: number|null, signal: string|null, output: string, timedOut: boolean, cancelled: boolean, spawnFailed?: boolean, error?: Error}>} & { cancel: () => void }
 */
function run(command, args, options = {}) {
  // Two different signals on purpose:
  //   timeout      → SIGTERM. A wedged TeX must die deterministically; SIGINT can leave it sitting at an
  //                  interactive error prompt waiting for input we will never send (stdin is `ignore`).
  //   user cancel  → SIGINT. That is TeX's "type `X` at the prompt" path: the engine wraps up and flushes a
  //                  readable .log, whereas SIGTERM cuts it mid-write.
  const { timeout = 180_000, maxOutput = 2_000_000, killSignal = 'SIGTERM', cancelSignal = 'SIGINT', onSpawn = null, ...spawnOptions } = options;
  let cancelHandle = null;
  const promise = new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { ...spawnOptions, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, signal: null, output: '', timedOut: false, cancelled: false, spawnFailed: true, error });
      return;
    }
    let pieces = [];
    let collected = 0;
    let clipped = false;
    let timedOut = false;
    let cancelledNow = false;
    let cancelCount = 0;
    let settled = false;
    let graceTimer = null;
    const escalate = () => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, killSignal);
      escalate();
    }, timeout);
    // A `data` listener keeps the pipes in flowing mode; once the cap is reached the chunks are dropped on the
    // floor instead of being copied into an ever-growing string, which never applies back-pressure to the engine.
    const collect = chunk => {
      if (collected >= maxOutput) { clipped = true; return; }
      const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const room = maxOutput - collected;
      if (chunkText.length > room) { pieces.push(chunkText.slice(0, room)); collected = maxOutput; clipped = true; }
      else { pieces.push(chunkText); collected += chunkText.length; }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      pieces = [];
      resolve(result);
    };
    const text = () => pieces.join('') + (clipped ? '\n[输出过长，已截断]' : '');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    // Cancellable more than once: an aborted browser request and a hand-exact `/api/compile/cancel` can
    // overlap, and the second signal would otherwise be dropped on the `cancelled` flag.
    const requestCancel = () => {
      if (settled) return false;
      cancelCount += 1;
      cancelledNow = true;
      killTree(child, cancelSignal);
      escalate();
      return true;
    };
    cancelHandle = requestCancel;
    child.on('error', error => {
      // Never reject: a rejected promise would skip the caller's `finally` and lock the compile slot forever.
      finish({ code: null, signal: null, output: text(), timedOut: false, cancelled: cancelledNow, spawnFailed: true, error });
    });
    child.on('close', (code, signal) => {
      // EOF on the pipes can lag the exit while a grandchild keeps the pipe open, and the same holds for a
      // killed process group; both must settle, or the compile slot is held for good.
      if (signal && code === null) {
        finish({ code: null, signal, output: text(), timedOut, cancelled: cancelledNow || signal === cancelSignal });
        setTimeout(() => killTree(child, 'SIGKILL'), 2_000).unref?.();
        return;
      }
      if (cancelledNow && !timedOut) {
        finish({ code: signal ? null : code, signal, output: text(), timedOut, cancelled: true });
        return;
      }
      finish({ code: signal ? null : code, signal, output: text(), timedOut, cancelled: cancelledNow || (cancelCount > 0 && signal === cancelSignal) });
    });
    try { onSpawn?.(child); } catch {}
  });
  promise.cancel = () => { cancelHandle?.(); };
  return promise;
}

function buildDir(rel) {
  const id = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12);
  return path.join(currentProjectRoot(), '.latex-tools', 'build', id);
}

function normalizeReferenceName(name) {
  if (typeof name !== 'string') return null;
  const value = name.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.includes('\0') || value.includes(' ')) return null;
  return value;
}

// Tectonic and TeX name files inconsistently (`sections/bad` and `main.tex` refer to the same file),
// so names are resolved against the real project listing instead of trusting the log text.
function resolveProjectPath(name, knownFiles) {
  const normalized = normalizeReferenceName(name);
  if (!normalized) return null;
  if (knownFiles.includes(normalized)) return normalized;
  const withExtension = knownFiles.find(file => file === `${normalized}.tex`);
  if (withExtension) return withExtension;
  if (normalized.includes('/') || normalized.includes('.')) return null;
  const matches = knownFiles.filter(file => path.basename(file, path.extname(file)) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

// TeX prints `(` before it starts a file and `)` when the file ends; non-project names are pushed
// as placeholders so their closing paren does not pop a real file.
function makeFileStack(knownFiles) {
  const stack = [];
  let innermost = null;
  return {
    feed(line) {
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === ')') { stack.pop(); continue; }
        if (char !== '(') continue;
        const token = line.slice(i + 1).match(/^[^\s()]+/)?.[0] || '';
        const resolved = resolveProjectPath(token, knownFiles);
        stack.push(resolved);
        if (resolved) i += token.length;
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]) { innermost = stack[i]; break; }
      }
      return innermost;
    }
  };
}

function cleanDiagnostic(message) {
  // Drop the sentence-final dot first, then trim: trimming first used to leave a trailing space behind when the
  // dot was removed, and the panel showed `提示 ：…` style strings.
  return message.replace(/\s+/g, ' ').replace(/\s+for explanation\.?$/i, '').replace(/[.。]+$/, '').trim();
}

function diagnosticHint(message) {
  if (/Undefined control sequence/i.test(message)) {
    return '未定义的命令：请检查命令拼写（如 \\textbf），或确认导言区已添加对应 \\usepackage（如 amsmath、graphicx、booktabs）';
  }
  if (/Missing \$ inserted/i.test(message)) {
    return '缺少数学符号 $：正文里的 _、^ 或数学符号需要放在 $...$ 内；普通下划线请写成 \\_';
  }
  if (/Misplaced alignment tab character &/i.test(message)) {
    return '正文中直接出现了 &：普通“和”号请转义为 \\&；若是表格或公式对齐，请检查环境是否闭合';
  }
  if (/Missing \} inserted|Too many \}'s|Extra \}, or forgotten \$/i.test(message)) {
    return '花括号 { } 或数学模式 $ 不配对，请检查附近是否有漏写或多写的括号';
  }
  if (/Runaway argument|File ended while scanning use of/i.test(message)) {
    return '参数未正常结束：通常是前面某处漏掉了右花括号 } 或 \\end{...}';
  }
  if (/Environment .+ undefined/i.test(message)) {
    return '环境未定义：请检查 \\begin{...} 名称拼写，或在导言区加载对应宏包';
  }
  if (/\\begin\{[^}]+\}.*ended by \\end\{[^}]+\}/i.test(message)) {
    return '环境首尾不匹配：请让 \\begin{...} 与 \\end{...} 的名称保持一致';
  }
  if (/Unable to load picture|File `[^']*' not found|Unable to find file|Cannot find image file|找不到引入的文件/i.test(message)) {
    return '找不到引入的文件或图片：请核对相对路径、扩展名及文件名大小写';
  }
  if (/Double subscript|Double superscript/i.test(message)) {
    return '连续上下标：多字符上下标请用花括号括起来，例如 x_{i,j} 或 a^{b^c}';
  }
  return null;
}

// `Reference `eq:x' on page 1 undefined on input line 2.` → a pointer at the \ref that produced it.
function warningKind(text) {
  const reference = text.match(/Reference `([^']*)' .*undefined/);
  if (reference) return `引用 \\ref{${reference[1]}} 没有对应的 \\label`;
  const citation = text.match(/Citation `([^']*)' .*undefined/);
  if (citation) return `文献引用 \\cite{${citation[1]}} 在 .bib 中不存在`;
  const duplicate = text.match(/Label `([^']*)' multiply defined/);
  if (duplicate) return `标签 ${duplicate[1]} 被定义了多次`;
  if (/Can't find file|File `([^']*)' not found/.test(text)) return '找不到引入的文件';
  return null;
}

// Turns an engine report into jumpable rows. Returns `{ items, total }`: at most 100 items, and `total` is how
// many survived deduplication, so a cut list can be announced instead of silently shortened.
function diagnosticList(output, fallbackFile, { logOutput = '', knownFiles = [] } = {}) {
  const lines = output.split(/\r?\n/);
  const stack = makeFileStack(knownFiles);
  const found = [];
  const annotation = /^(.+?):(\d+)(?::\d+)?\s*:?\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const currentFile = stack.feed(line) || fallbackFile;
    const bibErr = line.match(/^(.*?)---line (\d+) of file ([^\s]+)$/);
    if (bibErr) {
      const bibFile = resolveProjectPath(bibErr[3], knownFiles);
      const prev = (lines[i - 1] || '').trim();
      const rawReason = bibErr[1].trim() || prev || 'BibTeX 条目语法有误';
      if (bibFile) {
        found.push({
          kind: 'error',
          message: cleanDiagnostic(rawReason),
          hint: '请检查该行附近的逗号、花括号闭合或是否有重复的文献 key',
          file: bibFile,
          line: Number(bibErr[2])
        });
        continue;
      }
    }
    const texError = line.match(/^!\s*(.+)/);
    if (texError) {
      let lineNumber = null;
      let detail = '';
      for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
        const match = lines[j].match(/^l\.(\d+)\s*(.*)/);
        if (match) {
          lineNumber = Number(match[1]);
          detail = match[2]?.trim() || '';
          break;
        }
      }
      const msg = cleanDiagnostic(texError[1]);
      const fullMsg = /Undefined control sequence/i.test(msg) && detail ? `${msg} (${detail.slice(0, 40)})` : msg;
      const hint = diagnosticHint(fullMsg);
      found.push({ kind: 'error', message: fullMsg, ...(hint ? { hint } : {}), file: currentFile, line: lineNumber });
      continue;
    }
    const tectonic = line.match(/^\s*(error|warning):\s*(.+)/i);
    if (tectonic) {
      const message = tectonic[2];
      if (tectonic[1].toLowerCase() === 'warning' && message.startsWith('accessing absolute path')) continue;
      const ownLocation = message.match(annotation);
      const resolved = ownLocation ? resolveProjectPath(ownLocation[1], knownFiles) : null;
      if (ownLocation && resolved) {
        const msg = cleanDiagnostic(ownLocation[3] || message);
        const hint = diagnosticHint(msg);
        found.push({ kind: tectonic[1].toLowerCase(), message: msg, ...(hint ? { hint } : {}), file: resolved, line: Number(ownLocation[2]) });
        continue;
      }
      const location = lines.slice(i + 1, i + 5).join(' ').match(/-->\s*([^:\s]+):(\d+)(?::\d+)?/);
      const locationFile = location ? resolveProjectPath(location[1], knownFiles) : null;
      const msg = cleanDiagnostic(ownLocation?.[3] || message);
      const hint = diagnosticHint(msg);
      if (locationFile || !ownLocation) {
        found.push({ kind: tectonic[1].toLowerCase(), message: msg, ...(hint ? { hint } : {}), file: locationFile || currentFile, line: location ? Number(location[2]) : null });
      } else {
        // The annotation points inside a package or the engine, where the line number means nothing to
        // the author; keep the message and let the paired `!` error carry the position instead.
        found.push({ kind: tectonic[1].toLowerCase(), message: msg, ...(hint ? { hint } : {}), file: currentFile, line: null });
      }
    }
  }

  // Tectonic keeps LaTeX's own warnings in the .log file, where undefined cross-references live.
  if (logOutput) {
    const logStack = makeFileStack(knownFiles);
    for (const line of logOutput.split(/\r?\n/)) {
      const file = logStack.feed(line) || fallbackFile;
      if (!/^LaTeX Warning:/.test(line)) continue;
      const message = warningKind(line);
      if (!message) continue;
      const lineNumber = line.match(/on input line (\d+)/)?.[1];
      const hint = diagnosticHint(message);
      found.push({ kind: 'warning', message, ...(hint ? { hint } : {}), file, line: lineNumber ? Number(lineNumber) : null });
    }
  }

  // One mistake must not turn into two markers. The parser decorates some messages with the token TeX was
  // reading (`Undefined control sequence (\foo)`), so equality is decided on the message with that appended
  // ` (…)` tail removed and nothing else — two different messages still read as two different messages, and the
  // line number stays part of the identity so the same error on two lines stays two jumpable rows.
  const identity = (item, { withLine = true } = {}) =>
    `${item.kind}:${item.file}${withLine ? `:${item.line}` : ''}:${item.message.replace(/ \([^()]*\)$/, '')}`;
  const located = new Set(found.filter(item => item.line).map(item => identity(item, { withLine: false })));
  const seen = new Set();
  const kept = found
    .filter(item => !/something bad happened inside XeTeX|engine had an unrecoverable error/.test(item.message))
    // A position-less restatement of a diagnostic that already has a line adds nothing.
    .filter(item => item.line || !located.has(identity(item, { withLine: false })))
    .filter(item => {
      const key = identity(item);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  // The list stops at 100 rows, but the missing ones may not simply vanish: the caller reports how many there
  // really were so the log panel can say「另有 N 条未显示」.
  return { items: kept.slice(0, 100), total: kept.length };
}

// One walk of the project returns every text/image file. Directories are traversed in name order so the result
// is stable, and the whole list is sorted exactly once — sorting on every recursion level used to dominate the
// cost of `/api/tree` and every compile.
const fileIndexLimit = 800;

async function scanFiles(root) {
  const result = [];
  let truncated = false;
  const walk = async (directory, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignoredNames.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (result.length >= fileIndexLimit) { truncated = true; continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!editableExtensions.has(ext) && !imageExtensions.has(ext)) continue;
      result.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        type: editableExtensions.has(ext) ? 'text' : 'image'
      });
    }
  };
  await walk(root, 0);
  result.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return { files: result, truncated };
}

// `/api/tree` and `/api/template` hand the list straight to the browser; the rest of the server only needs the
// paths, and now every file read accepts a symlinked sibling, so the index itself must never be cached across
// those endpoints.
const freshFileIndex = new Set(['/api/tree', '/api/template']);
const fileIndexCache = new Map();
const fileIndexTtlMs = 150;
let currentRequestPath = '';

function invalidateFileIndex() {
  fileIndexCache.clear();
}

// The same project tree used to be re-walked by `/api/references`, `/api/search`, both compiles and both
// SyncTeX lookups; on a thesis with hundreds of files that recursion dominated every request.
async function getFileIndex(root = currentProjectRoot()) {
  if (!root) return [];
  const now = Date.now();
  const cached = fileIndexCache.get(root);
  if (cached && now - cached.at < fileIndexTtlMs && (cached.files.length < fileIndexLimit || !freshFileIndex.has(currentRequestPath))) return cached.files;
  const scanned = await scanFiles(root);
  fileIndexCache.set(root, { at: Date.now(), files: scanned.files, truncated: scanned.truncated });
  return scanned.files;
}

async function listFiles(root = currentProjectRoot()) {
  return getFileIndex(root);
}

// Neither the scan depth nor the file cap may hide files from the browser without saying so.
function indexTruncated(root = currentProjectRoot()) {
  const cached = fileIndexCache.get(root);
  return Boolean(cached?.truncated);
}

function normalizeActive(active) {
  const list = [];
  for (const item of Array.isArray(active) ? active : [active]) {
    if (item && typeof item === 'object' && typeof item.path === 'string' && typeof item.content === 'string') list.push(item);
  }
  return list;
}

function activeContent(buffers, fileRel) {
  for (let index = buffers.length - 1; index >= 0; index--) {
    if (buffers[index].path === fileRel) return buffers[index].content;
  }
  return null;
}

// `.latex-tools`, `.latex-tools/build` and any build id must be real directories: a symlinked build root would
// otherwise point Tectonic's output, the clean endpoint and the PDF reader at files outside the project.
async function ensurePlainDirectory(directory) {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive: true });
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink()) fail(400, '.latex-tools 目录不能是符号链接');
  if (!stat.isDirectory()) fail(400, '.latex-tools 不是文件夹');
  const real = await fs.realpath(directory);
  if (!inside(currentProjectRoot(), real)) fail(400, '不能访问项目目录之外的文件');
  return real;
}

const templates = {
  chinese: {
    'main.tex': String.raw`\documentclass[UTF8,a4paper,12pt]{ctexart}
\usepackage{amsmath,amssymb,graphicx,booktabs}
\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue]{hyperref}
\title{论文题目}
\author{作者姓名}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
在这里撰写摘要。
\end{abstract}

\tableofcontents

\section{引言}\label{sec:intro}
在这里开始写作。公式、图片和参考文献可以通过右侧工具插入。

\section{方法}

\section{结果与讨论}

\section{结论}

% 添加引用后，取消下面两行的注释。
% \bibliographystyle{plain}
% \bibliography{references}
\end{document}
`,
    'references.bib': '% 在这里添加 BibTeX 文献条目，例如 @article{key, ...}\n'
  },
  english: {
    'main.tex': String.raw`\documentclass[a4paper,11pt]{article}
\usepackage{amsmath,amssymb,graphicx,booktabs}
\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue]{hyperref}
\title{Paper Title}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write your abstract here.
\end{abstract}

\tableofcontents

\section{Introduction}\label{sec:intro}
Start writing here.

\section{Methods}

\section{Results and Discussion}

\section{Conclusion}

% Uncomment these lines after adding citations.
% \bibliographystyle{plain}
% \bibliography{references}
\end{document}
`,
    'references.bib': '% Add BibTeX entries here, e.g. @article{key, ...}\n'
  }
};

function parseBibEntries(content, filePath) {
  const entries = [];
  const regex = /@([A-Za-z]+)\s*[{(]\s*([^,\s}]+)\s*,([\s\S]*?)(?=\n\s*@[A-Za-z]+\s*[{(]|$)/g;
  for (const match of content.matchAll(regex)) {
    const type = match[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const body = match[3] || '';
    const line = content.slice(0, match.index || 0).split(/\r?\n/).length;
    const field = name => {
      const found = body.match(new RegExp(`\\b${name}\\s*=\\s*(?:\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}|"([^"]*)")`, 'i'));
      return (found?.[1] || found?.[2] || '').replace(/\s+/g, ' ').replace(/[{}]/g, '').trim();
    };
    entries.push({ key: match[2].trim(), type, title: field('title'), author: field('author'), year: field('year'), file: filePath, line });
  }
  return entries;
}

function computePlainWordStats(content) {
  const withoutComments = content.split(/\r?\n/).map(line => line.replace(/(?<!\\)%.*/, '')).join('\n');
  const stripped = withoutComments
    .replace(/\\(?:begin|end)\{[^}]*\}/g, ' ')
    .replace(/\\(?:label|ref|eqref|autoref|pageref|cite[a-zA-Z]*|includegraphics|usepackage|documentclass|bibliographystyle|bibliography|input|include)(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+/g, ' ');
  const cjk = (stripped.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (stripped.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || []).length;
  return { cjk, words, total: cjk + words };
}

const sectionHeadingRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
const sectionLevelMap = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };

// One pass over the project for the citation panel, editor completions, project-wide outline, and word stats;
// the caller may hand over the files being edited (a single buffer or an array of them) so unsaved content
// is included.
async function scanReferences(active, rootFile = null) {
  if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
  const buffers = normalizeActive(active);
  const files = await getFileIndex();
  const relevant = files.filter(file => /\.(bib|tex)$/i.test(file.path)).slice(0, 200);
  const bib = [];
  const labels = [];
  const wordCounts = {};
  const texContents = new Map();
  for (const file of relevant) {
    let content = activeContent(buffers, file.path);
    if (content === null) {
      try {
        const stat = await fs.stat(path.join(currentProjectRoot(), file.path));
        if (stat.size > 2_000_000) continue;
        content = await fs.readFile(path.join(currentProjectRoot(), file.path), 'utf8');
      } catch { continue; }
    }
    if (file.path.toLowerCase().endsWith('.bib')) {
      bib.push(...parseBibEntries(content, file.path));
      continue;
    }
    texContents.set(file.path, content);
    wordCounts[file.path] = computePlainWordStats(content);
    let currentSection = '';
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/(?<!\\)%.*/, '');
      const section = line.match(sectionHeadingRegex);
      if (section) currentSection = section[2].trim();
      for (const match of line.matchAll(/\\label\{([^}]+)\}/g)) {
        labels.push({ key: match[1], file: file.path, line: index + 1, context: currentSection });
      }
    }
  }

  const knownTex = [...texContents.keys()];
  const projectOutline = [];
  const visited = new Set();
  const resolveInclude = (rawTarget, fromFile) => {
    const cleaned = normalizeReferenceName(rawTarget);
    if (!cleaned) return null;
    const direct = resolveProjectPath(cleaned, knownTex);
    if (direct) return direct;
    const dir = path.posix.dirname(fromFile);
    if (dir && dir !== '.') {
      const relCandidate = path.posix.normalize(`${dir}/${cleaned}`);
      return resolveProjectPath(relCandidate, knownTex);
    }
    return null;
  };
  const walkTex = (filePath, depth = 0) => {
    if (!filePath || depth > 6 || visited.has(filePath) || !texContents.has(filePath)) return;
    visited.add(filePath);
    const lines = texContents.get(filePath).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const clean = lines[idx].replace(/(?<!\\)%.*/, '');
      const heading = clean.match(sectionHeadingRegex);
      if (heading) {
        projectOutline.push({
          file: filePath,
          line: idx + 1,
          level: sectionLevelMap[heading[1]] ?? 1,
          kind: heading[1],
          title: heading[2].trim() || '(未命名章节)'
        });
      }
      for (const inc of clean.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
        const child = resolveInclude(inc[1], filePath);
        if (child) walkTex(child, depth + 1);
      }
    }
  };
  if (rootFile && texContents.has(rootFile)) {
    walkTex(rootFile);
  }
  for (const texFile of knownTex) {
    if (!visited.has(texFile)) walkTex(texFile);
  }

  return { bib, labels, wordCounts, projectOutline, filesScanned: relevant.length };
}
const perFileMatchLimit = 50;
// A synchronous scan of the project is fine while it only reads and compares text, so it keeps a soft budget of
// its own; the hard wall for user regexes lives in the worker below.
const searchTextBudgetMs = 150;
const searchWorkerBudgetMs = 1_500;
const searchWorkerGraceMs = 150;

// Nested and adjacent quantifiers — `(a+)+`, `(a*)*`, `a**`, `(a+){2,}` — backtrack exponentially on a single
// line, and a synchronous regular expression cannot be interrupted from inside JS: what stalls is the whole
// server (compile callbacks, saves, cancels), not just this request.
//
// This is a mitigation, NOT a guarantee. Patterns that blow up without looking like this (`(?:a|aa)+$`,
// overlapping alternations, backreferences) still pass the test, which is why the real scan additionally runs
// in a disposable worker that the main thread may `terminate()` — see `runSearchInWorker`.
const riskyPattern = /(\((?:[^()\\]|\\.)*[+*]\)[+*]|\((?:[^()\\]|\\.)*[+*]\)\{\d+,\d*\}|[+*][+*]|\(\?[!:][^)]*[+*]\)[+*])/;

function rejectCatastrophicBacktracking(query) {
  if (riskyPattern.test(query)) fail(400, '正则存在灾难性回溯风险，请简化（如 (a+)+ 改成 a+）');
}

function buildSearchMatcher(query, { regex = false, caseSensitive = false } = {}) {
  if (regex) {
    let matcher;
    try { matcher = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { fail(400, '正则表达式无效'); }
    return {
      regex: true,
      line(line) {
        matcher.lastIndex = 0;
        const hit = matcher.exec(line);
        if (!hit || hit.index === undefined) return null;
        return { index: hit.index, count: hit[0].length || 1 };
      }
    };
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    regex: false,
    line(line) {
      const index = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
      if (index < 0) return null;
      return { index, count: needle.length };
    }
  };
}

function timeBudget(ms) {
  const startedAt = Date.now();
  return { expired: () => Date.now() - startedAt > ms };
}

// Sentinel only: it reports after the fact that a synchronous block (a pathological regex, a huge file) ate the
// event loop. It cannot prevent that block — only `terminate()` on the search worker can.
function syncBlockSampler() {
  let blocked = false;
  let timer = null;
  const start = () => {
    const armedAt = Date.now();
    timer = setTimeout(() => { if (Date.now() - armedAt >= 50) blocked = true; }, 10);
    timer.unref?.();
  };
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  return { blocked: () => blocked, start, stop };
}

// Client-supplied limits may only tighten the defaults, never widen them: an unbounded `maxFiles` used to turn a
// search into hundreds of 2 MB reads on the request thread.
function clampLimit(value, fallback, ceiling) {
  const requested = Number(value);
  const wanted = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
  return Math.min(wanted, ceiling);
}

// The scan body duplicated on purpose (worker + fallback): both must produce byte-identical match objects, and
// the semantics — `text` trimmed of its indent, `start`/`length` relative to that text — are asserted by tests.
const searchWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const pathModule = require('node:path');
const post = message => { try { parentPort.postMessage(message); } catch {} };
try {
  const options = workerData;
  const matcher = new RegExp(options.query, options.caseSensitive ? 'g' : 'gi');
  const active = new Map(options.active);
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt > options.budgetMs;
  const matches = [];
  let timedOut = false;
  let truncated = false;
  let scanned = 0;
  outer:
  for (const file of options.files) {
    if (scanned > 0 && expired()) { timedOut = true; truncated = true; break; }
    scanned += 1;
    let content = active.has(file.path) ? active.get(file.path) : null;
    if (content === null) {
      try {
        const stat = fs.statSync(pathModule.join(options.root, file.path));
        if (!stat.isFile() || stat.size > 2000000) continue;
        content = fs.readFileSync(pathModule.join(options.root, file.path), 'utf8');
      } catch { continue; }
    }
    const lines = content.split(/\\r?\\n/);
    let fileMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 20000) continue;
      matcher.lastIndex = 0;
      const hit = matcher.exec(line);
      if (!hit || hit.index === undefined) continue;
      const trimmed = line.trim();
      const leading = line.length - line.trimStart().length;
      matches.push({
        file: file.path,
        line: i + 1,
        text: trimmed.slice(0, 240),
        start: Math.max(0, hit.index - leading),
        length: hit[0].length || 1
      });
      fileMatches += 1;
      if (matches.length >= options.maxMatches) { truncated = true; break outer; }
      if (fileMatches >= options.perFileMatchLimit) { truncated = true; break; }
      if ((i & 255) === 0 && expired()) { timedOut = true; truncated = true; break outer; }
    }
  }
  if (!timedOut && expired()) { timedOut = true; truncated = true; }
  post({ ok: true, matches, truncated, timedOut, filesSearched: scanned });
} catch (error) {
  post({ ok: false, message: String((error && error.message) || error) });
}
`;

/**
 * Run the regex scan in a one-shot thread so the main loop stays responsive and a catastrophic pattern can be
 * killed for real. `terminate()` is the only interruption JavaScript offers; the main thread always resolves —
 * with the partial results if the worker got that far, with an empty timed-out result if it had to be killed.
 * Resolves `null` when a worker cannot be created at all, so the caller can fall back to the sync scan.
 */
function runSearchInWorker({ root, files, query, caseSensitive, maxMatches, active, budgetMs }) {
  return new Promise(resolve => {
    let worker;
    try {
      worker = new Worker(searchWorkerSource, {
        eval: true,
        workerData: {
          root,
          files,
          query,
          caseSensitive,
          maxMatches,
          perFileMatchLimit,
          budgetMs,
          active: active.map(item => [item.path, item.content])
        }
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      worker.terminate().catch(() => {});
      resolve(value);
    };
    const killTimer = setTimeout(
      () => finish({ matches: [], truncated: true, timedOut: true, filesSearched: 0 }),
      budgetMs + searchWorkerGraceMs
    );
    worker.once('message', message => finish(message?.ok
      ? { matches: message.matches || [], truncated: Boolean(message.truncated), timedOut: Boolean(message.timedOut), filesSearched: message.filesSearched || 0 }
      : (console.error('[search worker]', message?.message), { matches: [], truncated: true, timedOut: false, filesSearched: 0 })));
    worker.once('error', () => finish({ matches: [], truncated: true, timedOut: false, filesSearched: 0 }));
    worker.once('exit', () => finish({ matches: [], truncated: true, timedOut: true, filesSearched: 0 }));
  });
}

async function searchProject(query, { caseSensitive = false, regex = false, maxFiles, maxMatches, allFiles = false, active = null } = {}) {
  if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
  if (typeof query !== 'string' || !query) fail(400, '请输入搜索关键词');
  if (regex) {
    rejectCatastrophicBacktracking(query);
    try { new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { fail(400, '正则表达式无效'); }
  }
  const appliedMaxFiles = clampLimit(maxFiles, 200, allFiles ? 2000 : 400);
  const appliedMaxMatches = clampLimit(maxMatches, 300, 1000);
  const buffers = normalizeActive(active);
  const textFiles = (await getFileIndex()).filter(file => textExtensions.has(path.extname(file.path).toLowerCase()));
  const scan = textFiles.slice(0, appliedMaxFiles);
  // Nothing here is silent: fewer files than the project contains is reported as a truncated answer.
  let truncated = textFiles.length > scan.length;
  let timedOut = false;

  if (regex) {
    const inWorker = await runSearchInWorker({
      root: currentProjectRoot(),
      files: scan,
      query,
      caseSensitive,
      maxMatches: appliedMaxMatches,
      active: buffers,
      budgetMs: searchWorkerBudgetMs
    });
    // `null` means this platform refused to start a thread; the synchronous scan below is then the only option,
    // and its budget/sampler at least report honestly instead of pretending the answer was complete.
    if (inWorker) {
      return {
        query,
        matches: inWorker.matches,
        truncated: truncated || inWorker.truncated,
        timedOut: inWorker.timedOut,
        filesSearched: inWorker.filesSearched
      };
    }
  }

  const matcher = buildSearchMatcher(query, { regex, caseSensitive });
  const budget = timeBudget(searchTextBudgetMs);
  const matches = [];
  const sampler = syncBlockSampler();
  sampler.start();
  try {
    for (let index = 0; index < scan.length; index++) {
      if (index > 0 && budget.expired()) { timedOut = true; truncated = true; break; }
      const file = scan[index];
      let content = activeContent(buffers, file.path);
      if (content === null) {
        try {
          const stat = await fs.stat(path.join(currentProjectRoot(), file.path));
          if (stat.size > 2_000_000) continue;
          content = await fs.readFile(path.join(currentProjectRoot(), file.path), 'utf8');
        } catch { continue; }
      }
      const lines = content.split(/\r?\n/);
      let fileMatches = 0;
      let capped = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 20_000) continue;
        let hit;
        try { hit = matcher.line(line); }
        catch { continue; }
        if (!hit) continue;
        const trimmed = line.trim();
        const leading = line.length - line.trimStart().length;
        const start = Math.max(0, hit.index - leading);
        matches.push({ file: file.path, line: i + 1, text: trimmed.slice(0, 240), start, length: hit.count });
        fileMatches += 1;
        if (matches.length >= appliedMaxMatches) { truncated = true; capped = true; break; }
        // One file must not eat the whole answer: 50 hits per file, then move on to the next one.
        if (fileMatches >= perFileMatchLimit) { truncated = true; break; }
      }
      if (capped) break;
      // A single pathological line can block the loop for minutes; the wall clock reports it instead of
      // pretending the scan finished.
      if (budget.expired() || sampler.blocked()) { timedOut = true; truncated = true; break; }
      await null;
    }
  } finally {
    sampler.stop();
  }
  return { query, matches, truncated, timedOut, filesSearched: scan.length };
}

// Every level of `.latex-tools/build/<id>` is created and verified on its own: an existing symlink anywhere on
// that path is rejected instead of being followed out of the project, because the TeX engine writes into the
// returned directory and `/api/pdf` reads from it.
async function safeBuildSubdir(subdirName) {
  if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
  const dotDir = path.join(currentProjectRoot(), '.latex-tools');
  const buildRoot = path.join(dotDir, 'build');
  await ensurePlainDirectory(dotDir);
  await ensurePlainDirectory(buildRoot);
  const target = path.join(buildRoot, subdirName);
  const realTarget = await ensurePlainDirectory(target);
  return realTarget;
}

const syncTexCache = new Map();

async function loadSyncTex(rootRel) {
  const outdir = buildDir(rootRel);
  const gzPath = path.join(outdir, `${path.basename(rootRel, '.tex')}.synctex.gz`);
  let stat;
  let realGz;
  try {
    realGz = await fs.realpath(gzPath);
    if (!inside(currentProjectRoot(), realGz)) return null;
    stat = await fs.stat(realGz);
    if (!stat.isFile() || stat.size > 25_000_000) return null;
  } catch {
    return null;
  }
  // The key is the resolved path: two spellings of one file must not occupy two entries, and a symlinked build
  // directory must not hand its map to another project.
  const cacheKey = `${currentProjectRoot()}:${realGz}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  if (syncTexCache.has(cacheKey)) return syncTexCache.get(cacheKey);

  let raw;
  try {
    raw = zlib.gunzipSync(await fs.readFile(gzPath)).toString('utf8');
  } catch {
    return null;
  }

  const knownFiles = (await getFileIndex()).map(f => f.path);
  const tagToFile = new Map();
  let magnification = 1000;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('Magnification:')) magnification = Number(line.slice(14).trim()) || 1000;
    else if (line.startsWith('Unit:')) unit = Number(line.slice(5).trim()) || 1;
    else if (line.startsWith('X Offset:')) xOffset = Number(line.slice(9).trim()) || 0;
    else if (line.startsWith('Y Offset:')) yOffset = Number(line.slice(9).trim()) || 0;
    else if (line.startsWith('Input:')) {
      const m = line.match(/^Input:(\d+):(.+)$/);
      if (!m) continue;
      const tag = Number(m[1]);
      const rawInput = m[2].trim();
      if (!rawInput) continue;
      const candidateAbs = path.isAbsolute(rawInput) ? rawInput : path.resolve(currentProjectRoot(), rawInput);
      let resolvedRel = null;
      try {
        const real = await fs.realpath(candidateAbs);
        if (inside(currentProjectRoot(), real)) {
          const rel = path.relative(currentProjectRoot(), real).split(path.sep).join('/');
          if (knownFiles.includes(rel)) resolvedRel = rel;
        }
      } catch {
        resolvedRel = resolveProjectPath(rawInput, knownFiles);
      }
      if (resolvedRel) tagToFile.set(tag, resolvedRel);
    }
  }

  const scaleToBp = (unit * (magnification / 1000)) / 65781.76;
  const toBp = value => value * scaleToBp;
  const records = [];
  let currentPage = 0;

  for (const line of lines) {
    if (!line) continue;
    const ch = line[0];
    if (ch === '{') {
      const p = Number(line.slice(1));
      if (p > 0) currentPage = p;
      continue;
    }
    if (ch === '}') {
      currentPage = 0;
      continue;
    }
    if (!currentPage) continue;

    if (ch === '(') {
      const m = line.match(/^\((\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/);
      if (!m) continue;
      const file = tagToFile.get(Number(m[1]));
      const lineNum = Number(m[2]);
      if (!file || lineNum <= 0) continue;
      records.push({
        page: currentPage,
        file,
        line: lineNum,
        x: toBp(Number(m[3]) + xOffset),
        y: toBp(Number(m[4]) + yOffset),
        w: Math.max(0, toBp(Number(m[5]))),
        h: Math.max(0, toBp(Number(m[6]))),
        d: Math.max(0, toBp(Number(m[7]))),
        kind: 'box'
      });
    } else if (ch === 'x' || ch === 'k' || ch === 'g' || ch === '$' || ch === 'h' || ch === 'v') {
      const m = line.match(/^[xkghv$](\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/);
      if (!m) continue;
      const file = tagToFile.get(Number(m[1]));
      const lineNum = Number(m[2]);
      if (!file || lineNum <= 0) continue;
      records.push({
        page: currentPage,
        file,
        line: lineNum,
        x: toBp(Number(m[3]) + xOffset),
        y: toBp(Number(m[4]) + yOffset),
        w: m[5] ? Math.max(0, toBp(Number(m[5]))) : 0,
        h: m[6] ? Math.max(0, toBp(Number(m[6]))) : 10,
        d: m[7] ? Math.max(0, toBp(Number(m[7]))) : 3,
        kind: 'node'
      });
    }
  }

  const parsed = { records };
  if (syncTexCache.size >= 4) {
    const oldest = syncTexCache.keys().next().value;
    syncTexCache.delete(oldest);
  }
  syncTexCache.set(cacheKey, parsed);
  return parsed;
}

function forwardSyncTex(syncData, fileRel, targetLine) {
  if (!syncData?.records?.length) return { found: false };
  const fileRecords = syncData.records.filter(r => r.file === fileRel);
  if (!fileRecords.length) return { found: false };
  const compact = fileRecords.filter(r => (r.h + r.d) <= 260);
  const pool = compact.length ? compact : fileRecords;

  let minDiff = Infinity;
  for (const r of pool) {
    const diff = Math.abs(r.line - targetLine);
    if (diff < minDiff) minDiff = diff;
  }
  if (minDiff > 80) return { found: false };

  const near = pool.filter(r => Math.abs(r.line - targetLine) === minDiff);
  const preferredBox = near.find(r => r.kind === 'box' && r.w > 8 && (r.h + r.d) < 140);
  const best = preferredBox || near[0];
  return {
    found: true,
    page: best.page,
    file: best.file,
    line: best.line,
    x: Math.round(best.x * 10) / 10,
    y: Math.round((best.y - (best.h || 10)) * 10) / 10,
    width: Math.round(Math.max(best.w || 48, 36) * 10) / 10,
    height: Math.round(Math.max((best.h || 10) + (best.d || 3), 14) * 10) / 10
  };
}

function reverseSyncTex(syncData, page, xBp, yBp) {
  if (!syncData?.records?.length) return { found: false };
  const pageRecords = syncData.records.filter(r => r.page === page && (r.h + r.d) <= 260);
  if (!pageRecords.length) return { found: false };

  let best = null;
  let bestScore = Infinity;
  let bestDy = Infinity;
  for (const r of pageRecords) {
    const top = r.y - Math.max(r.h || 10, 8) - 2;
    const bottom = r.y + Math.max(r.d || 3, 3) + 2;
    const left = r.x - 4;
    const right = r.x + Math.max(r.w || 12, 12) + 4;
    const dy = yBp < top ? top - yBp : yBp > bottom ? yBp - bottom : 0;
    const dx = xBp < left ? left - xBp : xBp > right ? xBp - right : 0;
    const score = dy * 10 + dx + (r.kind === 'box' ? 0.5 + r.w * 0.002 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestDy = dy;
      best = r;
    }
  }
  if (!best || bestDy > 80) return { found: false };
  return { found: true, file: best.file, line: best.line };
}

// ─────────────────────────────── file responses ───────────────────────────────
// PDF.js loads a thesis PDF range by range, so both file endpoints stream from disk with ETag/Range support
// instead of reading the whole document into memory and answering with `no-store`.
const mtimeEpsilonMs = 1500;

function parseRanges(header, size) {
  const match = /^\s*bytes\s*=\s*(.*?)\s*$/.exec(header || '');
  if (!match) return null;
  const ranges = [];
  for (const piece of match[1].split(',')) {
    if (!piece.trim()) continue;
    const item = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(piece);
    if (!item) return null;
    const [, rawStart, rawEnd] = item;
    if (!rawStart && !rawEnd) return null;
    if (!rawStart) {
      const count = Number(rawEnd);
      if (!Number.isFinite(count) || count <= 0) return null;
      if (count >= size) { ranges.push({ start: 0, end: size - 1 }); continue; }
      ranges.push({ start: size - count, end: size - 1 });
      continue;
    }
    const start = Number(rawStart);
    if (!Number.isFinite(start) || start >= size) return null;
    if (!rawEnd) { ranges.push({ start, end: size - 1 }); continue; }
    const end = Math.min(Number(rawEnd), size - 1);
    if (!(end >= start)) return null;
    ranges.push({ start, end });
  }
  return ranges.length ? ranges : null;
}

async function sendFile(req, res, absolute, { contentType, disposition, maxBytes, stat: knownStat } = {}) {
  let stat = knownStat;
  if (!stat) {
    stat = await fs.stat(absolute);
    knownStat = null;
  }
  if (!stat.isFile()) fail(400, '这不是文件');
  // The size check has to happen before the first byte: a huge file must never be streamed just to be refused.
  if (maxBytes && stat.size > maxBytes) fail(413, '文件过大');
  const etag = `"${Math.round(stat.mtimeMs)}-${stat.size}"`;
  const conditional = req.headers['if-none-match'];
  const ifRange = req.headers['if-range'];
  const head = req.method === 'HEAD';
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
  if (disposition) baseHeaders['Content-Disposition'] = disposition;
  if (conditional && conditional.split(',').some(value => value.trim() === etag)) {
    res.writeHead(304, { ETag: etag, 'Last-Modified': baseHeaders['Last-Modified'], 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  const wantRange = req.headers.range;
  const ranges = wantRange && (!ifRange || ifRange === etag || ifRange === stat.mtime.toUTCString())
    ? parseRanges(wantRange, stat.size)
    : undefined;
  if (ranges && ranges.length > 1) {
    // A thesis PDF is one resource; a multi-range answer only complicates the reader, so answer the first one.
    const [first] = ranges;
    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    if (head) { res.end(); return; }
    streamFile(req, res, absolute, first.start, first.end);
    return;
  }
  if (ranges && ranges.length === 1) {
    const [{ start, end }] = ranges;
    res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (head) { res.end(); return; }
    streamFile(req, res, absolute, start, end);
    return;
  }
  if (wantRange) {
    // A Range we cannot parse or cannot satisfy is answered per RFC 7233 §4.4 instead of silently ignoring it.
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
    res.end();
    return;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  if (head) { res.end(); return; }
  streamFile(req, res, absolute, 0, stat.size - 1);
}

function streamFile(req, res, absolute, start, end) {
  const stream = createReadStream(absolute, { start, end });
  const abort = () => stream.destroy();
  res.on('close', abort);
  req.on('aborted', abort);
  stream.on('error', abort);
  stream.pipe(res);
}

function inlineDisposition(pdfName) {
  const asciiFallback = pdfName.replace(/[^\x20-\x7E]/g, '_') || 'document.pdf';
  return { inline: 'inline', attachment: `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(pdfName)}` };
}

// ─────────────────────────────── compilation ───────────────────────────────
// TeX artefacts that are never deleted before a run get read back as if they were the result of the run that
// just failed. `.pdf` deliberately stays: when a compile fails the author still wants the last good PDF.
const staleArtefacts = ['.log', '.synctex.gz', '.aux', '.bbl', '.blg', '.toc', '.out'];

async function clearStaleArtefacts(outdir, stem) {
  await Promise.allSettled(staleArtefacts.map(extension => fs.rm(path.join(outdir, stem + extension), { force: true })));
}

function engineMissing(result) {
  return Boolean(result?.spawnFailed && /ENOENT/i.test(String(result?.error?.code || result?.error?.message || '')));
}

function reportEngineFailure(result) {
  if (engineMissing(result)) fail(500, '本机未找到 Tectonic，请先安装：brew install tectonic');
  fail(500, '无法启动编译引擎，请确认 Tectonic 仍可执行');
}

// Freshness is decided by comparing the artefacts with what was on disk when this run started, never with the
// wall clock: two compiles can run one after another inside the same clock tick, and a file that is byte-for-byte
// the same as before the run can only be the previous result. The fingerprint is nanosecond mtime + size, so any
// rewrite by the engine changes it; APFS and ext4 both report the sub-millisecond digits a rewritten file needs.
// (On a filesystem whose mtimes stop at whole seconds an identical rewrite inside the same second stays
// "stale" — the safe direction: the viewer keeps showing the very same bytes instead of claiming a result the
// engine never wrote.)
async function fingerprintOf(directory, name) {
  try {
    // `bigint: true` is what makes this work: the floating `mtimeMs` rounds away the digits that separate two
    // writes in the same millisecond, `mtimeNs` keeps them.
    const stat = await fs.stat(path.join(directory, name), { bigint: true });
    if (!stat.isFile()) return null;
    return { fingerprint: `${stat.mtimeNs}-${stat.size}` };
  } catch {
    return null;
  }
}

function isFresh(current, before) {
  if (!current) return false;
  if (!before) return true;
  return before.fingerprint !== current.fingerprint;
}

async function compileArtifacts(compile) {
  const before = compile.artefactsBefore ?? {};
  const pdf = await fingerprintOf(compile.outdir, `${compile.stem}.pdf`);
  const synctex = await fingerprintOf(compile.outdir, `${compile.stem}.synctex.gz`);
  let pdfFresh = pdf && isFresh(pdf, before.pdf, compile.startedAt);
  if (compile.cancelled) pdfFresh = Boolean(compile.fingerprintBefore && pdf && pdf.fingerprint !== compile.fingerprintBefore);
  return {
    pdfAvailable: Boolean(pdf) && !compile.cancelled,
    pdfFresh: Boolean(pdfFresh),
    pdfStale: Boolean(pdf) && !pdfFresh,
    synctexAvailable: Boolean(synctex) && isFresh(synctex, before.synctex, compile.startedAt) && !compile.cancelled,
    pdfFingerprint: compile.cancelled ? (compile.fingerprintBefore ?? null) : (pdf?.fingerprint ?? null)
  };
}

async function compileResponseBody(compile, kind, rootRel) {
  const result = compile.result || { code: null, signal: null, output: '', timedOut: false, cancelled: false };
  const cancelled = Boolean(result.cancelled);
  const ok = !cancelled && !result.timedOut && result.code === 0;
  // The wall clock the engine actually ran for; a cancelled run reports how long it was alive before the stop.
  const durationMs = compile.finishedAt === null ? 0 : compile.finishedAt - compile.startedAt;
  const output = cancelled ? '' : result.output;
  let knownFiles = [];
  try { knownFiles = (await getFileIndex()).map(file => file.path); } catch {}
  if (kind === 'snippet') knownFiles = [...knownFiles, 'snippet.tex'];
  let logOutput = '';
  try { logOutput = cancelled ? '' : await fs.readFile(path.join(compile.outdir, `${compile.stem}.log`), 'utf8'); } catch {}
  // On failure Tectonic's stdout is often a bare `error: engine had an unrecoverable error`; the message with
  // the real file and line lives in the `.log`, so a failed run is parsed from both texts together.
  const parsed = cancelled
    ? { items: [], total: 0 }
    : diagnosticList(ok || !logOutput ? output : `${output}\n${logOutput}`, kind === 'snippet' ? 'snippet.tex' : rootRel, { logOutput, knownFiles });
  const diagnostics = kind === 'snippet' ? mapSnippetDiagnostics(parsed.items, compile) : parsed.items;
  const artifacts = await compileArtifacts(compile);
  // `v` is a content fingerprint so that an unchanged PDF keeps the same URL: with `Date.now()` here the browser
  // and PDF.js threw the document away and refetched every single megabyte on every compile.
  const version = artifacts.pdfFingerprint ?? Date.now();
  const pdfUrl = cancelled
    ? null
    : kind === 'snippet'
      ? `/api/pdf?snippet=1&v=${encodeURIComponent(version)}`
      : `/api/pdf?rootFile=${encodeURIComponent(rootRel)}&v=${encodeURIComponent(version)}`;
  const body = {
    ok,
    timedOut: Boolean(result.timedOut),
    cancelled,
    durationMs,
    output,
    diagnostics,
    // A cut list has to announce itself: the panel writes「另有 N 条未显示」from these two.
    diagnosticsTotal: parsed.total,
    diagnosticsTruncated: parsed.total > diagnostics.length,
    ...artifacts,
    pdfUrl
  };
  if (kind === 'snippet') body.snippet = true;
  return body;
}

// A snippet is compiled inside `.latex-tools/build/_snippet`, so a diagnostic in the snippet has to be
// translated back onto the editor or the inline error markers point at nothing. `file` is never null: the
// frontend skips diagnostics without a file, which would silently disable the markers.
// `snippet.tex` is the client's own document — preamble included — so `bodyLine` is the line the body starts
// on there, and `fromLine` the editor line of that first body line. Both come from the caller; the server adds
// nothing to the source, which is what keeps the numbers in the produced log meaningful.
function mapSnippetDiagnostics(items, compile) {
  const editorFile = compile.editorFile || 'snippet.tex';
  return items.map(item => {
    if (item.file !== 'snippet.tex') return item;
    if (item.line && compile.bodyLine !== null) {
      const offset = item.line - compile.bodyLine;
      if (offset >= 0) return { ...item, file: editorFile, line: compile.fromLine + offset };
    }
    return { ...item, file: editorFile, line: null };
  });
}

function compileToken(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !tokenPattern.test(value)) fail(400, '编译标识无效');
  return value;
}

// The lock is taken synchronously, before the first `await`: two compiles fired in the same tick used to both
// pass the `compiling` check and then run two engines against one output directory.
async function startCompile(kind, req, res) {
  if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
  if (compileJob) fail(409, '已有编译任务正在进行');
  const job = { kind, token: null, child: null, cancelled: false, cancel: null };
  compileJob = job;
  try {
    const input = await jsonBody(req);
    const token = compileToken(input.token);
    // The token only becomes cancellable once the whole body has been read: a cancel that arrives while this
    // request is still uploading must not be able to hit some later compile that reuses the token.
    if (compileJob !== job) fail(409, '已有编译任务正在进行');
    job.token = token;

    const compile = {
      kind,
      outdir: null,
      stem: null,
      startedAt: 0,
      finishedAt: null,
      result: null,
      cancelled: false,
      fingerprintBefore: null,
      editorFile: null,
      bodyLine: null,
      fromLine: 1
    };
    if (kind === 'snippet') {
      if (typeof input.source !== 'string' || !input.source.trim()) fail(400, '选段内容为空');
      if (input.source.length > 500_000) fail(413, '选段内容过长');
      const validEditor = input.editorFile ? (await projectFile(input.editorFile, { extensions: new Set(['.tex']) })).rel : null;
      const validRoot = input.rootFile ? (await projectFile(input.rootFile, { extensions: new Set(['.tex']) })).absolute : null;
      compile.outdir = await safeBuildSubdir('_snippet');
      compile.stem = 'snippet';
      compile.editorFile = validEditor;
      compile.fromLine = Number.isFinite(Number(input.fromLine)) && Number(input.fromLine) > 0 ? Number(input.fromLine) : 1;
      compile.bodyLine = Number.isFinite(Number(input.bodyStart)) && Number(input.bodyStart) > 0 ? Number(input.bodyStart) : 1;
      const snippetTex = path.join(compile.outdir, 'snippet.tex');
      await clearStaleArtefacts(compile.outdir, 'snippet');
      compile.artefactsBefore = {
        pdf: await fingerprintOf(compile.outdir, 'snippet.pdf'),
        synctex: await fingerprintOf(compile.outdir, 'snippet.synctex.gz')
      };
      compile.fingerprintBefore = compile.artefactsBefore.pdf?.fingerprint ?? null;
      await fs.writeFile(snippetTex, input.source, 'utf8');
      const searchArgs = ['-Z', `search-path=${currentProjectRoot()}`];
      if (validRoot && path.dirname(validRoot) !== currentProjectRoot()) {
        searchArgs.push('-Z', `search-path=${path.dirname(validRoot)}`);
      }
      compile.startedAt = Date.now();
      const runPromise = run('tectonic', ['-X', 'compile', '--keep-logs', '--print', ...searchArgs, '--outdir', compile.outdir, snippetTex], {
        cwd: currentProjectRoot(),
        timeout: SNIPPET_TIMEOUT_MS,
        cancelSignal: engineCancelSignal,
        onSpawn: child => { job.child = child; }
      });
      job.cancel = runPromise.cancel;
      compile.result = await runPromise;
      compile.finishedAt = Date.now();
      compile.cancelled = Boolean(compile.result.cancelled || job.cancelled);
      if (compile.result.spawnFailed) reportEngineFailure(compile.result);
      json(res, 200, await compileResponseBody(compile, 'snippet', null));
      return;
    }
    const { absolute, rel } = await projectFile(input.rootFile, { extensions: new Set(['.tex']) });
    const buildId = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12);
    compile.outdir = await safeBuildSubdir(buildId);
    compile.stem = path.basename(rel, '.tex');
    await clearStaleArtefacts(compile.outdir, compile.stem);
    compile.artefactsBefore = {
      pdf: await fingerprintOf(compile.outdir, `${compile.stem}.pdf`),
      synctex: await fingerprintOf(compile.outdir, `${compile.stem}.synctex.gz`)
    };
    compile.fingerprintBefore = compile.artefactsBefore.pdf?.fingerprint ?? null;
    compile.startedAt = Date.now();
    const runPromise = run('tectonic', ['-X', 'compile', '--keep-logs', '--synctex', '--print', '-Z', `search-path=${currentProjectRoot()}`, '--outdir', compile.outdir, absolute], {
      cwd: currentProjectRoot(),
      timeout: COMPILE_TIMEOUT_MS,
      cancelSignal: engineCancelSignal,
      onSpawn: child => { job.child = child; }
    });
    job.cancel = runPromise.cancel;
    compile.result = await runPromise;
    compile.finishedAt = Date.now();
    compile.cancelled = Boolean(compile.result.cancelled || job.cancelled);
    if (compile.result.spawnFailed) reportEngineFailure(compile.result);
    json(res, 200, await compileResponseBody(compile, 'full', rel));
  } finally {
    // Whatever happened — bad request, an engine that could not be spawned, a crashed response — the slot is
    // released, and a token that is no longer running stops being cancellable.
    job.token = null;
    job.cancel = null;
    job.child = null;
    if (compileJob === job) compileJob = null;
  }
}

// Cancelling never deletes anything: an interrupted run leaves the previous readable PDF on disk, and the next
// compile judges it by its mtime. This run simply reports nothing as its own result.
function cancelCompileJob(token) {
  const job = compileJob;
  if (!job || !job.child || job.cancelled) return false;
  if (token !== null && token !== job.token) return false;
  job.cancelled = true;
  if (job.cancel) job.cancel();
  else {
    killTree(job.child, engineCancelSignal);
    setTimeout(() => killTree(job.child, 'SIGKILL'), 5_000).unref?.();
  }
  return true;
}

// ─────────────────────────────── endpoints ───────────────────────────────
async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/status' && req.method === 'GET') {
    json(res, 200, { projectRoot: currentProjectRoot(), engine: 'tectonic' }); return;
  }
  if (route === '/api/project/choose' && req.method === 'POST') {
    if (process.platform !== 'darwin') fail(400, '文件夹选择器仅支持 macOS，请输入路径');
    const result = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择 LaTeX 项目文件夹")'], { timeout: 120_000 });
    if (result.code !== 0) fail(400, '未选择文件夹');
    const selected = result.output.trim();
    if (!selected) fail(400, '未选择文件夹');
    activeProjectRoot = await openProjectRoot(selected);
    json(res, 200, { projectRoot: activeProjectRoot, files: await listFiles(activeProjectRoot) }); return;
  }
  if (route === '/api/project/open' && req.method === 'POST') {
    const input = await jsonBody(req);
    if (typeof input.path !== 'string' || !input.path.trim()) fail(400, '请输入文件夹路径');
    const candidate = input.path.startsWith('~' + path.sep) ? path.join(os.homedir(), input.path.slice(2)) : input.path;
    activeProjectRoot = await openProjectRoot(candidate);
    json(res, 200, { projectRoot: activeProjectRoot, files: await listFiles(activeProjectRoot) }); return;
  }
  if (route === '/api/project/reveal' && req.method === 'POST') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    if (process.platform !== 'darwin') fail(400, '仅支持在 macOS Finder 中打开');
    await run('open', [currentProjectRoot()], { timeout: 10_000 });
    json(res, 200, { ok: true }); return;
  }
  if (route === '/api/tree' && req.method === 'GET') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    const files = await listFiles();
    // The browser has to say「仅显示前 800 个文件」instead of quietly showing a short tree.
    json(res, 200, { files, truncated: indexTruncated() || files.length >= fileIndexLimit }); return;
  }
  if (route === '/api/search' && req.method === 'POST') {
    const input = await jsonBody(req);
    json(res, 200, await searchProject(input.query, input)); return;
  }
  if (route === '/api/references' && req.method === 'POST') {
    const input = await jsonBody(req).catch(() => ({}));
    const rootRel = typeof input.rootFile === 'string' && input.rootFile ? relativePath(input.rootFile) : null;
    json(res, 200, await scanReferences(input.active, rootRel)); return;
  }
  if (route === '/api/file' && req.method === 'GET') {
    const { absolute, rel } = await projectFile(url.searchParams.get('path'));
    const stat = await fs.stat(absolute);
    if (stat.size > 5_000_000) fail(413, '文本文件过大');
    json(res, 200, { path: rel, content: await fs.readFile(absolute, 'utf8'), mtimeMs: stat.mtimeMs }); return;
  }
  if (route === '/api/file' && req.method === 'PUT') {
    const input = await jsonBody(req);
    const { absolute, rel } = await projectFile(input.path);
    if (typeof input.content !== 'string') fail(400, '文件内容无效');
    // An omitted `mtimeMs` used to skip the external-edit check entirely, which is exactly the case a second
    // editor writing to disk relies on.
    if (!input.force && typeof input.mtimeMs !== 'number') fail(400, '请先重新载入文件再保存');
    const stat = await fs.stat(absolute);
    if (!input.force && typeof input.mtimeMs === 'number' && Math.abs(input.mtimeMs - stat.mtimeMs) > 1) fail(409, '文件已在其他程序中修改，请先重新打开再决定如何处理');
    await fs.writeFile(absolute, input.content, 'utf8');
    invalidateFileIndex();
    json(res, 200, { path: rel, mtimeMs: (await fs.stat(absolute)).mtimeMs }); return;
  }
  if (route === '/api/file' && req.method === 'POST') {
    const input = await jsonBody(req);
    const { absolute, rel } = await projectFile(input.path, { create: true });
    if (typeof input.content !== 'string') fail(400, '文件内容无效');
    await fs.writeFile(absolute, input.content, { encoding: 'utf8', flag: 'wx' });
    invalidateFileIndex();
    json(res, 201, { path: rel, mtimeMs: (await fs.stat(absolute)).mtimeMs }); return;
  }
  if (route === '/api/template' && req.method === 'POST') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    const input = await jsonBody(req);
    // `templates[input.kind]` alone answers with `Object.prototype`, so `kind:"constructor"` used to report 201
    // while writing nothing at all.
    if (typeof input.kind !== 'string' || !Object.hasOwn(templates, input.kind)) fail(400, '未知模板');
    const files = templates[input.kind];
    const names = Object.keys(files);
    // Every name is checked before the first write: two template files must never land as a half-written pair.
    for (const name of names) {
      try { await fs.access(path.join(currentProjectRoot(), name)); fail(409, `${name} 已存在，模板不会覆盖文件`); }
      catch (error) { if (error.status) throw error; if (error.code !== 'ENOENT') throw error; }
    }
    let written = 0;
    try {
      for (const name of names) {
        await fs.writeFile(path.join(currentProjectRoot(), name), files[name], { flag: 'wx' });
        written += 1;
      }
    } catch (error) {
      if (error.code === 'EEXIST') fail(409, '模板文件已存在，不会覆盖');
      throw error;
    }
    invalidateFileIndex();
    json(res, 201, { files: await listFiles(), main: 'main.tex', written }); return;
  }
  if (route === '/api/upload' && req.method === 'POST') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    const name = path.basename(url.searchParams.get('filename') || '');
    if (!name || !imageExtensions.has(path.extname(name).toLowerCase())) fail(400, '请选择 PNG、JPG、PDF、EPS 或 SVG 图片');
    const data = await body(req, 20_000_000, { timeoutMs: 120_000 });
    if (!data.length) fail(400, '图片为空');
    const folder = path.join(currentProjectRoot(), 'figures');
    await fs.mkdir(folder, { recursive: true });
    const realFolder = await fs.realpath(folder);
    if (!inside(currentProjectRoot(), realFolder)) fail(400, '不能写入项目目录之外');
    const stem = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80) || 'image';
    const ext = path.extname(name).toLowerCase();
    let target = path.join(folder, `${stem}${ext}`);
    for (let index = 2; index < 1000; index++) {
      try { await fs.access(target); target = path.join(folder, `${stem}-${index}${ext}`); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await fs.writeFile(target, data, { flag: 'wx' });
    invalidateFileIndex();
    json(res, 201, { path: path.relative(currentProjectRoot(), target).split(path.sep).join('/') }); return;
  }
  if (route === '/api/compile' && req.method === 'POST') { await startCompile('full', req, res); return; }
  if (route === '/api/compile/snippet' && req.method === 'POST') { await startCompile('snippet', req, res); return; }
  if (route === '/api/compile/cancel' && req.method === 'POST') {
    const input = await jsonBody(req).catch(() => ({}));
    const token = compileToken(input?.token);
    // An unknown or already finished token is not an error: the browser fires and forgets the cancel.
    json(res, 200, { ok: true, cancelled: cancelCompileJob(token) }); return;
  }
  if (route === '/api/synctex/forward' && req.method === 'POST') {
    const input = await jsonBody(req);
    const { rel: rootRel } = await projectFile(input.rootFile, { extensions: new Set(['.tex']) });
    const { rel: fileRel } = await projectFile(input.file, { extensions: new Set(['.tex']) });
    const syncData = await loadSyncTex(rootRel);
    json(res, 200, forwardSyncTex(syncData, fileRel, Math.max(1, Number(input.line) || 1)));
    return;
  }
  if (route === '/api/synctex/reverse' && req.method === 'POST') {
    const input = await jsonBody(req);
    const { rel: rootRel } = await projectFile(input.rootFile, { extensions: new Set(['.tex']) });
    const syncData = await loadSyncTex(rootRel);
    json(res, 200, reverseSyncTex(syncData, Math.max(1, Number(input.page) || 1), Number(input.x) || 0, Number(input.y) || 0));
    return;
  }
  if (route === '/api/pdf' && (req.method === 'GET' || req.method === 'HEAD')) {
    let pdfName;
    let pdfPath;
    if (url.searchParams.get('snippet') === '1') {
      if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
      pdfName = 'snippet.pdf';
      pdfPath = path.join(await buildSubdirForRead('_snippet'), pdfName);
    } else {
      const { rel } = await projectFile(url.searchParams.get('rootFile'), { extensions: new Set(['.tex']) });
      pdfName = `${path.basename(rel, '.tex')}.pdf`;
      const buildId = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12);
      pdfPath = path.join(await buildSubdirForRead(buildId), pdfName);
    }
    // `realpath` on the file would follow a symlinked build root out of the project, so the two directory
    // levels are checked on their own before the file itself is resolved.
    const checked = await fs.realpath(pdfPath);
    if (!inside(currentProjectRoot(), checked)) fail(400, '不能访问项目目录之外的文件');
    const { inline, attachment } = inlineDisposition(pdfName);
    await sendFile(req, res, checked, {
      contentType: 'application/pdf',
      disposition: url.searchParams.get('download') === '1' ? attachment : inline,
      maxBytes: 25_000_000
    });
    return;
  }
  if (route === '/api/pdf/reveal' && req.method === 'POST') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    const input = await jsonBody(req);
    const { rel } = await projectFile(input.rootFile, { extensions: new Set(['.tex']) });
    const pdfPath = path.join(buildDir(rel), `${path.basename(rel, '.tex')}.pdf`);
    let checked;
    try {
      checked = await fs.realpath(pdfPath);
    } catch (error) {
      if (error.code === 'ENOENT') fail(404, '尚未找到编译生成的 PDF，请先编译');
      throw error;
    }
    if (!inside(currentProjectRoot(), checked)) fail(400, '不能访问项目目录之外的文件');
    if (process.platform !== 'darwin') fail(400, '仅支持在 macOS Finder 中定位');
    await run('open', ['-R', checked], { timeout: 10_000 });
    json(res, 200, { ok: true, pdfPath: checked }); return;
  }
  if (route === '/api/build/clean' && req.method === 'POST') {
    if (!currentProjectRoot()) fail(400, '请先打开项目文件夹');
    if (compileJob) fail(409, '编译正在进行，请稍候再清理');
    json(res, 200, await cleanBuildCache());
    return;
  }
  if (route === '/api/asset' && (req.method === 'GET' || req.method === 'HEAD')) {
    const { absolute } = await projectFile(url.searchParams.get('path'), { extensions: imageExtensions });
    const stat = await fs.stat(absolute);
    const ext = path.extname(absolute).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.eps': 'application/postscript' }[ext] || 'application/octet-stream';
    await sendFile(req, res, absolute, { contentType: mime, maxBytes: 25_000_000, stat });
    return;
  }
  if (apiRoutes.has(route)) fail(405, '方法不允许');
  fail(404, '接口不存在');
}

const apiRoutes = new Set([
  '/api/status', '/api/project/choose', '/api/project/open', '/api/project/reveal', '/api/tree',
  '/api/search', '/api/references', '/api/file', '/api/template', '/api/upload', '/api/compile',
  '/api/compile/snippet', '/api/compile/cancel', '/api/synctex/forward', '/api/synctex/reverse',
  '/api/pdf', '/api/pdf/reveal', '/api/build/clean', '/api/asset'
]);

// A read-only view of a build directory: unlike `safeBuildSubdir` it never creates anything, but it refuses a
// symlinked `.latex-tools/build` so a fake build root cannot point the reader outside the project.
async function buildSubdirForRead(subdirName) {
  const root = currentProjectRoot();
  const dotDir = path.join(root, '.latex-tools');
  const buildRoot = path.join(dotDir, 'build');
  for (const probe of [dotDir, buildRoot]) {
    let stat;
    try { stat = await fs.lstat(probe); }
    catch (error) {
      if (error.code === 'ENOENT') fail(404, '还没有编译生成物');
      throw error;
    }
    if (stat.isSymbolicLink()) fail(400, '.latex-tools 目录不能是符号链接');
    if (!stat.isDirectory()) fail(400, '.latex-tools 不是文件夹');
  }
  const target = path.join(buildRoot, subdirName);
  const realTarget = await fs.realpath(target);
  if (!inside(root, realTarget)) fail(400, '不能访问项目目录之外的文件');
  return realTarget;
}

function cleanFailureReason(error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') return '没有权限删除，可能有其他程序正在使用';
  if (error.code === 'EBUSY' || error.code === 'ENOTEMPTY') return '文件正被占用';
  return '删除失败';
}

// Reporting `ok: true, cleaned: 0` after a failed `rm` told the user their cache was gone while it was still
// there, so every entry is removed on its own and each failure is named.
async function cleanBuildCache() {
  const root = currentProjectRoot();
  const dotDir = path.join(root, '.latex-tools');
  const target = path.join(dotDir, 'build');
  let realTarget;
  try {
    const dotStat = await fs.lstat(dotDir);
    if (dotStat.isSymbolicLink()) fail(400, '.latex-tools 目录不能是符号链接');
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink()) fail(400, '.latex-tools/build 不能是符号链接');
    realTarget = await fs.realpath(target);
    if (!inside(root, realTarget)) fail(400, '不能访问项目目录之外的文件');
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') return { ok: true, cleaned: 0, remaining: 0, failures: [] };
    throw error;
  }
  const entries = await fs.readdir(realTarget, { withFileTypes: true });
  const failures = [];
  let cleaned = 0;
  for (const entry of entries) {
    try {
      await fs.rm(path.join(realTarget, entry.name), { recursive: true, force: true });
      cleaned += 1;
    } catch (error) {
      failures.push({ name: entry.name, reason: cleanFailureReason(error) });
    }
  }
  try { await fs.rmdir(realTarget); }
  catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
      failures.push({ name: 'build', reason: cleanFailureReason(error) });
    }
  }
  syncTexCache.clear();
  invalidateFileIndex();
  return { ok: failures.length === 0, cleaned, remaining: entries.length - cleaned, failures };
}

async function openProjectRoot(candidate) {
  let real;
  try {
    real = await fs.realpath(candidate);
    if (!(await fs.stat(real)).isDirectory()) fail(400, '这不是文件夹');
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail(400, '路径不存在或无法访问');
    if (error.code === 'EACCES' || error.code === 'EPERM') fail(400, '没有权限访问该文件夹');
    throw error;
  }
  invalidateFileIndex();
  return real;
}

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { fail(400, '地址无效'); }
  const requested = path.resolve(distRoot, '.' + pathname);
  if (!inside(distRoot, requested)) fail(403, '禁止访问');
  const target = pathname === '/' ? path.join(distRoot, 'index.html') : requested;
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json' }[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const stat = await fs.stat(target);
  if (!stat.isFile()) fail(404, '页面不存在');
  await sendFile(req, res, target, { contentType: mime, stat });
}

const allowedFetchSites = new Set(['same-origin', 'none']);

// No Origin header is sent by top-level navigations, `<img>` / `<script>` embeds, curl and tests, so a
// cross-site page could otherwise read project files straight out of `/api/file`. Browsers always attach
// `Sec-Fetch-Site`, which cannot be forged from a page, so an explicit value outside this whitelist is rejected
// while command-line clients keep working. `same-site` is rejected too: this app is only ever served from one
// same-origin page, so anything else — including a page on another port of this machine — has no business here.
function guardRequest(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) fail(403, '仅允许本机访问');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) fail(403, '不允许跨站请求');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !allowedFetchSites.has(fetchSite)) fail(403, '不允许跨站请求');
  return host;
}

const systemErrorMessages = new Map([
  ['ENOENT', '文件不存在或已被移除'],
  ['EACCES', '没有权限访问该文件'],
  ['EPERM', '没有权限访问该文件'],
  ['EISDIR', '路径类型不正确'],
  ['ENOTDIR', '路径类型不正确'],
  ['EEXIST', '文件已存在'],
  ['ENAMETOOLONG', '文件路径过长'],
  ['EINVAL', '路径不合法'],
  ['EMFILE', '打开的文件太多，请稍候再试'],
  ['ELOOP', '文件夹中存在循环的符号链接'],
  ['EROFS', '该文件位于只读磁盘上']
]);

// The browser only needs a sentence it can show. Absolute paths, `ENOENT`, `realpath` and `spawn tectonic ENOENT`
// would leak the layout of the user's disk into the page, so the original message stays in the terminal.
function errorEnvelope(error) {
  if (typeof error?.status === 'number') return { status: error.status, message: error.message };
  const text = String(error?.message || '');
  if (/spawn/i.test(text) && /ENOENT/.test(text)) return { status: 500, message: '本机未找到 Tectonic，请先安装：brew install tectonic' };
  const mapped = error?.code ? systemErrorMessages.get(error.code) : null;
  if (mapped) return { status: error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : 500, message: mapped };
  if (/Failed to fetch|socket hang up|aborted/.test(text)) return { status: 400, message: '请求已中断' };
  return { status: 500, message: '服务器出了点问题，请查看终端日志' };
}

function respondError(res, error) {
  const { status, message } = errorEnvelope(error);
  if (status >= 500) console.error(`[${status}]`, error?.stack || error?.message || error);
  if (res.headersSent) { res.end(); return; }
  json(res, status, { error: message });
}

const server = http.createServer((req, res) => {
  // Every request runs against the project that was open when it started, so opening another folder while a
  // compile is in flight cannot make that compile read from the new project.
  requestProject.run(activeProjectRoot, () => handle(req, res));
});

async function handle(req, res) {
  try {
    const host = guardRequest(req);
    let url;
    try { url = new URL(req.url, `http://${host}`); }
    catch { fail(400, '地址无效'); }
    currentRequestPath = url.pathname;
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else fail(405, '方法不允许');
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.code === 'REQUEST_TIMEOUT') respondError(res, httpError(504, '请求超时'));
    else if (error.code === 'ERR_HTTP_HEADERS_SENT') console.error(error);
    else respondError(res, error);
  } finally {
    currentRequestPath = '';
  }
}

// stop.sh (or Ctrl+C) can arrive mid-compile. The engine lives in its own process group, so killing the group is
// the only way to be sure no xelatex / xdvipdfmx is left writing into `.latex-tools/build/` after we exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const child = compileJob?.child;
  if (child) killTree(child, 'SIGKILL');
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  // A request that never finishes must not keep the process alive after the user asked it to stop.
  setTimeout(() => process.exit(0), 2_000).unref?.();
  console.log(`\n砚台已停止（${signal}）`);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => console.error('未处理的 Promise 异常：', reason));

server.headersTimeout = 660_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 5_000;
server.listen(port, '127.0.0.1', () => {
  console.log(`砚台已启动：http://127.0.0.1:${port}`);
});
