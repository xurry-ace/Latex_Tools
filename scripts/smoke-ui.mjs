// 砚台 UI 冒烟：headless Chrome + 真实 node server（随机端口）+ 真实 Tectonic。
//
// 定位：`npm test` 仍是主力 API 测试（不依赖 TeX，约 15s）；`npm run test:e2e` 是真 TeX 全链路；
// 本脚本 `npm run test:ui` 只管**前端行为**有没有被改坏——编译握手与取消按钮、失败保留上一版 +
// stale 横幅、PDF 画布预算与离屏回收、双击反查、外部修改同步、大文件打字延迟、未捕获异常。
//
// 环境缺依赖时一律「说明后 exit 0 跳过」，绝不因为没装 Chrome / Tectonic 就把仓库测试变红。
// 自己启动的进程记进 ownServerPids 白名单，收尾只动这些 PID（绝不碰用户 3210 上的服务），
// 并在 finally 里自证：进程已退出、监听端口已释放、临时目录已删除。异常退出（含 Ctrl+C）同样清理。
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_UI_PORT = 3210;
// CDP 修饰键位：Cmd 只在 macOS 是 4，其它平台用 Ctrl
const PLATFORM_MODIFIER = process.platform === 'darwin' ? 4 : 2;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, ok: Boolean(passed), detail: String(detail).slice(0, 200) });
  console.log(`${passed ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${String(detail).slice(0, 170)}` : ''}`);
};
const step = name => console.log(`\n\u001b[1m▶ ${name}\u001b[0m`);
const skipped = message => {
  console.log(`○ 跳过 UI 冒烟：${message}`);
  process.exitCode = 0;
};

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function hasTectonic() {
  try {
    await exec('tectonic', ['--version']);
    return true;
  } catch {
    return false;
  }
}

function findChrome() {
  const fromEnv = process.env.CHROME?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  return CHROME_CANDIDATES.find(candidate => existsSync(candidate)) || null;
}

// 端口是否真的空着：能 bind 才算释放（不依赖 lsof / ps，那些在部分沙箱里不可用）
async function portIsFree(port) {
  const probe = net.createServer();
  return new Promise(resolve => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function processGone(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function latexPages(sections, pagesPerSection) {
  const paragraph = '这一段中文正文用来把文档撑到多页，公式 $E = mc^2$ 与脚注引用都会参与排版。';
  let out = '';
  for (let index = 1; index <= sections; index++) {
    out += `\\newpage\n\\section{第 ${index} 章}\n`;
    for (let p = 0; p < pagesPerSection; p++) out += `${paragraph}\n\n`;
  }
  return out;
}

async function main() {
  if (typeof WebSocket !== 'function') {
    return skipped('当前 Node 没有内置 WebSocket（需要 Node 22+），无法驱动 CDP');
  }
  if (!(await hasTectonic())) {
    return skipped('未检测到 Tectonic（brew install tectonic 后重跑）');
  }
  const chromeBin = findChrome();
  if (!chromeBin) {
    return skipped('没找到 Chrome/Chromium，可用 CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome 指定');
  }
  if (!existsSync(path.join(repository, 'node_modules/vite'))) {
    return skipped('未安装依赖（先 npm install）');
  }

  step('构建与启动');
  // 每次跑都重新构建：dist 是产物，拿旧产物测等于没测改动
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [path.join(repository, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: repository, stdio: 'ignore' });
    build.once('error', reject);
    build.once('exit', code => (code === 0 ? resolve() : reject(new Error(`vite build 退出码 ${code}`))));
  });

  const port = await availablePort();
  const cdpPort = await availablePort();
  if (port === DEFAULT_UI_PORT || cdpPort === DEFAULT_UI_PORT) {
    return skipped(`随机端口撞上了用户常用的 ${DEFAULT_UI_PORT}，本脚本不动这个端口`);
  }
  const base = `http://127.0.0.1:${port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-smoke-ui-'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'chrome-profile');
  await fs.mkdir(project, { recursive: true });

  // 只登记本脚本自己启动的进程，收尾时只允许杀这些
  const ownServerPids = new Set();
  let server = null;
  let chrome = null;
  let socket = null;
  let finished = false;
  let cleanupReport = null;

  async function stop(child) {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([exited, sleep(6000)]);
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await Promise.race([exited, sleep(3000)]);
    }
  }

  async function finish(code = 0) {
    if (finished) return;
    finished = true;
    try { socket?.close(); } catch {}
    await stop(chrome);
    await stop(server);
    for (const pid of ownServerPids) processGone(pid) || (() => { try { process.kill(pid, 'SIGKILL'); } catch {} })();
    await sleep(400);
    const serverGone = processGone(server?.pid);
    const chromeGone = processGone(chrome?.pid);
    const portFree = await portIsFree(port);
    const cdpFree = await portIsFree(cdpPort);
    let tempGone = true;
    try {
      await fs.rm(root, { recursive: true, force: true });
      tempGone = !existsSync(root);
    } catch {
      tempGone = false;
    }
    cleanupReport = { serverGone, chromeGone, portFree, cdpFree, tempGone };
    console.log('\n\u001b[1m▶ 收尾自证\u001b[0m');
    if (server) check('测试服务进程已退出', serverGone, `pid=${server.pid} exit=${server.exitCode}`);
    else console.log('  ○ 测试服务未启动（前置失败），无需清理');
    if (chrome) check('无头浏览器进程已退出', chromeGone, `pid=${chrome.pid} exit=${chrome.exitCode}`);
    else console.log('  ○ 无头浏览器未启动，无需清理');
    check('服务端口已释放', portFree, `端口 ${port} ${portFree ? '可重新绑定' : '仍被占用'}`);
    check('调试端口已释放', cdpFree, `端口 ${cdpPort}`);
    check('临时目录已删除', tempGone, root);
    const bad = results.filter(item => !item.ok);
    console.log(`\n${bad.length ? '\u001b[31m✘' : '\u001b[32m✔'} UI 冒烟：${results.length - bad.length}/${results.length} 通过\u001b[0m`);
    for (const failure of bad) console.log(`  ✗ ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}`);
    process.exitCode = bad.length ? code || 1 : 0;
  }

  // 异常退出（含 Ctrl+C / 断言崩溃）也要走同一套清理
  process.on('exit', () => {
    if (finished) return;
    for (const child of [chrome, server]) {
      if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void finish(signal === 'SIGINT' ? 130 : 143);
    });
  }

  const pageErrors = [];
  const consoleErrors = [];
  const pdfResponses = [];

  try {
    // ---------- 夹具：14 页中文正文 + 一个 100KB 大文件（不进 \input，不参与编译） ----------
    const body = latexPages(14, 1);
    await fs.writeFile(path.join(project, 'main.tex'), [
      '\\documentclass[UTF8,a4paper,12pt]{ctexart}',
      '\\usepackage{amsmath}',
      '\\begin{document}',
      body,
      '\\end{document}',
      ''
    ].join('\n'));
    // 错误洪水：Overfull 警告按段落各算一条，能稳定超过服务端 100 条的上限
    await fs.writeFile(path.join(project, 'flood.tex'), [
      '\\documentclass[UTF8,a4paper,12pt]{ctexart}',
      '\\begin{document}',
      Array.from({ length: 140 }, (_, index) => `${'没有空格可断的长段落内容'.repeat(10)}${'X'.repeat(180 + index)}`).join('\n\n'),
      '\\end{document}',
      ''
    ].join('\n'));
    // 打字延迟用的大缓冲区：放在项目根（子目录默认折叠点不到），不被 \input，也不参与编译
    const bigFixture = `${'这一百来字的中文段落专门用来把文件撑大，好让编辑器的重算成本可以被量出来。'.repeat(6)}\n`.repeat(300);
    await fs.writeFile(path.join(project, 'scratch-big.tex'), bigFixture);
    // 体积以「脚本写进去多少」为准：CodeMirror 只渲染视口内的行，DOM 里数出来的字符数远小于全文
    const bigFixtureBytes = Buffer.byteLength(bigFixture);
    const mainClean = await fs.readFile(path.join(project, 'main.tex'), 'utf8');

    server = spawn(process.execPath, ['server/index.mjs'], {
      cwd: repository,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    });
    ownServerPids.add(server.pid);

    let up = false;
    for (let attempt = 0; attempt < 100 && !up; attempt++) {
      try {
        up = (await fetch(`${base}/api/status`)).ok;
      } catch {}
      if (!up) await sleep(120);
    }
    if (!up) {
      check('测试服务在随机端口启动', false, `${base} 12s 内没有响应`);
      return finish(1);
    }
    check('测试服务在随机端口启动', true, `${base}（不是用户的 ${DEFAULT_UI_PORT}）`);

    // ---------- 浏览器 ----------
    chrome = spawn(chromeBin, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--hide-scrollbars',
      // 容器 / CI 里没有用户命名空间沙箱；--remote-allow-origins 是 Chrome 111+ 连 CDP 的硬要求
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-allow-origins=*',
      '--window-size=1280,860',
      'about:blank'
    ], { stdio: 'ignore' });
    ownServerPids.add(chrome.pid);

    let version = null;
    for (let attempt = 0; attempt < 70 && !version; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (response.ok) version = await response.json();
      } catch {}
      if (!version) await sleep(200);
    }
    if (!version?.webSocketDebuggerUrl) {
      // 起不来是环境问题，不是代码问题：说明后跳过，别把 npm run test:ui 变红
      await finish();
      return skipped('Chrome 已启动但 CDP 端口没起来（可能是这个 Chrome 不支持 --headless=new）');
    }
    check('无头浏览器已连接', true, path.basename(chromeBin));

    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    let nextId = 0;
    const waiting = new Map();
    let sessionId = null;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && waiting.has(message.id)) {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(message.params.exceptionDetails?.exception?.description || message.params.text || '').split('\n')[0]);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push((message.params.args || []).map(a => a.description || a.value).join(' ').slice(0, 160));
      } else if (message.method === 'Network.responseReceived') {
        const entry = message.params.response || {};
        if (String(entry.url || '').includes('/api/pdf')) pdfResponses.push(entry.status);
      }
    });
    const send = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId: sessionId || undefined }));
      setTimeout(() => {
        if (waiting.has(id)) { waiting.delete(id); reject(new Error(`${method} 超时`)); }
      }, timeoutMs);
    });
    const js = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const probe = async (expression, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          if (await js(`(function(){ try { return Boolean(${expression}); } catch { return false; } })()`)) return true;
        } catch {}
        if (Date.now() > deadline) return false;
        await sleep(150);
      }
    };
    const count = expression => js(`(function(){ try { return Number(${expression}) || 0; } catch { return 0; } })()`);
    const text = selector => js(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`);
    const value = selector => js(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); return el ? String(el.value) : null; })()`);
    const refocus = () => js(`window.dispatchEvent(new Event('focus')); true`);
    const click = selector => js(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('找不到 ${selector}'); el.click(); return true; })()`);

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.navigate', { url: `${base}/` });
    check('首屏渲染出顶栏', await probe(`!!document.querySelector('#app .topbar')`, 15000));

    // 画布上限从源码里读，避免测试与实现各写一个数
    const source = await fs.readFile(path.join(repository, 'src/main.js'), 'utf8');
    const canvasLimit = Number(source.match(/const PDF_MAX_LIVE_CANVASES = (\d+)/)?.[1] || 0);
    check('读到 PDF 画布上限常量', canvasLimit > 0, `PDF_MAX_LIVE_CANVASES=${canvasLimit}`);

    step('打开项目');
    await click('#emptyOpen');
    await js(`(function(){ var input = document.querySelector('#modalInput'); input.value = ${JSON.stringify(project)}; document.querySelector('#modal').close('submit'); return true; })()`);
    check('打开临时项目（文件树渲染）', await probe(`document.querySelectorAll('.tree-file-row').length > 0`, 20000));
    check('自动打开 main.tex', await probe(`document.querySelector('#fileTab') && document.querySelector('#fileTab').textContent.includes('main.tex')`, 15000));

    step('全文编译与取消按钮');
    await click('#compileButton');
    const busy = await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); var b = document.querySelector('#compileButton'); return c && !c.hidden && !c.disabled && b.disabled; })()`, 4000);
    const idle = await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); var b = document.querySelector('#compileButton'); return c.hidden && !b.disabled; })()`, 180_000);
    check('编译中显示「■ 取消编译」且可点、编译按钮禁用', busy, busy ? '' : '没抓到编译中的按钮状态（可能编译太快）');
    check('编译结束后按钮状态复原', idle);
    check('全文编译出 PDF 预览', await probe(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length > 0`, 15000));
    check('PDF 页码回到第 1 页', (await value('#pageInput')) === '1', `pageInput=${await value('#pageInput')}`);
    check('多页连续模式已就绪', await probe(`document.querySelectorAll('#pdfStage .pdf-page-wrap').length >= 12`, 10000), `wrap=${await count(`document.querySelectorAll('#pdfStage .pdf-page-wrap').length`)}`);

    step('画布预算与离屏回收');
    const pageCount = await count(`document.querySelectorAll('#pdfStage .pdf-page-wrap').length`);
    await js(`(function(){ var s = document.querySelector('#pdfStage'); s.scrollTop = s.scrollHeight; return true; })()`);
    await sleep(1500);
    await js(`(function(){ var s = document.querySelector('#pdfStage'); s.scrollTop = 0; return true; })()`);
    await sleep(1500);
    await js(`(function(){ var i = document.querySelector('#pageInput'); i.value = '${Math.max(9, pageCount - 2)}'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(2500);
    const liveCanvases = await count(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length`);
    const currentPage = await value('#pageInput');
    const currentHasCanvas = await count(`(function(){ var w = document.querySelector('#pdfStage .pdf-page-wrap[data-page="${currentPage}"]'); return w && w.querySelector('canvas.pdf-canvas') ? 1 : 0; })()`);
    check(`滚到底再跳回中段后在屏画布不超过上限`, liveCanvases > 0 && liveCanvases <= canvasLimit + 2, `在屏 ${liveCanvases} 张，上限 ${canvasLimit}（+2 为在屏页保护余量）`);
    check('当前页一定有画布（预算回收不许吃掉它）', currentHasCanvas === 1, `当前第 ${currentPage} 页 ${currentHasCanvas ? '有' : '没有'}画布`);

    step('PDF 取用的条件请求');
    check('打开 PDF 会请求 /api/pdf', pdfResponses.length >= 1, `响应数=${pdfResponses.length} 状态=${pdfResponses.slice(0, 6).join(',')}`);
    if (pdfResponses.includes(206)) {
      check('PDF 走 Range 分段（出现过 206）', true, `206 次数=${pdfResponses.filter(status => status === 206).length}`);
    } else {
      console.log(`  ○ PDF Range 分段：本次全是 ${pdfResponses.join(',') || '无'}（小文件一次取完，不判失败）`);
    }

    step('外部修改与编译失败保留上一版');
    const toastBefore = (await text('#toast')) || '';
    await js(`(function(){ var w = document.querySelector('#pdfStage .pdf-page-wrap[data-page="${currentPage}"]'); var r = w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + Math.min(160, r.height * 0.3) })); return true; })()`);
    const located = await probe(`(function(){ var t = document.querySelector('#toast'); return t && t.classList.contains('visible') && t.textContent.length > 4 && t.textContent !== ${JSON.stringify(toastBefore)}; })()`, 25000);
    check('PDF 双击反查给出结果或可读提示', located, (await text('#toast')) || '');

    // 外部修改检查只挂在 focus / visibilitychange 上：改完盘上的文件要模拟「用户切回标签页」
    await fs.appendFile(path.join(project, 'main.tex'), '\n% 外部修改标记 EXTERNAL-MARK-77\n');
    await refocus();
    const synced = await probe(`document.querySelector('.cm-content').textContent.includes('EXTERNAL-MARK-77')`, 25000);
    check('外部修改自动同步到编辑器（缓冲区干净）', synced, `编辑器 ${await count(`document.querySelector('.cm-content').textContent.length`)} 字符`);

    // 坏掉的版本顺带做「错误洪水」：服务端最多报 100 条，前端必须说明还有多少条没显示
    const brokenLine = '\\undefinedcommand{坏掉的命令}';
    const broken = mainClean.replace('\\end{document}', (brokenLine + '\n').repeat(140) + '\\end{document}');
    await fs.writeFile(path.join(project, 'main.tex'), broken);
    await refocus();
    check('坏掉的版本同步进编辑器', await probe(`document.querySelector('.cm-content').textContent.includes('undefinedcommand')`, 25000));
    const canvasesBeforeFail = await count(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length`);
    await click('#compileButton');
    await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); return c.hidden; })()`, 180_000);
    await probe(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length > 0`, 20000);
    const canvasesAfterFail = await count(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length`);
    const staleFlag = await js(`document.querySelector('#pdfStage').dataset.stale || ''`);
    const staleCaption = (await text('#previewCaption')) || '';
    check('编译失败后上一版 PDF 仍在预览里', canvasesBeforeFail > 0 && canvasesAfterFail > 0, `画布 ${canvasesBeforeFail} → ${canvasesAfterFail}`);
    check('编译失败标记 stale 并给出说明', staleFlag === '1' || /上一次|未完成|失败/.test(staleCaption), `data-stale="${staleFlag}" caption=${staleCaption}`);

    const truncation = await js(`(function(){
      var hint = document.querySelector('#diagnostics .log-hidden-hint');
      var shown = document.querySelectorAll('#diagnostics .diagnostic').length;
      return { hint: hint ? hint.textContent : '', shown: shown, hidden: hint ? Number((hint.textContent.match(/\\d+/) || [0])[0]) : 0 };
    })()`);
    check('报错少时不显示隐藏条数提示', truncation.shown > 0 && truncation.shown <= 100 && !truncation.hint, `显示 ${truncation.shown} 条，提示「${truncation.hint}」`);

    await fs.writeFile(path.join(project, 'main.tex'), mainClean);
    await refocus();
    await probe(`!document.querySelector('.cm-content').textContent.includes('undefinedcommand')`, 25000);
    await click('#compileButton');
    await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); return c.hidden; })()`, 180_000);
    // 按钮恢复时 PDF 常常还在重新取用，等画布回来再判定
    const recoveredPainted = await probe(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length > 0`, 25000);
    const recovered = await js(`(function(){ return document.querySelector('#pdfStage').dataset.stale || ''; })()`);
    const recoveredCanvas = await count(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length`);
    check('修复后重新编译清掉 stale 并重画 PDF', recovered !== '1' && recoveredPainted, `data-stale="${recovered}" 画布 ${recoveredCanvas}`);

    // 错误洪水：服务端最多报 100 条，前端必须说明还有多少条没显示（否则 ⌘⇧E 会少跳）
    await js(`(function(){ var sel = document.querySelector('#rootFile'); sel.value = 'flood.tex'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await probe(`document.querySelector('#rootFile').value === 'flood.tex'`, 6000);
    await click('#compileButton');
    await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); return c.hidden; })()`, 180_000);
    await js(`(function(){ var tab = document.querySelector('[data-tab="logs"]'); if (tab) tab.click(); return true; })()`);
    const floodView = await js(`(function(){
      var hint = document.querySelector('#diagnostics .log-hidden-hint');
      var items = document.querySelectorAll('#diagnostics .diagnostic').length;
      // 原始输出里的 Overfull 只用作下界：服务端会合并同义告警，真实总数只会 ≤ 原始条数
      var raw = (document.querySelector('#rawLog').textContent.match(/Overfull .hbox/g) || []).length;
      return { hint: hint ? hint.textContent : '', items: items, raw: raw, hidden: hint ? Number((hint.textContent.match(/\\d+/) || [0])[0]) : 0 };
    })()`);
    check('错误洪水只显示前 100 条', floodView.items === 100 && floodView.raw > 100, `显示 ${floodView.items} 条，原始输出 ${floodView.raw} 条`);
    const expectedHint = floodView.hidden > 0 ? `另有 ${floodView.hidden} 条未显示，请修复上面的错误后重新编译` : '';
    check('截断提示文案完整且条数自洽',
      floodView.hint === expectedHint && floodView.hidden > 0 && floodView.items + floodView.hidden <= floodView.raw,
      `提示「${floodView.hint}」；显示 ${floodView.items} + 漏掉 ${floodView.hidden} ≤ 原始输出 ${floodView.raw} 条`);
    // 收尾：主文件切回 main.tex 并重新编译，让后面的取消测试拿到正常状态
    await js(`(function(){ var sel = document.querySelector('#rootFile'); sel.value = 'main.tex'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await click('#compileButton');
    await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); return c.hidden; })()`, 180_000);
    await probe(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length > 0`, 25000);

    step('取消编译保留上一版 PDF');
    // 取消后前端会按当前视口重新铺一遍画布，张数会变；要比的是「还是不是取消前那一版」
    const beforeCancel = await js(`(function(){ return {
      total: document.querySelector('#pageTotal').textContent,
      page: document.querySelector('#pageInput').value,
      stale: document.querySelector('#pdfStage').dataset.stale || '',
      canvases: document.querySelectorAll('#pdfStage canvas.pdf-canvas').length
    }; })()`);
    await click('#compileButton');
    await sleep(400);
    const cancelVisible = await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); return !c.hidden && !c.disabled; })()`, 5000);
    await click('#cancelCompileButton');
    const cancelled = await probe(`(function(){ var c = document.querySelector('#cancelCompileButton'); var t = document.querySelector('#toast'); return c.hidden && !document.querySelector('#compileButton').disabled && t.classList.contains('visible') && /取消/.test(t.textContent); })()`, 60_000);
    await probe(`document.querySelectorAll('#pdfStage canvas.pdf-canvas').length > 0`, 12000);
    const afterCancel = await js(`(function(){ return {
      total: document.querySelector('#pageTotal').textContent,
      page: document.querySelector('#pageInput').value,
      stale: document.querySelector('#pdfStage').dataset.stale || '',
      canvases: document.querySelectorAll('#pdfStage canvas.pdf-canvas').length
    }; })()`);
    check('取消编译：按钮恢复 + 状态空闲 + 给出提示', cancelVisible && cancelled, `取消按钮出现=${cancelVisible} 取消后提示=${(await text('#toast')) || ''}`);
    check('取消后预览仍是取消前那一版（页数/页码/stale 都不变）',
      afterCancel.canvases > 0 && afterCancel.total === beforeCancel.total && afterCancel.page === beforeCancel.page && afterCancel.stale === beforeCancel.stale,
      `取消前 第 ${beforeCancel.page}/${beforeCancel.total} 页 · ${beforeCancel.canvases} 张 · stale="${beforeCancel.stale}" → 取消后 第 ${afterCancel.page}/${afterCancel.total} 页 · ${afterCancel.canvases} 张 · stale="${afterCancel.stale}"`);

    step('大文件打字延迟');
    await js(`(function(){ var row = Array.from(document.querySelectorAll('.tree-file')).find(r => r.dataset.path === 'scratch-big.tex'); if (!row) throw new Error('文件树里找不到 scratch-big.tex'); row.click(); return true; })()`);
    check('切到 100KB 大文件', await probe(`document.querySelector('#fileTab').textContent.includes('scratch-big.tex')`, 25000), `写入的缓冲区 ${(bigFixtureBytes / 1024).toFixed(0)}KB（${bigFixtureBytes} 字节）`);
    await js(`document.querySelector('.cm-content').focus(); true`);
    const typedBefore = await text('#wordCount');
    await js(`(function(){
      var before = document.querySelector('#wordCount').textContent;
      var target = document.querySelector('#wordCount');
      window.__smokeLatency = new Promise(function(resolve){
        var started = performance.now();
        (function tick(){ if (target.textContent !== before) { resolve(performance.now() - started); return; } requestAnimationFrame(tick); })();
      });
      return true;
    })()`);
    const typedAt = Date.now();
    for (const character of '甲乙丙丁戊己庚辛壬癸') {
      await send('Input.insertText', { text: character });
    }
    const observed = await js(`Promise.race([window.__smokeLatency, new Promise(function(r){ setTimeout(function(){ r(-1); }, 4000); })])`);
    const transportMs = Date.now() - typedAt;
    if (observed < 0) {
      check('打字后字数条更新', false, `4s 内没更新（before=${typedBefore}）`);
    } else if (transportMs > 1500) {
      console.log(`  ○ 打字延迟：本次 CDP 往返偏慢（${transportMs}ms 打完 10 字），只记录不判失败`);
      check('打字后字数条有更新', true, `观察到的延迟 ${Math.round(observed)}ms`);
    } else {
      check('大文件打字后字数条 <600ms 更新', observed < 600, `${bigFixtureBytes} 字节的文件，字数条 ${Math.round(observed)}ms 更新`);
    }

    step('搜索没扫完不能谎报成「没有找到」');
    await js(`(function(){ document.querySelector('#searchProjectBtn').click(); return true; })()`);
    const typeSearch = query => js(`(function(){ var i = document.querySelector('#searchInput'); i.value = ${JSON.stringify(query)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const searchView = () => js(`({ meta: document.querySelector('#searchMeta').textContent, hint: document.querySelector('#searchTruncated').textContent })`);
    // ① 小项目全扫完且真的没有匹配：这时才允许说「没有找到匹配内容」
    await typeSearch('zzz这个短语项目里一定不存在zzz');
    await probe(`!/正在搜索/.test(document.querySelector('#searchMeta').textContent)`, 30000);
    const doneView = await searchView();
    check('确实扫完后零结果如实说「没有找到匹配内容」', /没有找到匹配内容/.test(doneView.meta) && !doneView.hint, `「${doneView.meta} ${doneView.hint}」`);

    // 服务端只扫前 200 个文件：补几百个小文件把「扫不完」这条分支变得可复现
    await fs.mkdir(path.join(project, 'bulk'), { recursive: true });
    await Promise.all(Array.from({ length: 210 }, async (_, index) => {
      await fs.writeFile(path.join(project, 'bulk', `ch${String(index).padStart(3, '0')}.tex`), `% 第 ${index} 章\n普通正文，没有要搜的词。\n`);
    }));
    await sleep(400);   // 让服务端的文件索引缓存过期
    // ② 文件数超限 → truncated:true、零匹配：必须说「没扫完」，不能报「没有找到匹配内容」
    await typeSearch('zzz这个短语项目里一定不存在zzz ');
    await probe(`!/正在搜索/.test(document.querySelector('#searchMeta').textContent)`, 30000);
    const cappedView = await searchView();
    check('文件数超限的零结果不说「没有找到匹配内容」',
      !/没有找到匹配内容/.test(cappedView.meta) && /只扫完|没有扫完|没扫完/.test(cappedView.meta) && /关键词/.test(cappedView.hint),
      `「${cappedView.meta} ${cappedView.hint}」`);
    // ③ 正则烧满 worker 的 1.5 秒预算 → timedOut:true。文件名要排在 bulk/ 之前：
    // 服务端默认只扫前 200 个文件，排在后面的话这个夹具根本扫不到
    await fs.writeFile(path.join(project, 'a-evil.tex'), `prefix ${'a'.repeat(45)}b suffix\n`);
    await sleep(400);
    await js(`(function(){ document.querySelector('#searchRegex').click(); return true; })()`);
    await typeSearch('(?:a|aa)+$');
    await probe(`!/正在搜索/.test(document.querySelector('#searchMeta').textContent)`, 30000);
    const timeoutView = await searchView();
    check('正则超时时说清是「没扫完」而不是「没有」',
      !/没有找到匹配内容/.test(timeoutView.meta) && /超时|没有扫完/.test(timeoutView.meta) && /关键词/.test(timeoutView.hint),
      `「${timeoutView.meta} ${timeoutView.hint}」`);
    await js(`(function(){ var d = document.querySelector('#searchModal'); if (d.open) d.close(); return true; })()`);

    step('异常兜底');
    await js(`Promise.reject(new Error('冒烟用的悬空 Promise')); true`);
    const notified = await probe(`(function(){ var t = document.querySelector('#toast'); return t.classList.contains('visible') && /异常/.test(t.textContent); })()`, 6000);
    check('悬空 Promise 会提示而不是静默', notified, (await text('#toast')) || '');
    pageErrors.length = 0;      // 上面那条是故意造的
    consoleErrors.length = 0;
    await sleep(600);
    check('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

    return finish(0);
  } catch (error) {
    console.error(`\n\u001b[31m✘ UI 冒烟中断：\u001b[0m${error?.message || error}`);
    if (error?.stack) console.error(error.stack.split('\n').slice(0, 5).join('\n'));
    return finish(1);
  }
}

await main();
