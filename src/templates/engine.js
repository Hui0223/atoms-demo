// 降级模板引擎：模型不可用时（无额度 / 429 / 超时 / 报错）仍能产出“真能跑”的完整应用。
// 纯函数、无运行时依赖，可在 Node 中单测。

export const TEMPLATE_RULES = [
  { id: 'kanban', name: '任务看板', re: /看板|待办|任务|todo|kanban|项目管理|拖拽/i },
  { id: 'mortgage', name: '房贷计算器', re: /房贷|贷款|月供|计算器|利率|还款|mortgage|loan|calculator/i },
  { id: 'profile', name: '个人主页', re: /主页|简历|个人|portfolio|作品集|名片|自我介绍|resume/i },
  { id: 'pomodoro', name: '番茄钟', re: /番茄|专注|计时|倒计时|pomodoro|timer|习惯|打卡/i },
];

export function pickTemplate(prompt) {
  const p = String(prompt || '');
  const hit = TEMPLATE_RULES.find((r) => r.re.test(p));
  return hit ? hit.id : 'generic';
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function slugify(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

function guessTitle(prompt, fallback) {
  const p = String(prompt || '').replace(/^(帮我|请|给我|我要|我想要|我需要|做|生成|创建|写)+/g, '').trim();
  const m = p.match(/^(?:一个|一款|一份)?([^，,。.!！?？\n]{2,18})/);
  return m ? m[1].replace(/^(一个|一款|一份)/, '').trim() : fallback;
}

function profileParams(prompt) {
  const p = String(prompt || '');
  const name = (p.match(/(?:叫|名字是|姓名[:：]?|我是)\s*([\u4e00-\u9fa5A-Za-z]{2,10})/) || [])[1] || '林晓';
  const role = (p.match(/(?:职业|岗位|是一名|是一位|职位)[:：]?\s*([^，,。\n]{2,20})/) || [])[1] || '全栈工程师 · 热爱用 AI 构建产品';
  const skillsRaw = (p.match(/技能[:：是有包括]*\s*([^。\n]+)/) || [])[1];
  const skills = skillsRaw ? skillsRaw.split(/[、,，/和及\s]+/).map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 10) : ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'AI Agent'];
  const email = (p.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || 'hello@example.com';
  return { name, role, skills, email };
}

export function renderTemplate(sources, id, prompt) {
  const src = sources[id] || sources.generic;
  const rule = TEMPLATE_RULES.find((r) => r.id === id);
  const title = guessTitle(prompt, rule ? rule.name : '我的应用');
  const vars = {
    TITLE: esc(title),
    SUBTITLE: esc(String(prompt || '').slice(0, 80) || '由 Atoms Demo 生成'),
    SLUG: slugify(prompt + id),
  };
  if (id === 'profile') {
    const pp = profileParams(prompt);
    Object.assign(vars, {
      TITLE: esc(`${pp.name} 的个人主页`), NAME: esc(pp.name), INITIAL: esc(pp.name.slice(0, 1)), ROLE: esc(pp.role),
      ABOUT: esc(`你好，我是${pp.name}。${String(prompt || '').slice(0, 120)}`), EMAIL: esc(pp.email), CITY: '上海', LINK: 'github.com/yourname',
      SKILLS_JSON: JSON.stringify(pp.skills).replace(/</g, '\\u003c'),
    });
  }
  if (id === 'generic') {
    const seed = [
      { id: 1, title: `欢迎使用「${title}」`, tag: '指南', note: '在上方输入框添加记录，支持分类、搜索、完成与导出', done: false, at: Date.now() },
      { id: 2, title: '数据会自动保存在浏览器中', tag: '指南', note: '刷新页面后依然存在', done: true, at: Date.now() },
    ];
    vars.SEED_JSON = JSON.stringify(seed).replace(/</g, '\\u003c');
  }
  return src.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

// ---------- 演示模式下的“规则化增量修改” ----------
const COLORS = [
  [/蓝|blue/i, '#2563eb', '蓝色'], [/红|red/i, '#dc2626', '红色'], [/绿|green/i, '#16a34a', '绿色'],
  [/紫|purple|violet/i, '#7c3aed', '紫色'], [/橙|orange/i, '#ea580c', '橙色'], [/粉|pink/i, '#db2777', '粉色'],
  [/青|cyan|teal/i, '#0891b2', '青色'], [/黄|金|yellow|gold/i, '#ca8a04', '黄色'], [/黑|black/i, '#111827', '黑色'],
];
const DARK_CSS = ':root{--bg:#0f172a;--card:#1e293b;--text:#e2e8f0;--muted:#94a3b8;--border:#334155}';

// 返回 { html, changes: [] }；changes 为空表示规则无法理解该请求
export function demoEdit(html, request) {
  const req = String(request || '');
  let out = html;
  const changes = [];
  const color = COLORS.find(([re]) => re.test(req));
  if (color && /色|color|主题|改成|换成/i.test(req)) {
    if (/--primary\s*:/.test(out)) out = out.replace(/--primary\s*:\s*[^;}]+/g, `--primary:${color[1]}`);
    else out = injectStyle(out, `:root{--primary:${color[1]}}`);
    changes.push(`主色调改为${color[2]}`);
  }
  if (/深色|暗色|暗黑|夜间|dark/i.test(req)) {
    out = injectStyle(out, DARK_CSS, 'atoms-dark');
    changes.push('切换为深色主题');
  } else if (/浅色|亮色|白天|light/i.test(req) && out.includes('atoms-dark')) {
    out = out.replace(/<style data-atoms="atoms-dark">[\s\S]*?<\/style>/, '');
    changes.push('切换为浅色主题');
  }
  const t = req.match(/标题(?:改为|改成|换成|修改为)[“"「]?([^”"」。\n]{1,30})/);
  if (t) {
    const nt = esc(t[1].trim());
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${nt}</title>`);
    out = out.replace(/(<h1[^>]*data-title[^>]*>)([^<]*)/i, `$1${nt}`);
    changes.push(`标题改为「${t[1].trim()}」`);
  }
  if (/字体?(放大|大一点|调大|变大)|大字/.test(req)) { out = injectStyle(out, 'html{font-size:18px}body{font-size:17px}', 'atoms-font'); changes.push('放大字号'); }
  if (/圆角/.test(req)) { out = injectStyle(out, '*{border-radius:16px}', 'atoms-radius'); changes.push('增大圆角'); }
  return { html: out, changes };
}

function injectStyle(html, css, tag = 'atoms-edit') {
  const block = `<style data-atoms="${tag}">${css}</style>`;
  const re = new RegExp(`<style data-atoms="${tag}">[\\s\\S]*?</style>`);
  if (re.test(html)) return html.replace(re, block);
  const pos = html.toLowerCase().indexOf('</head>');
  return pos === -1 ? block + html : html.slice(0, pos) + block + '\n' + html.slice(pos);
}
