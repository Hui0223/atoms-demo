// 静态 QA + 评分（赛马择优用）。Workers 运行时禁止 eval，因此不做 JS 语法执行检查，
// 运行时错误由前端预览 iframe 捕获后回传（见 public/app.js）。

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
