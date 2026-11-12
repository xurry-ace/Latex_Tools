# Agent.md · 砚台项目接力说明

这份文件供接手本项目的开发 agent 使用。先核对仓库现状和用户本轮要求；本文记录的是项目约定，不代替当前代码或用户的新指示。

## 项目目标

- 砚台是运行在本机浏览器中的 LaTeX 写作工具，主要服务中文学术论文、毕业论文写作。
- 用户已经确定第一版主流程：打开本机项目文件夹 → 编辑并保存 → 编译 → 预览 PDF → 从错误跳回源码。
- 第一版还包括公式、表格、图片插入，通用论文模板，以及 BibTeX 条目和 `\label` 引用辅助。范围和后续方向见 [REQUIREMENTS.md](./REQUIREMENTS.md)，使用方法见 [README.md](./README.md)。
- 保持本地工具定位；没有用户要求时，不要引入账户、云端存储或发布流程。

## 接手时先做

1. 阅读 `README.md`、`REQUIREMENTS.md`、本文件，并检查当前文件与用户未提交的改动。此目录最初没有 Git 仓库；不要假定已有提交历史。
2. 按任务涉及的路径读代码，再确定改动范围。不要根据旧交接记录断言当前功能正常。
3. 检查本机 Node、Tectonic 和端口状态。不要假定上次测试服务仍在运行。
4. 用临时 LaTeX 项目验证改动；不要拿用户真实论文当测试数据，也不要把论文内容复制进仓库或日志。

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `server/index.mjs` | 只监听本机的 HTTP 服务。**请求级项目上下文**：每个请求进来时把当时的项目根放进 `AsyncLocalStorage`（`currentProjectRoot()`），中途有人 `/api/project/open` 不会让在途请求读到新根；仍是单活动项目，多标签页独立开项目仍不支持。项目文件 API（含安全子目录创建与冲突覆盖确认；**PUT 必须带数值 `mtimeMs` 或 `force`**）、跨文件文本搜索 (`/api/search`，扫描体跑在一次性 `worker_threads` 里、1.5s `terminate()` 硬超时，嵌套量词正则入口直接拒绝；未保存缓冲支持多文件数组；客户端传的上限只能收紧)、引用与全篇结构扫描 (`/api/references`，返回 `.bib` 行号、`\label`、各文件字数 `wordCounts`、递归 `\input`/`\include` 全篇大纲；文件清单走 `getFileIndex()` 的 150ms 缓存，写操作后失效)、图片资源只读预览 (`/api/asset`)、模板（`Object.hasOwn` 校验 kind）、图片上传、Tectonic 编译（`startCompile`：编译槽**同步占用**、`token` + `POST /api/compile/cancel` 取消、`run()` 以 `detached` 进程组启动、超时 SIGTERM / 取消 SIGINT、5 秒后 SIGKILL 兜底、`child.on('error')` 只 resolve、生成物按**纳秒指纹**判 `pdfFresh`/`pdfStale`，绝不把上一版 PDF 当新结果）、选段极速编译 (`/api/compile/snippet`，源码原样落盘以保行号映射)、原生 `.synctex.gz` 正反向定位、PDF 输出/下载/Finder 定位、编译缓存清理，以及 `sendFile()` 统一提供 `HEAD` / `ETag` / `If-None-Match` 304 / `Range` 206 流式输出（大 PDF 可按页取用）与 `errorEnvelope()` 的中文错误（不外泄绝对路径与系统错误码）。进程收到 SIGTERM/SIGINT 时 `shutdown()` 先杀掉在跑的引擎组再关服务。 |
| `src/main.js` | CodeMirror 编辑器（含 `\cite`/`\ref`/`\input`/`\includegraphics`/`\begin` 上下文补全、中文化查找/替换与行跳转、行内报错标记与 `⌘⇧E` 跨文件报错跳转、`⌘/` 行注释、粘贴/拖拽插图（同图内容去重）、多文件会话与撤销栈保留（`setDoc` 走 `EditorState.create({oldState})` 保历史）、外部修改冲突恢复（**按内容比对**而非只比 mtime）、自动保存与保存即编译（`saveFile` 发请求前取快照 + `saveInFlight` 去重 + 回写前判活）、字号调节、单文件与全篇总字数（`statsCache` 按「文件 + doc 版本」缓存，光标移动不重跑全文正则）、最近打开项目记录（localStorage 读失败不清空内存副本）、左侧文件树（可折叠子目录、文件名过滤、一键设为主文件、报错点提示）与全篇/当前文件大纲切换、`⌘P` 快速跳转面板、`⌘⇧F` 跨文件搜索弹窗、可拖拽分栏（宽度持久化）、双向 SyncTeX 定位（`⌘J` 源码→PDF 高亮 + 双击 PDF→源码精准跳转 + 带缓存/并发上限的文本回退）、`⌘L` 选段极速预览、PDF.js 连续/单页预览（`loadPdf` 代际令牌 + 旧文档 `destroy()` + `disableAutoFetch` 分段加载 + `PDF_MAX_LIVE_CANVASES` 离屏画布回收）、编译握手（token / `AbortSignal.timeout` / 409 / `cancelled` / `pdfFresh`·`pdfStale` 决定换不换 URL / 独立「■ 取消编译」按钮）、分类数学符号库、Excel/TSV/CSV/Markdown 粘贴建表、BibTeX 模板新建与定义处跳转、窄窗口「…」溢出菜单、`window` 未捕获异常提示。 |
| `src/style.css` | 桌面与窄窗口布局、CodeMirror 查找/诊断面板样式、可拖拽分栏、快速跳转与组件样式。 |
| `test/api.test.mjs` | **33 个用例 / 6 个 describe**（请求防护、项目文件与资源、搜索与引用、模板、编译契约、诊断解析）。用 `before` 起一次服务、每个用例 `createFixture()` 建独立临时项目；需要「已编译产物」的用例往临时 `bin/` 塞**假 `tectonic`** 并前置 `PATH`（`barePath`，不会回落到机器上真 Tectonic），所以 `npm test` **不依赖 TeX**，约 12–17 秒。覆盖目录边界、符号链接防逃逸、条件请求与 Range、跨站拒绝、错误不泄漏路径、编译锁/取消/超时/进程组、产物新鲜度、选段行号映射与源码目录零污染、清理与截断标记。 |
| `scripts/e2e-compile.mjs` | `npm run test:e2e`：**真实 Tectonic** 的端到端验证（多文件中文夹具：全文编译、Range/ETag/304/416、SyncTeX 子文件正反向、失败编译 fresh/stale、取消与编译槽释放、选段与源码目录零污染、搜索钳制与正则硬超时、越界与泄漏、清理、端口释放与孤儿引擎检查）。没装 Tectonic 时自动跳过。**只在 `os.tmpdir()` 建项目，绝不用用户论文**；脚本自己起服务、自己收尾并核对端口与进程。 |
| `scripts/smoke-ui.mjs` | `npm run test:ui`：真实 headless Chrome（可用 `CHROME=` 覆盖路径）里的前端冒烟。自己**在随机端口**起服务（绝不复用用户的 3210）、在 `os.tmpdir()` 建夹具，检查取消按钮状态机、PDF 画布预算与离屏回收、反查、外部修改同步、编译失败保留上一版 + stale 标注、诊断截断提示、大文件打字延迟、未捕获异常，最后在 `finally` 里自证进程退出、端口可重新绑定、临时目录已删。找不到 Chrome 时打印说明并以 0 退出（不能把「没浏览器」当成失败）。 |
| `index.html`、`package.json` | Vite 入口与运行脚本；`dist/` 是生成物。 |
| `start.sh`、`启动砚台.command`、`stop.sh`、`停止砚台.command`、`scripts/service-process.sh` | 一键启动/停止；共用端口与进程归属检查，只复用或停止当前仓库的服务。停止支持 Finder 双击、终端 Control+C 或 `PORT=端口 ./stop.sh`。 |
| `scripts/preview-shot.mjs` | `node scripts/preview-shot.mjs [--out 路径]`：重新生成 README 顶部的 `docs/preview.png`。随机端口起服务、`os.tmpdir()` 里造一篇**纯虚构**的演示论文（ctexart + `\input` 两章 + 一个公式，绝不用用户的真论文）、headless Chrome 走 CDP 打开项目→编译→切到 `sections/method.tex`→等提示条消失→`Page.captureScreenshot`（2x 视网膜图），`finally` 里同样自证进程与临时目录已清。**这个截图必须由眼睛验收**：写它的 agent 没有图像输入，只能做「暗像素占比」这类结构检查（见已知问题 1）。 |
| `docs/round-2026-11-12-contract.md` | 2026-11-12 那轮的接口契约，现已冻结为**决策记录**（为什么取消用 SIGINT、超时用 SIGTERM，为什么新鲜度不能用 `mtime >= 开始时间 - ε`，为什么搜索的正则超时不能用 `Promise.race`）。**以代码为准**；要改这些语义先改本文件再改代码。 |
| `docs/preview.png` | README 顶部的界面截图，2026-11-12 由 `scripts/preview-shot.mjs` 重新生成（图里是脚本自造的演示论文，不是用户的文档）。 |

服务端目前一次只保存一个活动项目目录（请求级快照见 `currentProjectRoot()`）；浏览器用 `localStorage` 记住上次打开的路径。不要在未设计项目隔离的情况下假设多个标签页能独立操作不同项目。

编译类接口约定：编译槽同一时刻只允许一个任务（全文与选段共用），`/api/compile` 与 `/api/compile/snippet` 都在第一个 `await` 之前同步占位，`/api/build/clean` 与主文件切换在编译中会被拒。前端每次编译带一个 `token`，取消走 `POST /api/compile/cancel {token}`；引擎以独立进程组启动，取消只发 SIGINT（TeX 的「按 `X` 收尾」路径），超时用 SIGTERM——**不要**把两者互换或改成无参 `child.kill()`。生成物新鲜度靠 spawn 前后对比 `mtimeNs-size` 指纹判定，**不要**退回 `mtime >= 开始时间 - ε`（背靠背两次编译会把上一版说成本次结果）。编译时限可用 `YANTAI_COMPILE_TIMEOUT_MS` / `YANTAI_SNIPPET_TIMEOUT_MS` 调短，测试与手工验超时路径就靠它，不必真等三分钟；但它是**双向契约**——前端写死的 `AbortSignal.timeout(180_000 + 10_000)` 必须始终大于服务端时限，把服务端调大到 180s 以上会让前端先断开并且编译槽一直被占。

## 改动时必须守住的边界

- 服务仅监听 `127.0.0.1`，并检查 Host / Origin / `Sec-Fetch-Site`（`guardRequest`）。**Origin 与 `Sec-Fetch-Site` 都不存在的请求仍然放行**，这是给 curl 和命令行调试留的口子；浏览器一定会带 `Sec-Fetch-Site`，所以跨站读 `/api/file` 会被挡。不要为了「测试方便」把这条放宽成只查 Host。
- 所有读写仍需受当前项目根目录、允许的文件类型和 `realpath` 检查约束；符号链接不能绕过目录边界。
- 保存已有文件时保留磁盘修改时间冲突检测，避免覆盖其他编辑器刚写入的内容。模板不能覆盖同名文件。
- 编译命令使用参数数组执行，不拼接 shell 字符串；生成物留在项目的 `.latex-tools/build/`。只有用户明确触发保存、建文件、模板或图片导入时才改写源项目。
- 编译失败时保留原始日志，尽可能提供可点击的文件与行号。不能把旧 PDF 当成新编译成功结果：新增字段时**不要**改 `pdfFresh` / `pdfStale` / `pdfFingerprint` 的语义，前端靠它们决定要不要换预览地址，`pdfStale` 时前端会保留手里的旧文档重绘。
- 编译失败时**不要**为了「干净」删掉上一版 PDF 或半截 PDF：保留上一版可续读、半截 PDF 是本次真实输出，两种情况都靠 `pdfFresh` 如实标注。
- `state.compiling` / 服务端编译槽只是**并发闸门**，不是动画计时器；前端 `request()` 默认 15s 超时但**引用扫描与搜索是 30s、编译 190s、上传 120s**（扫描 200 个文件可能超过默认值），新增长耗时接口时记得单独放行。

## 验证与交接

常规检查：

```bash
npm test          # API 契约测试，33 例 / 约 15s，不依赖 TeX
npm run build     # Vite 生产构建
npm run test:e2e  # 真实 Tectonic 端到端（无 Tectonic 时自动跳过）
npm run test:ui   # 真实 Chrome 的 UI 冒烟（无 Chrome 时自动跳过；随机端口，绝不占用 3210）

node scripts/preview-shot.mjs   # 界面改了之后重新生成 README 顶部的 docs/preview.png（不是校验，别当测试跑）
```

涉及 UI 或编译链时，除了上面几条，再运行 `npm start`，用临时项目走一遍编辑、保存、编译、预览和报错定位。Tectonic 首次获取宏包可能耗时；`npm test` 本身不依赖 TeX 编译，改动时**不要**让它变成依赖。测试完关闭自己启动的服务。

用户明确要求不要留下 agent 启动的服务：启动测试进程时记录 PID 和端口，在 `finally` / trap 中清理；结束前核对进程已退出且监听端口已释放。不要自动重启或保留服务让用户自行收尾。用户自己启动的进程不能冒充测试进程清理；本轮用户明确要求停止的遗留服务除外。

给下一个 agent 的交接信息应写清：本次目标与已完成项、改动文件、实际运行的检查及结果、仍存在的问题和可复现步骤、下一步建议。不要写“已验证”而没有对应的命令或操作记录。

## 当前已知范围

- 已集成 Tectonic（含 `--synctex`）与 BibTeX。`biber`、`latexmk`、学校指定编译脚本、特殊 shell-escape 需求尚未作为通用编译配置支持。
- 已实现跨文件搜索（`/api/search` + `⌘⇧F`）、快速跳转（`⌘P`）、原生 `.synctex.gz` 双向精准定位（`⌘J` 源码→PDF 高亮、双击 PDF→源码，无 SyncTeX 记录时回退到文本近似匹配）以及选段极速预览（`⌘L`）。学校专属毕业论文模板、自定义编译链等仍列在需求文档的后续迭代中；实现前应以用户的实际模板和工作流重新确认优先级。
- 编译**可以取消**（`■ 取消编译` → `POST /api/compile/cancel`），但取消是发信号给引擎，已写出的半截 PDF 不归位、也不报成成功结果。
- 同一时刻只跑一个编译任务（全文与选段共用一个槽）；服务端**不做多项目并发**，多标签页各开一个项目的场景仍然不支持。
- 文件树上限 800 个文件、搜索默认 200 文件 / 300 条（超出会提示，客户端参数只能收紧不能放宽）；`⌘⇧F` 没有「搜索全部文件」的开关，服务端支持 `allFiles`（上限 2000）但 UI 暂未接。
- 前端 `src/main.js` 仍是单文件、无框架、无前端测试框架；UI 回归靠 `npm run test:ui`（缺 Chrome 时跳过），不要指望它替代手工验证。

## 最近交接：2026-11-12 编译链路正确性 + 大文档性能 + 越界防护

本轮由两个 agent 并行改服务端与前端，lead 复核契约、复跑全部验证。**接口字段只增不删**，前后端契约写死在代码注释与本文件。

- 目标与完成项：
  1. **编译链路正确性**：编译槽改为同步占用（原来在三个 `await` 之后才置标志，两个请求可在同一 outdir 并跑两个 Tectonic）；新增 `POST /api/compile/cancel` + 每次编译一个 `token`，前端有「■ 取消编译」按钮；生成物按 spawn 前后**纳秒指纹**判 `pdfFresh` / `pdfStale`，失败或取消不再把上一版 PDF、上一份 `.log`、上一份 `.synctex.gz` 当成本次结果；`run()` 改 `detached` 进程组（取消 SIGINT / 超时 SIGTERM / 5 秒 SIGKILL 兜底），`child.on('error')` 只 resolve，编译槽在任何失败下都必定释放；服务收到 SIGTERM/SIGINT 时 `shutdown()` 先收引擎进程组。
  2. **大文档性能**：`/api/pdf`、`/api/asset` 走 `sendFile()` 流式输出，带 `ETag` / `If-None-Match` 304 / `Range` 206 / 416，PDF.js 开 `disableAutoFetch` → 几十页的论文不必整份下载才出第一页；PDF 预览有画布预算（`PDF_MAX_LIVE_CANVASES`，离屏页回收、当前页必留）与旧文档 `destroy()`；编辑器输入路径去掉全量重算（`statsCache` 按「文件 + doc 版本」缓存、大纲高亮同行提前返回、`updateOutline` 仅在大纲页解析）；搜索扫描搬进一次性 `worker_threads` + 1.5s `terminate()` 硬超时（同步正则不可中断，`Promise.race` 那种「超时」是假超时，会把整个服务连编译一起卡死）。
  3. **越界与健壮性**：`guardRequest` 加 `Sec-Fetch-Site`（原来无 `Origin` 的跨站 `<img>` / 顶层导航可读 `/api/file`、`/api/pdf`、`/api/asset`）；`/api/asset` 的扩展名检查改为先于读取、符号链接文件一律拒绝；`safeBuildSubdir` / 读侧 `buildSubdirForRead` 逐层 `lstat`，`.latex-tools/build` 整体软链不再被跟随；`/api/template` 用 `Object.hasOwn`（此前 `kind:'constructor'` 返回 201 却零写入）；`PUT /api/file` 必须带数值 `mtimeMs` 或 `force`（此前不传即可绕过外部改动保护）；`errorEnvelope` 把系统错误码翻成中文、不再外泄绝对路径与 `spawn ENOENT`；`jsonBody` 不再把 413 改写成 400；`body()` 加超时；搜索上限只能收紧；`/api/tree` 命中 800 上限返回 `truncated`；诊断去重改用归一化消息（同一错误不再显示两条）、`diagnosticsTotal` / `diagnosticsTruncated` 让「另有 N 条未显示」成为可能。
  4. **前端健壮性**：`saveFile` 发请求前取快照 + `saveInFlight` 去重 + 回写前判活（修掉「打字期间自动保存返回把文档标成已保存 → 切文件静默丢字」）；`setDoc` 走 `EditorState.create({oldState})` 保撤销栈/光标/滚动，外部同步改为**按内容**比对（iCloud 换 inode 不再清空撤销栈）；`openFile` 加请求令牌（快速切文件不再出现「屏幕是 A、`state.activeFile` 是 B」）；`request()` 统一超时（引用/搜索 30s、上传 120s、编译 190s）；PDF 双击反查的文件读取加缓存 + 并发上限（原来每个候选 × 每个 tex 各发一次请求）；图片粘贴按内容去重；分栏拖拽持久化；搜索结果分成「命中 N 处 / 确实扫完零结果 / 没扫完（超时或超 200 文件上限）」三档文案——原来只要没匹配就写「没有找到匹配内容。」，1.5 秒没扫完的大项目会被谎报成「这个词不存在」（src/main.js:3271-3287）；诊断面板按 `diagnosticsTotal` 显示「另有 N 条未显示」；用户一旦自己滚轮/按下就立刻结束 `⌘J` 程序滚动的 700ms 宽限（src/main.js:3813-3815），页码不再跟用户抢；409 编译冲突直接念服务端 `errorEnvelope` 的话。
- 改动文件：`server/index.mjs`、`src/main.js`、`src/style.css`、`test/api.test.mjs`、`scripts/e2e-compile.mjs`（新）、`scripts/smoke-ui.mjs`（新）、`scripts/preview-shot.mjs`（新）、`docs/round-2026-11-12-contract.md`（新，冻结为决策记录）、`docs/preview.png`（重截）、`package.json`（新增 `test:e2e` / `test:ui`）、`README.md`、`Agent.md`。
- 实际运行的验证与结果（lead 亲自复跑，不是转述）：
  - `npm test` → **33 通过 / 6 suites / 0 失败**，约 12–17s。测试从 193 行的单个巨型用例重写为 6 个 `describe`，夹具改为每用例独立临时项目 + `createFixture()`；需要「已编译产物」的用例用临时 `bin/` 里的**假 tectonic**（`barePath` 防止回落到真引擎），所以仍不依赖 TeX。新增覆盖：编译锁与引擎启动失败释放、取消、超时杀进程组、SIGTERM 不产孤儿、产物新鲜度、Range/ETag/416、跨站拒绝、错误不泄漏路径、413 不被改写、PUT 缺 `mtimeMs`、搜索钳制与正则硬超时、模板原型链、选段行号映射与源码目录零污染、清理失败不谎报、树截断、`diagnosticList` 全套解析（TeX 文件栈 / BibTeX 行号 / `.log` 警告 / 中文 hint / 去重 / 100 条上限）。
  - `npm run build` → 通过（`dist/assets/index-*.js` 958KB / gzip 300KB + PDF.js worker 1.27MB，主包偏大，见「下一步」③）。
  - `npm run test:e2e`（新）→ **全绿**：`os.tmpdir()` 下多文件中文项目 + **真实 Tectonic 0.17**，走通全文编译（ctexart + BibTeX + `\input` 子文件 + 图片）、PDF 的 HEAD/304/206/416、SyncTeX 子文件正反向、失败编译的 fresh/stale、取消编译并确认编译槽释放、选段编译与报错行号映射、源码目录零污染、搜索超时与钳制、跨站 403、错误不泄漏绝对路径、清理后端口释放与无孤儿引擎进程。
  - `npm run test:ui`（新）→ **38 通过 / 0 失败，退出码 0**（lead 亲自复跑一次，client-eng 连跑两次一致）。真实 headless Chrome（`CHROME=` 可覆盖），自己随机端口起服务（撞上 3210 直接跳过，绝不复用用户端口），覆盖：取消按钮状态机、14 页 PDF 的画布预算（在屏 8 张 = `PDF_MAX_LIVE_CANVASES`）与「当前页必有画布」、PDF 双击反查（精准定位到 `main.tex` 第 50 行）、外部修改自动同步、编译失败保留上一版并标 `data-stale="1"` /「上一次成功生成的 PDF」、诊断洪水（560 条 Overfull）截断到 100 条 + 「另有 N 条未显示」自洽断言、取消编译后页码/页数/stale 全部不变、**195KB（200 100 字节）正文里连打 10 个字后页脚字数 10–26ms 更新**（改动前这条路径每次按键和每次光标移动都重跑全文正则；量出来的字节数取脚本写入夹具时的 `Buffer.byteLength`，**不要**数 `.cm-content` 的文本——CodeMirror 只渲染视口内的行，只能数到一千多字符）、搜索三档文案（命中 / 确实零结果 / 没扫完）、悬空 Promise 会提示、无未捕获异常与 console.error。`finally` 里自证：服务进程 exit=0、浏览器 exit=0、两个端口可重新绑定、临时目录已删。没装 Chrome 时打印说明并 exit 0。
  - 截图：`node scripts/preview-shot.mjs` 生成 `docs/preview.png`（3024×1900，脚本自证服务与浏览器 exit=0、端口已释放、临时目录已删）。**这张图没有经过人眼验收**，见上面已知问题 1。
  - 收尾核对：`pgrep -fl server/index.mjs`、`pgrep -fl tectonic` 均空；3210 无监听；各 agent 自启的测试服务与临时目录各自在 `finally` 中清理并核对端口释放；**未触碰用户自己的进程**。
- 已知问题与本轮故意没做：
  1. `docs/preview.png` 已在 2026-11-12 用 `scripts/preview-shot.mjs` 重截（不再是 11-07 的旧界面），**但没有人眼看过它**：本轮所有 agent 都没有图像输入，只能用「顶栏/左栏/中栏/右栏各自的暗像素占比 5.6% / 0.5% / 2.2% / 2.6%」这类结构指标证明「不是白屏、PDF 那一栏确实排出了字」。构图好不好看、有没有叠住东西，请用户打开看一眼，不满意就 `node scripts/preview-shot.mjs` 重跑。
  2. **每次保存都会重扫一遍全项目**：未保存缓冲本身没问题（切文件前 `openFile` 先 `saveFile()`，内存里真正未保存的只有当前文件那一份，`collectDirtyBuffers()`（src/main.js:3092）已把它连同各会话一起放进 `/api/references` 的 `active` 数组）；开销在服务端：每次保存 250ms 后重跑一次全项目扫描（`scheduleReferences(250)`），只有 150ms 文件清单缓存、没有按文件指纹缓存 `wordCounts` / `\label`，上百文件的项目里「保存即编译」会连着触发一次全量读盘。
  3. 取消编译没有二次确认，也不会回滚已写出的半截 PDF（`pdfFresh` 会如实标注）。
  4. PDF 画布预算在 headless Chrome 里能数到画布张数（8 张封顶、当前页保留），但**像素级观感**（回收时有没有白屏闪烁、stale 横幅好不好认、窄窗口「…」菜单收全了没有）仍需要用户拿 100+ 页真实论文手测。
  5. 冲突条三分支、iCloud 并发写、编译中途切项目、图片 413 提示未自动化。
- 下一步建议（按价值排序）：① `/api/references` 按文件指纹缓存 `wordCounts` / `\label`（现在每次保存都重扫全项目，`renderTree()` 也是整棵重画）；② 冲突条三分支 / 图片 413 文案的自动化（`npm run test:ui` 里加两条即可）；③ 主包 958KB（gzip 300KB）几乎全是 PDF.js，改 `import()` 动态加载能明显加快首屏；④ 用户真实模板若用 `biber` / 学校 `.cls` 脚本，再扩展编译引擎选项（保持参数数组执行与 `.latex-tools/build/` 隔离）；⑤ `renderTree()` 目前每次保存整棵重画，配合 ① 一起做增量。

## 历史交接：2026-11-11 写作与预览全链路体验优化

- 目标与完成项：
  1. 修复并补全编辑器行内编译诊断链路（`populateFileDiagnostics` + 文件树错误提示点 + `⌘⇧E` 跨文件报错跳转 + 常见 LaTeX/BibTeX 错误中文排错提示 `diagnosticHint`）以及未变更 PDF 重编译不闪屏保留（`keepPdf`）。
  2. 新增原生 `.synctex.gz` 解析与双向 SyncTeX 定位（`/api/synctex/forward`、`/api/synctex/reverse`、`⌘J` 正向滚动高亮、双击 PDF 反向精准跳转子文件行号）。
  3. 打通选段极速预览（`/api/compile/snippet`、`/api/pdf?snippet=1`、`⌘L` / `⌘+双击`，支持多文件项目自动继承主文件导言区与相对路径图片，生成物严格限制在 `.latex-tools/build/_snippet/`，可一键切回全文 PDF）。
  4. 新增 `⌘P` 快速切换文件/章节面板、最近打开项目列表、全篇递归大纲（`\input`/`\include`）与全篇总字数统计、文件夹折叠与文件名过滤、一键设为主文件、中文化编辑器查找/替换与行号跳转、字号缩放（`A-`/`A+`）、分类数学符号库、Excel/Numbers/CSV/Markdown 粘贴生成三线表、BibTeX 条目模板创建与引用定义处跳转。
- 改动文件：`server/index.mjs`、`src/main.js`、`src/style.css`、`test/api.test.mjs`、`README.md`、`Agent.md`。
- 实际运行的验证与结果：
  - `npm test`：通过（含目录防逃逸、外部冲突保护、未保存缓冲搜索、全篇大纲与字数、SyncTeX 正反向坐标解析与外部路径过滤、Origin 校验及 `.latex-tools/build` 符号链接防逃逸）。
  - `npm run build`：Vite 生产构建通过，更新 `dist/`。
  - 临时端口端到端编译验证：使用 `os.tmpdir()` 下的多文件临时项目（含 `main.tex`、`sections/exp.tex`、`references.bib`、上传图片）在临时端口启动 `node server/index.mjs`，实测静态产物访问、Tectonic 全文编译、`.synctex.gz` 子文件正反向定位、选段极速编译与源码目录零污染、选段报错行号映射与中文提示全部通过；测试服务已在 `finally` 中 `SIGTERM` 退出并验证端口释放，最终核对 `ps` 与 `lsof` 无遗留进程或 3210 监听。
- 后续建议：若用户的真实毕业论文使用 `biber` / `biblatex` 或学校自定义 `.cls` 编译脚本，可在保持参数数组安全执行与 `.latex-tools/build/` 隔离的前提下按需扩展编译引擎选项。
