#!/usr/bin/env node
// 重新生成 README 用的界面截图 docs/preview.png。
//   node scripts/preview-shot.mjs [--out docs/preview.png] [--keep]
//
// 为什么要有这个脚本：README 顶上是这张图，界面一改它就变成「假的现状」。
// 它跟 scripts/smoke-ui.mjs 用同一套做法：随机端口起服务（绝不碰用户的 3210）、
// 临时目录里造一个演示项目（绝不用用户的真论文）、headless Chrome 走 CDP、
// finally 里自证进程退出 + 端口释放 + 临时目录删除。没装 Chrome / Tectonic / dist 时打印说明并跳过。
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_UI_PORT = 3210;
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];
const argv = process.argv.slice(2);
const outPath = path.resolve(repository, argv[argv.indexOf('--out') + 1] || 'docs/preview.png');
const keepTemp = argv.includes('--keep');
const VIEWPORT = { width: 1512, height: 950 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);
let server = null;
let chrome = null;
let tempRoot = null;
let socket = null;

async function freePort(prefer) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = prefer ?? 20000 + Math.floor(Math.random() * 20000);
    if (port === DEFAULT_UI_PORT) continue;
    const ok = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('找不到可用端口');
}

async function portFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// ---------- 演示项目：一篇「看着像论文」的夹具 ----------
const CHAPTER = `
本节说明数据来源与处理方法。样本区间为 2015 至 2023 年，剔除上市不足一年的观测后得到 4 812 个公司—年度观测值。

为检验假说 H1，构建如下面板回归模型：

\\begin{equation}
  Y_{it} = \\alpha + \\beta Digital_{it} + \\gamma X_{it} + \\mu_i + \\lambda_t + \\varepsilon_{it}
  \\label{eq:baseline}
\\end{equation}

其中 $Y_{it}$ 为企业全要素生产率，$Digital_{it}$ 为数字化转型指数，$X_{it}$ 为控制变量向量，
$\\mu_i$ 与 $\\lambda_t$ 分别控制个体与时间固定效应。稳健性检验见第 \\ref{sec:robust} 节。
`;

async function buildProject() {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-preview-'));
  tempRoot = project;
  await fs.writeFile(path.join(project, 'main.tex'), [
    '\\documentclass[12pt]{ctexart}',
    '\\usepackage{amsmath,booktabs,geometry}',
    '\\geometry{a4paper,margin=2.5cm}',
    '\\title{数字化转型对企业全要素生产率的影响}',
    '\\author{砚台示例}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\begin{abstract}本文以 2015—2023 年 A 股上市公司为样本，考察数字化转型对全要素生产率的因果影响。',
    '截图用的演示文本，不含任何真实研究数据。\\end{abstract}',
    '\\input{sections/intro}',
    '\\input{sections/method}',
    '\\end{document}',
    ''
  ].join('\n'));
  await fs.mkdir(path.join(project, 'sections'));
  await fs.writeFile(path.join(project, 'sections/intro.tex'), `\\section{引言}

数字化转型正在重塑企业的生产组织方式。本文利用文本挖掘构造的企业层面数字化指数，
测度这一转型对生产率的影响。既有文献多关注宏观层面，本文的贡献在于微观机制的识别。
\n`);
  await fs.writeFile(path.join(project, 'sections/method.tex'), `\\section{研究设计}\\label{sec:design}\n${CHAPTER}
\\section{稳健性检验}\\label{sec:robust}

替换被解释变量的度量方式、剔除直辖市样本、以及工具变量法，结论保持一致。
\n`);
  await fs.writeFile(path.join(project, 'references.bib'), [
    '@article{zh2023digital,',
    '  author = {张三 and 李四},',
    '  title = {数字化转型与企业效率},',
    '  journal = {经济研究},',
    '  year = {2023},',
    '}',
    ''
  ].join('\n'));
  return project;
}

async function main(onPort) {
  const chromeBin = process.env.CHROME?.trim() || CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  if (!chromeBin) return log('○ 跳过截图：没找到 Chrome/Chromium，可用 CHROME= 指定'), 0;
  if (!existsSync(path.join(repository, 'dist', 'index.html'))) return log('○ 跳过截图：先运行 npm run build'), 0;
  const tectonic = spawn('which', ['tectonic'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const enginePath = await new Promise(resolve => {
    let out = '';
    tectonic.stdout.on('data', chunk => { out += chunk; });
    tectonic.on('close', () => resolve(out.trim()));
  });
  if (!enginePath) return log('○ 跳过截图：没装 Tectonic，截不出 PDF 预览'), 0;

  const base = await (async () => {
    const port = await freePort();
    server = spawn(process.execPath, ['server/index.mjs'], {
      cwd: repository,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', chunk => process.stderr.write(`[服务] ${chunk}`));
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tree`);
        if (response.ok || response.status === 400) return { port, base: `http://127.0.0.1:${port}` };
      } catch {}
      await sleep(150);
    }
    throw new Error(`端口 ${port} 上服务 12s 内没起来`);
  })();
  log(`· 服务 ${base.base}（用户的 ${DEFAULT_UI_PORT} 不会被动）`);
  onPort?.(base.port);

  const project = await buildProject();
  log(`· 演示项目 ${project}`);

  const cdpPort = await freePort();
  const profile = path.join(project, '.chrome-profile');
  chrome = spawn(chromeBin, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const version = await (async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (response.ok) return await response.json();
      } catch {}
      await sleep(200);
    }
    return null;
  })();
  if (!version?.webSocketDebuggerUrl) throw new Error('Chrome CDP 端口没起来');

  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  let nextId = 0;
  const waiting = new Map();
  let sessionId = null;
  const netLog = [];
  const pageErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.responseReceived') {
      const url = message.params.response?.url || '';
      if (url.includes('/api/')) netLog.push(`${message.params.response.status} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(message.params.exceptionDetails?.exception?.description || message.params.text || '').split('\n')[0]);
    }
    if (!message.id || !waiting.has(message.id)) return;
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
  });
  const js = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本抛错');
    return result.result?.value;
  };
  const probe = async (expression, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      try { if (await js(`(function(){ try { return Boolean(${expression}); } catch { return false; } })()`)) return true; } catch {}
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  const describe = async () => {
    const bits = await js(`(function(){
      var grab = function (sel) { var el = document.querySelector(sel); return el ? (el.textContent || '').trim().slice(0, 100) : '（没有 ' + sel + '）'; };
      var button = document.querySelector('#compileButton');
      return {
        toast: grab('#toast'),
        button: button ? button.textContent.trim().slice(0, 24) + ' disabled=' + button.disabled : '（没有 #compileButton）',
        stage: grab('#pdfStage'),
        tab: grab('#fileTab'),
        rows: document.querySelectorAll('.tree-file-row').length
      };
    })()`).catch(error => ({ toast: `读不到界面：${error.message}`, button: '', stage: '', tab: '', rows: -1 }));
    console.error(`  界面：按钮「${bits.button}」 提示「${bits.toast}」 文件 ${bits.rows} 个 当前标签「${bits.tab}」 预览区「${bits.stage}」`);
    if (netLog.length) console.error(`  请求：${netLog.slice(-12).join(' | ')}`);
    if (pageErrors.length) console.error(`  页面异常：${pageErrors.slice(-3).join(' | ')}`);
  };
  const need = async (expression, reason, ms = 20000) => {
    if (!await probe(expression, ms)) {
      await describe();
      throw new Error(reason);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${base.base}/` });
  await need('!!document.querySelector("#app .topbar")', '首屏没渲染出来', 15000);

  // 打开演示项目
  await js(`(function(){ document.querySelector('#emptyOpen').click(); return true; })()`);
  await js(`(function(){ var i = document.querySelector('#modalInput'); i.value = ${JSON.stringify(project)}; document.querySelector('#modal').close('submit'); return true; })()`);
  await need('document.querySelectorAll(".tree-file-row").length > 0', '文件树没渲染出来', 25000);
  await probe(`document.querySelector('#fileTab') && document.querySelector('#fileTab').textContent.includes('main.tex')`, 15000);

  // 编译出 PDF（右侧预览有真实像素是这张图的关键）
  await js(`(function(){ document.querySelector('#compileButton').click(); return true; })()`);
  await need('document.querySelectorAll("#pdfStage canvas").length > 0', 'PDF 没有渲染出画布', 120000);
  await sleep(1500);

  // 编辑器停在「研究设计」那一节：正文有公式，看着像在写论文
  await js(`(function(){
    var row = Array.from(document.querySelectorAll('.tree-file-row')).find(function (r) { return (r.dataset.path || '').endsWith('method.tex'); });
    if (row) row.click();
    return Boolean(row);
  })()`);
  await probe(`document.querySelector('#fileTab') && document.querySelector('#fileTab').textContent.includes('method.tex')`, 15000);
  await js(`(function(){
    var view = document.querySelector('.cm-content');
    if (view) view.scrollIntoView();
    var scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = Math.round(scroller.scrollHeight * 0.18);
    return true;
  })()`);
  await sleep(600);
  // 等提示条自己消失再截：不然 README 里永远糊着一块「编译完成」，每次生成的位置还不一样
  await probe(`(function(){ var t = document.querySelector('#toast'); return !t || !t.classList.contains('visible'); })()`, 8000);
  await sleep(300);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = Buffer.from(shot.data, 'base64');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, png);
  log(`· 已写入 ${outPath}（${(png.length / 1024).toFixed(0)}KB，${VIEWPORT.width * 2}×${VIEWPORT.height * 2}）`);
  log('· 提醒：写完要用眼睛看一遍。headless 截出全白也算「成功」，脚本判断不了构图。');
  return 0;
}

async function cleanup(servedPort) {
  for (const child of [server, chrome]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
  await sleep(1200);
  for (const child of [server, chrome]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  try { socket?.close(); } catch {}
  if (tempRoot && !keepTemp) await fs.rm(tempRoot, { recursive: true, force: true });
  const free = servedPort ? await portFree(servedPort) : true;
  log(`· 收尾：服务 ${server ? `exit=${server.exitCode ?? 'null'}` : '未启动'} / 浏览器 ${chrome ? `exit=${chrome.exitCode ?? 'null'}` : '未启动'}` +
    `${tempRoot && !keepTemp ? ' / 临时目录已删' : ''} / 端口 ${servedPort ? servedPort : ''} ${free ? '已释放' : '仍被占用'}`);
}

let code = 1;
let servedPort = 0;
try {
  code = await main(port => { servedPort = port; });
} catch (error) {
  console.error(`✘ 截图失败：${error?.message || error}`);
} finally {
  await cleanup(servedPort);
}
process.exitCode = code;
