// Atoms Demo 前端（原生 ES Module，无构建步骤）
import { injectShim } from './shim.js';

// ---------------- 基础工具 ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
const fmtTime = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const MODE_TAG = { ai: ['ai', 'AI 生成'], backup: ['backup', '备用模型'], demo: ['demo', '演示模式'], preset: ['preset', '官方示例'] };
const modeTag = (m) => { const t = MODE_TAG[m]; return t ? `<span class="tag ${t[0]}">${t[1]}</span>` : ''; };
function runtimeTag(v) {
  const rt = v && v.score_json && v.score_json.runtime;
  if (!rt) return '';
  if (rt.blank) return '<span class="tag demo">白屏</span>';
  if (rt.errorCount) return `<span class="tag demo">运行时 ${rt.errorCount} 错</span>`;
  return '<span class="tag ai">运行时通过</span>';
}
function scoreTags(v) {
  if (!v || v.score == null) return '';
  const stc = v.score_json && v.score_json.staticTotal;
  const diff = stc != null && stc !== v.score ? `<span class="tag">静态 ${stc}</span>` : '';
  return `<span class="tag">评分 ${v.score}</span>${diff}${runtimeTag(v)}`;
}
const AGENTS = {
  planner: ['📋', 'Emma · 产品经理'], engineer: ['💻', 'Alex · 工程师'], editor: ['✏️', 'Alex · 工程师（迭代）'],
  qa: ['🧪', 'Iris · 测试与评审'], system: ['⚙️', '系统'],
};
const EXAMPLES = [
  '我要一个带优先级、截止日、拖拽排序的项目看板',
  '一个能算房贷月供的计算器，带提前还款对比',
  '个人主页：我叫陈默，是一名产品设计师，技能：Figma、用户研究、交互设计',
  '记账本：按分类记录收支，显示本月饼图统计',
  '单词卡片背诵工具，支持翻面、标记熟悉度和复习进度',
];
const EDIT_SUGGESTIONS = ['把主色调换成蓝色', '切换为深色主题', '增加一个“导出数据为 JSON”的按钮', '标题改为「我的效率工具」'];

// 赛马表里缩短模型名（deepseek-v4-flash → DS-v4，glm-5.3-flash → GLM-5.3）；完整名字放 title。
function shortModel(name) {
  const full = String(name || '').trim();
  if (!full || full === '-') return full;
  let s = full.split('/').pop().trim();
  s = s.replace(/[\s_-]*flash\b/ig, '');
  s = s.replace(/^deepseek[\s._-]*/i, 'DS-').replace(/^glm[\s._-]*/i, 'GLM-');
  s = s.replace(/^[-_.\s]+|[-_.\s]+$/g, '');
  return s || full;
}

function jobErrorText(j) {
  const d = (j && j.detail) || {};
  return d.error || (d.result && d.result.error) || '';
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------- API ----------------
const auth = {
  get token() { return localStorage.getItem('atoms_token') || ''; },
  set(token, user) { localStorage.setItem('atoms_token', token); localStorage.setItem('atoms_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('atoms_token'); localStorage.removeItem('atoms_user'); },
  get user() { try { return JSON.parse(localStorage.getItem('atoms_user') || 'null'); } catch { return null; } },
};

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth.token) headers.authorization = 'Bearer ' + auth.token;
  let res;
  try { res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal }); }
  catch (e) { throw new Error('网络连接失败，请检查网络后重试'); }
  if (res.status === 401 && auth.token) { auth.clear(); renderUser(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status, data });
  return data;
}

// 读取 SSE（POST + 流式响应）
async function streamRun(path, body, onEvent, signal) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token };
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `请求失败（${res.status}）`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
      const data = (chunk.match(/^data: (.*)$/m) || [])[1];
      if (ev && data) { try { onEvent(ev, JSON.parse(data)); } catch (e) { console.error(e); } }
    }
  }
}

// ---------------- 登录 / 用户 ----------------
async function ensureLogin(reason) {
  if (auth.token) return true;
  try {
    const r = await api('/api/auth/guest', { method: 'POST' });
    auth.set(r.token, r.user); renderUser();
    toast(`已为你创建游客账号「${r.user.username}」${reason ? '，' + reason : ''}，可随时升级为正式账号`);
    return true;
  } catch (e) { toast(e.message); openAuth('login'); return false; }
}

function renderUser() {
  const u = auth.user;
  const box = $('#userbox');
  if (!u || !auth.token) { box.innerHTML = `<button class="btn sm" id="loginBtn">登录 / 注册</button>`; $('#loginBtn').onclick = () => openAuth('login'); return; }
  box.innerHTML = `<span class="avatar">${esc(u.username.slice(0, 1))}</span><span class="uname">${esc(u.username)}</span>${u.isGuest ? '<button class="btn sm primary" id="upBtn"><span class="up-full">升级为正式账号</span><span class="up-short">升级</span></button>' : ''}<button class="btn sm ghost" id="logoutBtn">退出</button>`;
  if (u.isGuest) $('#upBtn').onclick = () => openAuth('register');
  $('#logoutBtn').onclick = async () => { if (u.isGuest && !confirm('游客账号退出后将无法再找回其项目，建议先“升级为正式账号”。确定退出？')) return; await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); auth.clear(); renderUser(); location.hash = '#/'; };
}

let authTab = 'login';
function openAuth(tab) {
  authTab = tab; const dlg = $('#authDlg');
  $$('[data-tab]', dlg).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#authSubmit').textContent = tab === 'login' ? '登录' : (auth.user?.isGuest ? '升级并保留游客项目' : '注册');
  $('#authTip').textContent = tab === 'login' ? '登录后即可保存你的项目与版本历史。' : (auth.user?.isGuest ? '设置用户名和密码，当前游客账号下的项目会全部保留。' : '创建账号，项目与版本历史将永久保存。');
  $('#guestBtn').hidden = !!auth.token;
  $('#authErr').textContent = '';
  if (!dlg.open) dlg.showModal();
}
function initAuthDialog() {
  const dlg = $('#authDlg');
  $$('[data-tab]', dlg).forEach((b) => (b.onclick = () => openAuth(b.dataset.tab)));
  $('#authClose').onclick = () => dlg.close();
  $('#guestBtn').onclick = async () => { dlg.close(); await ensureLogin(); route(); };
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#authErr').textContent = '';
    try {
      const r = await api(`/api/auth/${authTab === 'login' ? 'login' : 'register'}`, { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value } });
      auth.set(r.token, r.user); renderUser(); dlg.close(); f.reset();
      toast(authTab === 'login' ? `欢迎回来，${r.user.username}` : '账号创建成功'); route();
    } catch (err) { $('#authErr').textContent = err.message; }
  });
}

// ---------------- 预览沙箱 ----------------
const appDataKey = (pid) => 'atoms_appdata:' + pid;
function previewDoc(html, pid) {
  let initial = {};
  try { initial = JSON.parse(localStorage.getItem(appDataKey(pid)) || '{}'); } catch {}
  return injectShim(html, { storageKey: pid, initial, bridge: true });
}
function makeFrame(html, pid, { thumb = false } = {}) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', thumb ? 'allow-scripts' : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.dataset.pid = pid;
  f.srcdoc = thumb ? injectShim(html, { storageKey: pid, bridge: false }) : previewDoc(html, pid);
  if (thumb) { f.loading = 'lazy'; f.tabIndex = -1; }
  return f;
}
// 预览中的 localStorage 写入 → 宿主按项目持久化
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.__atoms) return;
  const frame = $$('iframe').find((f) => f.contentWindow === e.source);
  if (!frame || !frame.dataset.pid) return;
  if (d.__atoms === 'ls' && frame.dataset.thumb !== '1') {
    try { localStorage.setItem(appDataKey(frame.dataset.pid), JSON.stringify(d.data || {})); } catch {}
  }
  if (d.__atoms === 'error' && WS.onRuntimeError) WS.onRuntimeError(frame, d);
});

// ---------------- 路由 ----------------
const views = { home: viewHome, plaza: viewPlaza, projects: viewProjects, project: viewProject };
let cleanup = null;
function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const h = location.hash.replace(/^#/, '') || '/';
  const [, a, b] = h.split('/');
  $$('[data-nav]').forEach((n) => n.classList.toggle('on', n.dataset.nav === (a || 'home')));
  const app = $('#app');
  app.innerHTML = '';
  if (a === 'p' && b) return views.project(app, decodeURIComponent(b));
  if (a === 'projects') return views.projects(app);
  if (a === 'plaza') return views.plaza(app);
  return views.home(app);
}

// ---------------- 首页 ----------------
const MODEL_LABEL = { deepseek: 'DeepSeek V4 Flash', glm: 'GLM-5.3 Flash', mixed: '混合（各路交替）' };
function composerOptions(prefix = '') {
  return `<label class="opt" title="生成所用模型；主模型失败时自动切换到另一个，再失败则用内置模板兜底">🧠 模型
      <select id="${prefix}model"><option value="deepseek" selected>DeepSeek V4 Flash</option><option value="glm">GLM-5.3 Flash（推理较慢）</option><option value="mixed">混合（赛马各路交替）</option></select></label>
    <label class="opt" title="赛马模式：多路工程师智能体并行生成，自动打分择优">🏁 赛马
      <select id="${prefix}lanes"><option value="1">1 路</option><option value="2" selected>2 路</option><option value="3">3 路</option></select></label>
    <label class="opt" title="不调用模型，使用内置模板与规则引擎（额度为零时也能完整演示）"><input type="checkbox" id="${prefix}demo"> 演示模式</label>
    <label class="opt" title="故障演练：验证重试 / 备用模型 / 降级兜底链路">🧯 故障演练
      <select id="${prefix}simulate"><option value="none">关闭</option><option value="primary429">主模型 429</option><option value="alldown">全部模型不可用</option><option value="runtimeError">运行时报错（方案 A 注入错误）</option></select></label>`;
}

// recommend: 'new' 时主按钮是「新建项目（推荐）」；否则维持原选择框，不标推荐
function askIntentChoice(text, opt = {}) {
  return new Promise((resolve) => {
    const dlg = $('#intentDlg');
    if (!dlg) { resolve(null); return; }
    const tip = $('#intentTip');
    const editBtn = $('#intentEdit');
    const newBtn = $('#intentNew');
    const closeBtn = $('#intentClose');
    const snippet = `「${String(text).slice(0, 42)}」`;
    const recommendNew = opt.recommend === 'new';
    if (tip) {
      tip.textContent = recommendNew
        ? `模型判断${snippet}是一个全新的应用。可以新建项目，也可以仍在当前应用上修改。`
        : `${snippet}不太好判断是在改当前应用，还是要做一个全新的应用。`;
    }
    if (editBtn && newBtn) {
      newBtn.textContent = recommendNew ? '新建项目（推荐）' : '新建项目';
      editBtn.textContent = '修改当前应用';
      newBtn.className = recommendNew ? 'btn primary block' : 'btn block';
      editBtn.className = recommendNew ? 'btn block' : 'btn primary block';
      const form = dlg.querySelector('form');
      if (form) {
        if (recommendNew) form.insertBefore(newBtn, editBtn);
        else form.insertBefore(editBtn, newBtn);
        if (closeBtn) form.appendChild(closeBtn);
      }
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onCancel = (e) => { e.preventDefault(); done(null); };
    const onClose = () => done(null);
    if (editBtn) editBtn.onclick = () => done('edit');
    if (newBtn) newBtn.onclick = () => done('new');
    if (closeBtn) closeBtn.onclick = () => done(null);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    if (!dlg.open) dlg.showModal();
  });
}

// 隐藏沙箱运行时探针：无同源、不桥接存储，约 2.5s 后收报告，单路最多 5s
function probeHtml(html, versionId) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.dataset.probe = '1';
    f.dataset.pid = 'probe';
    f.title = 'runtime-check';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-12000px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none';
    let done = false;
    const finish = (rep) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      try { f.remove(); } catch {}
      resolve({
        errors: Array.isArray(rep && rep.errors) ? rep.errors : [],
        blank: !!(rep && rep.blank),
        textLen: (rep && rep.textLen) | 0,
        nodes: (rep && rep.nodes) | 0,
        timeout: !!(rep && rep.timeout),
      });
    };
    const onMsg = (e) => {
      if (e.source !== f.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'atoms-runtime-report' && d.__atoms !== 'runtime-report') return;
      if (String(d.probeId || '') !== String(versionId)) return;
      finish(d);
    };
    const timer = setTimeout(() => finish({ errors: [], blank: false, timeout: true }), 5000);
    window.addEventListener('message', onMsg);
    document.body.appendChild(f);
    f.srcdoc = injectShim(html, { storageKey: 'probe-' + versionId, bridge: false, probe: true, probeId: versionId });
  });
}

function viewHome(app) {
  app.innerHTML = `
  <section class="hero">
    <h1>一句话，生成一个<br><span class="grad">能打开、能点、能存数据</span>的应用</h1>
    <p>产品经理拆解需求 → 多位工程师赛马编码 → 测试评审择优 → 即时预览、对话式增量修改、一键分享</p>
    <div class="composer">
      <textarea id="prompt" maxlength="2000" placeholder="描述你想要的应用，例如：我要一个带优先级、截止日、拖拽排序的项目看板"></textarea>
      <div class="bar">${composerOptions()}<span class="spacer"></span><button class="btn primary" id="go">✨ 开始生成</button></div>
    </div>
    <div class="chips">${EXAMPLES.map((e) => `<span class="chip">${esc(e)}</span>`).join('')}</div>
  </section>
  <section class="features">
    <div class="feature"><b>🤖 多智能体协作</b><span class="muted">Planner / Engineer / QA 分工，过程实时可见</span></div>
    <div class="feature"><b>🏁 赛马模式</b><span class="muted">2-3 路并行生成，按可解释的评分自动择优</span></div>
    <div class="feature"><b>✏️ 增量迭代</b><span class="muted">只生成补丁，QA 不过不落库，可随时回滚</span></div>
    <div class="feature"><b>🛟 永不白屏</b><span class="muted">重试 → 备用模型 → 模板降级，四层防线</span></div>
  </section>
  <section class="section"><h2>作品广场</h2><p class="sub">无需等待，点开即可体验；也可以 Fork 到自己的项目继续修改</p><div class="grid" id="plazaGrid"><div class="empty">加载中…</div></div></section>`;
  const ta = $('#prompt');
  $$('.chip', app).forEach((c) => (c.onclick = () => { ta.value = c.textContent; ta.focus(); }));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#go').click(); });
  $('#go').onclick = async () => {
    const prompt = ta.value.trim();
    if (prompt.length < 2) { toast('先描述一下你想要的应用吧'); ta.focus(); return; }
    $('#go').disabled = true;
    try {
      if (!(await ensureLogin('作品将保存在该账号下'))) return;
      const { id } = await api('/api/projects', { method: 'POST', body: { prompt } });
      sessionStorage.setItem('atoms_autostart', JSON.stringify({ id, prompt, lanes: +$('#lanes').value, model: $('#model').value, demo: $('#demo').checked, simulate: $('#simulate').value }));
      location.hash = '#/p/' + id;
    } catch (e) { toast(e.message); } finally { $('#go').disabled = false; }
  };
  loadPlaza($('#plazaGrid'));
}

async function loadPlaza(grid) {
  try {
    const { projects } = await api('/api/plaza');
    grid.innerHTML = projects.length ? '' : '<div class="empty">还没有公开作品</div>';
    projects.forEach((p) => grid.appendChild(projectCard(p, { plaza: true })));
  } catch (e) { grid.innerHTML = `<div class="empty">加载失败：${esc(e.message)} <button class="btn sm" id="retryPlaza">重试</button></div>`; $('#retryPlaza').onclick = () => loadPlaza(grid); }
}

function projectCard(p, { plaza = false, onDelete } = {}) {
  const el = document.createElement('div');
  el.className = 'pcard';
  el.innerHTML = `<div class="thumb"></div><div class="body"><div class="title">${esc(p.title)}</div><div class="desc">${esc(p.prompt)}</div>
    <div class="foot">${p.preset ? modeTag('preset') : modeTag(p.mode)}${p.isPublic && !plaza ? '<span class="tag">已公开</span>' : ''}<span class="tag">v${p.versions}</span>
    <span class="muted small">${plaza ? '@' + esc(p.author) : fmtTime(p.updatedAt)}</span>
    <span class="r">${onDelete ? '<button class="btn sm danger" data-del>删除</button>' : ''}</span></div></div>`;
  el.onclick = (e) => { if (e.target.closest('[data-del]')) return; location.hash = '#/p/' + p.id; };
  if (onDelete) $('[data-del]', el).onclick = () => onDelete(p);
  const thumb = $('.thumb', el);
  if (p.currentVersionId) {
    const io = new IntersectionObserver(async (ents) => {
      if (!ents[0].isIntersecting) return; io.disconnect();
      try { const v = await api('/api/versions/' + p.currentVersionId); const f = makeFrame(v.html, p.id, { thumb: true }); f.dataset.thumb = '1'; thumb.appendChild(f); } catch {}
    });
    io.observe(thumb);
  } else thumb.innerHTML = '<div class="placeholder" style="padding-top:70px">尚未生成</div>';
  return el;
}

function viewPlaza(app) {
  app.innerHTML = `<section class="section"><h2>作品广场</h2><p class="sub">官方预置示例与用户公开的作品，点击打开即可直接使用</p><div class="grid" id="plazaGrid"><div class="empty">加载中…</div></div></section>`;
  loadPlaza($('#plazaGrid'));
}

async function viewProjects(app) {
  if (!auth.token) {
    app.innerHTML = `<section class="section"><div class="empty">登录后查看你的项目<br><br><button class="btn primary" id="lg">登录 / 注册</button> <button class="btn" id="gs">游客体验</button></div></section>`;
    $('#lg').onclick = () => openAuth('login'); $('#gs').onclick = async () => { await ensureLogin(); route(); };
    return;
  }
  app.innerHTML = `<section class="section"><h2>我的项目</h2><p class="sub">所有项目与版本历史都保存在云端数据库，换设备登录也在</p><div class="grid" id="grid"><div class="empty">加载中…</div></div></section>`;
  const grid = $('#grid');
  try {
    const { projects } = await api('/api/projects');
    if (!projects.length) { grid.innerHTML = '<div class="empty">还没有项目，<a href="#/">去创作第一个应用</a></div>'; return; }
    grid.innerHTML = '';
    projects.forEach((p) => grid.appendChild(projectCard(p, {
      onDelete: async (pp) => { if (!confirm(`确定删除「${pp.title}」及其全部版本？`)) return; try { await api('/api/projects/' + pp.id, { method: 'DELETE' }); toast('已删除'); route(); } catch (e) { toast(e.message); } },
    })));
  } catch (e) { grid.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

// ---------------- 工作台 ----------------
const WS = { onRuntimeError: null };

async function viewProject(app, id) {
  app.innerHTML = '<div class="section"><div class="empty">加载项目中…</div></div>';
  let data;
  try { data = await api('/api/projects/' + id); }
  catch (e) {
    app.innerHTML = `<div class="section"><div class="empty">${esc(e.message)}${e.status === 403 && !auth.token ? '<br><br><button class="btn primary" id="lg">登录</button>' : ''}</div></div>`;
    if ($('#lg')) $('#lg').onclick = () => openAuth('login');
    return;
  }
  const st = { data, viewVersionId: data.project.currentVersionId, tab: 'preview', device: 'desktop', running: null, html: data.html, runtimeError: null, checkingRuntime: false, checkingThis: null, follow: true };
  let alive = true;
  const owner = data.isOwner;

  app.innerHTML = `
  <div class="ws">
    <aside class="chat">
      <div class="chat-head"><input id="title" value="${esc(data.project.title)}" ${owner ? '' : 'readonly'} maxlength="60">
        ${owner ? `<label class="opt" title="公开后会出现在作品广场"><input type="checkbox" id="pub" ${data.project.isPublic ? 'checked' : ''}> 公开</label>` : `<span class="tag">@${esc(data.project.author)}</span>`}</div>
      <div class="msgs" id="msgs"></div>
      <div class="composer2" id="composer"></div>
    </aside>
    <section class="stage-panel">
      <div class="toolbar">
        <div class="seg" id="tabs"><button data-t="preview" class="on">预览</button><button data-t="code">代码</button><button data-t="versions">版本</button></div>
        <span id="vinfo" class="muted small"></span><span class="spacer"></span>
        <div class="seg" id="dev"><button data-d="desktop" class="on" title="桌面">🖥</button><button data-d="mobile" title="手机">📱</button></div>
        <button class="btn sm" id="reload" title="重新加载预览">↻</button>
        <button class="btn sm" id="dl" title="下载为独立 HTML 文件">⤓ 下载</button>
        <button class="btn sm" id="share" title="复制分享链接">🔗 分享</button>
      </div>
      <div id="stage" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>
    </section>
  </div>`;

  const msgsEl = $('#msgs');
  let scrollLock = 0;
  // scrollTop 赋值会同步触发 scroll。锁住这一下，避免把程序滚动当成用户往上翻
  function setScrollTop(y) {
    scrollLock++;
    msgsEl.scrollTop = y;
    scrollLock--;
  }
  msgsEl.addEventListener('scroll', () => {
    if (scrollLock || !st.running) return;
    const gap = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
    st.follow = gap < 64;
  });
  function pinToProgress() {
    if (st.follow === false || !st.running) return;
    setScrollTop(msgsEl.scrollHeight);
  }

  // ----- 消息渲染 -----
  function renderMessages() {
    const keep = msgsEl.scrollTop;
    const follow = st.follow !== false;
    msgsEl.innerHTML = '';
    st.data.messages.forEach((m) => msgsEl.appendChild(messageEl(m)));
    if (st.running) msgsEl.appendChild(st.running.el);
    if (!st.running || follow) setScrollTop(msgsEl.scrollHeight);
    else setScrollTop(keep);
  }
  function messageEl(m) {
    const el = document.createElement('div');
    if (m.role === 'user') {
      el.className = 'msg user';
      const mm = m.meta || {};
      const opts = mm.type ? `<div class="small" style="opacity:.8;margin-top:4px">${mm.demo ? '演示模式' : `${mm.type === 'generate' ? `赛马 ${mm.lanes || 1} 路 · ` : ''}${MODEL_LABEL[mm.model] || MODEL_LABEL.deepseek}`}${mm.simulate && mm.simulate !== 'none' ? ' · 故障演练' : ''}</div>` : '';
      el.innerHTML = `<div class="who">🙂</div><div class="bubble">${md(m.content)}${opts}</div>`;
      return el;
    }
    const [icon, name] = AGENTS[m.agent] || AGENTS.system;
    el.className = 'msg';
    let extra = '';
    const meta = m.meta || {};
    if (meta.plan && meta.plan.features) extra += `<ul>${meta.plan.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${meta.mode === 'heuristic' ? '<div class="small muted">（规则拆解）</div>' : ''}`;
    if (meta.board && meta.board.length && (meta.board.length > 1 || meta.runtime)) {
      extra += `<div class="board-wrap"><table class="board"><tr><th>方案</th><th>静态</th><th>运行时</th><th>最终</th><th>模型</th><th>耗时</th><th></th></tr>${meta.board.map((b) => {
        const cand = (meta.candidates || []).find((c) => c.lane === b.lane);
        const tip = b.items && b.items.length ? b.items.map((i) => `${i.name} ${i.got}/${i.max}`).join('\n') : (b.error || '');
        const stat = b.staticScore != null ? b.staticScore : b.score;
        const fin = b.finalScore != null ? b.finalScore : b.score;
        const rt = b.runtimeLabel === '待检查' ? '<span class="muted">…</span>' : esc(b.runtimeLabel || '—');
        const modelFull = b.model || '';
        return `<tr class="${b.lane === meta.winner ? 'win' : ''}" title="${esc(tip)}"><td>${esc(b.lane)} · ${esc(b.name || '')}</td><td class="num">${b.ok ? stat : '失败'}</td><td class="num">${rt}</td><td class="num">${b.ok ? fin : '-'}</td><td class="model" title="${esc(modelFull)}">${esc(shortModel(modelFull) || '—')}</td><td class="num">${b.ms ? (b.ms / 1000).toFixed(0) + 's' : '-'}</td>
          <td>${b.lane === meta.winner ? '🏆 已采用' : cand && owner ? `<button class="btn sm" data-adopt="${cand.id}">采用</button>` : cand ? `<button class="btn sm" data-view="${cand.id}">查看</button>` : ''}</td></tr>`;
      }).join('')}</table></div><div class="small muted" style="margin-top:4px">鼠标悬停查看评分细项</div>`;
    }
    if (meta.versionId) {
      const v = st.data.versions.find((x) => x.id === meta.versionId);
      if (v) extra += `<span class="vchip" data-view="${v.id}">查看 v${v.n} ${meta.mode ? '· ' + (MODE_TAG[meta.mode] || ['', meta.mode])[1] : ''}</span>`;
    }
    el.innerHTML = `<div class="who">${icon}</div><div style="min-width:0;flex:1"><div class="name">${esc(name)} · ${fmtTime(m.created_at)}</div><div class="bubble">${md(m.content)}${extra}</div></div>`;
    $$('[data-view]', el).forEach((b) => (b.onclick = () => showVersion(b.dataset.view)));
    $$('[data-adopt]', el).forEach((b) => (b.onclick = () => adopt(b.dataset.adopt)));
    return el;
  }

  // ----- 输入区 -----
  function renderComposer() {
    const c = $('#composer');
    if (!owner) {
      c.innerHTML = `<p class="muted small" style="margin:0">这是 @${esc(st.data.project.author)} 的作品。Fork 到你的项目后即可对话修改。</p><button class="btn primary block" id="fork">⑂ Fork 到我的项目</button>`;
      $('#fork').onclick = async () => { if (!(await ensureLogin())) return; try { const r = await api(`/api/projects/${id}/fork`, { method: 'POST' }); toast('已复制到你的项目'); location.hash = '#/p/' + r.id; } catch (e) { toast(e.message); } };
      return;
    }
    const hasVersion = !!st.data.project.currentVersionId;
    const running = !!st.running;
    c.innerHTML = `
      ${hasVersion ? `<div class="quick">${EDIT_SUGGESTIONS.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
      <textarea id="ask" maxlength="2000" placeholder="${hasVersion ? '描述你想怎么改，例如：把主色调换成蓝色（Ctrl/⌘+Enter 发送）' : '描述你想要的应用'}" ${running ? 'disabled' : ''}></textarea>
      <div class="bar">
        ${running ? `<span class="muted small">任务进行中…</span><span class="spacer"></span><button class="btn danger" id="cancel">⏹ 取消</button>` :
        `<details style="flex:1"><summary class="muted small" style="cursor:pointer">选项</summary><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">${composerOptions('w')}</div></details>
         ${hasVersion ? '<button class="btn" id="regen" title="按原始需求重新生成（会产生新版本）">↺ 重新生成</button>' : ''}
         <button class="btn primary" id="send">${hasVersion ? '发送修改' : '生成'}</button>`}
      </div>`;
    if (running) { $('#cancel').onclick = cancelRun; return; }
    const ask = $('#ask');
    $$('.quick .chip', c).forEach((ch) => (ch.onclick = () => { ask.value = ch.textContent; ask.focus(); }));
    ask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#send').click(); });
    const opts = () => ({ lanes: +$('#wlanes').value, model: $('#wmodel').value, demo: $('#wdemo').checked, simulate: $('#wsimulate').value });
    async function spawnNewProject(text, o) {
      const { id: nid } = await api('/api/projects', { method: 'POST', body: { prompt: text } });
      sessionStorage.setItem('atoms_autostart', JSON.stringify({ id: nid, prompt: text, lanes: o.lanes, model: o.model, demo: !!o.demo, simulate: o.simulate || 'none' }));
      const title = text.replace(/\s+/g, ' ').slice(0, 24);
      toast(`检测到这是一个全新应用需求，已为你新建项目「${title}」`, 4200);
      location.hash = '#/p/' + nid;
    }
    $('#send').onclick = async () => {
      const text = ask.value.trim();
      const o = opts();
      if (!text) { if (!hasVersion) startRun({ type: 'generate', prompt: st.data.project.prompt, ...o }); else ask.focus(); return; }
      if (!hasVersion) { startRun({ type: 'generate', prompt: text, ...o }); return; }
      const btn = $('#send');
      btn.disabled = true; const prevLabel = btn.textContent; btn.textContent = '判断中…';
      let decision;
      try { decision = await api(`/api/projects/${id}/intent`, { method: 'POST', body: { prompt: text } }); }
      catch { decision = { intent: 'unsure', confidence: 0 }; }
      finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = prevLabel; } }
      if (!ask.isConnected) return;
      const fromModel = decision.source === 'model';
      // 规则高置信度的新应用直接开项目；模型判 new 先确认；模型或规则判 edit 直接打补丁
      const rulesNew = !fromModel && decision.intent === 'new' && decision.confidence >= 0.75;
      try {
        if (rulesNew) { await spawnNewProject(text, o); return; }
        if (decision.intent === 'edit') {
          toast('将修改当前应用');
          startRun({ type: 'edit', prompt: text, ...o });
          return;
        }
        const choice = await askIntentChoice(text, fromModel && decision.intent === 'new' ? { recommend: 'new' } : {});
        if (!ask.isConnected) return;
        if (choice === 'new') await spawnNewProject(text, o);
        else if (choice === 'edit') { toast('将修改当前应用'); startRun({ type: 'edit', prompt: text, ...o }); }
      } catch (e) { toast(e.message); }
    };
    if ($('#regen')) $('#regen').onclick = () => startRun({ type: 'generate', prompt: st.data.project.prompt, ...opts() });
  }

  // ----- 运行任务（流式进度） -----
  const GEN_STEPS = [
    { id: 'plan', label: '需求拆解' },
    { id: 'build', label: '并行生成' },
    { id: 'qa', label: '静态评分' },
    { id: 'runtime', label: '运行时检查' },
    { id: 'done', label: '完成' },
  ];
  const EDIT_STEPS = [
    { id: 'edit', label: '生成补丁' },
    { id: 'qa', label: '应用补丁/QA' },
    { id: 'runtime', label: '运行时检查' },
    { id: 'done', label: '完成' },
  ];
  function stepLabel(s, r) {
    if (s.id === 'build') return r.laneCount > 0 ? `并行生成 (${r.laneCount} 路)` : '并行生成';
    return s.label;
  }
  function progressEl() {
    const el = document.createElement('div');
    el.className = 'progress';
    el.innerHTML = `<div class="row"><span class="spinner"></span><span class="stage">准备中…</span><span class="timer">0s / 120s</span></div><div class="stepper"></div><div class="lanes"></div><div class="logs"></div>`;
    return el;
  }
  function laneExpect(l) { return l.lane === 'P' ? 1200 : l.lane === 'E' ? 2500 : 9000; }
  function laneElapsed(l) {
    const base = l.elapsed || 0;
    if (!l._at || l.status === 'done' || l.status === 'failed' || l.status === 'stopped') return base;
    return base + (Date.now() - l._at);
  }
  function laneStatusText(l) {
    const map = { queued: '排队', running: '思考中', thinking: '思考中', coding: '编写代码', done: '已完成', failed: '失败', stopped: '已中止' };
    const base = map[l.status] || '排队';
    return l.status === 'done' && l.score != null ? `${base} ${l.score} 分` : base;
  }
  function laneHtml(l) {
    const sec = Math.max(0, Math.round(laneElapsed(l) / 1000));
    const chars = l.chars || 0;
    const cps = sec > 0 ? Math.round(chars / sec) : (l.cps || 0);
    const pct = l.status === 'done' ? 100 : Math.min(95, Math.round((chars / laneExpect(l)) * 100));
    const label = l.lane === 'P' ? '规划' : l.lane === 'E' ? '补丁' : '方案 ' + (l.lane || '');
    // 默认只在正在输出时展开。用户点过 summary 之后以 userTail 为准（完成也不再自动展开）
    const streaming = l.status === 'thinking' || l.status === 'coding' || l.status === 'running';
    const open = l.userTail != null ? !!l.userTail : streaming;
    const tail = l.tail ? String(l.tail).slice(-400) : '';
    return `<div class="lh"><b>${esc(label)}</b>${l.name ? `<span class="muted">${esc(l.name)}</span>` : ''}${l.channel === 'backup' ? '<span class="muted">备用</span>' : ''}<span class="st">${esc(laneStatusText(l))}</span></div>
      <div class="meta"><span>${esc(l.model || '…')}</span><span>${chars} 字符</span><span data-cps>${cps} 字/秒</span><span data-sec>${sec}s</span></div>
      <div class="track"><i data-bar style="width:${pct}%"></i></div>
      ${l.error && (l.status === 'failed' || l.status === 'stopped') ? `<div class="small" style="color:var(--bad);margin-top:4px">${esc(l.error)}</div>` : ''}
      ${tail ? `<details class="tail" ${open ? 'open' : ''}><summary>实时代码</summary><pre>${esc(tail)}</pre></details>` : ''}`;
  }
  function paintStepper() {
    const r = st.running; if (!r) return;
    const box = $('.stepper', r.el); if (!box) return;
    const steps = r.type === 'edit' ? EDIT_STEPS : GEN_STEPS;
    let idx = steps.findIndex((s) => s.id === r.stageId);
    if (idx < 0) idx = 0;
    const elSec = Math.max(0, Math.floor((Date.now() - (r.stageAt || r.started)) / 1000));
    box.innerHTML = steps.map((s, i) => {
      const cls = i < idx ? 'ok' : i === idx ? 'on' : '';
      const extra = i === idx && s.id !== 'done' ? ` ${elSec}s` : '';
      const arrow = i < steps.length - 1 ? '<span class="step-arr">→</span>' : '';
      return `<span class="step ${cls}">${i < idx ? '✓ ' : ''}${esc(stepLabel(s, r))}${extra}</span>${arrow}`;
    }).join('');
  }
  function paintLaneTimes() {
    const r = st.running; if (!r) return;
    const box = $('.lanes', r.el); if (!box) return;
    for (const l of Object.values(r.lanes)) {
      const el = box.querySelector(`[data-lane="${l.lane}"]`);
      if (!el) continue;
      const sec = Math.max(0, Math.round(laneElapsed(l) / 1000));
      const chars = l.chars || 0;
      const cps = sec > 0 ? Math.round(chars / sec) : 0;
      const pct = l.status === 'done' ? 100 : Math.min(95, Math.round((chars / laneExpect(l)) * 100));
      const a = el.querySelector('[data-sec]'); if (a) a.textContent = sec + 's';
      const b = el.querySelector('[data-cps]'); if (b) b.textContent = cps + ' 字/秒';
      const c = el.querySelector('[data-bar]'); if (c) c.style.width = pct + '%';
    }
  }
  function paintLanes() {
    const r = st.running; if (!r) return;
    const box = $('.lanes', r.el); if (!box) return;
    Object.values(r.lanes).forEach((l) => {
      let el = box.querySelector(`[data-lane="${l.lane}"]`);
      if (!el) { el = document.createElement('div'); el.className = 'lane'; el.dataset.lane = l.lane; box.appendChild(el); }
      el.className = 'lane ' + (l.status === 'done' ? 'done' : (l.status === 'failed' || l.status === 'stopped') ? 'failed' : '');
      el.innerHTML = laneHtml(l);
      const det = el.querySelector('details.tail');
      const sum = det && det.querySelector('summary');
      // 点 summary 时 open 还是点击前的值。不用 toggle：插入 <details open> 会异步派发且 isTrusted 的 toggle
      if (sum) sum.addEventListener('click', () => { l.userTail = !det.open; });
    });
  }
  function onEvent(ev, d) {
    const r = st.running; if (!r) return;
    if (ev === 'job') r.jobId = d.id;
    if (ev === 'stage') {
      let stageChanged = false;
      if (d.stage && d.stage !== r.stageId) { r.stageId = d.stage; r.stageAt = d.at || Date.now(); stageChanged = true; }
      const stage = $('.stage', r.el); if (stage && d.text) stage.textContent = d.text;
      if (d.lanes && d.lanes.length) {
        r.laneCount = d.lanes.length;
        d.lanes.forEach((l) => { r.lanes[l.id] = { ...(r.lanes[l.id] || {}), lane: l.id, name: l.name, status: (r.lanes[l.id] && r.lanes[l.id].status) || 'queued' }; });
      }
      paintLanes(); paintStepper();
      if (stageChanged) pinToProgress();
    }
    if (ev === 'lane') {
      const prev = r.lanes[d.lane] || {};
      const next = { ...prev, ...d, _at: Date.now() };
      if (d.tail == null && prev.tail) next.tail = prev.tail;
      r.lanes[d.lane] = next;
      paintLanes();
    }
    if (ev === 'log') { const lg = $('.logs', r.el); if (!lg) return; const div = document.createElement('div'); div.className = d.level || ''; div.textContent = `${d.lane ? '[' + d.lane + '] ' : ''}${d.text}`; lg.appendChild(div); lg.scrollTop = lg.scrollHeight; }
    if (ev === 'message') { st.data.messages.push(d); renderMessages(); }
    if (ev === 'done') r.done = d;
  }
  function applySnapshot(r, progress) {
    if (!progress) return;
    const prevStage = r.stageId;
    if (progress.stage && progress.stage !== r.stageId) { r.stageId = progress.stage; r.stageAt = progress.stageStartedAt || Date.now(); }
    if (progress.laneCount) r.laneCount = progress.laneCount;
    if (progress.type) r.type = progress.type === 'edit' ? 'edit' : 'generate';
    const stage = $('.stage', r.el);
    if (stage && progress.stageText) stage.textContent = progress.stageText;
    for (const [k, v] of Object.entries(progress.lanes || {})) {
      const prev = r.lanes[k] || {};
      r.lanes[k] = { ...prev, ...v, _at: Date.now(), tail: prev.tail, userTail: prev.userTail };
    }
    paintLanes(); paintStepper();
    if (progress.stage && progress.stage !== prevStage) pinToProgress();
  }
  async function performRuntimeCheck(jobId, token) {
    if (!jobId || st.checkingThis === jobId) return false;
    if (!token) { st.checkingThis = null; return false; }
    st.checkingThis = jobId;
    try {
      const d = await api('/api/projects/' + id);
      if (!alive) return false;
      const targets = (d.versions || []).filter((v) => v.job_id === jobId);
      if (!targets.length) return false;
      const reports = await Promise.all(targets.map(async (v) => {
        const full = await api('/api/versions/' + v.id);
        const rep = await probeHtml(full.html, v.id);
        return { versionId: v.id, ...rep };
      }));
      if (!alive) return false;
      const real = reports.filter((rep) => !rep.timeout).map((rep) => ({
        versionId: rep.versionId,
        blank: !!rep.blank,
        textLen: Math.max(0, Math.min(1e7, rep.textLen | 0)),
        nodes: Math.max(0, Math.min(1e7, rep.nodes | 0)),
        errors: (Array.isArray(rep.errors) ? rep.errors : []).slice(0, 12).map((e) => ({
          message: String((e && e.message) || '').slice(0, 300),
          line: Math.max(0, Math.min(1e6, (e && e.line) | 0)),
        })),
      }));
      if (!real.length) { st.checkingThis = null; return false; }
      await api(`/api/projects/${id}/runtime-check`, { method: 'POST', body: { jobId, reports: real, runtimeToken: token } });
      if (!alive) return true;
      const fresh = await api('/api/projects/' + id);
      st.data.messages = fresh.messages;
      st.data.versions = fresh.versions;
      st.data.project = fresh.project;
      if (fresh.project.currentVersionId) {
        st.viewVersionId = fresh.project.currentVersionId;
        st.html = fresh.html || st.html;
      }
      renderMessages();
      renderStage();
      return true;
    } catch (e) {
      st.checkingThis = null;
      throw e;
    }
  }
  async function enterRuntime(r, jobId, token) {
    r.stageId = 'runtime'; r.stageAt = Date.now();
    const stage = $('.stage', r.el); if (stage) stage.textContent = '正在隐藏沙箱里做运行时检查…';
    paintStepper();
    pinToProgress();
    st.checkingRuntime = true;
    let checked = false;
    try { checked = await performRuntimeCheck(jobId, token || (r.done && r.done.runtimeToken)); } catch (e) { console.error(e); }
    st.checkingRuntime = false;
    if (st.running === r) { r.stageId = 'done'; r.stageAt = Date.now(); paintStepper(); pinToProgress(); }
    return checked;
  }

  async function startRun(body) {
    if (st.running) return;
    st.follow = true;
    const ctrl = new AbortController();
    const r = st.running = {
      el: progressEl(), lanes: {}, started: Date.now(), ctrl, jobId: null, done: null,
      type: body.type === 'edit' ? 'edit' : 'generate',
      stageId: body.type === 'edit' ? 'edit' : 'plan',
      stageAt: Date.now(),
      laneCount: body.type === 'edit' ? 1 : (body.lanes || 2),
    };
    st.data.messages.push({ id: 'tmp', role: 'user', content: body.prompt, meta: body, created_at: Date.now() });
    renderMessages(); renderComposer(); paintStepper();
    r.tick = setInterval(() => {
      const s = Math.floor((Date.now() - r.started) / 1000);
      const t = $('.timer', r.el); if (t) t.textContent = `${s}s / 120s`;
      paintStepper(); paintLaneTimes();
      if (s > 160) ctrl.abort(); // 前端兜底：服务端预算 120s，超过 160s 视为连接异常
    }, 500);
    let checked = false;
    let streamErr = null;
    try {
      await streamRun(`/api/projects/${id}/run`, { ...body, baseVersionId: st.data.project.currentVersionId }, onEvent, ctrl.signal);
    } catch (e) {
      streamErr = e;
    } finally {
      clearInterval(r.tick);
      const done = r.done;
      const jobId = r.jobId;
      if (alive && done && done.status === 'done' && jobId && st.running) checked = await enterRuntime(r, jobId, done.runtimeToken);
      const demoMode = done && done.status === 'done' && done.mode === 'demo';
      const interrupted = !done;
      if (!alive) { st.running = null; return; }
      if (interrupted && jobId) {
        try {
          const { job: j } = await api('/api/jobs/' + jobId);
          if (j && (j.status === 'running' || j.status === 'canceling')) {
            st.running = null;
            await resumeJob(j);
            return;
          }
          const detailErr = jobErrorText(j);
          st.running = null;
          renderComposer();
          let msg = detailErr || (streamErr && streamErr.name !== 'AbortError' ? streamErr.message : '连接已结束，本次生成未完成，可直接重新生成');
          if (j && j.status === 'canceled' && !detailErr) msg = '已取消本次任务，已有版本保持不变。';
          toast(msg, 5600);
          await refresh(null);
          return;
        } catch {}
      }
      st.running = null;
      renderComposer();
      if (interrupted) toast(streamErr && streamErr.name !== 'AbortError' ? streamErr.message : '连接已结束，本次生成未完成，可直接重新生成', 5600);
      else if (streamErr && streamErr.name !== 'AbortError') toast(streamErr.message);
      await refresh(checked ? null : (done && done.versionId ? done.versionId : null));
      if (demoMode) toast('模型不可用或已开启演示模式：已使用内置模板 / 规则引擎完成');
    }
  }
  async function cancelRun() {
    const r = st.running; if (!r) return;
    const stage = $('.stage', r.el); if (stage) stage.textContent = '正在取消…';
    if (r.jobId) await api(`/api/jobs/${r.jobId}/cancel`, { method: 'POST' }).catch(() => {});
    setTimeout(() => { if (st.running === r && r.ctrl) r.ctrl.abort(); }, 6000);
  }

  // 刷新页面后恢复后台任务（用任务上的进度快照画出阶段和字符数）
  async function resumeJob(job) {
    st.follow = true;
    const prog = (job.detail && job.detail.progress) || {};
    const r = st.running = {
      el: progressEl(), lanes: {}, started: job.createdAt, ctrl: null, jobId: job.id,
      type: job.type === 'edit' ? 'edit' : 'generate',
      stageId: prog.stage || (job.type === 'edit' ? 'edit' : 'plan'),
      stageAt: prog.stageStartedAt || job.createdAt,
      laneCount: prog.laneCount || (job.type === 'edit' ? 1 : 2),
    };
    renderMessages(); renderComposer();
    applySnapshot(r, prog);
    const stage = $('.stage', r.el);
    if (stage && !prog.stageText) stage.textContent = '任务仍在后台运行（已从刷新中恢复）…';
    paintStepper();
    r.tick = setInterval(async () => {
      if (!st.running || st.running !== r) return;
      const s = Math.floor((Date.now() - r.started) / 1000);
      const t = $('.timer', r.el); if (t) t.textContent = `${s}s / 120s`;
      paintStepper(); paintLaneTimes();
      if (s % 2) return;
      try {
        const { job: j } = await api('/api/jobs/' + job.id);
        if (!alive || st.running !== r) return;
        if (j.detail && j.detail.progress) applySnapshot(r, j.detail.progress);
        if (j.status !== 'running' && j.status !== 'canceling') {
          clearInterval(r.tick);
          if (j.status === 'done') await enterRuntime(r, job.id, j.detail && j.detail.runtimeToken);
          st.running = null;
          if (alive) renderComposer();
          if (j.status === 'failed' || j.status === 'canceled') {
            toast(jobErrorText(j) || (j.status === 'canceled' ? '已取消本次任务，已有版本保持不变。' : '任务未完成，可直接重新生成'), 5600);
          }
          if (alive) await refresh();
        }
      } catch { clearInterval(r.tick); st.running = null; if (alive) await refresh(); }
    }, 1000);
  }

  async function refresh(focusVersion) {
    try {
      const d = await api('/api/projects/' + id);
      st.data = d;
      st.viewVersionId = focusVersion && d.versions.some((v) => v.id === focusVersion) ? focusVersion : d.project.currentVersionId;
      st.html = st.viewVersionId === d.project.currentVersionId ? d.html : (await api('/api/versions/' + st.viewVersionId)).html;
    } catch (e) { toast('刷新失败：' + e.message); }
    renderMessages(); renderComposer(); renderStage();
  }

  async function showVersion(vid) {
    try { const v = await api('/api/versions/' + vid); st.viewVersionId = vid; st.html = v.html; st.tab = 'preview'; renderStage(); } catch (e) { toast(e.message); }
  }
  async function adopt(vid) {
    try { await api(`/api/projects/${id}/adopt`, { method: 'POST', body: { versionId: vid } }); toast('已切换，生成了新版本'); await refresh(); } catch (e) { toast(e.message); }
  }

  // ----- 右侧舞台 -----
  function currentVersion() { return st.data.versions.find((v) => v.id === st.viewVersionId); }
  function renderStage() {
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === st.tab));
    const v = currentVersion();
    $('#vinfo').innerHTML = v ? `v${v.n}${v.candidate ? '（候选）' : ''} ${modeTag(v.mode)} ${scoreTags(v)} ${v.id !== st.data.project.currentVersionId ? `<span class="tag backup">非当前版本</span>${owner ? ` <button class="btn sm" id="useThis">设为当前</button>` : ''}` : ''}` : '';
    if ($('#useThis')) $('#useThis').onclick = () => adopt(v.id);
    const stage = $('#stage');
    stage.innerHTML = '';
    if (st.tab === 'preview') {
      if (!st.html) { stage.innerHTML = `<div class="viewport"><div class="placeholder">${st.running ? '<span class="spinner" style="display:inline-block"></span><p>智能体正在生成应用，完成后会在这里实时预览</p>' : '<p>还没有生成任何版本</p>'}</div></div>`; return; }
      const vp = document.createElement('div'); vp.className = 'viewport';
      const wrap = document.createElement('div'); wrap.className = 'frame-wrap ' + (st.device === 'mobile' ? 'mobile' : '');
      wrap.appendChild(makeFrame(st.html, id)); vp.appendChild(wrap); stage.appendChild(vp);
      st.runtimeError = null;
    } else if (st.tab === 'code') {
      const bar = document.createElement('div'); bar.className = 'toolbar';
      bar.innerHTML = `<span class="muted small">${st.html.length} 字符 · ${st.html.split('\n').length} 行</span><span class="spacer"></span><button class="btn sm" id="copy">复制代码</button>`;
      const pre = document.createElement('pre'); pre.className = 'code'; pre.textContent = st.html || '（暂无代码）';
      stage.append(bar, pre);
      $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(st.html); toast('已复制'); } catch { toast('复制失败，请手动选择'); } };
    } else {
      const box = document.createElement('div'); box.className = 'versions';
      const list = [...st.data.versions].reverse();
      box.innerHTML = list.length ? list.map((x) => `<div class="vrow ${x.id === st.data.project.currentVersionId ? 'cur' : ''} ${x.candidate ? 'cand' : ''}">
        <span class="n">v${x.n}</span><span class="note">${esc(x.note || '')}<br><span class="muted small">${fmtTime(x.created_at)} · ${x.size} 字符${x.model ? ' · ' + esc(x.model) : ''}</span></span>
        ${modeTag(x.mode)}${scoreTags(x)}${x.candidate ? '<span class="tag">候选</span>' : ''}${x.id === st.data.project.currentVersionId ? '<span class="tag preset">当前</span>' : ''}
        <button class="btn sm" data-view="${x.id}">预览</button>${owner && x.id !== st.data.project.currentVersionId ? `<button class="btn sm" data-adopt="${x.id}">${x.candidate ? '采用' : '回滚到此版'}</button>` : ''}</div>`).join('') : '<div class="empty">暂无版本</div>';
      stage.appendChild(box);
      $$('[data-view]', box).forEach((b) => (b.onclick = () => showVersion(b.dataset.view)));
      $$('[data-adopt]', box).forEach((b) => (b.onclick = () => adopt(b.dataset.adopt)));
    }
  }

  WS.onRuntimeError = (frame, d) => {
    if (st.checkingRuntime || frame.dataset.probe === '1') return;
    if (frame.dataset.pid !== id || st.tab !== 'preview' || st.runtimeError) return;
    st.runtimeError = d;
    const vp = $('.viewport'); if (!vp) return;
    const bar = document.createElement('div'); bar.className = 'errbar';
    bar.innerHTML = `⚠️ <span title="${esc(d.message)}">预览运行时错误：${esc(d.message)}${d.line ? `（第 ${d.line} 行）` : ''}</span>${owner && st.viewVersionId === st.data.project.currentVersionId ? '<button class="btn sm primary" id="fixIt">让 AI 修复</button>' : ''}<button class="btn sm ghost" id="hideErr">×</button>`;
    vp.appendChild(bar);
    $('#hideErr').onclick = () => bar.remove();
    if ($('#fixIt')) $('#fixIt').onclick = () => { bar.remove(); startRun({ type: 'edit', prompt: `修复预览中的运行时错误：${d.message}${d.line ? `（大约在第 ${d.line} 行）` : ''}` }); };
  };

  // ----- 工具栏事件 -----
  $$('#tabs button').forEach((b) => (b.onclick = () => { st.tab = b.dataset.t; renderStage(); }));
  $$('#dev button').forEach((b) => (b.onclick = () => { st.device = b.dataset.d; $$('#dev button').forEach((x) => x.classList.toggle('on', x === b)); const w = $('.frame-wrap'); if (w) w.classList.toggle('mobile', st.device === 'mobile'); }));
  $('#reload').onclick = () => { if (st.tab !== 'preview') st.tab = 'preview'; renderStage(); };
  $('#dl').onclick = () => {
    if (!st.html) return toast('还没有可下载的版本');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([st.html], { type: 'text/html' }));
    a.download = (st.data.project.title || 'app').replace(/[\\/:*?"<>|]/g, '_') + '.html'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#share').onclick = async () => {
    if (!st.data.project.currentVersionId) return toast('还没有可分享的版本');
    if (owner && !st.data.project.isPublic) {
      if (!confirm('分享前需要先公开作品，是否公开并复制链接？')) return;
      try {
        await api('/api/projects/' + id, { method: 'PATCH', body: { isPublic: true } });
        st.data.project.isPublic = true;
        const pub = $('#pub');
        if (pub) pub.checked = true;
      } catch (e) { toast(e.message); return; }
    }
    const url = `${location.origin}/s/${id}`;
    try { await navigator.clipboard.writeText(url); toast('分享链接已复制：' + url, 4000); } catch { prompt('复制分享链接', url); }
  };
  if (owner) {
    $('#title').addEventListener('change', async (e) => { try { await api('/api/projects/' + id, { method: 'PATCH', body: { title: e.target.value.trim() || '未命名应用' } }); toast('已重命名'); } catch (er) { toast(er.message); } });
    $('#pub').onchange = async (e) => { try { await api('/api/projects/' + id, { method: 'PATCH', body: { isPublic: e.target.checked } }); toast(e.target.checked ? '已公开到作品广场' : '已取消公开'); } catch (er) { toast(er.message); e.target.checked = !e.target.checked; } };
  }

  renderMessages(); renderComposer(); renderStage();
  cleanup = () => { alive = false; WS.onRuntimeError = null; if (st.running) { clearInterval(st.running.tick); } document.querySelectorAll('iframe[data-probe="1"]').forEach((f) => f.remove()); };

  // 自动开始（从首页进入）、恢复后台任务，或补跑尚未回传的运行时检查
  const auto = JSON.parse(sessionStorage.getItem('atoms_autostart') || 'null');
  if (auto && auto.id === id && owner) {
    sessionStorage.removeItem('atoms_autostart');
    if (!data.project.currentVersionId && !data.activeJob) startRun({ type: 'generate', prompt: auto.prompt, lanes: auto.lanes, model: auto.model, demo: auto.demo, simulate: auto.simulate });
  } else if (data.activeJob && owner) resumeJob(data.activeJob);
  else if (data.pendingRuntime && owner) {
    const pr = data.pendingRuntime;
    const r = st.running = {
      el: progressEl(), lanes: {}, started: Date.now(), ctrl: null, jobId: pr.id,
      type: pr.type === 'edit' ? 'edit' : 'generate', stageId: 'runtime', stageAt: Date.now(), laneCount: 1,
    };
    renderMessages(); renderComposer();
    const stage = $('.stage', r.el); if (stage) stage.textContent = '正在补做运行时检查…';
    paintStepper();
    enterRuntime(r, pr.id, pr.token).catch((e) => console.error(e)).finally(async () => {
      st.running = null;
      if (alive) await refresh();
    });
  }
}

// ---------------- 启动 ----------------
initAuthDialog();
renderUser();
window.addEventListener('hashchange', route);
route();
