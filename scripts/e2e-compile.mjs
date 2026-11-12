// 端到端验证：真实 Tectonic + 真实多文件中文项目，走完「打开 → 保存 → 编译 → 产物新鲜度 → 取消 →
// 选段 → SyncTeX 正反向 → Range/条件请求 → 越界与泄漏防护 → 清理 → 无残留进程」。
//
// 与 npm test 分开：npm test 不依赖 TeX，这个脚本依赖，用 `npm run test:e2e` 调用。
// 只在 os.tmpdir() 下建临时项目，绝不碰用户真实论文；结束时确认端口释放、无孤儿引擎进程。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');

const log = (...args) => console.log('·', ...args);
const step = name => console.log(`\n\u001b[1m▶ ${name}\u001b[0m`);

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

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function longDocument(lines) {
  let out = '';
  for (let i = 1; i <= lines; i++) out += `第 ${i} 行这是用来拖慢编译的中文段落内容，公式 $x_{${i}}^2$ 与引用 \\cite{key${i % 3}}。\n`;
  return out;
}

async function main() {
  if (!(await hasTectonic())) {
    console.log('未检测到 Tectonic，跳过端到端验证（brew install tectonic 后重跑）。');
    return;
  }

  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-e2e-'));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repository,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  let childStopped = false;

  async function stopServer() {
    if (childStopped || child.exitCode !== null) return;
    childStopped = true;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 8_000))]);
  }

  async function api(route, method = 'GET', data, headers = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, data: parsed };
  }

  const sourceTree = async () => {
    const { stdout } = await exec('find', [project, '-type', 'f', '-not', '-path', '*/.latex-tools/*']);
    return stdout.trim().split('\n').filter(Boolean).map(file => path.relative(project, file)).sort();
  };

  try {
    // ---------- 夹具 ----------
    await fs.mkdir(path.join(project, 'sections'), { recursive: true });
    await fs.mkdir(path.join(project, 'figures'), { recursive: true });
    await fs.writeFile(path.join(project, 'main.tex'), [
      '\\documentclass[UTF8,a4paper,12pt]{ctexart}',
      '\\usepackage{amsmath,graphicx,booktabs}',
      '\\title{端到端验证用临时论文}',
      '\\author{砚台测试}',
      '\\date{\\today}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{引言}\\label{sec:intro}',
      '这里是中文引言，公式 $E = mc^2$，引用 \\cite{zhang2020}。',
      '\\input{sections/exp}',
      '如图 \\ref{fig:plot} 所示。',
      '\\bibliographystyle{plain}',
      '\\bibliography{references}',
      '\\end{document}',
      ''
    ].join('\n'));
    const expTex = [
      '\\section{实验}\\label{sec:exp}',
      '\\begin{figure}[h]\\centering',
      '\\includegraphics[width=0.4\\textwidth]{figures/plot.png}',
      '\\caption{示意图}\\label{fig:plot}',
      '\\end{figure}',
      '\\begin{equation}\\label{eq:loss}',
      'L = \\sum_{i=1}^{n} \\left( y_i - \\hat{y}_i \\right)^2',
      '\\end{equation}',
      '实验章节的中文正文内容。',
      ''
    ].join('\n');
    const expTexBroken = '\\section{实验}\n\\undefinedcommand{坏掉的命令}\n';
    await fs.writeFile(path.join(project, 'sections', 'exp.tex'), expTex);
    await fs.writeFile(path.join(project, 'references.bib'), '@article{zhang2020,\n  title = {测试文献},\n  author = {张三},\n  year = {2020}\n}\n');
    await fs.writeFile(path.join(project, 'figures', 'plot.png'), pngBytes);
    // 嵌套量词 + 不匹配的长串：没有超时保护的同步正则会在这里把事件循环卡死几分钟
    await fs.writeFile(path.join(project, 'bomb.txt'), `${'a'.repeat(45)}b\n普通一行\n`);

    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        if ((await api('/api/status')).status === 200) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    step('打开项目与文件读写');
    const opened = await api('/api/project/open', 'POST', { path: project });
    assert.equal(opened.status, 200, '项目能打开');
    assert.ok(opened.data.files.some(file => file.path === 'sections/exp.tex'), '子目录文件出现在树里');
    const main1 = await api('/api/file?path=main.tex');
    assert.equal(main1.status, 200);
    assert.equal((await api('/api/file', 'PUT', { path: 'main.tex', content: main1.data.content, mtimeMs: main1.data.mtimeMs })).status, 200, '带 mtimeMs 的保存通过');
    assert.ok([409, 400].includes((await api('/api/file', 'PUT', { path: 'main.tex', content: 'no mtime overwrite' })).status), '缺少 mtimeMs 的保存不能静默覆盖');
    await api('/api/file', 'PUT', { path: 'main.tex', content: main1.data.content, mtimeMs: main1.data.mtimeMs, force: true });

    step('全文编译（ctexart + BibTeX + 子文件 + 图片）');
    const compiled = await api('/api/compile', 'POST', { rootFile: 'main.tex' });
    assert.equal(compiled.status, 200);
    assert.equal(compiled.data.ok, true, `编译应当成功：${String(compiled.data.output).slice(-400)}`);
    assert.equal(compiled.data.pdfAvailable, true);
    assert.equal(compiled.data.pdfFresh, true, '成功编译的 PDF 必须标记为本次产物');
    assert.equal(compiled.data.pdfStale, false);
    assert.equal(compiled.data.synctexAvailable, true, 'Tectonic 产出 .synctex.gz');
    assert.match(String(compiled.data.pdfUrl), /v=/);
    log(`编译耗时 ${(compiled.data.durationMs / 1000).toFixed(1)}s`);

    step('PDF 的条件请求与分段下载');
    const pdfHead = await fetch(base + compiled.data.pdfUrl, { method: 'HEAD' });
    assert.equal(pdfHead.status, 200, 'HEAD 可用');
    assert.equal(pdfHead.headers.get('accept-ranges'), 'bytes');
    const etag = pdfHead.headers.get('etag');
    assert.ok(etag, '带 ETag');
    assert.equal((await fetch(base + compiled.data.pdfUrl, { headers: { 'If-None-Match': etag } })).status, 304, '命中 ETag 返回 304');
    const ranged = await fetch(base + compiled.data.pdfUrl, { headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206, '支持 Range 才能按需分段加载大 PDF');
    assert.match(ranged.headers.get('content-range') || '', /^bytes 0-99\//);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(base + compiled.data.pdfUrl, { headers: { Range: 'bytes=999999999-' } })).status, 416, '超范围返回 416');

    step('SyncTeX 正反向定位（子文件）');
    const forward = await api('/api/synctex/forward', 'POST', { rootFile: 'main.tex', file: 'sections/exp.tex', line: 1 });
    assert.equal(forward.status, 200);
    assert.equal(forward.data.found, true, '子文件首行应能正向定位');
    assert.ok(forward.data.page >= 1);
    const reverse = await api('/api/synctex/reverse', 'POST', { rootFile: 'main.tex', page: forward.data.page, x: 80, y: 700 });
    assert.equal(reverse.status, 200);
    assert.equal(reverse.data.found, true, '反向定位必须命中');
    assert.ok(typeof reverse.data.file === 'string' && reverse.data.file.endsWith('.tex'));
    for (const bad of [{ line: 0 }, { line: -5 }, { line: 999_999 }, { line: 'abc' }]) {
      const edge = await api('/api/synctex/forward', 'POST', { rootFile: 'main.tex', file: 'sections/exp.tex', ...bad });
      assert.equal(edge.status, 200, `非法行号 ${bad.line} 不得变成 500`);
      assert.equal(typeof edge.data.found, 'boolean', `非法行号 ${bad.line} 要有明确结果`);
    }
    assert.equal((await api('/api/synctex/reverse', 'POST', { rootFile: 'main.tex', page: Number.NaN, x: 0, y: 0 })).status, 200, '非法页码不得变成 500');

    step('编译失败不得把旧 PDF 当新结果');
    const previousFingerprint = compiled.data.pdfFingerprint;
    const expPut = async content => api('/api/file', 'PUT', { path: 'sections/exp.tex', content, mtimeMs: (await api('/api/file?path=sections/exp.tex')).data.mtimeMs });
    await expPut(expTexBroken);
    const broken = await api('/api/compile', 'POST', { rootFile: 'main.tex' });
    assert.equal(broken.data.ok, false, '坏命令必须报错');
    assert.notEqual(broken.data.pdfStale, true && broken.data.pdfFresh, 'fresh / stale 互斥');
    if (broken.data.pdfStale) {
      assert.equal(broken.data.pdfFresh, false);
      assert.equal(broken.data.pdfFingerprint, previousFingerprint, '标记为 stale 的必须是上一版');
    }
    if (broken.data.pdfFresh) {
      assert.notEqual(broken.data.pdfFingerprint, previousFingerprint, '失败那次若产出新 PDF，指纹必须变，绝不能再报上一版指纹');
    }
    const errored = (broken.data.diagnostics || []).filter(item => item.kind === 'error');
    assert.ok(errored.length > 0, '必须给出错误条目');
    assert.ok(errored.some(item => item.file === 'sections/exp.tex' && item.line >= 1), '错误要落到子文件行号');
    assert.ok(errored.some(item => item.hint), '常见错误要有中文排错提示');
    await expPut(expTex);

    step('取消编译并确认编译槽释放');
    await fs.mkdir(path.join(project, 'cancel'), { recursive: true });
    await fs.writeFile(path.join(project, 'cancel', 'big.tex'), `\\documentclass[UTF8]{ctexart}\n\\begin{document}\n${longDocument(4000)}\\end{document}\n`);
    const token = `e2e-${Date.now()}`;
    const running = api('/api/compile', 'POST', { rootFile: 'cancel/big.tex', token });
    await new Promise(resolve => setTimeout(resolve, 400));
    const cancel = await api('/api/compile/cancel', 'POST', { token });
    assert.equal(cancel.status, 200);
    const cancelledResult = await running;
    log(`取消结果 ok=${cancelledResult.data.ok} cancelled=${cancelledResult.data.cancelled}`);
    if (cancelledResult.data.cancelled) {
      assert.equal(cancelledResult.data.pdfAvailable, false, '被取消的编译不得报告产物');
      assert.equal(cancelledResult.data.pdfUrl, null);
    }
    const afterCancel = await api('/api/compile', 'POST', { rootFile: 'main.tex' });
    assert.equal(afterCancel.status, 200, '取消后编译槽必须释放');
    assert.equal(afterCancel.data.ok, true, '取消后仍能正常编译');

    step('选段极速预览');
    const sourceSnapshot = await sourceTree();
    const snippet = await api('/api/compile/snippet', 'POST', {
      source: '\\documentclass[UTF8]{ctexart}\n\\usepackage{amsmath}\n\\begin{document}\n\\begin{equation}\nR = \\frac{1}{2}mv^2\n\\end{equation}\n\\end{document}\n',
      editorFile: 'sections/exp.tex',
      rootFile: 'main.tex',
      fromLine: 6,
      bodyStart: 4
    });
    assert.equal(snippet.status, 200);
    assert.equal(snippet.data.ok, true, `选段编译应当成功：${String(snippet.data.output).slice(-300)}`);
    assert.equal(snippet.data.pdfAvailable, true);
    const snippetPdf = await fetch(base + snippet.data.pdfUrl);
    assert.equal(snippetPdf.status, 200);
    assert.equal(snippetPdf.headers.get('content-type'), 'application/pdf');
    const snippetError = await api('/api/compile/snippet', 'POST', {
      source: '\\documentclass{article}\n\\begin{document}\n\\bombcommand{x}\n\\end{document}\n',
      editorFile: 'sections/exp.tex',
      rootFile: 'main.tex',
      fromLine: 10,
      bodyStart: 3
    });
    assert.equal(snippetError.data.ok, false);
    assert.ok((snippetError.data.diagnostics || []).every(item => typeof item.file === 'string' && item.file), '选段诊断不得返回 file:null');
    const mapped = (snippetError.data.diagnostics || []).find(item => item.line);
    if (mapped) assert.equal(mapped.file, 'sections/exp.tex', '选段报错要映射回编辑器文件');
    const tree = await api('/api/tree');
    assert.ok(!tree.data.files.some(file => file.path.startsWith('snippet')), '选段生成物不得出现在项目文件里');
    assert.deepEqual(await sourceTree(), sourceSnapshot, '源码目录不得被生成物污染');

    step('搜索：截断、时限与参数钳制');
    const bombStartedAt = Date.now();
    const bomb = await api('/api/search', 'POST', { query: '(a+)+$', regex: true });
    const bombElapsed = Date.now() - bombStartedAt;
    assert.ok([200, 400].includes(bomb.status), `灾难性正则不能变成 500（实际 ${bomb.status}）`);
    if (bomb.status === 200) {
      assert.equal(bomb.data.timedOut, true, '正则搜索要有硬超时');
      assert.ok(bombElapsed < 5_000, `超时必须是真超时，实测 ${bombElapsed}ms`);
    }
    assert.ok(Date.now() - bombStartedAt < 8_000, '搜索超时后事件循环必须恢复');
    assert.equal((await api('/api/status')).status, 200, '搜索超时不得拖垮服务');
    const greedy = await api('/api/search', 'POST', { query: 'e', regex: true, maxFiles: 100_000, maxMatches: 1_000_000 });
    assert.ok(greedy.data.filesSearched <= 400, '客户端不得放大扫描文件数');
    assert.equal((await api('/api/search', 'POST', { query: '(', regex: true })).data.error, '正则表达式无效');

    step('越界与泄漏防护');
    assert.equal((await fetch(base + '/api/file?path=main.tex', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, '跨站读文件必须拒绝');
    assert.equal((await fetch(base + '/api/pdf?rootFile=main.tex', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const missing = await api('/api/file?path=nope.tex');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(JSON.stringify(missing.data), /\/(Users|private|var)\//, '错误响应不得泄漏绝对路径');
    assert.doesNotMatch(String(missing.data.error), /ENOENT|realpath|ENOENT/);
    assert.equal((await api('/api/template', 'POST', { kind: 'constructor' })).status, 400, '原型链上的 key 不是模板');
    assert.equal((await api('/api/file?path=..%2Foutside.tex')).status, 400);
    assert.equal((await api('/api/asset?path=main.tex')).status, 400, '预览接口只给图片');

    step('清理编译缓存');
    const cleaned = await api('/api/build/clean', 'POST', {});
    assert.equal(cleaned.status, 200);
    assert.ok(cleaned.data.cleaned > 0, '清理应当报出删除数量');
    await assert.rejects(fs.access(path.join(project, '.latex-tools', 'build')));
    const withoutCancelFixture = list => list.filter(item => !item.startsWith('cancel/'));
    assert.deepEqual(
      withoutCancelFixture(await sourceTree()),
      withoutCancelFixture(sourceSnapshot),
      '清理不得动源码文件'
    );
  } finally {
    await stopServer();
    const remained = await exec('ps', ['-axo', 'pid,command']).then(({ stdout }) =>
      stdout.split('\n').filter(line => /tectonic|xelatex|xdvipdfmx|biber/.test(line) && !/ps -axo/.test(line))
    ).catch(() => ({ toString: () => '' }));
    const orphans = Array.isArray(remained) ? remained.filter(Boolean) : [];
    const probe = net.createServer();
    const portFree = await new Promise(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    assert.equal(portFree, true, '测试服务必须释放端口');
    assert.equal(orphans.length, 0, `不得留下孤儿编译进程：${orphans.join(' | ')}`);
    await fs.rm(project, { recursive: true, force: true });
  }

  console.log('\n\u001b[32m✔ 端到端验证全部通过\u001b[0m');
}

main().catch(error => {
  console.error('\n\u001b[31m✘ 端到端验证失败：\u001b[0m', error?.message || error);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
});
