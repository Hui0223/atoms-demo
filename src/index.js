// Atoms Demo —— Cloudflare Worker 入口：静态资源 + REST/流式 API + 分享页
import { AppStore } from './store.js';
import { hashPassword, verifyPassword, newToken, validateCredentials } from './lib/auth.js';
import { runGenerate, runEdit, short } from './agents/pipeline.js';
import { CanceledError } from './agents/llm.js';
import { injectShim } from '../public/shim.js';
import { escapeHtml } from './lib/html.js';

export { AppStore };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (message, status = 400) => json({ error: message }, status);
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

route('GET', '/api/health', async (req, env) => json({ ok: true, aiDisabled: env.AI_DISABLED === '1', models: { primary: short(env.PRIMARY_MODEL), backup: short(env.BACKUP_MODEL), planner: short(env.PLANNER_MODEL) } }));

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
  const u = await db(env).getUserByName(String(username));
  if (!u || !u.pass_hash || !(await verifyPassword(String(password), u.pass_hash, u.salt))) return err('用户名或密码错误', 401);
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

// 核心：发起生成 / 迭代，返回 SSE 流；任务本身通过 waitUntil 在后台跑完并落库（刷新可恢复）
route('POST', '/api/projects/:id/run', async (req, env, { user, params, ctx }) => {
  const r = await loadOwned(env, user, params.id);
  if (r.error) return r.error;
  const body = await readJson(req);
  const type = body.type === 'edit' ? 'edit' : 'generate';
  const text = String(body.prompt || '').trim();
  if (!text) return err('请输入内容');
  if (text.length > 2000) return err('输入请控制在 2000 字以内');
  if (type === 'edit' && !r.row.current_version_id) return err('当前项目还没有可修改的版本');
  const store = db(env);
  const jr = await store.createJob(params.id, user.id, type);
  if (jr.error) return err(jr.error, 429);
  const jobId = jr.job.id;
  const umid = await store.addMessage(params.id, 'user', null, text, { type, lanes: body.lanes, demo: !!body.demo, simulate: body.simulate || 'none' });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const emit = (event, data) => {
    if (!open) return;
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => { open = false; });
  };
  const simulate = ['primary429', 'alldown'].includes(body.simulate) ? body.simulate : 'none';
  const jctx = { env, store, jobId, projectId: params.id, emit, simulate, demo: !!body.demo };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => emit('ping', { elapsed: Date.now() - startedAt }), 5000);

  const task = (async () => {
    emit('job', { id: jobId, type, userMessageId: umid });
    let result;
    try {
      result = type === 'edit' ? await runEdit(jctx, { request: text, baseVersionId: body.baseVersionId || r.row.current_version_id }) : await runGenerate(jctx, { prompt: text, lanes: body.lanes ?? 2 });
      await store.updateJob(jobId, result.status === 'done' ? 'done' : result.status, { result });
    } catch (e) {
      // 异常绝不穿透：取消 / 未知错误都转成可展示的状态
      if (e instanceof CanceledError) {
        result = { status: 'canceled' };
        await store.updateJob(jobId, 'canceled', { result });
        const mid = await store.addMessage(params.id, 'agent', 'system', '⏹ 已取消本次任务，已有版本保持不变。');
        emit('message', { id: mid, role: 'agent', agent: 'system', content: '⏹ 已取消本次任务，已有版本保持不变。' });
      } else {
        console.error('job failed', e?.stack || e);
        result = { status: 'failed', error: String(e?.message || e) };
        await store.updateJob(jobId, 'failed', { result });
        const mid = await store.addMessage(params.id, 'agent', 'system', `任务异常：${result.error}。已有版本不受影响，可重试。`);
        emit('message', { id: mid, role: 'agent', agent: 'system', content: `任务异常：${result.error}` });
      }
    } finally {
      clearInterval(heartbeat);
      emit('done', { ...result, elapsed: Date.now() - startedAt });
      open = false;
      try { await writer.close(); } catch {}
    }
  })();
  ctx.waitUntil(task);
  return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}, { auth: true });

// 分享页：独立页面运行生成的应用（CSP sandbox 隔离，无法访问本站登录态）
async function sharePage(env, id) {
  const store = db(env);
  const row = await store.getProjectRow(id);
  if (!row || !row.current_version_id) return new Response('作品不存在或尚未生成', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const v = await store.getVersion(row.current_version_id);
  const badge = `<a href="/#/p/${escapeHtml(id)}" target="_blank" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111827;color:#fff;font:12px/1.2 sans-serif;padding:7px 10px;border-radius:999px;text-decoration:none;opacity:.85">⚛ Made with Atoms Demo</a>`;
  let html = injectShim(v.html, { storageKey: id, bridge: false });
  const pos = html.toLowerCase().lastIndexOf('</body>');
  html = pos === -1 ? html + badge : html.slice(0, pos) + badge + html.slice(pos);
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    'cache-control': 'no-store',
  } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith('/s/')) return sharePage(env, decodeURIComponent(path.slice(3)));
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
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
      console.error('api error', e?.stack || e);
      return err('服务器开小差了：' + String(e?.message || e), 500);
    }
  },
};
