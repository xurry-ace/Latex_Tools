import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// One pixel, so `/api/asset` has something real to stream.
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const enginesStarted = [];
const serversStarted = [];
const sandboxes = [];

// The whole suite must not leave a server, an engine or a temporary folder behind: any test that forgets to
// clean up is caught by these global hooks, which run after every case finished.
after(async () => {
  for (const child of serversStarted.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  for (const directory of sandboxes.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  const leftovers = enginesStarted
    .filter(child => child.exitCode === null && child.signalCode === null)
    .map(child => child.pid);
  assert.deepEqual(leftovers, [], 'every tool spawned by the fake tectonic has exited');
});

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// undici manages `Host` itself and silently drops a forged one, so that guard is asserted on a raw socket.
function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('raw request timed out')); });
    socket.on('error', reject);
  });
}

// Run a small host tool (chflags, ps) outside the server for fixture setup and clean-up checks.
function run(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A directory that comes first on PATH, so the server's `tectonic` is whatever this test needs it to be:
// missing, hanging, or a script that writes artefacts and exits with a chosen status.
async function toolDirectory({ engine, extraPath, barePath = false, empty = false } = {}) {
  const bin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-bin-')));
  sandboxes.push(bin);
  if (empty) return { bin, PATH: bin };
  if (engine) {
    const target = path.join(bin, 'tectonic');
    await fs.writeFile(target, `#!/bin/sh\n${engine}\n`, { mode: 0o755 });
    if (!(await fs.stat(target)).mode.toString(8).endsWith('5')) {
      await fs.chmod(target, 0o755);
    }
  }
  // `extraPath: []` means *only* this directory: a test that wants "the engine is not installed" must not fall
  // back to the real tectonic in /opt/homebrew.
  if (Array.isArray(extraPath)) return { bin, PATH: [bin, ...extraPath].filter(Boolean).join(path.delimiter) };
  // `barePath` keeps the system directories but drops the developer PATH, where a real tectonic may sit: a test
  // that deletes its fake engine has to land on "not installed", not on the engine of whoever runs the suite.
  if (barePath) return { bin, PATH: [bin, '/bin', '/usr/bin'].join(path.delimiter) };
  return { bin, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

async function startServer({ env = {}, waitMs = 15_000 } = {}) {
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repository,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => logs.push(chunk));
  child.stderr.on('data', chunk => logs.push(chunk));
  serversStarted.push(child);

  const request = async (route, options = {}) => {
    const headers = new Headers(options.body && !options.rawBody ? { 'Content-Type': 'application/json' } : {});
    for (const [name, value] of Object.entries(options.headers || {})) headers.set(name, value);
    if (!headers.has('origin')) headers.set('Origin', base);
    return fetch(base + route, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : options.rawBody ? options.body : JSON.stringify(options.body)
    });
  };

  let closed = null;
  const close = () => {
    if (!closed) {
      closed = (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        // `server.close()` can wait for a keep-alive socket; the port must be free before the next case starts.
        for (let attempt = 0; attempt < 60; attempt++) {
          const free = await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(false); });
            socket.once('error', () => resolve(true));
          });
          if (free) return;
          await sleep(50);
        }
      })();
    }
    return closed;
  };

  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/status`, { headers: { Origin: base } });
        if (response.status) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${logs.join('')}`);
      if (Date.now() > deadline) throw new Error(`server did not start: ${logs.join('')}`);
      await sleep(60);
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    base,
    port,
    child,
    logs,
    close,
    request,
    async api(route, method = 'GET', data) {
      const response = await request(route, { method, body: data });
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return { status: response.status, data: parsed, text, headers: response.headers };
    }
  };
}

// Every case gets its own project and its own server: shared mutable fixtures made the old suite order-dependent.
async function createFixture({
  files = {},
  images = {},
  engine = null,
  engineLog = false,
  withProject = true,
  barePath = false,
  env = {},
  server = {}
} = {}) {
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-test-')));
  const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-sandbox-')));
  sandboxes.push(sandbox);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(project, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  // A fake engine always gets its scratch paths through the environment: the wrapper script writes there and
  // the test reads back what the "build" really did.
  const enginePaths = engine === null && engineLog === false ? {} : {
    YANTAI_ENGINE_LOG: path.join(sandbox, 'engine.log'),
    YANTAI_ENGINE_PID: path.join(sandbox, 'engine.pids'),
    YANTAI_ENGINE_SIGNALS: path.join(sandbox, 'engine.signals'),
    YANTAI_ENGINE_COUNT: path.join(sandbox, 'engine.count')
  };
  const tool = engine === 'missing'
    ? await toolDirectory({ empty: true })
    : engine
      ? await toolDirectory({ engine, barePath })
      : (engineLog ? await toolDirectory({ engine: 'exit 0' }) : null);
  const fixture = {
    project,
    sandbox,
    server: null,
    bin: tool?.bin ?? null,
    logFile: enginePaths.YANTAI_ENGINE_LOG ?? null,
    enginePids: enginePaths.YANTAI_ENGINE_PID ?? null,
    engineSignals: enginePaths.YANTAI_ENGINE_SIGNALS ?? null,
    engineCount: enginePaths.YANTAI_ENGINE_COUNT ?? null,
    async place(name, contents) {
      const target = path.join(project, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    },
    buildDirOf(rel) {
      const id = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12);
      return path.join(project, '.latex-tools', 'build', id);
    },
    async upload(name, contents = pngBytes) {
      const response = await fixture.server.request(`/api/upload?filename=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: contents,
        rawBody: true,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      return { status: response.status, data: await response.json() };
    },
    async close() {
      await fixture.server?.close();
      // A fixture may have made one file undeletable on purpose; clear flags before throwing the project away.
      await run('chflags', ['-R', 'nouchg,nosunlnk', project]).catch(() => {});
      await fs.rm(project, { recursive: true, force: true }).catch(() => {});
      if (fixture.bin) await fs.rm(fixture.bin, { recursive: true, force: true }).catch(() => {});
    }
  };

  fixture.server = await startServer({ env: { ...enginePaths, ...env, ...(tool ? { PATH: tool.PATH } : {}) }, ...server });
  if (withProject) {
    const opened = await fixture.server.api('/api/project/open', 'POST', { path: project });
    assert.equal(opened.status, 200, `fixture opens its project: ${opened.text}`);
  }
  for (const [name, contents] of Object.entries(images)) {
    const uploaded = await fixture.upload(name, contents);
    assert.equal(uploaded.status, 201, `fixture uploads ${name}`);
  }
  return fixture;
}

async function withFixture(options, body) {
  const fixture = await createFixture(options);
  try {
    return await body(fixture);
  } finally {
    await fixture.close();
  }
}

// Tracked so the global `after` hook can prove the server killed its whole process group.
function watchEngine(child) {
  enginesStarted.push(child);
  return child;
}

function runningChildren() {
  return enginesStarted.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid);
}

async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const mainTex = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{总览}',
  '\\input{sections/intro}',
  '\\section{实验与结果}\\label{sec:exp}',
  '中文测试 English words.',
  '\\end{document}',
  ''
].join('\n');

const referencesBib = '% comment\n@article{vaswani2017,\n  title = {Attention Is Only What You Need},\n  author = {Vaswani, Ashish},\n  year = {2017}\n}\n';

// ───────────────────────────── request guards and error shapes ─────────────────────────────

describe('request guards', () => {
  test('static handler stays in dist', async () => {
    await withFixture({}, async ({ server }) => {
      const escape = await server.request('/../package.json');
      // A client that normalises `..` first asks for `/package.json` (a 404 inside dist); one that sends it
      // verbatim is caught by the directory check. Neither may read the repository file.
      assert.ok([403, 404].includes(escape.status), `escape attempt returns 403/404, got ${escape.status}`);
      const body = await escape.text();
      assert.doesNotMatch(body, /"latex-workbench"/);
      assert.doesNotMatch(body, /\/(Users|private|var)\//);

      assert.equal((await server.request('/%zz')).status, 400);

      const deleted = await server.request('/api/status', { method: 'DELETE' });
      assert.equal(deleted.status, 405);
      assert.equal((await server.api('/api/unknown-endpoint')).status, 404);

      const head = await server.request('/', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal((await head.text()).length, 0, 'HEAD answers with headers only');
      assert.equal(head.headers.get('accept-ranges'), 'bytes');
      assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.ok(Number(head.headers.get('content-length')) > 0);

      const forgedHost = await rawRequest(server.port, 'GET /api/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
      assert.match(forgedHost, /^HTTP\/1\.1 403/, 'a Host header that is not this machine is refused');
      const goodHost = await rawRequest(server.port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
      assert.match(goodHost, /^HTTP\/1\.1 200/, 'the local Host header keeps working, curl included');
    });
  });

  test('sec-fetch-site cross-site is rejected', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server, project }) => {
      for (const [route, method, body] of [
        ['/api/file?path=main.tex', undefined, undefined],
        ['/api/pdf?rootFile=main.tex', undefined, undefined],
        ['/api/asset?path=figure.png', undefined, undefined],
        ['/api/tree', undefined, undefined]
      ]) {
        const response = await server.request(route, { method, body, headers: { 'Sec-Fetch-Site': 'cross-site' } });
        await response.body?.cancel();
        assert.equal(response.status, 403, `${route} with Sec-Fetch-Site: cross-site`);
      }
      const sameSite = await server.request('/api/file?path=main.tex', { headers: { 'Sec-Fetch-Site': 'same-site' } });
      await sameSite.body?.cancel();
      assert.equal(sameSite.status, 403, 'same-site is rejected too: this app is served from one origin only');

      for (const allowed of ['same-origin', 'none']) {
        const ok = await server.request('/api/status', { headers: { 'Sec-Fetch-Site': allowed } });
        assert.equal(ok.status, 200, `Sec-Fetch-Site: ${allowed} stays allowed`);
        await ok.body?.cancel();
      }
      // A cross-site page could read a whole thesis through `<img>`/`fetch`; no Origin and no Sec-Fetch-Site
      // means a non-browser client (curl), which stays allowed on purpose.
      const noHeaders = await fetch(`${server.base}/api/status`);
      assert.equal(noHeaders.status, 200);
      const badOrigin = await server.request('/api/status', { headers: { Origin: 'http://evil.example' } });
      assert.equal(badOrigin.status, 403);
      assert.ok(project);
    });
  });

  test('server errors never leak absolute paths', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server }) => {
      const missing = await server.api('/api/file?path=nope.tex');
      assert.equal(missing.status, 404);
      assert.doesNotMatch(missing.text, /\/(Users|private|var|home)\//);
      assert.doesNotMatch(missing.text, /ENOENT|realpath|spawn|no such file/i);
      assert.ok(missing.headers.get('x-content-type-options'), 'JSON answers carry nosniff');
      assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');

      const folder = await server.api('/api/file?path=.');
      assert.equal(folder.status, 400);
      assert.doesNotMatch(folder.text, /\/(Users|private|var)\//);

      const status = await server.api('/api/status');
      assert.equal(status.headers.get('x-content-type-options'), 'nosniff');
    });
  });

  test('oversized JSON body is reported as 413', async () => {
    await withFixture({}, async ({ server }) => {
      const big = JSON.stringify({ path: 'main.tex', content: 'x'.repeat(6_000_000) });
      const response = await server.request('/api/file', {
        method: 'PUT',
        body: big,
        rawBody: true,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(big)) }
      });
      assert.equal(response.status, 413);
      const data = await response.json();
      assert.equal(data.error, '文件太大', 'the 413 must survive jsonBody instead of becoming a 400');
    });
  });

  test('project endpoints report a missing folder as 400', async () => {
    await withFixture({ withProject: false }, async ({ server }) => {
      const missing = await server.api('/api/project/open', 'POST', { path: '/definitely/not/here-42' });
      assert.equal(missing.status, 400);
      assert.equal(missing.data.error, '路径不存在或无法访问');
      assert.doesNotMatch(missing.text, /ENOENT|lstat|no such file/i);
      const chooser = await server.api('/api/project/open', 'POST', { path: '' });
      assert.equal(chooser.status, 400);
    });
  });
});

// ───────────────────────────── project files, assets, cache ─────────────────────────────

describe('project files and assets', () => {
  test('files stay inside the selected folder and external edits are protected', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server, project, sandbox }) => {
      await fs.writeFile(path.join(sandbox, 'secret.tex'), 'private');
      assert.equal((await server.api('/api/file?path=..%2Fsecret.tex')).status, 400);
      assert.equal((await server.api('/api/file?path=%2E%2E%2F%2E%2E%2Fetc%2Fpasswd')).status, 400);

      const saved = await server.api('/api/file?path=main.tex');
      assert.equal(saved.status, 200);
      assert.match(saved.data.content, /总览/);
      assert.equal((await server.api('/api/file', 'PUT', { path: 'main.tex', content: 'edited\n', mtimeMs: saved.data.mtimeMs })).status, 200);

      await fs.writeFile(path.join(project, 'main.tex'), 'changed elsewhere');
      await fs.utimes(path.join(project, 'main.tex'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      const stale = await server.api('/api/file', 'PUT', { path: 'main.tex', content: 'would overwrite', mtimeMs: saved.data.mtimeMs });
      assert.equal(stale.status, 409);
      assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'changed elsewhere');
      assert.equal((await server.api('/api/file', 'PUT', { path: 'main.tex', content: 'forced save', mtimeMs: saved.data.mtimeMs, force: true })).status, 200);
      assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'forced save');

      await fs.symlink(path.join(sandbox, 'secret.tex'), path.join(project, 'linked.tex'));
      assert.equal((await server.api('/api/file?path=linked.tex')).status, 400, 'a symlinked source file is not project content');

      assert.equal((await server.api('/api/file', 'POST', { path: 'sections/intro.tex', content: '\\section{Intro}\n' })).status, 201);
      const intro = await server.api('/api/file?path=sections%2Fintro.tex');
      assert.equal(intro.status, 200);
      assert.match(intro.data.content, /Intro/);
      await fs.symlink(sandbox, path.join(project, 'linked-dir'));
      assert.equal((await server.api('/api/file', 'POST', { path: 'linked-dir/escape.tex', content: 'no' })).status, 400);
      assert.equal((await server.api('/api/file', 'POST', { path: 'main.tex', content: 'dup' })).status, 409);
    });
  });

  test('PUT without mtimeMs does not overwrite external edits', async () => {
    await withFixture({ files: { 'main.tex': 'original\n' } }, async ({ server, project }) => {
      await fs.writeFile(path.join(project, 'main.tex'), 'written by another editor\n');
      const blind = await server.api('/api/file', 'PUT', { path: 'main.tex', content: 'clobbered' });
      assert.equal(blind.status, 400);
      assert.equal(blind.data.error, '请先重新载入文件再保存');
      assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'written by another editor\n');

      const fresh = await server.api('/api/file?path=main.tex');
      assert.equal((await server.api('/api/file', 'PUT', { path: 'main.tex', content: 'merged\n', mtimeMs: fresh.data.mtimeMs })).status, 200);
      assert.equal(await fs.readFile(path.join(project, 'main.tex'), 'utf8'), 'merged\n');
    });
  });

  test('asset endpoint reads through project symlink', async () => {
    await withFixture({ images: { 'plot.png': pngBytes } }, async ({ server, project, sandbox }) => {
      const listed = await server.api('/api/tree');
      const assetPath = listed.data.files.find(file => file.path.endsWith('plot.png')).path;
      const asset = await server.request(`/api/asset?path=${encodeURIComponent(assetPath)}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.equal(asset.headers.get('accept-ranges'), 'bytes', 'assets stream with range support');
      assert.match(asset.headers.get('etag') || '', /^"\d+-\d+"$/);
      await asset.body?.cancel();

      const outsidePng = path.join(sandbox, 'outside.png');
      await fs.writeFile(outsidePng, pngBytes);
      await fs.writeFile(path.join(sandbox, 'plain.txt'), 'not an image');
      await fs.symlink(outsidePng, path.join(project, 'figures', 'link.png'));
      await fs.symlink(path.join(sandbox, 'plain.txt'), path.join(project, 'figures', 'figure.png'));

      const throughSymlink = await server.api(`/api/asset?path=${encodeURIComponent(path.posix.join('figures', 'link.png'))}`);
      assert.equal(throughSymlink.status, 400, 'a symlink is not a project file, whatever it is named');
      const disguised = await server.api(`/api/asset?path=${encodeURIComponent(path.posix.join('figures', 'figure.png'))}`);
      assert.equal(disguised.status, 400, 'a .png suffix on a symlink to a text file is still refused');
      assert.equal((await server.api('/api/asset?path=main.tex')).status, 400, 'non-image extensions stay out');
      assert.doesNotMatch(throughSymlink.text, /\/(Users|private|var)\//);
    });
  });

  test('build clean reports partial failures instead of claiming success', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server, project }) => {
      const buildRoot = path.join(project, '.latex-tools', 'build');
      const fresh = await server.api('/api/build/clean', 'POST', {});
      assert.deepEqual(fresh.data, { ok: true, cleaned: 0, remaining: 0, failures: [] });

      const locked = path.join(buildRoot, 'aaa-locked');
      const free = path.join(buildRoot, 'bbb-free');
      await fs.mkdir(locked, { recursive: true });
      await fs.mkdir(free, { recursive: true });
      await fs.writeFile(path.join(free, 'main.pdf'), '%PDF-1.4');
      const entriesBefore = await fs.readdir(buildRoot);
      assert.equal(entriesBefore.length, 2, 'the fixture built exactly two cache entries');

      // One file the user cannot delete is the smallest way to make a removal fail for real: permissions stay
      // intact, and the flag is cleared again below so the temporary project can still be thrown away.
      const protectedFile = path.join(locked, 'keep.pdf');
      await fs.writeFile(protectedFile, '%PDF-1.4 protected');
      const lock = await run('chflags', ['uchg', protectedFile]);
      assert.equal(lock.code, 0, `the fixture can make one file undeletable: ${lock.stderr}`);
      let partial;
      try {
        partial = await server.api('/api/build/clean', 'POST', {});
      } finally {
        await run('chflags', ['nouchg', protectedFile]);
      }
      assert.equal(partial.status, 200);
      assert.equal(partial.data.ok, false, 'a failed removal must not be reported as a clean cache');
      assert.equal(partial.data.cleaned, entriesBefore.length - 1);
      assert.equal(partial.data.remaining, 1);
      assert.equal(partial.data.failures.length, 1);
      assert.equal(partial.data.failures[0].name, 'aaa-locked');
      assert.doesNotMatch(JSON.stringify(partial.data.failures), /\/(Users|private|var)\//, 'failure reasons stay path-free');
      // Whatever could not be removed is still on disk — that is exactly what `ok: false` tells the user.
      assert.equal(await exists(locked), true, 'the entry that could not be removed is still there');
      assert.equal(await exists(buildRoot), true, 'the cache root stays while something is left inside');

      // Relative expectations: the second round must report exactly what is on disk at that moment, whatever
      // the first round left behind.
      await fs.mkdir(free, { recursive: true });
      await fs.writeFile(path.join(free, 'main.pdf'), '%PDF-1.4');
      const entriesNow = await fs.readdir(buildRoot);
      const second = await server.api('/api/build/clean', 'POST', {});
      assert.equal(second.data.ok, true, JSON.stringify(second.data));
      assert.equal(second.data.cleaned, entriesNow.length);
      assert.equal(second.data.remaining, 0);
      assert.equal(await exists(buildRoot), false, 'the cache directory is gone once everything could be removed');
    });
  });

  test('pdf endpoints block symlinked output', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server, project, sandbox }) => {
      // Put a readable PDF in a directory outside the project and make the whole build root point at it.
      const external = path.join(sandbox, 'external-build');
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(external, 'main.pdf'), '%PDF-1.4 not project content');
      await fs.mkdir(path.join(project, '.latex-tools'), { recursive: true });
      await fs.symlink(external, path.join(project, '.latex-tools', 'build'));

      const pdf = await server.api('/api/pdf?rootFile=main.tex');
      assert.ok([400, 403, 404].includes(pdf.status), `symlinked build root is refused, got ${pdf.status}`);
      assert.doesNotMatch(pdf.text, /not project content/);
      assert.doesNotMatch(pdf.text, /\/(Users|private|var)\//);

      const asset = await server.api('/api/asset?path=%2Elatex-tools%2Fbuild%2Fmain.pdf');
      assert.notEqual(asset.status, 200, 'the generated PDF is never served through the asset endpoint');

      const snippet = await server.api('/api/compile/snippet', 'POST', { source: '\\documentclass{article}\\begin{document}x\\end{document}' });
      assert.equal(snippet.status, 400, 'the snippet compiler refuses to write through a symlinked build root');

      const clean = await server.api('/api/build/clean', 'POST', {});
      assert.equal(clean.status, 400, 'cleanup refuses to rm -rf through a symlink');
      assert.equal(await exists(path.join(external, 'main.pdf')), true, 'the external file was not touched');
    });
  });
});

// ───────────────────────────── search, references, tree, template ─────────────────────────────

const searchFixture = {
  files: {
    'sections/intro.tex': '\\section{引言}\n目标方法目标\n% 目标 注释\n',
    'method.tex': '这里提到 目标 一次\n',
    'references.bib': referencesBib,
    'main.tex': mainTex
  }
};

describe('search and references', () => {
  test('search finds matches across files with editor-relative offsets', async () => {
    await withFixture(searchFixture, async ({ server, sandbox }) => {
      await fs.writeFile(path.join(sandbox, 'secret.tex'), '目标 outside');
      const plain = await server.api('/api/search', 'POST', { query: '目标' });
      assert.equal(plain.status, 200);
      assert.equal(plain.data.matches.length, 3, 'one entry per matching line');
      assert.deepEqual([...new Set(plain.data.matches.map(m => m.file))].sort(), ['method.tex', 'sections/intro.tex']);
      const first = plain.data.matches.find(m => m.file === 'sections/intro.tex' && m.line === 2);
      assert.equal(first.text.slice(first.start, first.start + first.length), '目标');
      assert.equal(plain.data.timedOut, false);
      assert.equal(plain.data.truncated, false);
      assert.equal((await server.api('/api/search', 'POST', { query: 'secret' })).data.matches.length, 0, 'outside files are never searched');
      assert.equal((await server.api('/api/search', 'POST', { query: '目标', caseSensitive: true })).data.matches.length, 3);

      const regex = await server.api('/api/search', 'POST', { query: '目标.*一次', regex: true });
      assert.equal(regex.status, 200);
      assert.equal(regex.data.matches.length, 1);
      assert.equal(regex.data.matches[0].file, 'method.tex');
      assert.equal(regex.data.matches[0].text.slice(regex.data.matches[0].start, regex.data.matches[0].start + regex.data.matches[0].length), '目标 一次');
      assert.equal(regex.data.timedOut, false);

      const unsaved = await server.api('/api/search', 'POST', {
        query: '未保存的新段落',
        active: [{ path: 'method.tex', content: '第一行\n这里有未保存的新段落内容\n' }]
      });
      assert.equal(unsaved.data.matches.length, 1);
      assert.equal(unsaved.data.matches[0].line, 2);
      assert.equal((await server.api('/api/search', 'POST', { query: '' })).status, 400);
    });
  });

  test('invalid regex is reported as regex error', async () => {
    await withFixture(searchFixture, async ({ server }) => {
      const unterminated = await server.api('/api/search', 'POST', { query: '(', regex: true });
      assert.equal(unterminated.status, 400);
      assert.equal(unterminated.data.error, '正则表达式无效');
      const danglingQuantifier = await server.api('/api/search', 'POST', { query: '*', regex: true });
      assert.equal(danglingQuantifier.status, 400);
      // The catastrophic-pattern guard is a different, earlier answer than an uncompilable pattern.
      const nested = await server.api('/api/search', 'POST', { query: '(目标+)+', regex: true });
      assert.equal(nested.status, 400);
      assert.match(nested.data.error, /灾难性回溯/);
    });
  });

  test('search ignores client-supplied limits', async () => {
    const files = { 'main.tex': 'needle in main\n' };
    for (let index = 0; index < 420; index++) {
      files[`lots/f${String(index).padStart(4, '0')}.tex`] = `needle in file ${index}\n`;
    }
    await withFixture({ files }, async ({ server }) => {
      const capped = await server.api('/api/search', 'POST', { query: 'needle', maxFiles: 100_000, maxMatches: 1_000_000, allFiles: true });
      assert.equal(capped.status, 200);
      assert.equal(capped.data.filesSearched, 421, 'allFiles raises the ceiling to its own 2000, not to whatever the client asked');
      assert.equal(capped.data.truncated, false, 'everything that exists was searched, so nothing was truncated');
      // Without `allFiles`, 420 text files cannot all be searched no matter what the request body says.
      const clamped = await server.api('/api/search', 'POST', { query: 'needle', maxFiles: 100_000, maxMatches: 1_000_000 });
      assert.ok(clamped.data.filesSearched <= 400, `maxFiles is clamped to 400, got ${clamped.data.filesSearched}`);
      assert.equal(clamped.data.truncated, true, 'a scan that stopped early says so');

      const matchesCapped = await server.api('/api/search', 'POST', { query: 'needle', maxMatches: 1_000_000, allFiles: true });
      assert.ok(matchesCapped.data.matches.length <= 400);
      const small = await server.api('/api/search', 'POST', { query: 'needle', maxMatches: 3 });
      assert.equal(small.data.matches.length, 3);
      assert.equal(small.data.truncated, true);
    });
  });

  test('search reports truncation and times out on catastrophic regex', async () => {
    const line = `${'a'.repeat(45)}b`;
    await withFixture({ files: { 'evil.tex': `prefix ${line} suffix\n`, 'main.tex': mainTex } }, async ({ server }) => {
      const nested = await server.api('/api/search', 'POST', { query: '(a+)+$', regex: true });
      assert.equal(nested.status, 400, 'the entry heuristic refuses (a+)+ before any scanning starts');
      assert.match(nested.data.error, /灾难性回溯/);

      // The heuristic is a mitigation, not a guarantee: this one slips through, so the worker hard timeout has
      // to stop it. The `/api/status` probe right after is the assertion that matters — the event loop stayed
      // free the whole time, so compiles and saves are not queued behind somebody's regex.
      const startedAt = Date.now();
      const runaway = await server.api('/api/search', 'POST', { query: '(?:a|aa)+$', regex: true });
      const elapsed = Date.now() - startedAt;
      assert.equal(runaway.status, 200, 'a runaway pattern answers, it never becomes a 500');
      assert.equal(runaway.data.timedOut, true, JSON.stringify(runaway.data));
      assert.ok(elapsed < 8_000, `the scan was cut off at the budget, took ${elapsed}ms`);
      const probeStart = Date.now();
      assert.equal((await server.api('/api/status')).status, 200);
      assert.ok(Date.now() - probeStart < 1_000, 'the service answered immediately while the pattern was burning');

      const files = { 'many/a.tex': 'needle one\n', 'many/b.tex': 'needle two\n' };
      await withFixture({ files }, async second => {
        const hit = await second.server.api('/api/search', 'POST', { query: 'needle', maxMatches: 1 });
        assert.equal(hit.data.matches.length, 1);
        assert.equal(hit.data.truncated, true);
      });
    });
  });

  test('references accept multiple unsaved buffers', async () => {
    const buffers = [
      { path: 'sections/one.tex', content: '\\section{未保存一}\\label{sec:one}\n这里有十二个中文字符在呀\n' },
      { path: 'sections/two.tex', content: '\\section{未保存二}\\label{sec:two}\n五个中文字\n' }
    ];
    const diskFiles = {
      'main.tex': mainTex,
      'sections/one.tex': '\\section{磁盘一}\\label{sec:disk-one}\n磁盘上的旧内容啊啊啊啊啊啊\n',
      'sections/two.tex': '\\section{磁盘二}\n另一段磁盘内容哦\n'
    };
    await withFixture({ files: diskFiles }, async ({ server }) => {
      const baseline = await server.api('/api/references', 'POST', { rootFile: 'main.tex' });
      const asArray = await server.api('/api/references', 'POST', { rootFile: 'main.tex', active: buffers });
      assert.equal(asArray.status, 200);
      for (const key of ['sec:one', 'sec:two']) {
        assert.ok(asArray.data.labels.some(label => label.key === key), `${key} only exists in the unsaved buffer`);
      }
      assert.equal(asArray.data.labels.some(label => label.key === 'sec:disk-one'), false, 'the buffer replaced the file, nothing was merged');

      // The counts are compared with a project where the very same text lives on disk: that asserts both
      // buffers were used without hard-coding what the counter does to `\section{}`.
      const onDisk = {
        'main.tex': mainTex,
        'sections/one.tex': buffers[0].content,
        'sections/two.tex': buffers[1].content
      };
      await withFixture({ files: onDisk }, async reference => {
        const expected = await reference.server.api('/api/references', 'POST', { rootFile: 'main.tex' });
        assert.ok(expected.data.wordCounts['sections/one.tex'].cjk > 10);
        const asSingle = await server.api('/api/references', 'POST', { rootFile: 'main.tex', active: buffers[0] });
        assert.equal(asSingle.data.wordCounts['sections/one.tex'].cjk, expected.data.wordCounts['sections/one.tex'].cjk);
        assert.equal(asSingle.data.wordCounts['sections/two.tex'].cjk, baseline.data.wordCounts['sections/two.tex'].cjk, 'the file nobody is editing is still read from disk');
        assert.ok(asSingle.data.labels.some(label => label.key === 'sec:one'));
        assert.equal(asSingle.data.labels.some(label => label.key === 'sec:two'), false, 'a single object still behaves like before');
      });
    });
  });

  test('references return bib entries, outline, labels and word counts', async () => {
    await withFixture({
      files: {
        'main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{总览}\n\\input{sections/intro}\n\\section{实验与结果}\\label{sec:exp}\n中文测试 English words.\n\\end{document}\n',
        'sections/intro.tex': '\\section{磁盘}\n',
        'references.bib': referencesBib
      }
    }, async ({ server }) => {
      const refs = await server.api('/api/references', 'POST', {
        rootFile: 'main.tex',
        active: { path: 'sections/intro.tex', content: '\\subsection{问题定义 \\textbf{核心}}\\label{sec:prob}\n这里有十个中文字符啊。\n' }
      });
      assert.equal(refs.status, 200);
      assert.equal(refs.data.bib.length, 1);
      assert.equal(refs.data.bib[0].key, 'vaswani2017');
      assert.equal(refs.data.bib[0].line, 2);
      assert.deepEqual(
        refs.data.projectOutline.filter(h => ['main.tex', 'sections/intro.tex'].includes(h.file)).map(h => `${h.file}:${h.title}`),
        ['main.tex:总览', 'sections/intro.tex:问题定义 \\textbf{核心}', 'main.tex:实验与结果']
      );
      assert.equal(refs.data.wordCounts['sections/intro.tex'].cjk, 16);
      assert.equal(refs.data.labels.some(l => l.key === 'sec:prob' && l.file === 'sections/intro.tex'), true);
    });
  });

  test('synctex resolves in-project coordinates and ignores outside paths', async () => {
    await withFixture({ files: { 'main.tex': mainTex, 'sections/intro.tex': '\\subsection{问题定义}\\label{sec:prob}\n这里有十个中文字符啊。\n' } }, async ({ server, project, sandbox }) => {
      const buildId = crypto.createHash('sha256').update('main.tex').digest('hex').slice(0, 12);
      const buildDir = path.join(project, '.latex-tools', 'build', buildId);
      await fs.mkdir(buildDir, { recursive: true });
      const sp = bp => Math.round(bp * 65781.76);
      const synctexText = [
        'SyncTeX Version:1',
        `Input:1:${path.join(project, 'main.tex')}`,
        `Input:2:${path.join(project, 'sections', 'intro.tex')}`,
        `Input:3:${path.join(sandbox, 'secret.tex')}`,
        'Magnification:1000',
        'Unit:1',
        'X Offset:0',
        'Y Offset:0',
        'Content:',
        '{1',
        `[1,1:${sp(72)},${sp(700)}:${sp(400)},${sp(600)},0`,
        `(1,3:${sp(72)},${sp(120)}:${sp(220)},${sp(12)},${sp(3)}`,
        ']',
        '}',
        '{2',
        `(2,12:${sp(80)},${sp(240)}:${sp(300)},${sp(11)},${sp(3)}`,
        `(3,1:${sp(80)},${sp(300)}:${sp(200)},${sp(11)},${sp(3)}`,
        '}'
      ].join('\n');
      await fs.writeFile(path.join(buildDir, 'main.synctex.gz'), zlib.gzipSync(Buffer.from(synctexText, 'utf8')));

      const fwd = await server.api('/api/synctex/forward', 'POST', { rootFile: 'main.tex', file: 'sections/intro.tex', line: 12 });
      assert.equal(fwd.status, 200);
      assert.equal(fwd.data.found, true);
      assert.equal(fwd.data.page, 2);
      assert.ok(Math.abs(fwd.data.x - 80) < 1);
      assert.ok(Math.abs(fwd.data.y - 229) < 1);

      const rev = await server.api('/api/synctex/reverse', 'POST', { rootFile: 'main.tex', page: 2, x: 110, y: 235 });
      assert.equal(rev.data.found, true);
      assert.equal(rev.data.file, 'sections/intro.tex');
      assert.equal(rev.data.line, 12);
      const revOutside = await server.api('/api/synctex/reverse', 'POST', { rootFile: 'main.tex', page: 2, x: 110, y: 298 });
      assert.equal(revOutside.data.file, 'sections/intro.tex', 'the outside Input:3 entry is never exposed');
    });
  });

  test('synctex endpoints degrade without a build and clamp coordinates', async () => {
    await withFixture({ files: { 'main.tex': mainTex } }, async ({ server }) => {
      const forward = await server.api('/api/synctex/forward', 'POST', { rootFile: 'main.tex', file: 'main.tex', line: 12 });
      assert.equal(forward.status, 200);
      assert.deepEqual(forward.data, { found: false });

      for (const payload of [
        { rootFile: 'main.tex', file: 'main.tex', line: 0 },
        { rootFile: 'main.tex', file: 'main.tex', line: -5 },
        { rootFile: 'main.tex', file: 'main.tex', line: 'abc' },
        { rootFile: 'main.tex', file: 'main.tex' }
      ]) {
        const response = await server.api('/api/synctex/forward', 'POST', payload);
        assert.equal(response.status, 200, JSON.stringify(payload));
        assert.equal(response.data.found, false);
      }
      for (const payload of [
        { rootFile: 'main.tex', page: NaN, x: 0, y: 0 },
        { rootFile: 'main.tex', page: 0, x: -10, y: -10 },
        { rootFile: 'main.tex', page: 'seven', x: 'wide', y: 'high' }
      ]) {
        const response = await server.api('/api/synctex/reverse', 'POST', payload);
        assert.equal(response.status, 200, JSON.stringify(payload));
        assert.equal(response.data.found, false);
      }
      const missingFile = await server.api('/api/synctex/forward', 'POST', { rootFile: 'main.tex', file: 'nope.tex', line: 3 });
      assert.equal(missingFile.status, 404, 'an unknown file is a 404 with a friendly message');
      assert.doesNotMatch(missingFile.text, /ENOENT|\/(Users|private)\//);
    });
  });

  test('tree reports truncation for big projects', async () => {
    const files = {};
    for (let index = 0; index < 850; index++) {
      files[`big/dir${index % 40}/f${String(index).padStart(4, '0')}.tex`] = `\\section{${index}}\n`;
    }
    await withFixture({ files }, async ({ server }) => {
      const tree = await server.api('/api/tree');
      assert.equal(tree.status, 200);
      assert.ok(tree.data.files.length <= 800, `the listing stops at the cap, got ${tree.data.files.length}`);
      assert.equal(tree.data.truncated, true, 'the browser must be able to say 看不到的文件仍然存在');
      const probe = await server.api('/api/tree');
      assert.equal(probe.data.truncated, true, 'the answer does not depend on the cache being fresh');
      assert.ok(tree.data.files[0].path < tree.data.files[tree.data.files.length - 1].path, 'the listing is sorted once, from the root');
    });
  });

  test('tree stays small and honest for ordinary projects', async () => {
    await withFixture({ files: { 'main.tex': mainTex, 'sections/intro.tex': '\\section{a}\n' } }, async ({ server }) => {
      const tree = await server.api('/api/tree');
      assert.equal(tree.data.truncated, false);
      assert.deepEqual(tree.data.files.map(file => file.path), ['main.tex', 'sections/intro.tex']);
    });
  });
});

describe('templates', () => {
  test('template endpoint rejects unknown and inherited kinds', async () => {
    await withFixture({}, async ({ server, project }) => {
      for (const kind of ['constructor', '__proto__', 'toString', 'nope', '', 42]) {
        const response = await server.api('/api/template', 'POST', { kind });
        assert.equal(response.status, 400, `kind ${JSON.stringify(kind)} is unknown, not inherited`);
        assert.equal(response.data.error, '未知模板');
      }
      assert.deepEqual(await fs.readdir(project), [], 'a rejected template wrote nothing at all');
    });
  });

  test('template endpoint creates the second file when the first write fails', async () => {
    await withFixture({ files: { 'references.bib': '% already there\n' } }, async ({ server, project }) => {
      const blocked = await server.api('/api/template', 'POST', { kind: 'chinese' });
      assert.equal(blocked.status, 409);
      assert.match(blocked.data.error, /references\.bib 已存在/);
      // Both names are checked before anything is written, so a collision never leaves a half-written pair.
      assert.equal(await exists(path.join(project, 'main.tex')), false, 'main.tex must not exist when references.bib blocked the template');
      assert.equal(await fs.readFile(path.join(project, 'references.bib'), 'utf8'), '% already there\n');

      const withoutJson = await server.request('/api/template', { method: 'POST', body: { kind: 'chinese' }, rawBody: 'kind=chinese', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      assert.equal(withoutJson.status, 415);

      await fs.rm(path.join(project, 'references.bib'));
      const created = await server.api('/api/template', 'POST', { kind: 'chinese' });
      assert.equal(created.status, 201);
      assert.deepEqual((await fs.readdir(project)).sort(), ['main.tex', 'references.bib']);
      assert.equal((await server.api('/api/template', 'POST', { kind: 'chinese' })).status, 409, 'a second call cannot overwrite either');
      const tree = await server.api('/api/tree');
      assert.deepEqual(tree.data.files.map(file => file.path).sort(), ['main.tex', 'references.bib'], 'the file index noticed the new files at once');
    });
  });
});

// ───────────────────────────── compilation (fake Tectonic, never real TeX) ─────────────────────────────

// The engine is a shell script: it sees the same argv Tectonic gets (`-X compile … --outdir <dir> <file>.tex`),
// so a test can inspect what the server asked for and decide what the "build" produced.
function fakeEngine(body) {
  return `
src=""
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--outdir" ]; then outdir="$arg"; fi
  prev="$arg"
  src="$arg"
done
stem=$(basename "$src" .tex)
if [ -n "\${YANTAI_ENGINE_LOG:-}" ]; then
  echo "$@" >> "$YANTAI_ENGINE_LOG"
fi
${body}
`;
}

async function engineCalls(logFile) {
  const text = await fs.readFile(logFile, 'utf8').catch(() => '');
  return text ? text.trim().split('\n') : [];
}

async function waitFor(condition, timeoutMs = 8_000, message = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`);
    await sleep(80);
  }
}

describe('compilation contract', () => {
  test('compile locks the project synchronously and releases the slot on engine spawn failure', async () => {
    const fixture = await createFixture({
      files: { 'main.tex': mainTex },
      engine: fakeEngine('sleep 30'),
      barePath: true
    });
    const { server, bin } = fixture;
    try {
      const running = server.api('/api/compile', 'POST', { rootFile: 'main.tex', token: 'tok-running' });
      const [full, snippet] = await Promise.all([
        server.api('/api/compile', 'POST', { rootFile: 'main.tex' }),
        server.api('/api/compile/snippet', 'POST', { source: '\\begin{document}x\\end{document}' })
      ]);
      assert.equal(full.status, 409, 'a second full compile is refused while one is running');
      assert.equal(full.data.error, '已有编译任务正在进行');
      assert.equal(snippet.status, 409, 'a snippet compile is refused too');

      await waitFor(async () => (await engineCalls(fixture.logFile)).length >= 1, 8_000, 'the engine started');
      const cancel = await server.api('/api/compile/cancel', 'POST', { token: 'tok-running' });
      assert.deepEqual(cancel.data, { ok: true, cancelled: true });
      const cancelled = await running;
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.data.cancelled, true);

      // A token that no longer belongs to a running job is answered, never 404.
      const stale = await server.api('/api/compile/cancel', 'POST', { token: 'tok-running' });
      assert.equal(stale.status, 200);
      assert.deepEqual(stale.data, { ok: true, cancelled: false });
      const unknown = await server.api('/api/compile/cancel', 'POST', { token: 'never-sent' });
      assert.deepEqual(unknown.data, { ok: true, cancelled: false });
      const invalid = await server.api('/api/compile/cancel', 'POST', { token: 'bad token!' });
      assert.equal(invalid.status, 400);

      const calls = await engineCalls(fixture.logFile);
      assert.equal(calls.length, 1, `exactly one engine ever ran, saw ${calls.length}: ${calls.join(' | ')}`);

      // A file the user cannot execute is the closest portable stand-in for a broken installation.
      // Make the engine impossible to start. The compile must resolve with an error and, above all, must
      // release the lock — a rejected `run()` used to leave every later compile answering 409 forever.
      await fs.rm(path.join(bin, 'tectonic'));
      const broken = await server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(broken.status, 500);
      assert.doesNotMatch(broken.text, /\/(Users|private|var)\//);
      assert.doesNotMatch(broken.text, /ENOENT|EACCES|spawn|realpath/i);

      await fs.writeFile(path.join(bin, 'tectonic'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const recovered = await server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(recovered.status, 200, 'the slot was released even though the engine never started');
      assert.equal(recovered.data.cancelled, false);
      const recoveredSnippet = await server.api('/api/compile/snippet', 'POST', { source: '\\begin{document}x\\end{document}' });
      assert.equal(recoveredSnippet.status, 200);
    } finally {
      await fixture.close();
    }
  });

  test('compile surfaces a missing tectonic binary as a readable error', async () => {
    await withFixture({ files: { 'main.tex': mainTex }, engine: 'missing' }, async ({ server }) => {
      const response = await server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(response.status, 500);
      assert.equal(response.data.error, '本机未找到 Tectonic，请先安装：brew install tectonic');
      assert.doesNotMatch(response.text, /\/(Users|private|var|opt)\//);
      assert.doesNotMatch(response.text, /ENOENT|spawn|realpath|ENOENT/i);

      const snippet = await server.api('/api/compile/snippet', 'POST', { source: '\\begin{document}x\\end{document}' });
      assert.equal(snippet.status, 500);
      assert.equal(snippet.data.error, '本机未找到 Tectonic，请先安装：brew install tectonic');
      // The service is still serving after a failed engine: a locked slot would show up as a 409 here.
      assert.equal((await server.api('/api/tree')).status, 200);
    });
  });

  test('compile clears stale log and synctex before the engine starts', async () => {
    const fixture = await createFixture({ files: { 'main.tex': mainTex }, engine: fakeEngine('exit 1') });
    try {
      const buildDir = fixture.buildDirOf('main.tex');
      await fs.mkdir(buildDir, { recursive: true });
      await fs.writeFile(path.join(buildDir, 'main.log'), 'Stale log from the previous run\n');
      await fs.writeFile(path.join(buildDir, 'main.synctex.gz'), zlib.gzipSync(Buffer.from('Stale SyncTeX', 'utf8')));
      await fs.writeFile(path.join(buildDir, 'main.aux'), '\\relax\n');
      await fs.writeFile(path.join(buildDir, 'main.bbl'), '\\begin{thebibliography}\n');
      await fs.writeFile(path.join(buildDir, 'main.pdf'), '%PDF-1.4 the last readable version');

      const response = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(response.status, 200);
      const engineArguments = (await engineCalls(fixture.logFile))[0];
      assert.ok(engineArguments.includes('--synctex'), 'the engine is asked for a SyncTeX map');
      assert.equal(response.data.ok, false);
      assert.equal(response.data.synctexAvailable, false, 'a stale map would position the editor on the wrong line');

      const survivors = await fs.readdir(buildDir);
      assert.deepEqual(survivors, ['main.pdf'], `.pdf is the only thing kept: ${survivors.join(', ')}`);
      assert.equal(await fs.readFile(path.join(buildDir, 'main.pdf'), 'utf8'), '%PDF-1.4 the last readable version');
    } finally {
      await fixture.close();
    }
  });

  test('compile reports stale artifacts after a failed build', async () => {
    let calls = 0;
    const engine = fakeEngine(`
n=$(cat "$YANTAI_ENGINE_COUNT" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$YANTAI_ENGINE_COUNT"
if [ "$n" = "1" ]; then
  printf '%%PDF-1.4 first good run' > "$outdir/$stem.pdf"
  printf 'synctex' | gzip > "$outdir/$stem.synctex.gz"
  printf 'This is a log.\\n' > "$outdir/$stem.log"
  exit 0
fi
printf 'error: something exploded\n' >&2
printf 'run 2 log\\n! LaTeX Error: Something broke.\nl.7 boom\\n' > "$outdir/$stem.log"
exit 1
`);
    const fixture = await createFixture({ files: { 'main.tex': mainTex }, engine });
    try {
      const first = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(first.status, 200);
      assert.equal(first.data.ok, true);
      assert.equal(first.data.pdfAvailable, true);
      assert.equal(first.data.pdfFresh, true);
      assert.equal(first.data.pdfStale, false);
      assert.equal(first.data.synctexAvailable, true);
      const goodFingerprint = first.data.pdfFingerprint;
      assert.match(goodFingerprint, /^\d+-\d+$/);
      assert.ok(first.data.pdfUrl.includes(`v=${encodeURIComponent(goodFingerprint)}`), `the version is the content fingerprint: ${first.data.pdfUrl}`);
      assert.ok(!first.data.pdfUrl.includes(String(Date.now())), 'not a per-request timestamp');

      const second = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(second.status, 200);
      assert.equal(second.data.ok, false);
      assert.equal(second.data.timedOut, false);
      assert.equal(second.data.cancelled, false);
      assert.equal(second.data.pdfAvailable, true, 'the author still wants the last good PDF after a failed run');
      assert.equal(second.data.pdfFresh, false);
      assert.equal(second.data.pdfStale, true, 'an untouched PDF is never reported as this run\'s result');
      assert.equal(second.data.synctexAvailable, false);
      assert.equal(second.data.pdfFingerprint, goodFingerprint, 'the unchanged PDF keeps its fingerprint, so the browser keeps its copy');
      const failureMessages = second.data.diagnostics.map(item => item.message);
      assert.ok(failureMessages.some(message => /Something broke/.test(message)), `the .log is parsed too: ${JSON.stringify(failureMessages)}`);
      const located = second.data.diagnostics.find(item => /Something broke/.test(item.message));
      assert.equal(located.file, 'main.tex');
      assert.equal(located.line, 7);
    } finally {
      await fixture.close();
    }
  });

  test('cancelled compile reports no outputs', async () => {
    const engine = fakeEngine(`
printf '%%PDF-1.4 half written by the cancelled run' > "$outdir/$stem.pdf"
printf 'synctex' | gzip > "$outdir/$stem.synctex.gz"
printf 'partial log\\n' > "$outdir/$stem.log"
echo "$$" > "$YANTAI_ENGINE_PID"
trap 'echo INT >> "$YANTAI_ENGINE_SIGNALS"; exit 130' INT
sleep 30
`);
    const fixture = await createFixture({ files: { 'main.tex': mainTex }, engine });
    try {
      const running = fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex', token: 'tok-cancel' });
      const buildDir = fixture.buildDirOf('main.tex');
      await waitFor(async () => exists(path.join(buildDir, 'main.pdf')), 8_000, 'the engine wrote its artefacts');
      const cancel = await fixture.server.api('/api/compile/cancel', 'POST', { token: 'tok-cancel' });
      assert.deepEqual(cancel.data, { ok: true, cancelled: true });

      const cancelled = await running;
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.data.cancelled, true);
      assert.equal(cancelled.data.ok, false);
      assert.equal(cancelled.data.timedOut, false);
      assert.equal(cancelled.data.output, '', 'a cancelled run has no log to show');
      assert.deepEqual(cancelled.data.diagnostics, []);
      assert.ok(Number.isFinite(cancelled.data.durationMs), 'the wall time it did run is reported honestly');
      assert.equal(cancelled.data.pdfAvailable, false);
      assert.equal(cancelled.data.pdfUrl, null);
      assert.equal(cancelled.data.synctexAvailable, false);

      // Cancelling reports nothing as its own result, but it does not reach into the output directory either:
      // the file on disk is judged by its mtime by the next real compile (see the stale-build test).
      assert.equal(await exists(path.join(buildDir, 'main.pdf')), true);
      const signalsSeen = await fs.readFile(fixture.engineSignals, 'utf8').catch(() => '');
      assert.match(signalsSeen, /INT/, 'the user cancel path uses SIGINT so TeX can flush a readable log');

      // Swap in a cooperative engine: the point of this last call is the freed slot, not another 30 s sleep.
      await fs.writeFile(path.join(fixture.bin, 'tectonic'), `#!/bin/sh\n${fakeEngine('exit 0')}\n`, { mode: 0o755 });
      const next = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(next.status, 200, 'the slot is free again after a cancel');
      assert.equal(next.data.timedOut, false);
    } finally {
      await fixture.close();
    }
  });

  test('compile timeout kills the engine group and releases the compile slot', async () => {
    // The clock has to stay well above "time it takes macOS to exec a shell script under a loaded test run":
    // with 700 ms the timer used to fire before the fake engine had run a single line, which proved nothing
    // about the kill path. The engine announces itself, so a missing pid file means "never started".
    const engine = fakeEngine(`
echo "$$" > "$YANTAI_ENGINE_PID"
trap 'echo TERM >> "$YANTAI_ENGINE_SIGNALS"; exit 143' TERM
sleep 60 &
echo "$!" >> "$YANTAI_ENGINE_PID"
wait
`);
    const fixture = await createFixture({
      files: { 'main.tex': mainTex },
      engine,
      env: { YANTAI_COMPILE_TIMEOUT_MS: '3000' }
    });
    try {
      const startedAt = Date.now();
      const response = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200);
      assert.equal(response.data.timedOut, true, JSON.stringify(response.data));
      assert.equal(response.data.cancelled, false);
      assert.equal(response.data.ok, false);
      assert.ok(elapsed >= 2_800 && elapsed < 12_000, `the timeout was honoured, took ${elapsed}ms`);

      const signalsSeen = await fs.readFile(fixture.engineSignals, 'utf8').catch(() => '');
      assert.match(signalsSeen, /TERM/, 'a wedged engine is stopped with SIGTERM, not SIGINT it may sit on');
      // The whole point of the process group: the engine *and* the grandchild it were waiting on must be gone.
      await waitFor(async () => {
        const written = (await fs.readFile(fixture.enginePids, 'utf8').catch(() => '')).trim();
        if (!written) return false;
        for (const pid of written.split(/\s+/).filter(Boolean)) if (await pidAlive(Number(pid))) return false;
        return true;
      }, 8_000, 'the engine process group to be gone');
      assert.deepEqual(runningChildren(), [], 'no fake engine child is left behind');

      // Same fixture, cooperative engine now: what matters is that the slot came back after the timeout.
      await fs.writeFile(path.join(fixture.bin, 'tectonic'), `#!/bin/sh\n${fakeEngine('exit 0')}\n`, { mode: 0o755 });
      const next = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(next.status, 200, 'the compile slot was released after the timeout');
      assert.equal(next.data.timedOut, false, 'the next run got a compile, not an inherited timeout');
    } finally {
      await fixture.close();
    }
  });

  test('compile endpoint survives SIGTERM when the browser reloads', async () => {
    const engine = fakeEngine(`
echo "$$" > "$YANTAI_ENGINE_PID"
( trap '' TERM; sleep 30 ) &
echo "$!" >> "$YANTAI_ENGINE_PID"
wait
`);
    const fixture = await createFixture({ files: { 'main.tex': mainTex }, engine });
    try {
      const pending = fixture.server.request('/api/compile', { method: 'POST', body: { rootFile: 'main.tex' } });
      // Let the engine actually get going before pulling the plug: shutdown has a live process group to reap,
      // which is the thing under test.
      await waitFor(async () => (await fs.readFile(fixture.enginePids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length >= 2, 8_000, 'the engine started');
      // A browser reload closes the connection: that must not take the server down, and the compile must still
      // be cancellable / finishable.
      const pendingResult = await Promise.race([pending.then(() => 'done'), sleep(600).then(() => 'pending')]);
      assert.equal(pendingResult, 'pending', 'the compile keeps running after a reload-style disconnect');

      const status = await fixture.server.api('/api/status');
      assert.equal(status.status, 200, 'the service is alive after the client vanished');

      // Now stop the server the way stop.sh does, mid-compile.
      await fixture.server.close();
      const outcome = await pending.then(() => 'resolved', () => 'rejected');
      assert.ok(['resolved', 'rejected'].includes(outcome));
      await waitFor(async () => {
        const written = (await fs.readFile(fixture.enginePids, 'utf8').catch(() => '')).trim();
        if (!written) return false;
        for (const pid of written.split(/\s+/).filter(Boolean)) if (await pidAlive(Number(pid))) return false;
        return true;
      }, 8_000, 'no engine left writing into the build directory after shutdown');
      assert.deepEqual(runningChildren(), []);
    } finally {
      await fixture.close();
    }
  });

  test('snippet diagnostics keep a resolvable file when editorFile is omitted', async () => {
    const engine = fakeEngine(`
printf "! LaTeX Error: File 'nope.sty' not found.\n" > "$outdir/$stem.log"
printf "run 2 log\nl.4 nope\n" >> "$outdir/$stem.log"
exit 1
`);
    const fixture = await createFixture({ files: { 'main.tex': mainTex }, engine });
    try {
      const response = await fixture.server.api('/api/compile/snippet', 'POST', { source: '\\usepackage{nope}\n\\begin{document}\nx\n\\end{document}\n', fromLine: 3 });
      assert.equal(response.status, 200);
      assert.equal(response.data.snippet, true);
      assert.equal(response.data.ok, false);
      assert.ok(response.data.diagnostics.length > 0, 'the failure produced at least one diagnostic');
      for (const item of response.data.diagnostics) {
        assert.ok(item.file, `no diagnostic may come back without a file: ${JSON.stringify(item)}`);
        assert.equal(item.file, 'snippet.tex', 'without editorFile the wrapper file is named, not null');
      }
      assert.ok(response.data.pdfUrl.startsWith('/api/pdf?snippet=1&v='), response.data.pdfUrl);
    } finally {
      await fixture.close();
    }
  });

  test('snippet error lines map back to the editor file', async () => {
    const editorSource = [
      '\\documentclass{article}',
      '\\begin{document}',
      '',
      '上一段',
      '\\begin{equation}',
      'x = \\frac{1',
      '} \\end{equation}'
    ].join('\n');
    // Same shape the frontend sends: the client builds `preamble + \pagestyle + \begin{document} + selection`
    // itself and reports the body start, so the server only has to translate `l.<line>` back by
    // `fromLine + (snippetLine - bodyStart)`.
    const selection = 'x = \\frac{1\n}';
    const fromLine = 6;
    const preamble = '\\documentclass{article}\n\\usepackage{amsmath}';
    const bodyStart = preamble.split('\n').length + 4;
    const source = `${preamble}\n\\pagestyle{empty}\n\\begin{document}\n${selection}\n\\end{document}\n`;
    const engine = fakeEngine(`
printf '! Missing $ inserted.\\nl.%s  x = \\\\frac{1\\n' "$line_under_test" > "$outdir/$stem.log"
exit 1
`.replace('$line_under_test', String(bodyStart)));
    const fixture = await createFixture({ files: { 'main.tex': `${editorSource}\n` }, engine });
    try {
      const response = await fixture.server.api('/api/compile/snippet', 'POST', {
        source,
        editorFile: 'main.tex',
        rootFile: 'main.tex',
        fromLine,
        bodyStart
      });
      assert.equal(response.status, 200);
      assert.equal(response.data.ok, false);
      const engineArgs = (await engineCalls(fixture.logFile))[0] || '';
      assert.match(engineArgs, /--outdir/);
      const error = response.data.diagnostics.find(item => /Missing \$/.test(item.message));
      assert.ok(error, `expected the wrapped error, got ${JSON.stringify(response.data.diagnostics)}`);
      assert.equal(error.file, 'main.tex', 'the snippet error is attributed to the editor file');
      assert.equal(error.line, fromLine, `body line ${bodyStart} in the snippet is line ${fromLine} in the editor: ${JSON.stringify(error)}`);
    } finally {
      await fixture.close();
    }
  });

  test('snippet artifacts stay in _snippet and leave the source tree clean', async () => {
    const engine = fakeEngine(`
printf '%%PDF-1.4 snippet' > "$outdir/snippet.pdf"
printf 'log\\n' > "$outdir/snippet.log"
exit 0
`);
    const fixture = await createFixture({ files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\n正文\n\\end{document}\n' }, engine });
    try {
      const before = (await fs.readdir(fixture.project)).filter(name => !name.startsWith('.'));
      const response = await fixture.server.api('/api/compile/snippet', 'POST', { source: '正文片段', editorFile: 'main.tex', rootFile: 'main.tex', fromLine: 3, bodyStart: 3 });
      assert.equal(response.status, 200);
      assert.equal(response.data.ok, true);
      assert.equal(response.data.pdfAvailable, true);
      assert.equal(response.data.pdfStale, false, 'the snippet PDF this run produced is fresh');

      const tree = await fixture.server.api('/api/tree');
      assert.deepEqual(tree.data.files.map(file => file.path), ['main.tex'], 'the tree never shows build output');
      assert.deepEqual((await fs.readdir(fixture.project)).filter(name => !name.startsWith('.')), before, 'the source tree is untouched');
      const snippetDir = path.join(fixture.project, '.latex-tools', 'build', '_snippet');
      assert.deepEqual((await fs.readdir(snippetDir)).sort(), ['snippet.log', 'snippet.pdf', 'snippet.tex']);
      const engineArgs = (await engineCalls(fixture.logFile))[0];
      assert.match(engineArgs, new RegExp(`--outdir ${snippetDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), 'the engine writes straight into _snippet');
      assert.match(engineArgs, /search-path=/);

      const pdf = await fixture.server.request('/api/pdf?snippet=1');
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(await pdf.text(), '%PDF-1.4 snippet');
    } finally {
      await fixture.close();
    }
  });
});

describe('diagnostics', () => {
  test('compile parses TeX, BibTeX and log-file diagnostics into jumpable locations', async () => {
    // A thesis-shaped project: ownership is decided by matching the names the engine prints against the real
    // project listing, so the files have to exist for the parser to attribute anything. The claimed line numbers
    // point at the text each message talks about, which is what "jumpable" is supposed to mean.
    const thesisTex = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{总览}',
      '\\undefinedcommand alpha',
      '公式 x_3_4 写错了',
      '图~\\ref{fig:missing} 见文献~\\cite{nosuchkey}。\\label{sec:a}',
      '\\input{sections/bad}',
      '\\end{document}',
      ''
    ].join('\n');
    const badTex = [
      '% 这一节故意留着错',
      '',
      '\\section{坏掉的一节}',
      '',
      '前后都有正文。',
      '',
      'bad x^2_3 here',
      ''
    ].join('\n');

    // Captured by the lead from a real `tectonic -X compile --keep-logs` run (Tectonic 0.17, 2026-11-12) rather
    // than invented: the shape of TeX's `(`…`)` file chatter, the `! …` + `l.N` pair and BibTeX's
    // `---line N of file X` trailer is the whole subject of the case.
    const engineReported = [
      'note: Running TeX ...',
      '(main.tex',
      'LaTeX2e <2021-11-15> patch level 1',
      'No file main.aux.',
      '! Undefined control sequence.',
      'l.4 \\undefinedcommand',
      '                      alpha',
      'error: Undefined control sequence.',
      '! Double subscript.',
      'l.5 公式 x_3_4 写错了',
      'error: Double subscript.',
      '(sections/bad.tex',
      '! Missing $ inserted.',
      'l.7 bad x^2_3 here',
      ')',
      '--I\'m broken somewhere. Probably a missing comma.---line 7 of file references.bib',
      ' I\'m skipping whatever remains after this entry',
      '! Undefined control sequence.',
      'l.20 \\anotherBad',
      '! Undefined control sequence.',
      'l.21 \\yetAnother',
      'error: Malformed specification of a blxa name ...',
      'note: Writing `build/main.log`'
    ].join('\n');
    // One bad macro in a class file really does print a hundred-plus errors across a thesis; this is the flood.
    const floodReported = [
      '(main.tex',
      ...Array.from({ length: 120 }, (_, index) => [
        '! Undefined control sequence.',
        `l.${10 + index} \\undefinedFlood${index}`,
        '% Ok'
      ]).flat(),
      ')'
    ].join('\n');
    const logReported = [
      'LaTeX Warning: Reference `fig:missing\' on page 1 undefined on input line 6.',
      'LaTeX Warning: Citation `nosuchkey\' on page 1 undefined on input line 6.',
      'LaTeX Warning: Label `sec:a\' multiply defined.'
    ].join('\n');

    // Quoted heredocs: the report contains backticks, `$` and apostrophes, and none of them may be expanded.
    const engine = fakeEngine(`
cat <<'YANTAI_TEX_REPORT'
${engineReported}
YANTAI_TEX_REPORT
cat <<'YANTAI_LOG_REPORT' > "$outdir/$stem.log"
${logReported}
YANTAI_LOG_REPORT
exit 1
`);
    // A second engine for the cap: 120 errors and no `.log`, so nothing but the flood competes for the 100 slots.
    const floodEngine = fakeEngine(`
cat <<'YANTAI_FLOOD_REPORT'
${floodReported}
YANTAI_FLOOD_REPORT
exit 1
`);
    const fixture = await createFixture({
      files: { 'main.tex': thesisTex, 'sections/bad.tex': badTex, 'references.bib': referencesBib },
      engine
    });
    try {
      const response = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(response.status, 200);
      assert.equal(response.data.ok, false);
      const diagnostics = response.data.diagnostics;
      const shape = list => JSON.stringify(list.map(item => [item.kind, item.file, item.line, item.message]));

      // 1. The first `!` error belongs to the file TeX had open, and its Chinese hint is attached.
      const undefinedMacro = diagnostics[0];
      assert.deepEqual(
        { kind: undefinedMacro.kind, file: undefinedMacro.file, line: undefinedMacro.line },
        { kind: 'error', file: 'main.tex', line: 4 },
        `the first error is owned by main.tex: ${shape(diagnostics)}`
      );
      assert.match(undefinedMacro.message, /Undefined control sequence/);
      assert.match(undefinedMacro.message, /\\undefinedcommand/, 'the token TeX was reading is quoted back');
      assert.match(undefinedMacro.hint || '', /^未定义的命令/, 'an undefined macro gets the 未定义的命令 hint');

      // 2. A nested `(` moves ownership to the included file; that is the one place the file stack breaks.
      const nested = diagnostics.find(item => /Missing \$/.test(item.message));
      assert.ok(nested, `the nested error survived: ${shape(diagnostics)}`);
      assert.deepEqual(
        { file: nested.file, line: nested.line },
        { file: 'sections/bad.tex', line: 7 },
        'the included file owns the error until its `)`, and main.tex owns what comes after'
      );
      assert.match(nested.hint || '', /^缺少数学符号/, 'a missing math mode gets the 缺少数学符号 hint');

      // 3. BibTeX reports somewhere else entirely: `---line N of file X` names the .bib, not the TeX file.
      const bibliography = diagnostics.find(item => item.file === 'references.bib');
      assert.ok(bibliography, `the BibTeX trailer is attributed to the .bib: ${shape(diagnostics)}`);
      assert.deepEqual({ line: bibliography.line, kind: bibliography.kind }, { line: 7, kind: 'error' });
      assert.match(bibliography.message, /broken somewhere/);
      assert.match(bibliography.hint || '', /逗号|花括号/, 'a BibTeX syntax error gets the comma/brace hint');

      // 4. LaTeX keeps its cross-reference warnings in the `.log`; they are warnings, rewritten into Chinese.
      // The multiply-defined label really is printed without `on input line N`, so the honest answer for it is
      // "no line" — the parser must not guess one and send the editor somewhere arbitrary.
      assert.deepEqual(
        diagnostics.filter(item => item.kind === 'warning').map(item => [item.file, item.line, item.message]),
        [
          ['main.tex', 6, '引用 \\ref{fig:missing} 没有对应的 \\label'],
          ['main.tex', 6, '文献引用 \\cite{nosuchkey} 在 .bib 中不存在'],
          ['main.tex', null, '标签 sec:a 被定义了多次']
        ],
        `the three LaTeX warnings come out of the .log: ${shape(diagnostics)}`
      );

      // 5. The same mistake printed twice — once with a line, once as a bare `error:` — stays one marker, even
      // when the parser decorated the located one with the token TeX was reading.
      const doubled = diagnostics.filter(item => /Double subscript/.test(item.message));
      assert.equal(doubled.length, 1, `a position-less restatement adds nothing: ${shape(diagnostics)}`);
      assert.equal(doubled[0].line, 5, 'the located copy is the one that survives');
      const decorated = diagnostics.filter(item => /\\undefinedcommand/.test(item.message));
      assert.equal(decorated.length, 1, `the appended token is not a second error: ${shape(diagnostics)}`);
      assert.equal(decorated[0].line, 4, 'the copy that survives is the jumpable one');
      assert.equal(decorated[0].message, 'Undefined control sequence (\\undefinedcommand)', 'the surviving copy keeps the token TeX was reading');
      // …and the normalisation must not merge two real errors that merely share TeX's wording.
      const sameWording = diagnostics.filter(item => item.line === 20 || item.line === 21);
      assert.equal(sameWording.length, 2, `one error text on two lines stays two jumpable rows: ${shape(diagnostics)}`);
      assert.deepEqual(sameWording.map(item => item.line), [20, 21]);
      assert.ok(
        diagnostics.some(item => item.message === 'Malformed specification of a blxa name' && item.line === null),
        'an engine error with no author-side position is still reported, just unjumpable — with no trailing space'
      );
      assert.equal(diagnostics.length, 10, `seven errors plus the three warnings, nothing invented: ${shape(diagnostics)}`);

      // 6. Nothing may come back without somewhere to jump to, and no message may carry stray whitespace: the
      // panel renders `message` straight into a sentence.
      for (const item of diagnostics) {
        assert.ok(typeof item.file === 'string' && item.file, `every diagnostic names a file: ${JSON.stringify(item)}`);
        assert.ok(item.line === null || (Number.isInteger(item.line) && item.line >= 1), `line numbers are 1-based: ${JSON.stringify(item)}`);
        assert.ok(['error', 'warning'].includes(item.kind), `only errors and warnings are reported: ${JSON.stringify(item)}`);
        assert.equal(item.message, item.message.trim(), `a message is never padded: ${JSON.stringify(item.message)}`);
      }
      assert.equal(response.data.diagnosticsTotal, 10, 'nothing was cut here, so the total is the length');
      assert.equal(response.data.diagnosticsTruncated, false, 'an uncut list does not claim to be one');

      // 7. The cap: one bad macro in a class file really does print 120 of these. The panel stops at 100 and the
      // response says how many there were, so the missing rows are announced instead of vanishing.
      await fs.writeFile(path.join(fixture.bin, 'tectonic'), `#!/bin/sh\n${floodEngine}\n`, { mode: 0o755 });
      const flooded = await fixture.server.api('/api/compile', 'POST', { rootFile: 'main.tex' });
      assert.equal(flooded.status, 200);
      assert.equal(flooded.data.diagnostics.length, 100, `a 120-error report is cut to 100, got ${flooded.data.diagnostics.length}`);
      assert.equal(flooded.data.diagnosticsTotal, 120, 'the response admits what it left out');
      assert.equal(flooded.data.diagnosticsTruncated, true, 'the cut is visible to the client');
      assert.equal(
        flooded.data.diagnostics.filter(item => /\\undefinedFlood/.test(item.message)).length,
        100,
        `the first 100 in reading order survive: ${shape(flooded.data.diagnostics.slice(0, 3))}`
      );
      assert.equal(flooded.data.diagnostics[0].line, 10, 'the cut keeps the beginning of the report, not the tail');
      for (const item of flooded.data.diagnostics) {
        assert.equal(item.message, item.message.trim(), `a message is never padded: ${JSON.stringify(item.message)}`);
      }
    } finally {
      await fixture.close();
    }
  });
});
