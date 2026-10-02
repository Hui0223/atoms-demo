// 静态 QA + 评分（赛马择优用）。Workers 运行时禁止 eval，因此 JS 运行时检查在浏览器隐藏沙箱里做，
// 结果回传后由 applyRuntime 并入分数（见 public/app.js 的探针与 POST /runtime-check）。

function scriptBlocks(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc=/.test(m[1])) out.push(m[2]);
  return out;
}

// 粗粒度括号配平（跳过字符串、模板字符串、注释），用于发现被截断的脚本
export function bracketsBalanced(code) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = code.indexOf('*/', i + 2); if (i === -1) return false; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') i++;
        else if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
          // 模板插值：简单跳到配对的 }
          let depth = 1; i += 2;
          while (i < code.length && depth) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; if (depth) i++; }
        }
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c in pairs) { if (stack.pop() !== pairs[c]) return false; }
  }
  return stack.length === 0;
}

// 硬性检查：不通过则不允许落库
export function qaCheck(html) {
  const issues = [];
  const lower = (html || '').toLowerCase();
  if (!html || html.length < 400) issues.push('输出过短，不是完整应用');
  if (!/<html[\s>]/.test(lower)) issues.push('缺少 <html> 标签');
  if (!lower.includes('</html>')) issues.push('缺少 </html>，输出可能被截断');
  if (!/<body[\s>]/.test(lower)) issues.push('缺少 <body>');
  const open = (lower.match(/<script\b/g) || []).length;
  const close = (lower.match(/<\/script>/g) || []).length;
  if (open !== close) issues.push('<script> 标签未闭合');
  if (html && html.length > 200000) issues.push('文件过大（>200KB）');
  return { ok: issues.length === 0, issues };
}

// 需求覆盖：对每条功能描述取中文二元组 / 英文词，命中率 ≥ 50% 视为覆盖
function featureCovered(feature, text) {
  const f = String(feature).toLowerCase();
  const grams = new Set();
  for (const seg of f.split(/[^\u4e00-\u9fa5a-z0-9]+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(seg)) { if (seg.length >= 3) grams.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) grams.add(seg.slice(i, i + 2));
  }
  if (!grams.size) return true;
  let hit = 0;
  for (const g of grams) if (text.includes(g)) hit++;
  return hit / grams.size >= 0.5;
}

// 打分：0-100，并给出可解释的分项（赛马择优依据）
export function scoreHtml(html, features = []) {
  const qa = qaCheck(html);
  const lower = (html || '').toLowerCase();
  const js = scriptBlocks(html || '').join('\n');
  const items = [];
  const add = (name, got, max) => items.push({ name, got: Math.round(Math.max(0, Math.min(max, got))), max });
  add('结构完整', qa.ok ? 25 : 0, 25);
  const handlers = (lower.match(/addeventlistener\(|\son(click|input|change|submit|keydown|keyup|dragstart|drop)\s*=/g) || []).length;
  add('真实交互', handlers ? 10 : 0, 10);
  add('交互丰富度', handlers >= 10 ? 10 : handlers, 10);
  add('数据持久化', /localstorage|indexeddb/.test(lower) ? 15 : 0, 15);
  add('移动端适配', (/name=["']viewport["']/.test(lower) ? 3 : 0) + (/@media/.test(lower) ? 2 : 0), 5);
  add('脚本完整', js.trim() ? (bracketsBalanced(js) ? 10 : 0) : 3, 10);
  const feats = (features || []).filter(Boolean).slice(0, 8);
  if (feats.length) add('需求覆盖', (feats.filter((f) => featureCovered(f, lower)).length / feats.length) * 15, 15);
  else add('需求覆盖', 10, 15);
  const visual = [/transition|animation|@keyframes/, /box-shadow/, /border-radius/, /var\(--primary\)/, /:hover/].filter((re) => re.test(lower)).length;
  add('视觉细节', visual, 5);
  // 体量：过于单薄的实现通常功能不完整
  add('实现完整度', Math.min(5, Math.floor((html || '').length / 1600)), 5);
  const total = items.reduce((s, i) => s + i.got, 0);
  return { total, items, qa };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function isIntIn(n, lo, hi) {
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
}

/**
 * 校验客户端运行时报告。不改写、不截断：任一字段越界即失败，由接口返回 400。
 * versionIds 给出时，每条 versionId 必须属于该任务。
 */
export function validateRuntimeReports(reports, { versionIds } = {}) {
  if (!Array.isArray(reports)) return { ok: false, error: '报告格式不正确' };
  if (reports.length > 8) return { ok: false, error: '报告数量过多' };
  const allowed = versionIds ? new Set([...versionIds].map((id) => String(id))) : null;
  const out = [];
  for (const r of reports) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: '报告格式不正确' };
    const versionId = typeof r.versionId === 'string' ? r.versionId : (typeof r.versionId === 'number' ? String(r.versionId) : '');
    if (!versionId || versionId.length > 64) return { ok: false, error: '版本编号不合法' };
    if (allowed && !allowed.has(versionId)) return { ok: false, error: '版本不属于该任务' };
    if (typeof r.blank !== 'boolean') return { ok: false, error: 'blank 必须是布尔值' };
    if (!Array.isArray(r.errors)) return { ok: false, error: 'errors 必须是数组' };
    if (r.errors.length > 12) return { ok: false, error: '错误条数过多' };
    const errors = [];
    for (const e of r.errors) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: '错误项格式不正确' };
      if (typeof e.message !== 'string') return { ok: false, error: '错误信息必须是字符串' };
      if (e.message.length > 300) return { ok: false, error: '错误信息过长' };
      if (!isIntIn(e.line, 0, 1e6)) return { ok: false, error: '行号不合法' };
      const message = e.message.trim();
      if (message) errors.push({ message, line: e.line });
    }
    if (!isIntIn(r.textLen, 0, 1e7)) return { ok: false, error: 'textLen 不合法' };
    if (!isIntIn(r.nodes, 0, 1e7)) return { ok: false, error: 'nodes 不合法' };
    out.push({ versionId, errors, blank: r.blank, textLen: r.textLen, nodes: r.nodes });
  }
  return { ok: true, reports: out };
}

// 按 message 去重，保留首次出现的行号
function distinctErrors(errors) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(errors)) return out;
  for (const e of errors) {
    const message = String(e && typeof e === 'object' ? (e.message || '') : (e || '')).trim().slice(0, 300);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    out.push({ message, line: e && typeof e === 'object' && e.line ? (e.line | 0) : 0 });
  }
  return out;
}

/**
 * 把客户端运行时报告并入评分。输入 score.total 视为静态总分（0–100）；
 * 若已套用过，则用 staticTotal，重复调用不会叠扣。
 * - 新分项「运行时检查」满分 15：无错误且非白屏 15；白屏 0；否则每个不同错误扣 8，最低 0。
 * - 对外总分仍归一化到 0–100：在静态总分上，有错误扣 30（封顶 30），白屏扣 40。不把 15 分再加进总分。
 */
export function applyRuntime(score, report) {
  const base = score && typeof score === 'object' ? score : { total: 0, items: [] };
  const already = base.runtime && base.staticTotal != null;
  const staticTotal = clamp(Math.round(Number(already ? base.staticTotal : base.total) || 0), 0, 100);
  const errors = distinctErrors(report && report.errors);
  const blank = !!(report && report.blank);
  const got = blank ? 0 : Math.max(0, 15 - errors.length * 8);
  const items = (Array.isArray(base.items) ? base.items : []).filter((i) => i && i.name !== '运行时检查');
  items.push({ name: '运行时检查', got, max: 15 });
  const penalty = blank ? 40 : Math.min(30, errors.length > 0 ? 30 : 0);
  const total = clamp(staticTotal - penalty, 0, 100);
  return {
    total,
    staticTotal,
    items,
    qa: base.qa || { ok: true, issues: [] },
    runtime: {
      blank,
      errors,
      errorCount: errors.length,
      penalty,
      clean: !blank && errors.length === 0,
      textLen: report && report.textLen ? (report.textLen | 0) : 0,
      nodes: report && report.nodes ? (report.nodes | 0) : 0,
    },
  };
}
