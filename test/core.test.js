import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePatches, applyPatches } from '../src/lib/patch.js';
import { qaCheck, scoreHtml, bracketsBalanced, applyRuntime, validateRuntimeReports } from '../src/lib/qa.js';
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

test('运行时报告校验：合法报告通过，越界与串版本返回 400 原因', () => {
  const ids = ['va', 'vb'];
  const ok = validateRuntimeReports([{
    versionId: 'va', blank: false, textLen: 40, nodes: 8,
    errors: [{ message: 'x', line: 0 }, { message: 'y', line: 1e6 }],
  }], { versionIds: ids });
  assert.equal(ok.ok, true);
  assert.equal(ok.reports[0].errors.length, 2);
  assert.equal(ok.reports[0].errors[1].line, 1e6);
  const boundary = validateRuntimeReports([{
    versionId: 'vb', blank: true, textLen: 1e7, nodes: 0,
    errors: Array.from({ length: 12 }, (_, i) => ({ message: 'e' + i, line: i })),
  }], { versionIds: ids });
  assert.equal(boundary.ok, true);
  assert.equal(validateRuntimeReports([], { versionIds: ids }).ok, true);
  const tooMany = validateRuntimeReports(Array.from({ length: 9 }, () => ({ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: [] })), { versionIds: ids });
  assert.equal(tooMany.ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'nope', blank: false, textLen: 1, nodes: 1, errors: [] }], { versionIds: ids }).error, '版本不属于该任务');
  const longMsg = 'a'.repeat(301);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: [{ message: longMsg, line: 1 }] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: Array.from({ length: 13 }, () => ({ message: 'e', line: 1 })) }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: [{ message: 'e', line: -1 }] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: [{ message: 'e', line: 1e6 + 1 }] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: 1, errors: [{ message: 'e', line: 1.5 }] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: 1, textLen: 1, nodes: 1, errors: [] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1e7 + 1, nodes: 1, errors: [] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports([{ versionId: 'va', blank: false, textLen: 1, nodes: -1, errors: [] }], { versionIds: ids }).ok, false);
  assert.equal(validateRuntimeReports('nope').ok, false);
});

test('设计系统：注入幂等、可剥离还原', () => {
  const h = '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>';
  const a = injectDesignSystem(h);
  assert.ok(a.includes('data-atoms-ui'));
  assert.equal(injectDesignSystem(a), a);
  assert.equal(stripDesignSystem(a), h);
});

import { LlmError, friendlyError, parseRetryAfter, computeRetryWait } from '../src/agents/llm.js';
import { hashPassword, verifyPassword, needsRehash, loginLockDecision, LOGIN_LOCK_WINDOW_MS } from '../src/lib/auth.js';
import { channelsFor } from '../src/agents/models.js';

test('Retry-After：秒数与 HTTP-date', () => {
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('1'), 1000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter('  8 '), 8000);
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(parseRetryAfter('Fri, 02 Oct 2026 00:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 00:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('nope'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('-1'), null);
});

test('重试等待：1s→2s→4s，429/503 的 Retry-After 取较大值并封顶 8s', () => {
  assert.equal(computeRetryWait(1, { jitter: 0 }).wait, 1000);
  assert.equal(computeRetryWait(2, { jitter: 0 }).wait, 2000);
  assert.equal(computeRetryWait(3, { jitter: 250 }).wait, 4250);
  assert.equal(computeRetryWait(1, { jitter: 0, retryable: true, status: 429, retryAfterMs: 30000 }).wait, 8000);
  assert.equal(computeRetryWait(2, { jitter: 100, retryable: true, status: 429, retryAfterMs: 500 }).wait, 2100);
  assert.equal(computeRetryWait(1, { jitter: 0, retryable: true, status: 503, retryAfterMs: 3000 }).wait, 3000);
  assert.equal(computeRetryWait(1, { jitter: 0, retryable: true, status: 502, retryAfterMs: 7000 }).wait, 1000);
  assert.equal(computeRetryWait(1, { jitter: 0, retryable: false, status: 429, retryAfterMs: 5000 }).wait, 1000);
});

test('friendlyError：按类型给中文，不带上游正文；故障演练单独一句', () => {
  const leak = 'upstream body sk-secret <html>raw';
  assert.equal(friendlyError(new LlmError(leak, { kind: 'rate_limit', status: 429 })), '模型繁忙（限流），已自动重试/切换');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'quota', status: 402 })), '模型额度不足');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'auth', status: 401 })), '模型接口鉴权失败');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'timeout' })), '模型响应超时');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'network' })), '无法连接模型服务');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'truncated' })), '模型输出被截断');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'config' })), '模型接口未配置');
  assert.equal(friendlyError(new LlmError(leak, { kind: 'error', status: 503 })), '模型服务暂时不可用');
  assert.equal(friendlyError(new LlmError(leak, { status: 500 })), '模型服务暂时不可用');
  const drill = friendlyError(new LlmError('[故障演练] 模拟上游 429：访问量过大', { kind: 'rate_limit', status: 429, drill: true }));
  assert.equal(drill, '[故障演练] 模型繁忙（模拟 429）');
  for (const s of [friendlyError(new LlmError(leak, { kind: 'error', status: 500 })), drill]) {
    assert.equal(s.includes('sk-secret'), false);
    assert.equal(s.includes('upstream'), false);
  }
});

test('登录锁定判定：用户名 5 次、IP 20 次、15 分钟窗口', () => {
  const now = 1_000_000_000_000;
  const recent = now - 60_000;
  const expired = now - LOGIN_LOCK_WINDOW_MS;
  assert.equal(loginLockDecision({ userFails: 4, userFirstAt: recent, now }).locked, false);
  assert.deepEqual(loginLockDecision({ userFails: 5, userFirstAt: recent, now }), { locked: true, by: 'user' });
  assert.equal(loginLockDecision({ userFails: 5, userFirstAt: expired, now }).locked, false);
  assert.equal(loginLockDecision({ ipFails: 19, ipFirstAt: recent, now }).locked, false);
  assert.equal(loginLockDecision({ ipFails: 20, ipFirstAt: recent, now }).by, 'ip');
  assert.equal(loginLockDecision({ userFails: 5, userFirstAt: recent, ipFails: 20, ipFirstAt: recent, now }).by, 'both');
  assert.equal(loginLockDecision({ ipFails: 20, ipFirstAt: expired, now }).locked, false);
});

test('密码：新哈希 100000 次可校验；旧 20000 次纯 hex 仍能通过且 needsRehash', async () => {
  const pw = 'correct-horse';
  const salt = '00112233445566778899aabbccddeeff';
  const legacyBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'hex'), iterations: 20000 },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']),
    256,
  );
  const legacy = Buffer.from(legacyBits).toString('hex');
  assert.equal(await verifyPassword(pw, legacy, salt), true);
  assert.equal(await verifyPassword('wrong-password', legacy, salt), false);
  assert.equal(needsRehash(legacy), true);
  const next = await hashPassword(pw);
  assert.match(next.hash, /^pbkdf2_sha256\$100000\$[0-9a-f]{64}$/);
  assert.equal(needsRehash(next.hash), false);
  assert.equal(await verifyPassword(pw, next.hash, next.salt), true);
  assert.equal(await verifyPassword('wrong-password', next.hash, next.salt), false);
  assert.equal(await verifyPassword(pw, 'pbkdf2_sha256$1000000$' + 'ab'.repeat(32), salt), false);
});

test('备用通道：两个 Secret 都在才换地址，缺一则保持原样', () => {
  const both = channelsFor({ ANTHROPIC_BACKUP_BASE_URL: 'https://backup.invalid', ANTHROPIC_BACKUP_AUTH_TOKEN: 'placeholder' }, 'deepseek');
  assert.equal(both[0].baseUrl, undefined);
  assert.equal(both[1].baseUrl, 'https://backup.invalid');
  assert.equal(both[1].attempts, 2);
  assert.equal(both[0].attempts, 3);
  const half = channelsFor({ ANTHROPIC_BACKUP_BASE_URL: 'https://backup.invalid' }, 'glm');
  assert.equal(half[1].baseUrl, undefined);
  assert.equal(half[1].authToken, undefined);
});
