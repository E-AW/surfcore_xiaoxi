/**
 * screen-watch 的宿主侧接线：把扩展递过来的画面塞进 DSH 的一轮会话。
 *
 * 为什么要有这一层：
 *   extensions.js 只提供 `setMediaInjector(fn)` 这个接线点，它不知道 DSH 的会话怎么起。
 *   B站 生物钟（lib/scheduler.js 的 ensureSession）已经证明这条路能走：
 *   sessionController.inspect → create({ sessionId, ...params }) → prompt({ sessionId, mode:'queue', content:[…] })
 *   这里套用同一套，只是 content 里除了 text 还带 image part。
 */
import fs from 'node:fs';
import path from 'node:path';
import { biliSessionCreateParams } from './bili-workspace.js';

const DEFAULT_NAME = 'screen-watch.jpg';

export function createScreenWatchInjector({
  ctx,
  dshHome,
  characterId = '',
  workspaceDir = '',
  agentPreset = '',
  log = () => {},
} = {}) {
  const sessionId = characterId ? `screen-watch-${characterId}` : 'screen-watch';
  const dir = workspaceDir || path.join(dshHome || '.', 'surfcore', 'state', 'screen-watch');
  let ready = false;

  async function ensureSession() {
    if (ready) return;
    const controller = ctx?.sessionController;
    if (!controller) throw new Error('sessionController 未就绪');
    try {
      await controller.inspect(sessionId);
      ready = true;
      return;
    } catch {
      // 会话不存在 → 往下建
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const params = biliSessionCreateParams({ cwd: dir, agentPreset });
    await controller.create({ sessionId, ...params });
    ready = true;
  }

  return async function injectMedia(payload = {}) {
    const data = String(payload.data ?? '');
    if (!data) return { ok: false, reason: '没有画面数据' };
    const controller = ctx?.sessionController;
    if (!controller) return { ok: false, reason: 'sessionController 未就绪' };
    try {
      await ensureSession();
      const content = [];
      const text = String(payload.text ?? '').trim();
      if (text) content.push({ type: 'text', text });
      content.push({
        type: 'image',
        mediaType: String(payload.mediaType || 'image/jpeg'),
        data,
        name: String(payload.name || DEFAULT_NAME),
      });
      const note = String(payload.note ?? '').trim();
      if (note) content.push({ type: 'text', text: note });
      await controller.prompt({ sessionId, mode: 'queue', content });
      return { ok: true, sessionId };
    } catch (error) {
      ready = false;
      const reason = String(error?.message ?? error);
      log(`[screen-watch] 画面注入失败：${reason}`);
      return { ok: false, reason };
    }
  };
}
