// 把本地文件/视频发给 QQ 对方（OneBot 11 的 upload_private_file / upload_group_file）。
//
// 边界（都是硬性、在代码里，不是靠调用方自觉）：
//   1. 文件必须存在、必须是普通文件（不跟软链/目录/设备）；
//   2. 必须落在允许的根目录内（默认用户主目录，可用 socialV2.file.allowedRoots 覆盖）；
//   3. 有大小上限（默认 200MB，可配 socialV2.file.maxMB）；
//   4. 只读打开过 —— 不复制、不改名、不动原文件。
//
// 为什么要有允许根：模型能读的路径和能「发到 QQ 上」的路径不是一回事。
// 前者泄露给用户自己还算可控，后者一旦被套话就能把 C:\Windows、凭据目录、
// 同事的共享盘整块搬出去，所以默认只在主目录内放行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_MB = 200;

function norm(p) {
  const abs = path.resolve(String(p));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function rootsOf(cfg, env = process.env) {
  const configured = cfg?.socialV2?.file?.allowedRoots;
  const list = Array.isArray(configured) && configured.length ? configured : [env.USERPROFILE || os.homedir()];
  return list.map((r) => norm(r));
}

/**
 * 校验一个待发送路径。
 * 返回 { ok:true, path, size } 或 { ok:false, error }（error 是给人看的中文句子）。
 */
export function resolveSendableFile(cfg, rawPath, stat = fs.statSync) {
  const input = String(rawPath ?? '').trim();
  if (!input) return { ok: false, error: 'path 不能为空' };
  const abs = path.resolve(input);
  let st;
  try {
    st = stat(abs);
  } catch {
    return { ok: false, error: `文件不存在：${abs}` };
  }
  if (!st.isFile()) return { ok: false, error: '只能发送普通文件（目录、设备、管道都不行）' };
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* 取不到真实路径就用原路径比较 */ }
  const roots = rootsOf(cfg);
  const target = norm(real);
  const inside = roots.some((r) => target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  if (!inside) {
    return { ok: false, error: `只能发送 ${roots.join('、')} 里面的文件（可在设置里改允许目录）` };
  }
  const maxMB = Number(cfg?.socialV2?.file?.maxMB) > 0 ? Number(cfg.socialV2.file.maxMB) : DEFAULT_MAX_MB;
  if (st.size > maxMB * 1024 * 1024) {
    return { ok: false, error: `文件太大（${(st.size / 1024 / 1024).toFixed(1)}MB），上限 ${maxMB}MB` };
  }
  return { ok: true, path: real, size: st.size };
}

/** 群聊走群文件，私聊走私聊文件。 */
export function pickUploadAction(kind) {
  return kind === 'group' ? 'upload_group_file' : 'upload_private_file';
}

/** 组装 OneBot 参数：群要 group_id + name，私聊要 user_id + name。 */
export function buildUploadParams(kind, id, filePath, name) {
  const base = { file: filePath, name: name || path.basename(filePath) };
  return kind === 'group'
    ? { group_id: Number(id), ...base }
    : { user_id: Number(id), ...base };
}
