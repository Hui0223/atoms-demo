// Atoms Demo —— Cloudflare Worker 入口：静态资源 + REST/流式 API + 分享页
import { AppStore } from './store.js';
import { hashPassword, verifyPassword, newToken, validateCredentials, loginLockDecision, needsRehash, DUMMY_LOGIN } from './lib/auth.js';
import { catalog, channelsFor } from './agents/models.js';
import { resilientChat } from './agents/llm.js';
import { injectShim } from '../public/shim.js';
import { escapeHtml, parseLooseJson } from './lib/html.js';
import { classifyIntent } from './lib/intent.js';

export { AppStore };

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
const err = (message, status = 400) => json({ error: message }, status);
const shortId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
const LOGIN_LOCK_MSG = '登录失败次数过多，请 15 分钟后再试';
const db = (env) => env.STORE.get(env.STORE.idFromName('global'));

async function readJson(req) { try { return await req.json(); } catch { return {}; } }

async function currentUser(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || token.length > 100) return null;
  return db(env).getSessionUser(token);
}

async function issueSession(env, user) {
  const token = newToken();
  await db(env).createSession(token, user.id);
  return { token, user };
}

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

route('GET', '/api/health', async (req, env) => json({ ok: true, aiDisabled: env.AI_DISABLED === '1', llmConfigured: !!(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN), models: catalog(env).map(({ id, model, label }) => ({ id, model, label })) }));

route('POST', '/api/auth/register', async (req, env, { user }) => {
  const { username, password } = await readJson(req);
  const bad = validateCredentials(username, password);
  if (bad) return err(bad);
  const { hash, salt } = await hashPassword(password);
  // 游客升级为正式账号：保留其项目
  const r = user?.isGuest ? await db(env).upgradeGuest(user.id, { username, passHash: hash, salt }) : await db(env).createUser({ username, passHash: hash, salt });
  if (r.error) return err(r.error, 409);
  return json(await issueSession(env, r.user));
});

route('POST', '/api/auth/login', async (req, env) => {
  const { username, password } = await readJson(req);
  if (!username || !password) return err('请输入用户名和密码');
  const name = String(username).slice(0, 64);
  const ip = req.headers.get('cf-connecting-ip') || '';
  const store = db(env);
  const userKey = 'u:' + name;
  const ipKey = ip ? 'ip:' + ip.slice(0, 80) : '';
  const uf = await store.authFailState(userKey);
  const ipf = ipKey ? await store.authFailState(ipKey) : { count: 0, firstAt: 0 };
  const decision = loginLockDecision({ userFails: uf.count, userFirstAt: uf.firstAt, ipFails: ipf.count, ipFirstAt: ipf.firstAt, now: Date.now() });
  if (decision.locked) return err(LOGIN_LOCK_MSG, 429);
  const u = await store.getUserByName(name);
  let ok = false;
  try {
    if (!u || !u.pass_hash || !u.salt) {
      await verifyPassword(String(password), DUMMY_LOGIN.hash, DUMMY_LOGIN.salt);
    } else {
      ok = await verifyPassword(String(password), u.pass_hash, u.salt);
      if (ok && needsRehash(u.pass_hash)) {
        const next = await hashPassword(String(password));
        await store.updatePassword(u.id, next.hash, next.salt);
      }
    }
  } catch (e) {
    console.error('login verify', e);
    ok = false;
  }
  if (!ok) {
    await store.recordAuthFail(userKey);
    if (ipKey) await store.recordAuthFail(ipKey);
    return err('用户名或密码错误', 401);
  }
  await store.clearAuthFail(userKey);
  return json(await issueSession(env, { id: u.id, username: u.username, isGuest: false }));
});

route('POST', '/api/auth/guest', async (req, env) => {
  const ip = req.headers.get('cf-connecting-ip') || '';
  const r = await db(env).createUser({ username: '游客' + Math.random().toString(36).slice(2, 8), isGuest: true, ip });
  if (r.error) return err(r.error, 429);
  return json(await issueSession(env, r.user));
});

route('POST', '/api/auth/logout', async (req, env) => {
  const token = (req.headers.get('authorization') || '').slice(7);
  if (token) await db(env).deleteSession(token);
  return json({ ok: true });
});

route('GET', '/api/me', async (req, env, { user }) => json({ user }));

route('GET', '/api/plaza', async (req, env) => json({ projects: await db(env).listPlaza() }));

route('GET', '/api/projects', async (req, env, { user }) => json({ projects: await db(env).listProjects(user.id) }), { auth: true });

route('POST', '/api/projects', async (req, env, { user }) => {
  const { prompt } = await readJson(req);
  const p = String(prompt || '').trim();
  if (p.length < 2) return err('请先描述你想要的应用');
  if (p.length > 2000) return err('需求描述请控制在 2000 字以内');
  const title = p.replace(/\s+/g, ' ').slice(0, 24);
  const store = db(env);
  const id = await store.createProject(user.id, { title, prompt: p });
  return json({ id });
}, { auth: true });

async function loadOwned(env, user, id, { allowPublic = false } = {}) {
  const row = await db(env).getProjectRow(id);
  if (!row) return { error: err('项目不存在', 404) };
  const owner = user && row.user_id === user.id;
  if (!owner && !(allowPublic && row.is_public)) return { error: err('无权访问该项目', 403) };
  return { row, owner };
}

route('GET', '/api/projects/:id', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id, { allowPublic: true });
  if (r.error) return r.error;
  const data = await db(env).getProject(params.id);
  if (data && !r.owner) data.pendingRuntime = null;
  return json({ ...data, isOwner: r.owner });
});

route('PATCH', '/api/projects/:id', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const body = await readJson(req);
  return json({ project: await db(env).updateProject(params.id, { title: body.title, isPublic: body.isPublic }) });
}, { auth: true });

route('DELETE', '/api/projects/:id', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  if (r.row.preset) return err('预置示例不可删除', 403);
  await db(env).deleteProject(params.id);
  return json({ ok: true });
}, { auth: true });

route('POST', '/api/projects/:id/fork', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id, { allowPublic: true });
  if (r.error) return r.error;
  const id = await db(env).forkProject(params.id, user.id);
  return id ? json({ id }) : err('该作品暂无可复制的版本');
}, { auth: true });

// 规则分不清时，最多问一次模型（短输出、8s 预算）；失败或超时保持 unsure
async function modelIntent(env, text, ctx) {
  const plan = ctx?.plan ? JSON.stringify(ctx.plan).slice(0, 400) : '';
  const r = await resilientChat(env, {
    messages: [
      { role: 'system', content: '判断用户的新消息是要修改「当前应用」还是要做「一个全新的应用」。只输出 JSON：{"intent":"new"} 或 {"intent":"edit"}。不要解释，不要思考。' },
      { role: 'user', content: `当前应用：${ctx?.title || ''}\n原需求：${String(ctx?.prompt || '').slice(0, 200)}\n规格：${plan}\n新消息：${String(text).slice(0, 500)}` },
    ],
    maxTokens: 400, temperature: 0, deadline: Date.now() + 8000,
  }, { channels: channelsFor(env, 'deepseek', { attempts: 1, backupAttempts: 0 }), simulate: 'none' });
  const j = parseLooseJson(r.text);
  return j && (j.intent === 'new' || j.intent === 'edit') ? j.intent : null;
}

route('POST', '/api/projects/:id/intent', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const body = await readJson(req);
  const text = String(body.prompt || '').trim();
  if (!text) return err('请输入内容');
  if (text.length > 2000) return err('输入请控制在 2000 字以内');
  const ctx = await db(env).projectContext(params.id) || { title: r.row.title, prompt: r.row.prompt };
  const store = db(env);
  let result = { ...classifyIntent(text, ctx), source: 'rules' };
  const configured = env.AI_DISABLED !== '1' && env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_BASE_URL;
  const callModel = result.intent === 'unsure' && !!configured;
  if (callModel) {
    // 额度用尽时不打模型、也不要报错：保持规则的 unsure，前端会弹出选择
    const used = await store.hourlyModelUses(user.id);
    if (used >= 30) return json(result);
    await store.logUsage(user.id, 'intent-model');
    let settled = false;
    try {
      const intent = await Promise.race([
        modelIntent(env, text, ctx).then((v) => { settled = true; return v; }),
        new Promise((resolve) => setTimeout(() => resolve(settled ? undefined : null), 10000)),
      ]);
      if (intent === 'new' || intent === 'edit') result = { intent, confidence: 0.86, reason: (result.reason ? result.reason + '；' : '') + '模型判别', source: 'model' };
    } catch { /* 保持规则给出的 unsure */ }
    return json(result);
  }
  const gate = await store.consumeRulesIntent(user.id);
  if (gate.error) return err(gate.error, 429);
  return json(result);
}, { auth: true });

route('POST', '/api/projects/:id/runtime-check', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const body = await readJson(req);
  const job = await db(env).getJob(String(body.jobId || ''));
  if (!job || job.userId !== user.id || job.projectId !== params.id) return err('任务不存在', 404);
  const out = await db(env).applyRuntimeCheck(params.id, { jobId: job.id, reports: body.reports, runtimeToken: body.runtimeToken });
  if (out.error) return err(out.error, out.status || 400);
  return json(out);
}, { auth: true });

route('POST', '/api/projects/:id/adopt', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const { versionId, note } = await readJson(req);
  const store = db(env);
  const v = await store.getVersion(versionId);
  if (!v || v.project_id !== params.id) return err('版本不存在', 404);
  const vid = await store.adoptVersion(params.id, versionId, note || (v.candidate ? `采用候选方案 ${v.lane}` : `回滚到 v${v.n}`));
  await store.addMessage(params.id, 'agent', 'system', v.candidate ? `已采用候选方案 ${v.lane}，生成新版本。` : `已回滚到 v${v.n} 的内容（生成新版本，历史不丢失）。`, { versionId: vid });
  return json({ versionId: vid });
}, { auth: true });

route('GET', '/api/versions/:id', async (req, env, { user, params }) => {
  const v = await db(env).getVersion(params.id);
  if (!v) return err('版本不存在', 404);
  const r = await loadOwned(env, user, v.project_id, { allowPublic: true });
  if (r.error) return r.error;
  return json({ id: v.id, n: v.n, html: v.html, note: v.note, mode: v.mode, candidate: !!v.candidate, lane: v.lane });
});

route('GET', '/api/jobs/:id', async (req, env, { user, params }) => {
  const j = await db(env).getJob(params.id);
  if (!j || j.userId !== user.id) return err('任务不存在', 404);
  return json({ job: j });
}, { auth: true });

route('POST', '/api/jobs/:id/cancel', async (req, env, { user, params }) => {
  const store = db(env);
  const j = await store.getJob(params.id);
  if (!j || j.userId !== user.id) return err('任务不存在', 404);
  await store.cancelJob(params.id);
  return json({ ok: true });
}, { auth: true });

// 核心：发起生成 / 迭代，返回 SSE 流。
// 任务在 Durable Object 内执行（DO 的单请求 CPU 预算远高于免费版 Worker 的 10ms），Worker 只做鉴权与转发。
route('POST', '/api/projects/:id/run', async (req, env, { user, params }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const body = await readJson(req);
  // 新应用 / 修改由 /intent 决定；这里 edit 一律增量，不会整页重生成
  const type = body.type === 'edit' ? 'edit' : 'generate';
  const text = String(body.prompt || '').trim();
  if (!text) return err('请输入内容');
  if (text.length > 2000) return err('输入请控制在 2000 字以内');
  if (type === 'edit' && !r.row.current_version_id) return err('当前项目还没有可修改的版本');
  return db(env).fetch('https://store/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: params.id, userId: user.id, body: { ...body, type, prompt: text } }) });
}, { auth: true });

const SHARE_MISS = '作品不存在或未公开';
function shareMiss() {
  return new Response(SHARE_MISS, { status: 404, headers: {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
}

// 分享页：独立页面运行生成的应用（CSP sandbox 隔离，无法访问本站登录态）。
// 不设 X-Frame-Options，避免和 sandbox CSP 打架；未公开与不存在返回同一句，避免探测。
async function sharePage(env, id) {
  const store = db(env);
  const row = await store.getProjectRow(id);
  if (!row || !row.is_public) return shareMiss();
  if (!row.current_version_id) return new Response('作品不存在或尚未生成', { status: 404, headers: {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
  const v = await store.getVersion(row.current_version_id);
  const badge = `<a href="/#/p/${escapeHtml(id)}" target="_blank" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111827;color:#fff;font:12px/1.2 sans-serif;padding:7px 10px;border-radius:999px;text-decoration:none;opacity:.85">⚛ Made with Atoms Demo</a>`;
  let html = injectShim(v.html, { storageKey: id, bridge: false });
  const pos = html.toLowerCase().lastIndexOf('</body>');
  html = pos === -1 ? html + badge : html.slice(0, pos) + badge + html.slice(pos);
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/s/')) return sharePage(env, decodeURIComponent(path.slice(3)));
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        const user = await currentUser(req, env);
        if (r.auth && !user) return err('请先登录', 401);
        return await r.handler(req, env, { user, params: m.groups || {}, ctx });
      }
      return err('接口不存在', 404);
    } catch (e) {
      const id = shortId();
      console.error('api error', id, e?.stack || e);
      const message = `服务器开小差了，请稍后重试（编号 ${id}）`;
      if (path.startsWith('/api/')) return err(message, 500);
      return new Response(message, { status: 500, headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      } });
    }
  },
};
