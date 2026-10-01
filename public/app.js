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
  box.innerHTML = `<span class="avatar">${esc(u.username.slice(0, 1))}</span><span>${esc(u.username)}</span>${u.isGuest ? '<button class="btn sm primary" id="upBtn">升级为正式账号</button>' : ''}<button class="btn sm ghost" id="logoutBtn">退出</button>`;
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
function composerOptions(prefix = '') {
  return `<label class="opt" title="赛马模式：多路工程师智能体并行生成，自动打分择优">🏁 赛马
      <select id="${prefix}lanes"><option value="1">1 路</option><option value="2" selected>2 路</option><option value="3">3 路</option></select></label>
    <label class="opt" title="不调用模型，使用内置模板与规则引擎（额度为零时也能完整演示）"><input type="checkbox" id="${prefix}demo"> 演示模式</label>
    <label class="opt" title="故障演练：验证重试 / 备用模型 / 降级兜底链路">🧯 故障演练
      <select id="${prefix}simulate"><option value="none">关闭</option><option value="primary429">主模型 429</option><option value="alldown">全部模型不可用</option></select></label>`;
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
      sessionStorage.setItem('atoms_autostart', JSON.stringify({ id, prompt, lanes: +$('#lanes').value, demo: $('#demo').checked, simulate: $('#simulate').value }));
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
  const st = { data, viewVersionId: data.project.currentVersionId, tab: 'preview', device: 'desktop', running: null, html: data.html, runtimeError: null };
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

  // ----- 消息渲染 -----
  function renderMessages() {
    msgsEl.innerHTML = '';
    st.data.messages.forEach((m) => msgsEl.appendChild(messageEl(m)));
    if (st.running) msgsEl.appendChild(st.running.el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function messageEl(m) {
    const el = document.createElement('div');
    if (m.role === 'user') {
      el.className = 'msg user';
      const opts = m.meta && m.meta.type === 'generate' ? `<div class="small" style="opacity:.8;margin-top:4px">${m.meta.demo ? '演示模式' : `赛马 ${m.meta.lanes || 1} 路`}${m.meta.simulate && m.meta.simulate !== 'none' ? ' · 故障演练' : ''}</div>` : '';
      el.innerHTML = `<div class="who">🙂</div><div class="bubble">${md(m.content)}${opts}</div>`;
      return el;
    }
    const [icon, name] = AGENTS[m.agent] || AGENTS.system;
    el.className = 'msg';
    let extra = '';
    const meta = m.meta || {};
    if (meta.plan && meta.plan.features) extra += `<ul>${meta.plan.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${meta.mode === 'heuristic' ? '<div class="small muted">（规则拆解）</div>' : ''}`;
    if (meta.board && meta.board.length > 1) {
      extra += `<table class="board"><tr><th>方案</th><th>评分</th><th>模型</th><th>耗时</th><th></th></tr>${meta.board.map((b) => {
        const cand = (meta.candidates || []).find((c) => c.lane === b.lane);
        const tip = b.items && b.items.length ? b.items.map((i) => `${i.name} ${i.got}/${i.max}`).join('\n') : (b.error || '');
        return `<tr class="${b.lane === meta.winner ? 'win' : ''}" title="${esc(tip)}"><td>${esc(b.lane)} · ${esc(b.name)}</td><td>${b.ok ? b.score : '失败'}</td><td>${esc(b.model)}</td><td>${b.ms ? (b.ms / 1000).toFixed(0) + 's' : '-'}</td>
          <td>${b.lane === meta.winner ? '🏆 已采用' : cand && owner ? `<button class="btn sm" data-adopt="${cand.id}">采用</button>` : cand ? `<button class="btn sm" data-view="${cand.id}">查看</button>` : ''}</td></tr>`;
      }).join('')}</table><div class="small muted" style="margin-top:4px">鼠标悬停查看评分细项</div>`;
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
    const opts = () => ({ lanes: +$('#wlanes').value, demo: $('#wdemo').checked, simulate: $('#wsimulate').value });
    $('#send').onclick = () => {
      const text = ask.value.trim();
      if (!text) { if (!hasVersion) startRun({ type: 'generate', prompt: st.data.project.prompt, ...opts() }); else ask.focus(); return; }
      startRun({ type: hasVersion ? 'edit' : 'generate', prompt: text, ...opts() });
    };
    if ($('#regen')) $('#regen').onclick = () => startRun({ type: 'generate', prompt: st.data.project.prompt, ...opts() });
  }

  // ----- 运行任务（流式进度） -----
  function progressEl() {
    const el = document.createElement('div');
    el.className = 'progress';
    el.innerHTML = `<div class="row"><span class="spinner"></span><span class="stage" id="pStage">准备中…</span><span class="timer" id="pTimer">0s / 120s</span></div><div class="lanes" id="pLanes"></div><div class="logs" id="pLogs"></div>`;
    return el;
  }
  function laneHtml(l) {
    const stText = { running: '启动中', thinking: '思考中…', coding: '编码中…', done: `✅ ${l.score ?? ''} 分`, failed: '❌ 失败' }[l.status] || l.status;
    return `<div class="lh"><b>${l.lane === 'E' ? '增量补丁' : '方案 ' + esc(l.lane)}</b><span class="muted">${esc(l.name || '')}</span><span class="muted">${l.chars ? l.chars + ' 字符' : ''}${l.model ? ' · ' + esc(l.model) : ''}${l.channel === 'backup' ? '（备用）' : ''}</span><span class="st">${stText}</span></div>
      ${l.status === 'failed' && l.error ? `<div class="small" style="color:var(--bad)">${esc(l.error)}</div>` : ''}${l.tail ? `<pre>${esc(l.tail)}</pre>` : ''}`;
  }
  function onEvent(ev, d) {
    const r = st.running; if (!r) return;
    if (ev === 'job') r.jobId = d.id;
    if (ev === 'stage') { $('#pStage', r.el).textContent = d.text; if (d.lanes) d.lanes.forEach((l) => (r.lanes[l.id] = { lane: l.id, name: l.name, status: 'running' })); paintLanes(); }
    if (ev === 'lane') { r.lanes[d.lane] = { ...(r.lanes[d.lane] || {}), ...d }; paintLanes(); }
    if (ev === 'log') { const lg = $('#pLogs', r.el); const div = document.createElement('div'); div.className = d.level; div.textContent = `${d.lane ? '[' + d.lane + '] ' : ''}${d.text}`; lg.appendChild(div); lg.scrollTop = lg.scrollHeight; }
    if (ev === 'message') { st.data.messages.push(d); renderMessages(); }
    if (ev === 'done') r.done = d;
  }
  function paintLanes() {
    const r = st.running; const box = $('#pLanes', r.el);
    Object.values(r.lanes).forEach((l) => {
      let el = box.querySelector(`[data-lane="${l.lane}"]`);
      if (!el) { el = document.createElement('div'); el.className = 'lane'; el.dataset.lane = l.lane; box.appendChild(el); }
      el.className = 'lane ' + (l.status === 'done' ? 'done' : l.status === 'failed' ? 'failed' : '');
      el.innerHTML = laneHtml(l);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function startRun(body) {
    if (st.running) return;
    const ctrl = new AbortController();
    const r = st.running = { el: progressEl(), lanes: {}, started: Date.now(), ctrl, jobId: null, done: null };
    st.data.messages.push({ id: 'tmp', role: 'user', content: body.prompt, meta: body, created_at: Date.now() });
    renderMessages(); renderComposer();
    r.tick = setInterval(() => {
      const s = Math.floor((Date.now() - r.started) / 1000);
      const t = $('#pTimer', r.el); if (t) t.textContent = `${s}s / 120s`;
      if (s > 160) ctrl.abort(); // 前端兜底：服务端预算 120s，超过 160s 视为连接异常
    }, 500);
    try {
      await streamRun(`/api/projects/${id}/run`, { ...body, baseVersionId: st.data.project.currentVersionId }, onEvent, ctrl.signal);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message);
    } finally {
      clearInterval(r.tick);
      const done = r.done;
      st.running = null;
      await refresh(done && done.versionId ? done.versionId : null);
      if (done && done.status === 'done' && done.mode === 'demo') toast('模型不可用或已开启演示模式：已使用内置模板 / 规则引擎完成');
    }
  }
  async function cancelRun() {
    const r = st.running; if (!r) return;
    $('#pStage', r.el).textContent = '正在取消…';
    if (r.jobId) await api(`/api/jobs/${r.jobId}/cancel`, { method: 'POST' }).catch(() => {});
    setTimeout(() => { if (st.running === r) r.ctrl.abort(); }, 6000);
  }

  // 刷新页面后恢复后台任务
  async function resumeJob(job) {
    const r = st.running = { el: progressEl(), lanes: {}, started: job.createdAt, ctrl: new AbortController(), jobId: job.id };
    renderMessages(); renderComposer();
    $('#pStage', r.el).textContent = '任务仍在后台运行（已从刷新中恢复）…';
    r.tick = setInterval(async () => {
      const s = Math.floor((Date.now() - r.started) / 1000);
      const t = $('#pTimer', r.el); if (t) t.textContent = `${s}s / 120s`;
      if (s % 2) return;
      try {
        const { job: j } = await api('/api/jobs/' + job.id);
        if (j.status !== 'running' && j.status !== 'canceling') { clearInterval(r.tick); st.running = null; await refresh(); }
      } catch { clearInterval(r.tick); st.running = null; await refresh(); }
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
    $('#vinfo').innerHTML = v ? `v${v.n}${v.candidate ? '（候选）' : ''} ${modeTag(v.mode)} ${v.score != null ? `<span class="tag">评分 ${v.score}</span>` : ''} ${v.id !== st.data.project.currentVersionId ? `<span class="tag backup">非当前版本</span>${owner ? ` <button class="btn sm" id="useThis">设为当前</button>` : ''}` : ''}` : '';
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
        ${modeTag(x.mode)}${x.score != null ? `<span class="tag">评分 ${x.score}</span>` : ''}${x.candidate ? '<span class="tag">候选</span>' : ''}${x.id === st.data.project.currentVersionId ? '<span class="tag preset">当前</span>' : ''}
        <button class="btn sm" data-view="${x.id}">预览</button>${owner && x.id !== st.data.project.currentVersionId ? `<button class="btn sm" data-adopt="${x.id}">${x.candidate ? '采用' : '回滚到此版'}</button>` : ''}</div>`).join('') : '<div class="empty">暂无版本</div>';
      stage.appendChild(box);
      $$('[data-view]', box).forEach((b) => (b.onclick = () => showVersion(b.dataset.view)));
      $$('[data-adopt]', box).forEach((b) => (b.onclick = () => adopt(b.dataset.adopt)));
    }
  }

  WS.onRuntimeError = (frame, d) => {
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
    const url = `${location.origin}/s/${id}`;
    try { await navigator.clipboard.writeText(url); toast('分享链接已复制：' + url, 4000); } catch { prompt('复制分享链接', url); }
  };
  if (owner) {
    $('#title').addEventListener('change', async (e) => { try { await api('/api/projects/' + id, { method: 'PATCH', body: { title: e.target.value.trim() || '未命名应用' } }); toast('已重命名'); } catch (er) { toast(er.message); } });
    $('#pub').onchange = async (e) => { try { await api('/api/projects/' + id, { method: 'PATCH', body: { isPublic: e.target.checked } }); toast(e.target.checked ? '已公开到作品广场' : '已取消公开'); } catch (er) { toast(er.message); e.target.checked = !e.target.checked; } };
  }

  renderMessages(); renderComposer(); renderStage();
  cleanup = () => { WS.onRuntimeError = null; if (st.running) { clearInterval(st.running.tick); } };

  // 自动开始（从首页进入）或恢复后台任务
  const auto = JSON.parse(sessionStorage.getItem('atoms_autostart') || 'null');
  if (auto && auto.id === id && owner) {
    sessionStorage.removeItem('atoms_autostart');
    if (!data.project.currentVersionId && !data.activeJob) startRun({ type: 'generate', prompt: auto.prompt, lanes: auto.lanes, demo: auto.demo, simulate: auto.simulate });
  } else if (data.activeJob && owner) resumeJob(data.activeJob);
}

// ---------------- 启动 ----------------
initAuthDialog();
renderUser();
window.addEventListener('hashchange', route);
route();
