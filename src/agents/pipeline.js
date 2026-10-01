// 多智能体流水线：Planner → Engineer×N（赛马）→ QA/Judge；以及 Editor（增量补丁迭代）
import { resilientChat, CanceledError, StoppedError } from './llm.js';
import { PLANNER_SYSTEM, LANE_VARIANTS, engineerSystem, engineerUser, EDITOR_SYSTEM, editorUser, editorRepair } from './prompts.js';
import { extractHtml, parseLooseJson } from '../lib/html.js';
import { injectDesignSystem, stripDesignSystem } from '../lib/designSystem.js';
import { qaCheck, scoreHtml } from '../lib/qa.js';
import { parsePatches, applyPatches } from '../lib/patch.js';
import { pickTemplate, renderTemplate, demoEdit, TEMPLATE_RULES } from '../templates/engine.js';
import sources from '../templates/sources.js';

export const JOB_BUDGET_MS = 120_000; // 单个任务总时长上限（超时即中断并兜底）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const RACE_GRACE_MS = 50_000; // 赛马：首个方案通过 QA 后，其余方案最多再等 50s（仍受 120s 总预算约束）

function channels(env, swap = false) {
  const a = { model: env.PRIMARY_MODEL, label: `主模型 ${short(env.PRIMARY_MODEL)}`, attempts: 3 };
  const b = { model: env.BACKUP_MODEL, label: `备用模型 ${short(env.BACKUP_MODEL)}`, attempts: 2 };
  // 赛马：A/B 两路使用质量最好的主模型（不同设计取向 + 温度）；第 3 路换用另一模型增加多样性
  return swap ? [{ ...b, label: `主模型 ${short(b.model)}`, attempts: 2 }, { ...a, label: `备用模型 ${short(a.model)}`, attempts: 2 }] : [a, b];
}
// 迭代修改只输出小补丁：优先用响应更快的模型（目标：轻量修改 1 分钟内返回），另一个作备用
function editChannels(env) {
  const fast = env.EDIT_MODEL || env.BACKUP_MODEL;
  const other = fast === env.PRIMARY_MODEL ? env.BACKUP_MODEL : env.PRIMARY_MODEL;
  return [{ model: fast, label: `主模型 ${short(fast)}`, attempts: 2 }, { model: other, label: `备用模型 ${short(other)}`, attempts: 2 }];
}

// 中止器：把“用户取消”（轮询任务状态）与“赛马提前收敛”统一成一个可 race 的 Promise
function makeStopper(store, jobId) {
  let reject, reason = null;
  const signal = new Promise((_, rej) => { reject = rej; });
  signal.catch(() => {});
  const stop = (err) => { if (!reason) { reason = err; reject(err); } };
  const poll = setInterval(async () => { try { if (await store.isCanceled(jobId)) stop(new CanceledError()); } catch {} }, 2000);
  return { signal, stop, isStopped: () => reason, dispose: () => clearInterval(poll) };
}

export const short = (m) => String(m || '').split('/').pop();

function heuristicPlan(prompt) {
  const parts = String(prompt).split(/[，,。；;、\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 5);
  return { title: String(prompt).slice(0, 12), summary: String(prompt).slice(0, 60), features: parts.length ? parts : [String(prompt).slice(0, 16)], data: '用户在应用中创建的数据', style: '简洁现代' };
}

function fallbackVersion(prompt) {
  const tpl = pickTemplate(prompt);
  const html = renderTemplate(sources, tpl, prompt);
  return { html, tpl, name: (TEMPLATE_RULES.find((r) => r.id === tpl) || { name: '通用记录应用' }).name };
}

/**
 * ctx: { env, store, jobId, projectId, emit(event, data), simulate, demo }
 */
export async function runGenerate(ctx, { prompt, lanes = 2 }) {
  const { env, store, jobId, projectId, emit } = ctx;
  const deadline = Date.now() + JOB_BUDGET_MS;
  const demo = ctx.demo || env.AI_DISABLED === '1';
  const checkCancel = () => store.isCanceled(jobId);
  const say = async (agent, content, meta) => { const id = await store.addMessage(projectId, 'agent', agent, content, meta); emit('message', { id, role: 'agent', agent, content, meta, created_at: Date.now() }); };
  const log = (agent) => (l) => emit('log', { agent, ...l });

  // ---------- 1. Planner ----------
  emit('stage', { stage: 'plan', text: '产品经理正在拆解需求…' });
  let plan = heuristicPlan(prompt);
  let planMode = 'heuristic';
  if (!demo) {
    try {
      const r = await resilientChat(env, { messages: [{ role: 'system', content: PLANNER_SYSTEM }, { role: 'user', content: prompt }], maxTokens: 600, temperature: 0.2, deadline: Math.min(deadline, Date.now() + 25_000), checkCancel },
        { channels: [{ model: env.PLANNER_MODEL, label: `规划模型 ${short(env.PLANNER_MODEL)}`, attempts: 2 }], simulate: ctx.simulate, log: log('planner') });
      const j = parseLooseJson(r.text);
      if (j && Array.isArray(j.features) && j.features.length) { plan = { ...plan, ...j, features: j.features.slice(0, 6).map(String) }; planMode = 'ai'; }
    } catch (e) {
      if (e instanceof CanceledError) throw e;
      emit('log', { agent: 'planner', level: 'warn', text: '规划模型不可用，改用规则拆解：' + e.message });
    }
  }
  await say('planner', `需求拆解完成：**${plan.title}**\n${plan.summary || ''}`, { plan, mode: planMode });
  await store.updateJob(jobId, 'running', { stage: 'build', plan });

  // ---------- 2. Engineers（赛马） ----------
  const n = demo ? 0 : Math.max(1, Math.min(3, lanes | 0));
  const variants = LANE_VARIANTS.slice(0, n);
  emit('stage', { stage: 'build', text: n > 1 ? `赛马模式：${n} 路工程师并行生成…` : '工程师正在编写代码…', lanes: variants.map((v) => ({ id: v.id, name: v.name })) });

  // 赛马提前收敛：首个合格方案产生后启动宽限计时，超时未完成的赛道被中止
  // 每条赛道有自己的中止器（宽限到期只停掉未完成赛道）；用户取消则全部停止
  const stoppers = variants.map(() => makeStopper(store, jobId));
  let firstOkAt = 0, graceTimer = null;
  const markOk = () => {
    if (firstOkAt || n < 2) return;
    firstOkAt = Date.now();
    graceTimer = setTimeout(() => stoppers.forEach((s) => s.stop(new StoppedError(`已有方案胜出，宽限 ${RACE_GRACE_MS / 1000}s 后提前结束`))), RACE_GRACE_MS);
  };

  const results = await Promise.all(variants.map(async (v, i) => {
    await sleep(i * 1500); // 节流：错峰启动，降低撞 429 概率
    const t0 = Date.now();
    let lastEmit = 0;
    emit('lane', { lane: v.id, name: v.name, status: 'running', chars: 0 });
    try {
      const r = await resilientChat(env, {
        messages: [{ role: 'system', content: engineerSystem(v.desc) }, { role: 'user', content: engineerUser(prompt, plan) }],
        maxTokens: 9000, temperature: v.temperature, deadline, stopSignal: stoppers[i].signal, isStopped: stoppers[i].isStopped,
        onDelta: ({ text, reasoning }) => {
          if (Date.now() - lastEmit < 350) return;
          lastEmit = Date.now();
          emit('lane', { lane: v.id, status: text ? 'coding' : 'thinking', chars: text.length, reasoning, tail: text.slice(-240) });
        },
      }, { channels: channels(env, i === 2), simulate: ctx.simulate, log: (l) => emit('log', { agent: 'engineer', lane: v.id, ...l }) });
      const raw = extractHtml(r.text);
      const score = scoreHtml(raw, plan.features); // 在注入设计系统前打分，避免基础样式“刷分”
      const html = injectDesignSystem(raw);
      const ms = Date.now() - t0;
      const status = score.qa.ok ? 'done' : 'failed';
      emit('lane', { lane: v.id, status, chars: html.length, score: score.total, model: short(r.model), channel: r.channel, ms, issues: score.qa.issues });
      if (score.qa.ok) markOk();
      return { v, html, score, model: r.model, channel: r.channel, ms, ok: score.qa.ok, error: score.qa.ok ? null : score.qa.issues.join('；') };
    } catch (e) {
      if (e instanceof CanceledError) throw e;
      emit('lane', { lane: v.id, status: 'failed', error: e.message, ms: Date.now() - t0 });
      return { v, ok: false, error: e.message };
    }
  }).map((p, i) => p.finally(() => stoppers[i].dispose())));
  clearTimeout(graceTimer);

  // ---------- 3. QA / Judge ----------
  emit('stage', { stage: 'qa', text: '测试工程师正在校验并打分…' });
  const passed = results.filter((r) => r.ok).sort((a, b) => b.score.total - a.score.total || b.html.length - a.html.length);
  if (passed.length) {
    const win = passed[0];
    const mode = win.channel === 'primary' ? 'ai' : 'backup';
    const vid = await store.addVersion(projectId, { html: win.html, note: n > 1 ? `赛马胜出：方案 ${win.v.id}（${win.v.name}）` : '首次生成', kind: n > 1 ? 'race' : 'generate', mode, model: short(win.model), score: win.score, lane: win.v.id, jobId });
    const candidates = [];
    for (const r of passed.slice(1)) {
      const cid = await store.addVersion(projectId, { html: r.html, note: `候选方案 ${r.v.id}（${r.v.name}）`, kind: 'race', mode: r.channel === 'primary' ? 'ai' : 'backup', model: short(r.model), score: r.score, lane: r.v.id, candidate: true, jobId });
      candidates.push({ id: cid, lane: r.v.id, name: r.v.name, score: r.score.total });
    }
    const board = results.map((r) => ({ lane: r.v.id, name: r.v.name, ok: r.ok, score: r.score?.total ?? 0, items: r.score?.items || [], model: r.model ? short(r.model) : '-', channel: r.channel || '-', ms: r.ms || 0, error: r.error }));
    await say('qa', n > 1 ? `赛马结果：方案 ${win.v.id}（${win.v.name}）以 ${win.score.total} 分胜出${candidates.length ? '，其余方案已保留为候选，可一键切换' : ''}。` : `QA 通过，综合评分 ${win.score.total} 分。`,
      { versionId: vid, board, winner: win.v.id, candidates, mode });
    return { status: 'done', versionId: vid, mode };
  }

  // ---------- 4. 降级兜底：模板必成功 ----------
  const fb = fallbackVersion(prompt);
  const reason = demo ? '演示模式（未调用模型）' : `模型通道全部失败（${results.map((r) => `${r.v.id}: ${r.error}`).join(' | ').slice(0, 300)}）`;
  const vid = await store.addVersion(projectId, { html: fb.html, note: `演示模式：内置「${fb.name}」模板`, kind: 'fallback', mode: 'demo', model: 'template', score: scoreHtml(fb.html, plan.features), jobId });
  await say('qa', `⚠️ ${reason}。已自动降级为内置「${fb.name}」模板，生成了一个可完整使用的应用（演示模式）。模型恢复后可重新生成或继续对话修改。`, { versionId: vid, mode: 'demo', fallback: true });
  return { status: 'done', versionId: vid, mode: 'demo' };
}

/**
 * 对话式迭代：真增量（SEARCH/REPLACE 补丁），QA 不过不落库，带超时与取消
 */
export async function runEdit(ctx, { request, baseVersionId }) {
  const { env, store, jobId, projectId, emit } = ctx;
  const deadline = Date.now() + JOB_BUDGET_MS;
  const demo = ctx.demo || env.AI_DISABLED === '1';
  const checkCancel = () => store.isCanceled(jobId);
  const say = async (agent, content, meta) => { const id = await store.addMessage(projectId, 'agent', agent, content, meta); emit('message', { id, role: 'agent', agent, content, meta, created_at: Date.now() }); };

  const base = await store.getVersion(baseVersionId);
  if (!base) { await say('system', '找不到当前版本，无法修改。'); return { status: 'failed' }; }
  const hasDS = base.html.includes('data-atoms-ui');
  const original = stripDesignSystem(base.html); // 模型只看到应用自身代码
  const finalize = (html) => (hasDS ? injectDesignSystem(html) : html);

  const commit = async (html, note, mode, model, extra = {}) => {
    const score = scoreHtml(html);
    const vid = await store.addVersion(projectId, { html: finalize(html), note, kind: 'edit', mode, model, score, jobId });
    return { vid, score, ...extra };
  };

  const tryDemo = async (why) => {
    const r = demoEdit(original, request);
    if (r.changes.length && qaCheck(r.html).ok) {
      const { vid } = await commit(r.html, `规则修改：${r.changes.join('、')}`, 'demo', 'rules');
      await say('editor', `${why ? `⚠️ ${why}。` : ''}已在演示模式下通过规则引擎完成修改：${r.changes.join('、')}。`, { versionId: vid, mode: 'demo' });
      return { status: 'done', versionId: vid, mode: 'demo' };
    }
    await say('editor', `${why ? `⚠️ ${why}。` : ''}演示模式仅支持「换主色 / 深浅色主题 / 改标题 / 放大字号 / 圆角」类修改，这条需求未能处理，已保留当前版本（v${base.n}）不变。`, { mode: 'demo', kept: base.id });
    return { status: 'noop' };
  };

  if (demo) return tryDemo('');

  emit('stage', { stage: 'edit', text: '编辑智能体正在生成增量补丁…' });
  let lastEmit = 0;
  const stopper = makeStopper(store, jobId);
  const chs = editChannels(env);
  const call = (messages, list) => resilientChat(env, {
    messages, maxTokens: 4000, temperature: 0.2, deadline, stopSignal: stopper.signal, isStopped: stopper.isStopped,
    onDelta: ({ text, reasoning }) => { if (Date.now() - lastEmit > 350) { lastEmit = Date.now(); emit('lane', { lane: 'E', status: text ? 'coding' : 'thinking', chars: text.length, reasoning, tail: text.slice(-240) }); } },
  }, { channels: list, simulate: ctx.simulate, log: (l) => emit('log', { agent: 'editor', ...l }) });

  // 一轮尝试：生成补丁 → 应用 → 若有未匹配块则让同一模型修正一次
  const attempt = async (list) => {
    const messages = [{ role: 'system', content: EDITOR_SYSTEM }, { role: 'user', content: editorUser(original, request) }];
    const r = await call(messages, list);
    const blocks = parsePatches(r.text);
    let html = original, applied = 0, failed = [];
    if (blocks.length) {
      ({ html, applied, failed } = applyPatches(original, blocks));
      if (failed.length && deadline - Date.now() > 35_000) {
        emit('log', { agent: 'editor', level: 'warn', text: `${failed.length} 个补丁未能匹配，正在让模型修正…` });
        const retry = await call([...messages, { role: 'assistant', content: r.text }, { role: 'user', content: editorRepair(failed) }], [list[0]]);
        const res2 = applyPatches(html, parsePatches(retry.text));
        html = res2.html; applied += res2.applied; failed = res2.failed;
      }
    } else {
      // 模型没按补丁格式输出：仅当它给出了完整 HTML 时才接受
      const full = extractHtml(r.text);
      if (qaCheck(full).ok) { html = full; applied = 1; }
    }
    return { r, html, applied, failed };
  };
  // QA 闸门：补丁必须全部命中（原子性）、结构完整、无异常缩水、确有变化
  const verdict = ({ html, applied, failed }) => {
    const qa = qaCheck(html);
    if (!applied) return '补丁无法应用到当前代码';
    if (failed.length) return `有 ${failed.length} 个补丁无法匹配（为避免半成品，整体不落库）`;
    if (!qa.ok) return `QA 未通过（${qa.issues.join('；')}）`;
    if (html.length < original.length * 0.4) return '修改后代码体积异常缩水，疑似被截断';
    if (html === original) return '补丁未产生实际变化';
    return null;
  };

  try {
    let ok = null, why = null;
    for (let i = 0; i < chs.length && !ok; i++) {
      if (i > 0) {
        if (deadline - Date.now() < 45_000) { emit('log', { agent: 'editor', level: 'warn', text: '剩余时间不足，不再升级模型' }); break; }
        emit('log', { agent: 'editor', level: 'warn', text: `快速模型的补丁未通过 QA（${why}），升级到 ${short(chs[i].model)} 重新生成补丁…` });
      }
      let out;
      try { out = await attempt(i === 0 ? chs : [chs[i]]); }
      catch (e) { if (e instanceof CanceledError) throw e; if (i === 0) throw e; why = e.message; break; }
      why = verdict(out);
      if (!why) ok = out;
      else emit('log', { agent: 'qa', level: 'warn', text: why });
    }
    if (!ok) {
      await say('qa', `❌ ${why}。为保护已有成果，本次修改未落库，当前版本（v${base.n}）保持不变，可换个更具体的说法重试。`, { kept: base.id });
      return { status: 'rejected' };
    }
    const { r, html, applied } = ok;
    const mode = r.channel === 'primary' ? 'ai' : 'backup';
    const { vid, score } = await commit(html, `修改：${request.slice(0, 40)}`, mode, short(r.model));
    const delta = html.length - original.length;
    await say('editor', `已应用 ${applied} 处增量修改（${delta >= 0 ? '+' : ''}${delta} 字符，模型 ${short(r.model)}），QA 通过，评分 ${score.total}。`, { versionId: vid, mode, applied });
    return { status: 'done', versionId: vid, mode };
  } catch (e) {
    if (e instanceof CanceledError) throw e;
    return tryDemo(`模型不可用（${e.message}），已降级`);
  } finally {
    stopper.dispose();
  }
}
