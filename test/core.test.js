import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePatches, applyPatches } from '../src/lib/patch.js';
import { qaCheck, scoreHtml, bracketsBalanced, applyRuntime } from '../src/lib/qa.js';
import { extractHtml, parseLooseJson, injectRuntimeFault } from '../src/lib/html.js';
import { classifyIntent } from '../src/lib/intent.js';
import { pickTemplate, renderTemplate, demoEdit } from '../src/templates/engine.js';
import { injectShim, buildShim } from '../public/shim.js';

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

const pomo = { title: '番茄钟', prompt: '番茄钟专注计时器，可以管理今日任务并统计近 7 天专注数', plan: { title: '番茄钟', features: ['专注计时', '今日任务', '近7天统计'] } };

test('intent: 全新需求 / 增量修改 / 混合', () => {
  const neu = classifyIntent('做一个记账本应用', pomo);
  assert.equal(neu.intent, 'new');
  assert.ok(neu.confidence >= 0.75);
  const again = classifyIntent('再做一个贪吃蛇小游戏', pomo);
  assert.equal(again.intent, 'new');
  assert.ok(again.confidence >= 0.75);
  assert.equal(classifyIntent('把主色改成蓝色', pomo).intent, 'edit');
  assert.equal(classifyIntent('加一个导出按钮', pomo).intent, 'edit');
  assert.equal(classifyIntent('番茄钟增加长休息设置', pomo).intent, 'edit');
  const mixed = classifyIntent('把颜色改成蓝色，再做一个记账本应用', pomo);
  assert.equal(mixed.intent, 'unsure');
  for (const r of [neu, again, mixed]) assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test('applyRuntime: 干净不加罚，错误扣 30，白屏扣 40，重复套用不叠扣', () => {
  const base = { total: 90, items: [{ name: '结构完整', got: 25, max: 25 }], qa: { ok: true, issues: [] } };
  const clean = applyRuntime(base, { errors: [], blank: false, textLen: 40, nodes: 8 });
  assert.equal(clean.total, 90);
  assert.equal(clean.staticTotal, 90);
  assert.equal(clean.items.find((i) => i.name === '运行时检查').got, 15);
  assert.equal(clean.runtime.clean, true);
  const one = applyRuntime(base, { errors: [{ message: 'x', line: 3 }, { message: 'x' }], blank: false });
  assert.equal(one.runtime.errorCount, 1);
  assert.equal(one.items.find((i) => i.name === '运行时检查').got, 7);
  assert.equal(one.total, 60);
  const two = applyRuntime(base, { errors: [{ message: 'x' }, { message: 'y' }], blank: false });
  assert.equal(two.items.find((i) => i.name === '运行时检查').got, 0);
  assert.equal(two.total, 60);
  const blank = applyRuntime(base, { errors: [{ message: 'x' }], blank: true, textLen: 0, nodes: 1 });
  assert.equal(blank.items.find((i) => i.name === '运行时检查').got, 0);
  assert.equal(blank.total, 50);
  assert.equal(blank.runtime.blank, true);
  const again = applyRuntime(one, { errors: [{ message: 'x', line: 3 }] });
  assert.equal(again.total, one.total);
  assert.equal(again.items.filter((i) => i.name === '运行时检查').length, 1);
  const low = applyRuntime({ total: 10, items: [] }, { blank: true });
  assert.equal(low.total, 0);
});

test('applyRuntime: 内置模板在干净报告下保持高分', () => {
  const html = renderTemplate(sources, 'pomodoro', '番茄钟');
  const base = scoreHtml(html);
  const next = applyRuntime(base, { errors: [], blank: false, textLen: 80, nodes: 12 });
  assert.equal(next.runtime.clean, true);
  assert.equal(next.total, base.total);
  assert.ok(next.total >= 70);
});

test('故障演练脚本插在 </body> 前，且静态分按插入前计算', () => {
  const html = renderTemplate(sources, 'kanban', '看板');
  const before = scoreHtml(html);
  const out = injectRuntimeFault(html);
  assert.ok(out.indexOf("throw new Error") < out.toLowerCase().lastIndexOf('</body>'));
  assert.match(out, /故障演练：方案 A 运行时错误/);
  assert.equal(scoreHtml(html).total, before.total);
});

test('运行时探针脚本只在 probe 模式注入', () => {
  const plain = buildShim({ storageKey: 'p' });
  assert.equal(plain.includes('atoms-runtime-report'), false);
  assert.ok(plain.includes("__atoms:'error'"));
  const probe = buildShim({ storageKey: 'p', probe: true, probeId: 'ver1' });
  assert.ok(probe.includes('atoms-runtime-report'));
  assert.ok(probe.includes('ver1'));
  assert.equal(probe.includes("__atoms:'error'"), false);
});

test('设计系统：注入幂等、可剥离还原', () => {
  const h = '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>';
  const a = injectDesignSystem(h);
  assert.ok(a.includes('data-atoms-ui'));
  assert.equal(injectDesignSystem(a), a);
  assert.equal(stripDesignSystem(a), h);
});
