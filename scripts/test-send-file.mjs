// src/file-send.js 的单测：全部用临时目录里的真实文件，不碰 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildUploadParams, pickUploadAction, resolveSendableFile } from '../src/file-send.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-send-'));
const inside = path.join(root, 'videos');
fs.mkdirSync(inside);
const okFile = path.join(inside, 'demo.mp4');
fs.writeFileSync(okFile, Buffer.alloc(1024, 1));
const outside = path.join(os.tmpdir(), 'outside-' + process.pid + '.txt');
fs.writeFileSync(outside, 'x');

const cfg = { socialV2: { file: { allowedRoots: [root], maxMB: 1 } } };

test('空路径直接拒', () => {
  assert.equal(resolveSendableFile(cfg, '   ').error, 'path 不能为空');
  assert.equal(resolveSendableFile(cfg, undefined).ok, false);
});

test('文件不存在给中文提示，不是抛异常', () => {
  const r = resolveSendableFile(cfg, path.join(root, 'nope.mp4'));
  assert.equal(r.ok, false);
  assert.match(r.error, /文件不存在/);
});

test('目录不能发', () => {
  const r = resolveSendableFile(cfg, inside);
  assert.equal(r.ok, false);
  assert.match(r.error, /只能发送普通文件/);
});

test('允许目录外的文件被拦下', () => {
  const r = resolveSendableFile(cfg, outside);
  assert.equal(r.ok, false);
  assert.match(r.error, /只能发送/);
});

test('允许目录内的文件放行，并回报大小', () => {
  const r = resolveSendableFile(cfg, okFile);
  assert.equal(r.ok, true);
  assert.equal(r.size, 1024);
  assert.ok(r.path.endsWith('demo.mp4'));
});

test('超过 maxMB 被拦，且提示里带实际大小', () => {
  const small = { socialV2: { file: { allowedRoots: [root], maxMB: 0.0005 } } };
  const r = resolveSendableFile(small, okFile);
  assert.equal(r.ok, false);
  assert.match(r.error, /文件太大/);
  assert.match(r.error, /MB）/);
});

test('没配 allowedRoots 时默认用户主目录（系统目录进不去）', () => {
  // 注意：os.tmpdir() 在 Windows 上也在用户目录里，所以这里必须挑一个真的在家的外面、
  // 又一定存在的文件来试。
  const systemFile = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  if (!fs.existsSync(systemFile)) return; // 非 Windows 或路径不同就跳过
  const r = resolveSendableFile({ socialV2: {} }, systemFile);
  assert.equal(r.ok, false);
  assert.match(r.error, /只能发送/);
});

test('群走群文件、私聊走私聊文件', () => {
  assert.equal(pickUploadAction('group'), 'upload_group_file');
  assert.equal(pickUploadAction('private'), 'upload_private_file');
  assert.equal(pickUploadAction('whatever'), 'upload_private_file');
});

test('参数拼装：群带 group_id、私聊带 user_id，都带 name', () => {
  assert.deepEqual(buildUploadParams('group', '123', okFile), {
    group_id: 123, file: okFile, name: 'demo.mp4',
  });
  assert.deepEqual(buildUploadParams('private', '456', okFile, '别名.mp4'), {
    user_id: 456, file: okFile, name: '别名.mp4',
  });
});
