// 从模型输出中提取完整 HTML 文档（容忍 markdown 代码块、前后废话）
export function extractHtml(text) {
  if (!text) return '';
  let t = String(text);
  const fence = t.match(/```(?:html|HTML)?\s*\n([\s\S]*?)(?:```|$)/);
  if (fence && /<html|<!doctype/i.test(fence[1])) t = fence[1];
  const start = t.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return t.trim();
  t = t.slice(start);
  const endIdx = t.toLowerCase().lastIndexOf('</html>');
  if (endIdx !== -1) t = t.slice(0, endIdx + 7);
  return t.trim();
}

export function extractTitle(html) {
  const m = html && html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 60) : '';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 宽松 JSON 解析：取第一个 {...} 块
export function parseLooseJson(text) {
  if (!text) return null;
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
