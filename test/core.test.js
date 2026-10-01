import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePatches, applyPatches } from '../src/lib/patch.js';
import { qaCheck, scoreHtml, bracketsBalanced } from '../src/lib/qa.js';
import { extractHtml, parseLooseJson } from '../src/lib/html.js';
import { pickTemplate, renderTemplate, demoEdit } from '../src/templates/engine.js';
import { injectShim } from '../public/shim.js';

const sources = Object.fromEntries(['kanban', 'mortgage', 'profile', 'pomodoro', 'generic'].map((k) => [k, readFileSync(new URL(`../src/templates/${k}.html`, import.meta.url), 'utf8')]));

test('patch: 精确匹配与宽松匹配', () => {
  const src = '<html>\n  <body>\n    <h1>Hi</h1>\n  </body>\n</html>';
  const out = `<<<<<<< SEARCH\n    <h1>Hi</h1>\n=======\n    <h1>Hello</h1>\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<body>\n<h1>Hello</h1>\n=======\n<body class="x">\n<h1>Hello</h1>\n>>>>>>> REPLACE`;
  const blocks = parsePatches(out);
  assert.equal(blocks.length, 2);
  const r = applyPatches(src, blocks);
  assert.equal(r.applied, 2);
  assert.match(r.html, /<h1>Hello<\/h1>/);
  assert.match(r.html, /class="x"/);
});

test('patch: 找不到的块报告失败且不破坏原文', () => {
  const src = '<p>a</p>';
  const r = applyPatches(src, parsePatches('<<<<<<< SEARCH\n<p>zzz</p>\n=======\n<p>b</p>\n>>>>>>> REPLACE'));
  assert.equal(r.applied, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.html, src);
});

test('patch: 去除模型误带的行号前缀', () => {
  const r = applyPatches('<p>a</p>', parsePatches('<<<<<<< SEARCH\n  1| <p>a</p>\n=======\n  1| <p>b</p>\n>>>>>>> REPLACE'));
  assert.equal(r.html, '<p>b</p>');
});

test('qa: 截断的 HTML 不通过', () => {
  const full = sources.kanban.replace(/\{\{\w+\}\}/g, 'x');
  assert.ok(qaCheck(full).ok);
  const cut = full.slice(0, Math.floor(full.length * 0.7));
  const r = qaCheck(cut);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes('</html>')));
});

test('qa: 括号配平检测', () => {
  assert.ok(bracketsBalanced('function a(){ const s = "}"; return `${1+{a:1}.a}`; }'));
  assert.equal(bracketsBalanced('function a(){ if (x) {'), false);
});

test('extractHtml: 去除 markdown 围栏与废话', () => {
  const t = '好的，这是代码：\n```html\n<!DOCTYPE html><html><body>hi</body></html>\n```\n希望有帮助';
  assert.equal(extractHtml(t), '<!DOCTYPE html><html><body>hi</body></html>');
  assert.deepEqual(parseLooseJson('xx {"a":1} yy'), { a: 1 });
});

test('降级模板：按关键词选择且全部通过 QA、评分合格', () => {
  const cases = { '项目看板，带拖拽': 'kanban', '房贷计算器': 'mortgage', '我的个人主页': 'profile', '番茄钟': 'pomodoro', '读书清单': 'generic' };
  for (const [p, id] of Object.entries(cases)) {
    assert.equal(pickTemplate(p), id);
    const html = renderTemplate(sources, id, p);
    assert.ok(!/\{\{\w+\}\}/.test(html), `${id} 有未替换的占位符`);
    const s = scoreHtml(html);
    assert.ok(s.qa.ok, `${id} QA 失败: ${s.qa.issues}`);
    assert.ok(s.total >= 70, `${id} 评分过低 ${s.total}`);
  }
});

test('演示模式规则修改：换色 / 深色 / 改标题；无法理解时返回空', () => {
  const html = renderTemplate(sources, 'kanban', '看板');
  const r = demoEdit(html, '把主色调换成蓝色，并切换为深色主题，标题改为「冲刺看板」');
  assert.match(r.html, /--primary:#2563eb/);
  assert.match(r.html, /atoms-dark/);
  assert.match(r.html, /<title>冲刺看板<\/title>/);
  assert.equal(r.changes.length, 3);
  assert.equal(demoEdit(html, '接入微信登录').changes.length, 0);
});

test('预览沙箱 shim 注入到 <head> 之后', () => {
  const out = injectShim('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>', { storageKey: 'p1', initial: { a: '</script>' } });
  assert.ok(out.indexOf('data-atoms-shim') < out.indexOf('<title>'));
  assert.ok(!out.includes('"</script>"'), '初始数据中的 </script> 必须被转义');
});

import { injectDesignSystem, stripDesignSystem } from '../src/lib/designSystem.js';
test('设计系统：注入幂等、可剥离还原', () => {
  const h = '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>';
  const a = injectDesignSystem(h);
  assert.ok(a.includes('data-atoms-ui'));
  assert.equal(injectDesignSystem(a), a);
  assert.equal(stripDesignSystem(a), h);
});
