// 增量修改：解析并应用 SEARCH/REPLACE 补丁块
// 格式：
// <<<<<<< SEARCH
// 原文（必须与当前文件某段连续内容一致）
// =======
// 替换后的内容
// >>>>>>> REPLACE
const BLOCK_RE = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9}\s*REPLACE/g;

// 容错：若模型把行号前缀（如 "  12| "）也复制进来，则去掉
function stripLineNo(s) {
  const lines = s.split('\n');
  if (lines.length && lines.every((l) => /^\s*\d+\| ?/.test(l) || l === '')) return lines.map((l) => l.replace(/^\s*\d+\| ?/, '')).join('\n');
  return s;
}

export function parsePatches(text) {
  const blocks = [];
  if (!text) return blocks;
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(String(text)))) blocks.push({ search: stripLineNo(m[1]), replace: stripLineNo(m[2]) });
  return blocks;
}

function findByTrimmedLines(src, search) {
  const srcLines = src.split('\n');
  const sLines = search.split('\n').map((l) => l.trim()).filter((l, i, a) => !(l === '' && (i === 0 || i === a.length - 1)));
  if (!sLines.length) return null;
  outer: for (let i = 0; i <= srcLines.length - sLines.length; i++) {
    for (let j = 0; j < sLines.length; j++) if (srcLines[i + j].trim() !== sLines[j]) continue outer;
    const before = srcLines.slice(0, i).join('\n');
    const start = i === 0 ? 0 : before.length + 1;
    const matched = srcLines.slice(i, i + sLines.length).join('\n');
    return { start, end: start + matched.length };
  }
  return null;
}

// 返回 { html, applied, failed: [{index, reason}] }
export function applyPatches(src, blocks) {
  let html = src;
  const failed = [];
  let applied = 0;
  blocks.forEach((b, index) => {
    if (!b.search.trim()) {
      // 空 SEARCH：视为在 </body> 前插入
      const pos = html.toLowerCase().lastIndexOf('</body>');
      if (pos === -1) { failed.push({ index, reason: '空 SEARCH 且找不到 </body>' }); return; }
      html = html.slice(0, pos) + b.replace + '\n' + html.slice(pos);
      applied++;
      return;
    }
    const exact = html.indexOf(b.search);
    if (exact !== -1) {
      html = html.slice(0, exact) + b.replace + html.slice(exact + b.search.length);
      applied++;
      return;
    }
    const loose = findByTrimmedLines(html, b.search);
    if (loose) {
      html = html.slice(0, loose.start) + b.replace + html.slice(loose.end);
      applied++;
      return;
    }
    failed.push({ index, reason: 'SEARCH 片段在当前代码中找不到', snippet: b.search.slice(0, 120) });
  });
  return { html, applied, failed };
}
