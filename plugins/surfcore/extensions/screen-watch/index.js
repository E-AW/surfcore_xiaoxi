/**
 * 看屏幕扩展（screen-watch）。
 *
 * 定位：和 QQ 聊天平级的输入源，不是 QQ 的附属。
 *   · 帧从外面推过来（POST /frame，body: { image: base64, mimeType, ts, note }）
 *   · 落到 api.dataDir 下的 frames/，保留最近 N 张
 *   · 通过宿主的注入面 api.injectMedia(...) 送进同一份记忆/工作区的会话
 *
 * 宿主没提供 injectMedia 时不会静默吞掉：帧照样落盘，状态里标 queued，
 * 等宿主接上再补投，不假装成功。
 *
 * 节流两道闸：minGapMs（两张之间最短间隔）与 maxPerHour（每小时上限）。
 */

const DEFAULTS = {
  minGapMs: 20000,
  maxPerHour: 30,
  keepFrames: 200,
  maxBytes: 6 * 1024 * 1024,
  note: '屏幕',
};

function nowMs() {
  return Date.now();
}

function extOf(mimeType) {
  const t = String(mimeType || 'image/jpeg').toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  return '.jpg';
}

export async function activate(api) {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const cfg = { ...DEFAULTS, ...(api.config.get() || {}) };
  const framesDir = path.join(api.dataDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const state = {
    seen: 0,
    saved: 0,
    injected: 0,
    rejected: 0,
    queued: 0,
    lastAt: 0,
    lastFile: null,
    lastReason: null,
    hourWindow: [],
  };

  function prune(keep) {
    try {
      const files = fs.readdirSync(framesDir)
        .filter((name) => name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.webp') || name.endsWith('.gif'))
        .sort();
      const extra = files.length - keep;
      if (extra <= 0) return 0;
      for (const name of files.slice(0, extra)) {
        try { fs.unlinkSync(path.join(framesDir, name)); } catch {}
      }
      return extra;
    } catch {
      return 0;
    }
  }

  function throttled() {
    const t = nowMs();
    if (t - state.lastAt < cfg.minGapMs) return `间隔太密（${cfg.minGapMs}ms 内只收一张）`;
    state.hourWindow = state.hourWindow.filter((item) => t - item < 3600_000);
    if (state.hourWindow.length >= cfg.maxPerHour) return `每小时上限 ${cfg.maxPerHour} 张`;
    return null;
  }

  api.registerRoute('POST', '/frame', async (req, res) => {
    const reply = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > cfg.maxBytes * 2) throw new Error('请求体过大');
      }
      const input = JSON.parse(body || '{}');
      const raw = String(input.image || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) return reply(400, { ok: false, reason: '缺少 image（base64）' });

      const buffer = Buffer.from(raw, 'base64');
      if (!buffer.length) return reply(400, { ok: false, reason: 'image 解码为空' });
      if (buffer.length > cfg.maxBytes) return reply(413, { ok: false, reason: '单帧超过上限' });

      state.seen += 1;
      const blocked = throttled();
      if (blocked) {
        state.rejected += 1;
        state.lastReason = blocked;
        return reply(429, { ok: false, reason: blocked, stats: { ...state, hourWindow: undefined } });
      }

      const mimeType = String(input.mimeType || 'image/jpeg');
      const ts = Number(input.ts) || nowMs();
      const filename = `${ts}${extOf(mimeType)}`;
      const file = path.join(framesDir, filename);
      fs.writeFileSync(file, buffer);

      state.saved += 1;
      state.lastAt = nowMs();
      state.lastFile = filename;
      state.lastReason = null;
      state.hourWindow.push(state.lastAt);
      const pruned = prune(Number(cfg.keepFrames) || DEFAULTS.keepFrames);

      const note = String(input.note || cfg.note || '屏幕').slice(0, 40);
      let injection = { ok: false, reason: '宿主未提供 injectMedia' };
      if (typeof api.injectMedia === 'function') {
        try {
          injection = await api.injectMedia({
            mediaType: mimeType,
            data: buffer.toString('base64'),
            name: `screen-${ts}${extOf(mimeType)}`,
            text: `[屏幕 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}] ${note}`,
          });
        } catch (error) {
          injection = { ok: false, reason: `注入失败：${error?.message ?? error}` };
        }
      }
      if (injection?.ok) state.injected += 1;
      else {
        state.queued += 1;
        state.lastReason = injection?.reason || '未注入';
      }

      api.emit('screen.frame', { file, filename, ts, mimeType, bytes: buffer.length, injected: Boolean(injection?.ok) });

      return reply(200, {
        ok: true,
        file: filename,
        bytes: buffer.length,
        pruned,
        injected: Boolean(injection?.ok),
        injection,
        stats: { ...state, hourWindow: undefined },
      });
    } catch (error) {
      return reply(500, { ok: false, reason: `处理失败：${error?.message ?? error}` });
    }
  });

  api.registerRoute('GET', '/status', async (req, res) => {
    const frames = (() => {
      try {
        return fs.readdirSync(framesDir).sort().slice(-10).reverse();
      } catch {
        return [];
      }
    })();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      extension: 'screen-watch',
      injectAvailable: typeof api.injectMedia === 'function',
      dataDir: api.dataDir,
      config: cfg,
      stats: { ...state, hourWindow: undefined },
      recent: frames,
    }, null, 2));
  });

  api.registerRoute('POST', '/config', async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let input = {};
    try { input = JSON.parse(body || '{}'); } catch { input = {}; }
    const next = { ...cfg, ...(input && typeof input === 'object' ? input : {}) };
    for (const key of ['minGapMs', 'maxPerHour', 'keepFrames', 'maxBytes']) {
      if (key in next) next[key] = Math.max(0, Number(next[key]) || DEFAULTS[key]);
    }
    Object.assign(cfg, next);
    api.config.set(cfg);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, config: cfg }));
  });

  api.log(`screen-watch 已激活：帧目录 ${framesDir}，injectMedia=${typeof api.injectMedia === 'function' ? '有' : '没有'}`);
}
