// QQ 收到的视频/文件「到手即存」。
//
// 为什么必须马上存：QQ 的媒体链接带 rkey（有时效，通常几十分钟到几小时）。
// 早前实测：一条 41 分钟前的图片链接再取已经 HTTP 400，视频更早失效。
// 过了那个窗口，SnowLuma 的库里只剩元数据，字节再也拿不回来
// （get_video 在网关上根本不存在这个 action）。
//
// 所以这里只做一件事：消息到达时如果带 url，就立刻把字节落盘；失败就放弃，
// 绝不影响消息本身送进模型。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 512 * 1024 * 1024;

/** 媒体根目录：$DSH_HOME/snowluma-media，缺省 ~/.dsh/snowluma-media。 */
export function mediaRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'snowluma-media');
}

function extOf(url, name) {
  const fromName = typeof name === 'string' ? path.extname(name).toLowerCase() : '';
  if (fromName && fromName.length <= 6) return fromName;
  try {
    const p = new URL(url).pathname;
    const e = path.extname(p).toLowerCase();
    if (e && e.length <= 6) return e;
  } catch { /* 不是合法 URL，落到下面 */ }
  return '.bin';
}

/** 文件名：url 哈希 + 原名后缀，保证同一条消息重复到达不会写出两份。 */
export function targetPath(url, name, root = mediaRoot()) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  return path.join(root, 'videos', hash + extOf(url, name));
}

/**
 * 把一条带 url 的媒体段存到本地。
 * 返回 { ok, path } 或 { ok:false, reason }；任何失败都不抛。
 */
export async function keepMedia(url, { name, root = mediaRoot(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, reason: 'no-url' };
  const dest = targetPath(url, name, root);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { ok: true, path: dest, reused: true };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty' };
    if (buf.length > MAX_BYTES) return { ok: false, reason: 'too-large' };
    fs.writeFileSync(dest, buf);
    return { ok: true, path: dest, bytes: buf.length };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) };
  }
}

/** 给模型看的占位文本：存下来就带上路径，没存下就退回原来的 [视频]。 */
export function mediaLabel(kind, result, extra = '') {
  if (!result?.ok) return kind === 'video' ? '[视频]' : `[文件${extra}]`;
  const size = result.bytes ? ` ${(result.bytes / 1024 / 1024).toFixed(1)}MB` : '';
  return kind === 'video'
    ? `[视频 已存到本地${size}：${result.path}]`
    : `[文件${extra} 已存到本地${size}：${result.path}]`;
}
