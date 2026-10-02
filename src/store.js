// 持久化层：Durable Object 内置 SQLite（强一致、随 Worker 部署、免费可用、重启不丢）
import { DurableObject } from 'cloudflare:workers';
import sources from './templates/sources.js';
import { renderTemplate } from './templates/engine.js';
import { scoreHtml, applyRuntime, validateRuntimeReports } from './lib/qa.js';
import { timingSafeEqualStr } from './lib/auth.js';
import { LANE_VARIANTS } from './agents/prompts.js';
import { startRun } from './runner.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT, salt TEXT, is_guest INTEGER DEFAULT 0, ip TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, prompt TEXT, is_public INTEGER DEFAULT 0, preset INTEGER DEFAULT 0,
  current_version_id TEXT, forked_from TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at);
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, n INTEGER, html TEXT, note TEXT, kind TEXT, mode TEXT, model TEXT,
  score INTEGER, score_json TEXT, lane TEXT, candidate INTEGER DEFAULT 0, job_id TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, created_at);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT, agent TEXT, content TEXT, meta TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, type TEXT, status TEXT, detail TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
CREATE TABLE IF NOT EXISTS auth_fail(key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage(user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);
`;

const PRESETS = [
  { tpl: 'kanban', prompt: '我要一个带优先级、截止日、拖拽排序的项目看板' },
  { tpl: 'mortgage', prompt: '一个能算房贷月供的计算器，带提前还款对比' },
  { tpl: 'profile', prompt: '个人主页：我叫林晓，职业是全栈工程师，技能：TypeScript、React、Node.js、Python、AI Agent，邮箱 linxiao@example.com' },
  { tpl: 'pomodoro', prompt: '番茄钟专注计时器，可以管理今日任务并统计近 7 天专注数' },
  { tpl: 'generic', prompt: '读书清单：记录想读的书，按分类筛选并标记已读' },
];

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => Date.now();
const STALE_MS = 150_000;
const HOUR_MS = 3600_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ORPHAN_MSG = '任务中断：服务重启（如刚部署新版本），本次生成未完成，已有版本不受影响，可直接重新生成';
const MODEL_QUOTA = 30;
const RULES_INTENT_QUOTA = 120;

export class AppStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
      this.seed();
      // 任务在本 DO 内执行。进程起来时仍是 running/canceling 的行，一定是重启前被打断的，不会再有人接着跑。
      this.failOrphanJobs();
    });
  }

  // HTTP 入口：仅用于流式任务（Worker 转发）
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/run') {
      const payload = await request.json();
      return startRun(this.env, this, payload);
    }
    return new Response('not found', { status: 404 });
  }

  q(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }
  one(sql, ...args) { return this.q(sql, ...args)[0] || null; }

  failOrphanJobs() {
    const rows = this.q("SELECT id, project_id FROM jobs WHERE status IN ('running','canceling')");
    for (const r of rows) {
      this.updateJob(r.id, 'failed', { error: ORPHAN_MSG, result: { status: 'failed', error: ORPHAN_MSG } });
      if (r.project_id) this.addMessage(r.project_id, 'agent', 'system', ORPHAN_MSG);
    }
  }

  seed() {
    if (this.one("SELECT id FROM users WHERE id='system'")) return;
    this.sql.exec("INSERT INTO users(id, username, is_guest, created_at) VALUES('system','Atoms 官方',0,?)", now());
    PRESETS.forEach((p, i) => {
      const html = renderTemplate(sources, p.tpl, p.prompt);
      const t = now() - (PRESETS.length - i) * 1000;
      const pid = 'preset-' + p.tpl;
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || p.tpl;
      this.sql.exec('INSERT INTO projects(id,user_id,title,prompt,is_public,preset,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)', pid, 'system', title, p.prompt, t, t);
      this.addMessage(pid, 'user', null, p.prompt);
      const vid = this.addVersion(pid, { html, note: '官方预置示例', kind: 'generate', mode: 'preset', model: 'template', score: scoreHtml(html) });
      this.addMessage(pid, 'agent', 'engineer', '已生成应用（官方预置示例，不依赖模型即可体验）', { versionId: vid });
    });
  }

  // ---------- 用户 & 会话 ----------
  createUser({ username, passHash, salt, isGuest, ip }) {
    if (this.one('SELECT id FROM users WHERE username=?', username)) return { error: '用户名已被占用' };
    if (isGuest && ip) {
      const c = this.one('SELECT COUNT(*) c FROM users WHERE is_guest=1 AND ip=? AND created_at>?', ip, now() - 3600_000).c;
      if (c >= 20) return { error: '游客账号创建过于频繁，请稍后再试或注册账号' };
    }
    const id = uid();
    this.sql.exec('INSERT INTO users(id,username,pass_hash,salt,is_guest,ip,created_at) VALUES(?,?,?,?,?,?,?)', id, username, passHash || null, salt || null, isGuest ? 1 : 0, ip || null, now());
    return { user: { id, username, isGuest: !!isGuest } };
  }
  getUserByName(username) { return this.one('SELECT * FROM users WHERE username=?', username); }
  upgradeGuest(userId, { username, passHash, salt }) {
    if (this.one('SELECT id FROM users WHERE username=? AND id<>?', username, userId)) return { error: '用户名已被占用' };
    this.sql.exec('UPDATE users SET username=?, pass_hash=?, salt=?, is_guest=0 WHERE id=? AND is_guest=1', username, passHash, salt, userId);
    return { user: { id: userId, username, isGuest: false } };
  }
  createSession(token, userId) {
    this.sql.exec('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, userId, now() + 30 * 86400_000);
    this.sql.exec('DELETE FROM sessions WHERE expires_at<?', now());
  }
  getSessionUser(token) {
    const r = this.one('SELECT u.id, u.username, u.is_guest FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?', token, now());
    return r ? { id: r.id, username: r.username, isGuest: !!r.is_guest } : null;
  }
  deleteSession(token) { this.sql.exec('DELETE FROM sessions WHERE token=?', token); }
  updatePassword(userId, passHash, salt) {
    this.sql.exec('UPDATE users SET pass_hash=?, salt=? WHERE id=?', passHash, salt, userId);
  }

  // ---------- 登录失败计数（用户名 / IP，15 分钟窗口）----------
  authFailState(key) {
    const row = this.one('SELECT count, first_at FROM auth_fail WHERE key=?', key);
    if (!row) return { count: 0, firstAt: 0 };
    if (now() - row.first_at >= LOGIN_WINDOW_MS) return { count: 0, firstAt: 0 };
    return { count: row.count | 0, firstAt: row.first_at };
  }
  recordAuthFail(key) {
    const cur = this.authFailState(key);
    const count = cur.count + 1;
    const firstAt = cur.count ? cur.firstAt : now();
    this.sql.exec('INSERT INTO auth_fail(key,count,first_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, first_at=excluded.first_at', key, count, firstAt);
    return { count, firstAt };
  }
  clearAuthFail(key) { this.sql.exec('DELETE FROM auth_fail WHERE key=?', key); }

  // ---------- 模型额度：生成任务 + 真正打到模型的意图判断 ----------
  hourlyModelUses(userId) {
    const since = now() - HOUR_MS;
    const jobs = this.one('SELECT COUNT(*) c FROM jobs WHERE user_id=? AND created_at>?', userId, since)?.c || 0;
    const intents = this.one("SELECT COUNT(*) c FROM usage WHERE user_id=? AND kind='intent-model' AND created_at>?", userId, since)?.c || 0;
    return Number(jobs) + Number(intents);
  }
  hourlyRulesIntents(userId) {
    const since = now() - HOUR_MS;
    return Number(this.one("SELECT COUNT(*) c FROM usage WHERE user_id=? AND kind='intent-rules' AND created_at>?", userId, since)?.c || 0);
  }
  logUsage(userId, kind) {
    this.sql.exec('INSERT INTO usage(user_id,kind,created_at) VALUES(?,?,?)', userId, kind, now());
  }
  consumeRulesIntent(userId) {
    if (this.hourlyRulesIntents(userId) >= RULES_INTENT_QUOTA) return { error: '意图判断过于频繁，请稍后再试' };
    this.logUsage(userId, 'intent-rules');
    return { ok: true };
  }

  // ---------- 项目 ----------
  projectSummary(p) {
    const vc = this.one('SELECT COUNT(*) c FROM versions WHERE project_id=? AND candidate=0', p.id).c;
    const author = this.one('SELECT username FROM users WHERE id=?', p.user_id);
    const cur = p.current_version_id ? this.one('SELECT mode, score FROM versions WHERE id=?', p.current_version_id) : null;
    return { id: p.id, title: p.title, prompt: p.prompt, isPublic: !!p.is_public, preset: !!p.preset, author: author?.username || '-',
      ownerId: p.user_id, versions: vc, mode: cur?.mode || null, score: cur?.score ?? null, currentVersionId: p.current_version_id, createdAt: p.created_at, updatedAt: p.updated_at };
  }
  listPlaza() {
    return this.q('SELECT * FROM projects WHERE is_public=1 AND current_version_id IS NOT NULL ORDER BY preset ASC, updated_at DESC LIMIT 60').map((p) => this.projectSummary(p));
  }
  listProjects(userId) {
    return this.q('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC LIMIT 200', userId).map((p) => this.projectSummary(p));
  }
  createProject(userId, { title, prompt }) {
    const id = uid();
    this.sql.exec('INSERT INTO projects(id,user_id,title,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?)', id, userId, title, prompt, now(), now());
    return id;
  }
  getProjectRow(id) { return this.one('SELECT * FROM projects WHERE id=?', id); }
  getProject(id) {
    const p = this.getProjectRow(id);
    if (!p) return null;
    const versions = this.q('SELECT id,n,note,kind,mode,model,score,score_json,lane,candidate,job_id,created_at,length(html) size FROM versions WHERE project_id=? ORDER BY created_at ASC', id)
      .map((v) => ({ ...v, candidate: !!v.candidate, score_json: v.score_json ? JSON.parse(v.score_json) : null }));
    const messages = this.q('SELECT id,role,agent,content,meta,created_at FROM messages WHERE project_id=? ORDER BY created_at ASC, rowid ASC LIMIT 300', id)
      .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
    const current = p.current_version_id ? this.one('SELECT html FROM versions WHERE id=?', p.current_version_id) : null;
    const job = this.activeJob(id);
    return { project: this.projectSummary(p), versions, messages, html: current?.html || '', activeJob: job, pendingRuntime: this.runtimeHint(id) };
  }
  updateProject(id, { title, isPublic }) {
    if (title !== undefined) this.sql.exec('UPDATE projects SET title=?, updated_at=? WHERE id=?', String(title).slice(0, 60), now(), id);
    if (isPublic !== undefined) this.sql.exec('UPDATE projects SET is_public=?, updated_at=? WHERE id=?', isPublic ? 1 : 0, now(), id);
    return this.projectSummary(this.getProjectRow(id));
  }
  deleteProject(id) {
    for (const t of ['versions', 'messages', 'jobs']) this.sql.exec(`DELETE FROM ${t} WHERE project_id=?`, id);
    this.sql.exec('DELETE FROM projects WHERE id=?', id);
  }
  forkProject(srcId, userId) {
    const src = this.getProjectRow(srcId);
    if (!src || !src.current_version_id) return null;
    const v = this.one('SELECT * FROM versions WHERE id=?', src.current_version_id);
    const id = this.createProject(userId, { title: src.title + '（副本）', prompt: src.prompt });
    this.sql.exec('UPDATE projects SET forked_from=? WHERE id=?', srcId, id);
    this.addMessage(id, 'agent', 'system', `已从广场作品「${src.title}」复制，你可以在下方继续对话修改它。`);
    this.addVersion(id, { html: v.html, note: `Fork 自「${src.title}」`, kind: 'fork', mode: v.mode, model: v.model, score: v.score_json ? JSON.parse(v.score_json) : null });
    return id;
  }

  // ---------- 消息 & 版本 ----------
  addMessage(projectId, role, agent, content, meta) {
    const id = uid();
    this.sql.exec('INSERT INTO messages(id,project_id,role,agent,content,meta,created_at) VALUES(?,?,?,?,?,?,?)', id, projectId, role, agent, String(content || ''), meta ? JSON.stringify(meta) : null, now());
    return id;
  }
  updateMessage(id, content, meta) {
    this.sql.exec('UPDATE messages SET content=?, meta=? WHERE id=?', String(content ?? ''), meta ? JSON.stringify(meta) : null, id);
  }
  addVersion(projectId, { html, note, kind, mode, model, score, lane, candidate, jobId }) {
    const id = uid();
    const n = (this.one('SELECT COALESCE(MAX(n),0) m FROM versions WHERE project_id=?', projectId).m || 0) + 1;
    this.sql.exec('INSERT INTO versions(id,project_id,n,html,note,kind,mode,model,score,score_json,lane,candidate,job_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, n, html, note || '', kind || 'generate', mode || 'ai', model || '', score ? score.total : null, score ? JSON.stringify(score) : null, lane || null, candidate ? 1 : 0, jobId || null, now());
    if (!candidate) this.sql.exec('UPDATE projects SET current_version_id=?, updated_at=? WHERE id=?', id, now(), projectId);
    return id;
  }
  getVersion(id) { return this.one('SELECT * FROM versions WHERE id=?', id); }
  // 回滚 / 采用候选方案：复制成新版本（历史不丢）
  adoptVersion(projectId, versionId, note) {
    const v = this.one('SELECT * FROM versions WHERE id=? AND project_id=?', versionId, projectId);
    if (!v) return null;
    return this.addVersion(projectId, { html: v.html, note, kind: v.candidate ? 'adopt' : 'rollback', mode: v.mode, model: v.model, score: v.score_json ? JSON.parse(v.score_json) : null, lane: v.lane });
  }

  // ---------- 生成任务（状态落库，刷新可恢复） ----------
  createJob(projectId, userId, type) {
    const running = this.activeJob(projectId);
    if (running) return { error: '该项目已有任务在运行', job: running };
    if (this.hourlyModelUses(userId) >= MODEL_QUOTA) return { error: '每小时最多 30 次生成（含意图模型判断），请稍后再试' };
    const id = uid();
    this.sql.exec('INSERT INTO jobs(id,project_id,user_id,type,status,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, projectId, userId, type, 'running', '{}', now(), now());
    return { job: { id, status: 'running', type } };
  }
  updateJob(id, status, detail) {
    let payload = null;
    if (detail) {
      let prev = {};
      try { prev = JSON.parse(this.one('SELECT detail FROM jobs WHERE id=?', id)?.detail || '{}') || {}; } catch {}
      payload = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev, ...detail } : detail;
    }
    this.sql.exec('UPDATE jobs SET status=COALESCE(?,status), detail=COALESCE(?,detail), updated_at=? WHERE id=?', status || null, payload ? JSON.stringify(payload) : null, now(), id);
    if (status && status !== 'running') {
      const j = this.one('SELECT project_id FROM jobs WHERE id=?', id);
      if (j) this.sql.exec('UPDATE projects SET updated_at=? WHERE id=?', now(), j.project_id);
    }
  }
  getJob(id) {
    const j = this.one('SELECT * FROM jobs WHERE id=?', id);
    if (!j) return null;
    if (j.status === 'running' && now() - j.updated_at > STALE_MS) {
      const error = '任务中断（超时无心跳）';
      this.updateJob(id, 'failed', { error });
      j.status = 'failed';
      try {
        const prev = JSON.parse(j.detail || '{}') || {};
        j.detail = JSON.stringify(prev && typeof prev === 'object' ? { ...prev, error } : { error });
      } catch { j.detail = JSON.stringify({ error }); }
    }
    return { id: j.id, projectId: j.project_id, userId: j.user_id, type: j.type, status: j.status, detail: JSON.parse(j.detail || '{}'), createdAt: j.created_at, updatedAt: j.updated_at };
  }
  activeJob(projectId) {
    const j = this.one("SELECT id FROM jobs WHERE project_id=? AND status IN ('running','canceling') ORDER BY created_at DESC LIMIT 1", projectId);
    if (!j) return null;
    const job = this.getJob(j.id);
    return job && (job.status === 'running' || job.status === 'canceling') ? job : null;
  }
  // 意图分类用：标题 / 原始需求 / 最近一次规划，不带 HTML
  projectContext(id) {
    const p = this.getProjectRow(id);
    if (!p) return null;
    let plan = null;
    const rows = this.q("SELECT meta FROM messages WHERE project_id=? AND agent='planner' ORDER BY created_at DESC LIMIT 5", id);
    for (const r of rows) {
      if (!r.meta) continue;
      try { const m = JSON.parse(r.meta); if (m && m.plan) { plan = m.plan; break; } } catch {}
    }
    return { title: p.title, prompt: p.prompt, plan };
  }
  // 刚结束、还没做过运行时检查的任务（刷新后补跑）
  runtimeHint(projectId) {
    const j = this.one('SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 1', projectId);
    if (!j) return null;
    const job = this.getJob(j.id);
    if (!job || job.status !== 'done') return null;
    const d = job.detail || {};
    if (d.needsRuntime && !d.runtimeChecked && d.runtimeToken) return { id: job.id, type: job.type, token: d.runtimeToken };
    return null;
  }
  findResultMessage(projectId, jobId, versionIds) {
    const rows = this.q("SELECT id, agent, content, meta FROM messages WHERE project_id=? AND agent IN ('qa','editor') ORDER BY created_at DESC, rowid DESC LIMIT 40", projectId);
    let byVersion = null;
    for (const m of rows) {
      let meta = null;
      try { meta = m.meta ? JSON.parse(m.meta) : null; } catch { meta = null; }
      if (!meta || typeof meta !== 'object') continue;
      if (meta.jobId && meta.jobId === jobId) return { id: m.id, agent: m.agent, content: m.content, meta };
      if (!byVersion && meta.versionId && versionIds.has(String(meta.versionId)) && !meta.runtime) byVersion = { id: m.id, agent: m.agent, content: m.content, meta };
    }
    return byVersion;
  }
  applyRuntimeCheck(projectId, { jobId, reports, runtimeToken }) {
    const job = this.getJob(jobId);
    if (!job || job.projectId !== projectId) return { error: '任务不存在', status: 404 };
    if (job.status !== 'done') return { error: '任务尚未完成', status: 409 };
    if (job.detail?.runtimeChecked || job.detail?.runtimeTokenUsed) return { error: '运行时检查已提交', status: 409 };
    const expected = typeof job.detail?.runtimeToken === 'string' ? job.detail.runtimeToken : '';
    if (!expected) return { error: '缺少运行时检查凭证', status: 403 };
    if (!timingSafeEqualStr(expected, String(runtimeToken ?? ''))) return { error: '运行时检查凭证无效', status: 403 };
    const versions = this.q('SELECT * FROM versions WHERE project_id=? AND job_id=? ORDER BY created_at ASC', projectId, jobId);
    const checked = validateRuntimeReports(reports, { versionIds: versions.map((v) => v.id) });
    if (!checked.ok) return { error: checked.error, status: 400 };
    const list = checked.reports;
    if (!list.length) return { inconclusive: true };
    // 凭证一次性：校验通过后立即作废，重放返回 409
    this.updateJob(jobId, null, { runtimeToken: '', runtimeTokenUsed: true });
    const byId = new Map(versions.map((v) => [v.id, v]));
    const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    const updated = [];
    for (const rep of list) {
      const v = byId.get(rep.versionId);
      if (!v) continue;
      let prev = { total: v.score || 0, items: [], qa: { ok: true, issues: [] } };
      try { if (v.score_json) prev = JSON.parse(v.score_json); } catch {}
      const next = applyRuntime(prev, rep);
      next.total = clamp100(next.total);
      if (next.staticTotal != null) next.staticTotal = clamp100(next.staticTotal);
      this.sql.exec('UPDATE versions SET score=?, score_json=? WHERE id=?', next.total, JSON.stringify(next), v.id);
      updated.push({ row: { ...v, score_json: JSON.stringify(next) }, score: next });
    }
    if (!updated.length) {
      this.updateJob(jobId, null, { runtimeChecked: true, needsRuntime: false });
      return { inconclusive: true };
    }
    const laneName = (id) => (LANE_VARIANTS.find((x) => x.id === id) || {}).name || '';
    const labelOf = (rt) => !rt ? '—' : rt.blank ? '⚪ 白屏' : rt.errorCount > 0 ? `❌ ${rt.errorCount} 个错误` : '✅';
    const proj = this.getProjectRow(projectId);
    const isEdit = job.type === 'edit';
    const winner = updated.find((u) => u.row.id === proj.current_version_id) || updated.find((u) => !u.row.candidate) || updated[0];
    const clean = updated.filter((u) => u.row.candidate && u.score.runtime.clean).sort((a, b) => b.score.total - a.score.total);
    const winnerDirty = winner && !winner.score.runtime.clean;
    let switched = false, newVersionId = null, note = '';
    if (!isEdit && winnerDirty && clean.length && clean[0].score.total > winner.score.total) {
      const best = clean[0];
      const wLane = winner.row.lane || 'A';
      const bLane = best.row.lane || 'B';
      note = winner.score.runtime.blank ? `运行时检查：方案 ${wLane} 白屏，自动改用方案 ${bLane}` : `运行时检查：方案 ${wLane} 报错，自动改用方案 ${bLane}`;
      newVersionId = this.adoptVersion(projectId, best.row.id, note);
      switched = true;
    }
    const winLane = switched ? clean[0].row.lane : winner?.row.lane;
    const board = updated.map((u) => ({
      lane: u.row.lane || (isEdit ? 'E' : '-'),
      name: laneName(u.row.lane) || (u.row.kind === 'fallback' ? '模板' : isEdit ? '本次修改' : ''),
      ok: true,
      score: u.score.total,
      staticScore: u.score.staticTotal,
      finalScore: u.score.total,
      runtimeLabel: labelOf(u.score.runtime),
      items: u.score.items,
      model: u.row.model || '-',
      ms: 0,
      error: u.score.runtime.clean ? null : (u.score.runtime.blank ? '白屏' : (u.score.runtime.errors[0]?.message || '运行时错误')),
    }));
    const candidates = isEdit ? [] : updated.filter((u) => u.row.candidate && u.row.lane !== winLane).map((u) => ({ id: u.row.id, lane: u.row.lane, name: laneName(u.row.lane), score: u.score.total }));
    const prevMsg = this.findResultMessage(projectId, jobId, new Set(versions.map((v) => v.id)));
    const isFallback = !!(prevMsg?.meta?.fallback) || versions.some((v) => v.kind === 'fallback');
    const wasRace = !!(prevMsg && String(prevMsg.content || '').includes('赛马结果')) || (!isEdit && !isFallback && updated.length > 1);
    const appendPass = (base) => {
      const t = String(base || '').trim();
      if (!t) return '运行时检查通过。';
      if (t.includes('运行时检查通过')) return t;
      return t.replace(/。?$/, '。') + '运行时检查通过。';
    };
    const appendFail = (base, sentence) => {
      const t = String(base || '').replace(/运行时检查未通过：.*$/, '').trim();
      return (t ? t.replace(/。?$/, '。') : '') + sentence;
    };
    let content = '';
    if (isEdit || isFallback) {
      const base = prevMsg?.content || (isEdit ? '已完成修改。' : '已使用内置模板。');
      const rt = winner?.score.runtime;
      if (!winnerDirty || !rt) content = appendPass(base);
      else if (rt.blank) content = appendFail(base, '运行时检查未通过：页面白屏。可在预览里点「让 AI 修复」。');
      else content = appendFail(base, `运行时检查未通过：${rt.errorCount} 个错误。可在预览里点「让 AI 修复」。`);
    } else if (switched) {
      const wLane = winner.row.lane || 'A';
      const bLane = clean[0].row.lane || 'B';
      const rt = winner.score.runtime;
      const problem = rt.blank ? '运行时白屏' : `运行时报 ${rt.errorCount} 个错误`;
      content = `赛马结果：方案 ${bLane} 以 ${clean[0].score.total} 分胜出（方案 ${wLane} 静态 ${winner.score.staticTotal} 分领先，但${problem}，已自动改用方案 ${bLane}）`;
    } else if (updated.every((u) => !u.score.runtime.clean)) {
      content = `运行时检查：全部方案都有运行时问题。已保留当前方案${winLane ? ' ' + winLane : ''}，可在预览里点「让 AI 修复」。`;
    } else if (winnerDirty) {
      content = `运行时检查：当前方案存在运行时问题，其他方案分数未超过它，暂时保留。可在预览里点「让 AI 修复」。`;
    } else if (wasRace) {
      const name = laneName(winLane);
      const extra = candidates.length ? '，其余方案已保留为候选，可一键切换' : '';
      content = `赛马结果：方案 ${winLane}${name ? '（' + name + '）' : ''}以 ${winner.score.total} 分胜出${extra}。运行时检查通过。`;
    } else {
      content = appendPass(prevMsg?.content || `QA 通过，综合评分 ${winner.score.total} 分。`);
    }
    const meta = {
      ...(prevMsg?.meta || {}),
      runtime: true,
      jobId,
      board,
      winner: winLane || null,
      versionId: newVersionId || winner?.row.id || prevMsg?.meta?.versionId || null,
      candidates,
    };
    if (prevMsg) this.updateMessage(prevMsg.id, content, meta);
    else this.addMessage(projectId, 'agent', isEdit ? 'editor' : 'qa', content, meta);
    this.updateJob(jobId, null, { runtimeChecked: true, needsRuntime: false });
    return { ok: true, switched, versionId: newVersionId || null };
  }
  cancelJob(id) { this.sql.exec("UPDATE jobs SET status='canceling', updated_at=? WHERE id=? AND status='running'", now(), id); }
  isCanceled(id) {
    const j = this.one('SELECT status FROM jobs WHERE id=?', id);
    // 顺带刷新心跳
    this.sql.exec('UPDATE jobs SET updated_at=? WHERE id=? AND status=\'running\'', now(), id);
    return !j || j.status === 'canceling' || j.status === 'canceled';
  }
}
