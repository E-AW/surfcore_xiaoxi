// src/media-keep.js 的单测：只测纯逻辑 + 一次本地 HTTP 下载，不碰 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keepMedia, mediaLabel, mediaRoot, targetPath } from '../src/media-keep.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-keep-'));

function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const hit = routes[req.url];
      if (!hit) { res.statusCode = 404; return res.end('no'); }
      res.writeHead(hit.code ?? 200, hit.headers ?? {});
      res.end(hit.body ?? Buffer.from('hello'));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('mediaRoot 跟随 DSH_HOME', () => {
  assert.equal(mediaRoot({ DSH_HOME: 'C:/x' }).replace(/\\/g, '/'), 'C:/x/snowluma-media');
  assert.ok(mediaRoot({}).endsWith('snowluma-media'));
});

test('targetPath 同名同 url 稳定，不同 url 不同', () => {
  const a = targetPath('https://e.com/a.mp4', 'a.mp4', tmp);
  const b = targetPath('https://e.com/a.mp4', 'a.mp4', tmp);
  const c = targetPath('https://e.com/b.mp4', 'b.mp4', tmp);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.endsWith('.mp4'));
});

test('没有 url 直接跳过', async () => {
  assert.equal((await keepMedia(undefined, { root: tmp })).reason, 'no-url');
  assert.equal((await keepMedia('file:///etc/passwd', { root: tmp })).reason, 'no-url');
});

test('下载成功并落盘，第二次复用不再请求', async () => {
  const { server, port } = await serve({ '/v.mp4': { body: Buffer.from('videobytes') } });
  try {
    const url = `http://127.0.0.1:${port}/v.mp4`;
    const first = await keepMedia(url, { root: tmp, name: 'x.mp4' });
    assert.equal(first.ok, true);
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'videobytes');
    server.close();
    const second = await keepMedia(url, { root: tmp, name: 'x.mp4' });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
  } finally { try { server.close(); } catch {} }
});

test('HTTP 404 不抛，只返回原因', async () => {
  const { server, port } = await serve({});
  try {
    const r = await keepMedia(`http://127.0.0.1:${port}/missing`, { root: tmp });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-404');
  } finally { try { server.close(); } catch {} }
});

test('超时返回 timeout 而不是挂死', async () => {
  const server = http.createServer(() => { /* 永不响应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await keepMedia(`http://127.0.0.1:${port}/slow`, { root: tmp, timeoutMs: 120 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  } finally { server.close(); }
});

test('写不进去时也返回失败而不是抛', async () => {
  const blocked = path.join(tmp, 'blocked');
  fs.writeFileSync(blocked, 'x'); // 同名文件占位，mkdir 必失败
  const { server, port } = await serve({ '/v.mp4': {} });
  try {
    const r = await keepMedia(`http://127.0.0.1:${port}/v.mp4`, { root: blocked });
    assert.equal(r.ok, false);
  } finally { try { server.close(); } catch {} }
});

test('mediaLabel：存下带路径，没存下退回占位', () => {
  assert.equal(mediaLabel('video', { ok: false }), '[视频]');
  assert.equal(mediaLabel('file', { ok: false }, 'a.zip'), '[文件a.zip]');
  const ok = mediaLabel('video', { ok: true, path: 'C:/p/a.mp4', bytes: 2 * 1024 * 1024 });
  assert.match(ok, /已存到本地 2\.0MB：C:\/p\/a\.mp4/);
  assert.match(mediaLabel('file', { ok: true, path: 'C:/p/a.zip' }, 'a.zip'), /^\[文件a\.zip 已存到本地/);
});
