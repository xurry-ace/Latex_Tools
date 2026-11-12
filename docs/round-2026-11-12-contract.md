# 本轮接口契约（2026-11-12 · 编译正确性 + 大文档性能）

> **状态：本轮已收尾，本文件转为「决策记录」。** 当初它是服务端与前端并行改动的唯一契约（任何一方要改契约先改本文件再改代码），现在**代码是唯一事实**，日常交接看 `Agent.md`（代码地图 + 编译约定 + 已知问题）。留着它是因为下面这些「为什么」在代码里只有一行注释、删掉就没人知道：为什么取消用 SIGINT 而超时用 SIGTERM、为什么 `child.on('error')` 必须 resolve、为什么新鲜度不能用 `mtime >= 开始时间 - ε`、为什么搜索的正则超时不能用 `Promise.race`。
> 后续代码与本文件冲突时**以代码为准**，并把结论同步进 `Agent.md`，不要反过来照着本文件改代码。

## 1. `run(command, args, options)`（服务端）

- `options.maxOutput`：字符上限，默认 2_000_000，超出后停止累加并在末尾附 `[输出过长，已截断]`。
- `options.killSignal`：默认 `'SIGTERM'`，**只用于超时**（卡死的 TeX 必须确定性退出；SIGINT 可能让它停在交互式错误提示上等一个永远不会来的输入，stdin 是 `ignore`）。
- `options.cancelSignal`：默认 `'SIGINT'`，**只用于用户点取消**（这是 TeX「在提示符输 `X`」的收尾路径，会尽量 flush 出可读的 `.log`；SIGTERM 会把 `.log` 截断在半句）。
- `options.onSpawn(child)`：子进程启动后**同步**回调，供 `/api/compile*` 注册可取消句柄。
- 超时：先发 `killSignal` 一次；**5 秒后仍在运行**才 `killTree(child, 'SIGKILL')`。任何时候都不得出现无参 `child.kill()`（那是 SIGTERM）。
- `child.on('error')`：**必须 resolve，绝不 reject、绝不让 Promise 悬空**（否则调用方 `finally` 不执行，编译锁永久卡死）。resolve 形状：`{ code: null, signal: null, error, output, timedOut: false, cancelled: false, spawnFailed: true }`。
- 正常 resolve 形状：`{ code, signal, output, timedOut, cancelled }`。`cancelled` 由取消路径置位。

## 2. 编译串行锁与取消

- 服务端把 `let compiling = false` 换成 `let compileJob = null`。
- `/api/compile` 与 `/api/compile/snippet`：**在第一个 `await` 之前**同步占位
  `if (compileJob) fail(409, '已有编译任务正在进行'); compileJob = { kind, token: null, child: null, cancelled: false };`
  并在 `finally` 中 `compileJob = null`。锁住后再 `await jsonBody(req)`。
- 请求体可选 `token`：字符串、`^[A-Za-z0-9._-]{1,64}$`，否则 `fail(400, '编译标识无效')`；spawn 前写入 `compileJob.token`。
- 新端点 `POST /api/compile/cancel`，体 `{ token }`：
  - 命中当前 `compileJob.token` → `compileJob.cancelled = true`，`child.kill('SIGINT')`，5 秒后 SIGKILL 兜底；响应 `{ ok: true, cancelled: true }`。
  - 未命中（已结束 / token 不符）→ 响应 200 `{ ok: true, cancelled: false }`（前端忽略即可，**不要** 404）。
- 被取消的编译响应：`{ ok: false, cancelled: true, timedOut: false, durationMs, output, diagnostics: [], pdfAvailable: false, pdfFresh: false, pdfStale: <见 §3>, synctexAvailable: false, pdfFingerprint: <旧值或 null>, pdfUrl: null }`。

## 3. 编译产物新鲜度（不得把旧 PDF 当新结果）

`/api/compile` 在 spawn 之前删除上一次生成物（`Promise.allSettled`，忽略 ENOENT）：
`<stem>.log`、`<stem>.synctex.gz`、`<stem>.aux`、`<stem>.bbl`、`<stem>.blg`、`<stem>.toc`、`<stem>.out`。
（**保留** `<stem>.pdf`：编译失败时用户仍要看上一版 PDF。）

spawn 之前先给 `<stem>.pdf` / `<stem>.synctex.gz` 拍一张**指纹快照** `artefactsBefore`，spawn 之后按「指纹相对快照有没有变」判新鲜，**不靠墙上时钟**：

- 指纹 = `fs.stat(p, { bigint: true })` 的 `${mtimeNs}-${size}`（纳秒 mtime + 字节数；浮点 `mtimeMs` 分不开同一毫秒内的两次写入，所以字段值是 `<bigint 纳秒>-<字节数>`，前端只做相等比较与 URL 版本号，不要解析）。
- `pdfAvailable`：PDF 存在且是普通文件（可能是旧版）；被取消的编译恒为 `false`。
- `pdfFresh`：快照里没有这张 PDF（本次第一次生成），或指纹与快照不同（本次真的重写了它）。被取消的编译按 `fingerprintBefore` 单独判。
- `pdfStale = Boolean(pdf) && !pdfFresh`。
- `synctexAvailable`：同样要求指纹相对快照有变化（否则 `false`，避免旧 SyncTeX 假定位）；被取消的编译恒为 `false`。
- 不用 `mtimeMs >= startedAt - ε`：两次编译可以在同一毫秒里背靠背跑完，任何容差窗口都会把上一版 PDF 说成本次结果。若文件系统只精确到秒，一次「内容变了但字节数相同、还在同一秒内」的重写会被判成 stale —— 这是安全的方向（阅读器显示的仍是同一份字节，只是不谎称是本次产物）。
- `pdfFingerprint` 即上面的指纹（取消时回落到快照值）；`pdfUrl = /api/pdf?rootFile=<rel>&v=<pdfFingerprint ?? Date.now()>`。
  （`v` 必须是**内容指纹**而不是 `Date.now()`，否则浏览器与 PDF.js 每次都全量重取。）
- 响应字段保持向后兼容：`ok, timedOut, cancelled, durationMs, output, diagnostics, pdfAvailable, pdfFresh, pdfStale, synctexAvailable, pdfFingerprint, pdfUrl`。
- 新增两个**只增不改**的字段：`diagnosticsTotal`（去重之后、截断之前的条数）与 `diagnosticsTruncated`（`diagnosticsTotal > diagnostics.length`）。
  `diagnostics` 仍然最多 100 条、**不给 warning 留配额**（爆 120 个错时 `.log` 里的 warning 被挤掉是可接受的），但截断必须由这两个字段说出来，前端日志页在列表尾部写「另有 N 条未显示」（`diagnosticsTotal - diagnostics.length`）。

`/api/compile/snippet` 同样要：同步占位、支持 token/cancel、`pdfUrl` 用 snippet PDF 指纹（拿不到再退回 `Date.now()`）。

选段的 `snippet.tex` 是**前端传来的 `source` 原样落盘**（导言区由前端 `buildSnippetPreamble()` 拼好），服务端不加任何包装、不补 `\documentclass`：日志里的行号就是这份源码的行号，`fromLine + (snippetLine - bodyStart)` 才能对上编辑器。`bodyStart` 缺省按 1 处理。

## 4. `GET | HEAD /api/pdf`、`GET | HEAD /api/asset`

新增 `sendFile(req, res, absolute, { contentType, disposition, maxBytes })`：

- `maxBytes` 超限 → 413（PDF 25MB、图片 25MB，沿用现值）。
- 响应头：`Accept-Ranges: bytes`、`ETag: "<mtimeMs round>-<size>"`、`Last-Modified`、`Cache-Control: no-cache`（**不再是 `no-store`**）。
- `If-None-Match` 命中 → 304（GET/HEAD 都要）。
- `Range: bytes=a-b`、`bytes=a-`、`bytes=-n` → 206 + `Content-Range: bytes a-b/total`；范围非法/不可满足 → 416；无法解析的 Range 头 → 退回 200 全量。
- 全量响应用 `createReadStream` 流式输出，**不得** `readFile` 整个文件进内存。
- `HEAD`：只写头，不写 body。
- 客户端断开（`res.on('close')`）→ 销毁流。
- `/api/pdf` 的 `Content-Disposition`（inline / attachment + 中文文件名）保持现有行为。

## 5. 搜索与扫描

- `searchProject`：`maxFiles` 默认 200（**`allFiles: true` 提到 2000**，客户端传更大的数一律钳到这两个上限）、`maxMatches` 默认 300（钳到 1000）、单文件最多 50 条。响应加 `truncated`（已有）与 `timedOut`。
  **正则时限不能用 `Promise.race` 糊**：同步正则在 JS 里不可中断，`Promise.race` 只是「不再等它」，事件循环仍被阻塞到它跑完，等于换个写法卡死整个服务（`/api/compile` 的回调也排在同一条队列上）。改成 **`node:worker_threads` 起一次性 worker 跑扫描，主线程 `worker.terminate()` 硬超时（1500ms）**，超时返回已得结果为空 + `timedOut: true`（**不要** 500）；worker 崩溃/超时都要保证主线程一定收到 resolve。不想引入 worker 就退而求其次：入口加嵌套量词启发式拦截（形如 `(a+)+`、`(a*)*`、`(a+)*` 一律 400「正则存在灾难性回溯风险，请简化」）并在代码注释写明它只是缓解、不是保证。
  现有匹配语义（`text` 为去缩进前缀、`start`/`length` 相对 `text`）必须保持不变，测试已断言。
- `scanReferences` / `searchProject` 的 `active` 参数**同时接受单个对象和数组** `[{ path, content }]`；前端会传多文件缓冲数组。
- `GET /api/tree` 响应加 `truncated: boolean`（命中 800 上限时 true），`files` 语义不变。
- `listFiles()`：排序只在顶层做一次（递归里不要每层 sort）；命中上限要能报 `truncated`。`scanReferences`、`searchProject`、`/api/compile` 的 `knownFiles`、`loadSyncTex` 的 `knownFiles` 走一个 **150ms、以 projectRoot 为键的短缓存**（`getFileIndex()`），并在 `/api/file` PUT/POST、`/api/upload`、`/api/template`、`/api/build/clean`、`/api/project/open|choose` 之后失效。
- `body(req, limit, { timeoutMs = 30_000 })`：超时 `fail(408, '请求超时')`；`/api/upload` 用 120_000。

## 6. 请求来源防护（已实现，勿回退）

`guardRequest(req)`：Host 白名单；带 `Origin` 必须同源；带 `Sec-Fetch-Site` 必须 ∈ {same-origin, local, none}。
不带这两个头的非浏览器客户端仍可访问（curl 调试不破）。静态文件支持 `HEAD`。
**所有测试 helper 发请求时显式带 `Origin: http://127.0.0.1:<port>` 或 `Sec-Fetch-Site: same-origin`**，并新增一条断言：`Sec-Fetch-Site: cross-site` → 403。

## 7. 前端如何消费（服务端负责人只需知道，不要改前端）

- `compile()` 不再在发请求前置 `state.compiling`；改为请求发出成功后由服务端 200/409 决定。409 时提示「已有编译任务正在进行」，静默自动编译遇 409 直接跳过。
- 结果处理：`result.cancelled → 只提示已取消，保留原 state.pdfUrl / result`；
  `result.pdfFresh && result.pdfAvailable → 切到 result.pdfUrl`；
  `result.pdfStale → 不动 state.pdfUrl`，预览标题写「上一次成功生成的 PDF」；
  `!result.pdfAvailable → state.pdfUrl = null`。
- 每次 `compile()` 生成新 token（`crypto.randomUUID()`）并带 `signal`：全文编译用 `AbortSignal.timeout(190_000)`（服务端 180s）、选段用 `AbortSignal.timeout(130_000)`（服务端 120s）。**前端不要 import 服务端模块**，这两个数字在前端顶部写成 `COMPILE_TIMEOUT_MS = 180_000` / `SNIPPET_TIMEOUT_MS = 120_000` 常量并加注释「与服务端 server/index.mjs 同名常量保持一致」。取消按钮调 `/api/compile/cancel { token }`，成功后按钮文案回到「正在取消…」。
- `sendFile` 之后前端 PDF.js 直接用 `state.pdfUrl`；开启按需分段加载（`disableAutoFetch: true`），前提是 §4 的 Range/ETag 生效。

## 9. 契约增补（2026-11-12 00:35，来自服务端审计，已完成实现复核）

### 9.1 子进程必须独立进程组（影响 §2 的取消语义）

Tectonic 会派生 `xelatex` / `xdvipdfmx` / `biber` 孙进程，`child.kill()` 只杀到直接子进程。

- `run()` 里 `spawn(command, args, { detached: true, ... })`，取消与超时一律用 `killTree(child, signal)`：
  `try { process.kill(-child.pid, signal); } catch { child.kill(signal); }`（先杀进程组，失败退回单进程）。
- SIGTERM → 5 秒后 SIGKILL 的兜底同样走 `killTree`。
- 进程退出收口：`process.on('SIGTERM')` / `('SIGINT')` / `'beforeExit'` 之外，新增 `shutdown()`：
  若有 `compileJob.child`，先 `killTree(compileJob.child, 'SIGKILL')`，再 `server.close()` 后退出。
  这样 `stop.sh` 在编译中途停服务时不会留下继续写 `.latex-tools/build/` 的孤儿引擎（Agent.md 要求无残留进程）。
- 取消端点仍然只发 SIGINT（让 TeX 尽量写出可读日志），5 秒兜底 SIGKILL。

### 9.2 错误响应不得泄漏系统细节

统一 `errorEnvelope(error)`：

- 无 `status` 的系统错误按 code 映射中文文案（`ENOENT`→「文件不存在或已被移除」、`EACCES`/`EPERM`→「没有权限访问该文件」、`EISDIR`/`ENOTDIR`→「路径类型不正确」、`EEXIST`→「文件已存在」、`ENAMETOOLONG`→「文件路径过长」），原始 message 只 `console.error`，**响应体里不得出现绝对路径、`ENOENT`、`spawn`、`realpath` 这类字样**。
- `spawn ... ENOENT` 特判为「本机未找到 Tectonic，请先安装：brew install tectonic」（status 500，仍不泄漏路径）。
- `jsonBody` 的 `catch` 必须 `if (error.status) throw error;`，否则 `body()` 的 413「文件太大」会被改写成 400「JSON 格式无效」。
- 所有 JSON 响应加 `X-Content-Type-Options: nosniff`（在 `json()` 里加即可）。

### 9.3 其它必须收口的小项

- `PUT /api/file`：**不带数值 `mtimeMs` 且没有 `force` 时拒绝（400「请先重新载入文件再保存」）**，否则等于允许绕过 Agent.md 的外部改动保护。
- `/api/search` 的上限只能收紧不能放宽：`maxFiles = Math.min(Number(input.maxFiles) || 200, allFiles ? 2000 : 400)`、`maxMatches = Math.min(..., 1000)`。
- `/api/template`：`kind` 必须 `Object.hasOwn(templates, kind)`，`constructor` / `__proto__` 一律 400（现在返回 201 却零写入）。
- `/api/compile/snippet`：诊断没有 `editorFile` 时 `file` 落到 `'snippet.tex'`，**不得返回 `file: null`**（前端 `populateFileDiagnostics` 会 `continue`，行内报错点静默失效）。
- `guardRequest` 的 `Sec-Fetch-Site` 白名单只留 `same-origin` 与 `none`（`local` 不是规范值）；注释写明「`same-site` 也被拒：本项目只从同源页面访问」。
- 编译超时常量 `COMPILE_TIMEOUT_MS` / `SNIPPET_TIMEOUT_MS` 必须真的传给 `run()`，不要再写字面量。
- `/api/asset`、`/api/pdf` 一律 `stat` 后 `createReadStream`，**先判大小再发第一个字节**（snippet 分支现在完全不校验大小）。

## 10. 测试清单（服务端负责人按此逐条建 `test()`；允许往临时目录塞一个假 `tectonic` 可执行文件并前置 `PATH`，这样用例不依赖真实 TeX）

必做：契约 §6 的 cross-site 403；`compile locks the project synchronously and releases the slot on engine spawn failure`；`compile clears stale log and synctex before the engine starts`；`cancelled compile reports no outputs`；
`compile reports stale artifacts after a failed build`（假 tectonic 第一次 exit 0 并写 `%PDF-1.4`+`.synctex.gz`，第二次 exit 1 → `ok:false`、`pdfStale:true`、`synctexAvailable:false`）；
`compile surfaces a missing tectonic binary as a readable error`（PATH 去掉 tectonic → 响应体不含 `/Users/`、`spawn`、`ENOENT`）；
`compile timeout kills the engine group and releases the compile slot`（假 tectonic `trap '' TERM; sleep 30` + 短超时 → `timedOut:true`、随后一次编译不是 409、`ps` 无残留）；
`server errors never leak absolute paths`（`GET /api/file?path=nope.tex` → 404 且 body 不匹配 `/\/(Users|private|var)\//`、`ENOENT`）；
`oversized JSON body is reported as 413`；`PUT without mtimeMs does not overwrite external edits`；
`search ignores client-supplied limits`（`maxFiles:100000` → `filesSearched<=400` 且 `truncated:true`）；
`invalid regex is reported as regex error`（`{query:'(',regex:true}` → 400「正则表达式无效」）；
`template endpoint rejects unknown and inherited kinds`（`constructor` → 400 且项目文件数不变）；
`snippet diagnostics keep a resolvable file when editorFile is omitted`；
`snippet error lines map back to the editor file`（`fromLine + (snippetLine - bodyStart)`）；
`snippet artifacts stay in _snippet and leave the source tree clean`（`/api/tree` 不含 `snippet.*`，项目根无新文件）；
`pdf endpoint serves ranges and conditional requests`（206 + `Content-Range` + 304 + HEAD + 超范围 416）；
`pdf endpoints block symlinked output`；`asset endpoint reads through project symlink is blocked`（含「非图片后缀软链到 PNG」）；
`synctex endpoints degrade without a build and clamp coordinates`（未编译 → `found:false`；`line:0/-5`、`page:NaN` 不 500）；
`static handler stays in dist`（`GET /../package.json` → 403/404、`DELETE /api/status` → 405、非法百分号编码 → 400、HEAD / → 200 无 body）；
`build clean reports partial failures instead of claiming success`；`tree reports truncation for big projects`。

夹具要求：每个用例自己的临时项目 + 一个 `createFixture({ mainTex, sections, bib, images })` 帮助函数，**不要让所有断言共享同一个可变项目**（现在第 75-96 行的写法会让新断言随顺序漂移）。

## 11. 验收


- 服务端：`npm test` 全绿，并按 lead 在任务里列的清单补用例；不得为了让用例通过而放宽边界。
- 前端：`npm run build` 必须通过（会 import 校验语法）。
- 双方都不要改 README.md / Agent.md（lead 负责），也不要 `git init` 或提交。
- 结束前把「改了哪些函数、实际跑过什么命令、结果、还有什么没做」发给 lead，不要只说「已完成」。
