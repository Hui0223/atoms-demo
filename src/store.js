// 持久化层：Durable Object 内置 SQLite（强一致、随 Worker 部署、免费可用、重启不丢）
import { DurableObject } from 'cloudflare:workers';
import sources from './templates/sources.js';
import { renderTemplate } from './templates/engine.js';
import { scoreHtml, applyRuntime } from './lib/qa.js';
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

export class AppStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
      this.seed();
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
    const recent = this.one("SELECT COUNT(*) c FROM jobs WHERE user_id=? AND created_at>?", userId, now() - 3600_000).c;
    if (recent >= 30) return { error: '每小时最多 30 次生成，请稍后再试' };
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
    if (j.status === 'running' && now() - j.updated_at > STALE_MS) { this.updateJob(id, 'failed', { error: '任务中断（超时无心跳）' }); j.status = 'failed'; }
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
    if (d.needsRuntime && !d.runtimeChecked) return { id: job.id, type: job.type };
    return null;
  }
  applyRuntimeCheck(projectId, { jobId, reports }) {
    const job = this.getJob(jobId);
    if (!job || job.projectId !== projectId) return { error: '任务不存在' };
    if (job.detail?.runtimeChecked) return { ignored: true };
    const list = (Array.isArray(reports) ? reports : []).slice(0, 8).map((r) => {
      if (!r || !r.versionId || r.timeout) return null;
      const errors = (Array.isArray(r.errors) ? r.errors : []).slice(0, 12).map((e) => ({
        message: String((e && e.message) || '').trim().slice(0, 300),
        line: e && e.line ? (e.line | 0) : 0,
      })).filter((e) => e.message);
      return { versionId: String(r.versionId), errors, blank: !!r.blank, textLen: r.textLen | 0, nodes: r.nodes | 0 };
    }).filter(Boolean);
    if (!list.length) return { inconclusive: true };
    const versions = this.q('SELECT * FROM versions WHERE project_id=? AND job_id=? ORDER BY created_at ASC', projectId, jobId);
    const byId = new Map(versions.map((v) => [v.id, v]));
    const updated = [];
    for (const rep of list) {
      const v = byId.get(rep.versionId);
      if (!v) continue;
      let prev = { total: v.score || 0, items: [], qa: { ok: true, issues: [] } };
      try { if (v.score_json) prev = JSON.parse(v.score_json); } catch {}
      const next = applyRuntime(prev, rep);
      this.sql.exec('UPDATE versions SET score=?, score_json=? WHERE id=?', next.total, JSON.stringify(next), v.id);
      updated.push({ row: { ...v, score_json: JSON.stringify(next) }, score: next });
    }
    if (!updated.length) return { inconclusive: true };
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
    let content = '';
    if (isEdit) {
      if (winnerDirty) {
        const rt = winner.score.runtime;
        content = rt.blank ? '运行时检查未通过：页面白屏。可在预览里点「让 AI 修复」。' : `运行时检查未通过：${rt.errorCount} 个错误。可在预览里点「让 AI 修复」。`;
      }
    } else if (switched) {
      content = `${note}（最终 ${clean[0].score.total} 分）。`;
    } else if (updated.every((u) => !u.score.runtime.clean)) {
      content = `运行时检查：全部方案都有运行时问题。已保留当前方案${winLane ? ' ' + winLane : ''}，可在预览里点「让 AI 修复」。`;
    } else if (winnerDirty) {
      content = `运行时检查：当前方案存在运行时问题，其他方案分数未超过它，暂时保留。可在预览里点「让 AI 修复」。`;
    } else {
      content = `运行时检查通过${winLane ? '：方案 ' + winLane + ' 无报错' : ''}（最终 ${winner.score.total} 分）。`;
    }
    if (content) {
      const meta = {
        runtime: true,
        board,
        winner: winLane || null,
        versionId: newVersionId || winner?.row.id || null,
        candidates: isEdit ? [] : updated.filter((u) => u.row.candidate && u.row.lane !== winLane).map((u) => ({ id: u.row.id, lane: u.row.lane, name: laneName(u.row.lane), score: u.score.total })),
      };
      this.addMessage(projectId, 'agent', 'qa', content, meta);
    }
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
