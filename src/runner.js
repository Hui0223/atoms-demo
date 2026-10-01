// 生成 / 迭代任务的执行器：在 Durable Object 内运行，返回 SSE 流
import { runGenerate, runEdit } from './agents/pipeline.js';
import { CanceledError } from './agents/llm.js';
import { resolveChoice } from './agents/models.js';

export function startRun(env, store, { projectId, userId, body }) {
  const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const row = store.getProjectRow(projectId);
  if (!row || row.user_id !== userId) return json({ error: '无权访问该项目' }, 403);
  const type = body.type;
  const text = body.prompt;
  const jr = store.createJob(projectId, userId, type);
  if (jr.error) return json({ error: jr.error }, 429);
  const jobId = jr.job.id;
  const modelChoice = resolveChoice(body.model);
  const umid = store.addMessage(projectId, 'user', null, text, { type, lanes: body.lanes, demo: !!body.demo, simulate: body.simulate || 'none', model: modelChoice });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  // runtimeError 只影响生成产物（pipeline 注入），不进入模型调用的 simulate 分支
  const simulate = ['primary429', 'alldown', 'runtimeError'].includes(body.simulate) ? body.simulate : 'none';
  // 意图在 /intent 判定；type==='edit' 一律走增量补丁，不因文案像新需求而整页重生成
  const progress = { stage: type === 'edit' ? 'edit' : 'plan', stageText: '', stageStartedAt: Date.now(), laneCount: type === 'edit' ? 1 : (body.lanes ?? 2), type, lanes: {} };
  let lastSnap = 0;
  const snapshot = (force) => {
    const n = Date.now();
    if (!force && n - lastSnap < 2000) return;
    lastSnap = n;
    const lanes = {};
    for (const [k, v] of Object.entries(progress.lanes)) {
      lanes[k] = { lane: v.lane, name: v.name || '', status: v.status || 'queued', chars: v.chars || 0, model: v.model || '', elapsed: v.elapsed || 0, cps: v.cps || 0, score: v.score, error: v.error ? String(v.error).slice(0, 140) : undefined };
    }
    try {
      store.updateJob(jobId, null, { progress: { stage: progress.stage, stageText: progress.stageText, stageStartedAt: progress.stageStartedAt, laneCount: progress.laneCount, type, lanes } });
    } catch {}
  };
  const emit = (event, data) => {
    if (!open) return;
    let payload = data;
    if (event === 'stage' && data) {
      progress.stage = data.stage || progress.stage;
      progress.stageText = data.text || '';
      progress.stageStartedAt = Date.now();
      if (data.lanes && data.lanes.length) progress.laneCount = data.lanes.length;
      payload = { ...data, at: progress.stageStartedAt };
      snapshot(true);
    } else if (event === 'lane' && data && data.lane) {
      const prev = progress.lanes[data.lane] || {};
      const startedAt = prev.startedAt || Date.now();
      const chars = data.chars != null ? data.chars : (prev.chars || 0);
      const elapsed = Date.now() - startedAt;
      const cps = elapsed > 500 ? Math.round((chars * 1000) / elapsed) : (prev.cps || 0);
      const merged = {
        ...prev, ...data, startedAt, chars, elapsed, cps,
        name: data.name || prev.name || '',
        model: data.model || prev.model || '',
        status: data.status || prev.status || 'queued',
      };
      progress.lanes[data.lane] = merged;
      payload = { lane: merged.lane, name: merged.name, status: merged.status, chars, model: merged.model, elapsed, cps };
      if (merged.score != null) payload.score = merged.score;
      if (merged.error) payload.error = merged.error;
      if (data.tail != null) payload.tail = String(data.tail).slice(-400);
      if (data.channel) payload.channel = data.channel;
      if (data.issues) payload.issues = data.issues;
      if (data.ms != null) payload.ms = data.ms;
      snapshot(lastSnap === 0);
    }
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)).catch(() => { open = false; });
  };
  const jctx = { env, store, jobId, projectId, emit, simulate, demo: !!body.demo, modelChoice };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => emit('ping', { elapsed: Date.now() - startedAt }), 5000);

  (async () => {
    emit('job', { id: jobId, type, userMessageId: umid });
    let result;
    try {
      result = type === 'edit' ? await runEdit(jctx, { request: text, baseVersionId: body.baseVersionId || row.current_version_id }) : await runGenerate(jctx, { prompt: text, lanes: body.lanes ?? 2 });
      const status = result.status === 'done' ? 'done' : result.status;
      store.updateJob(jobId, status, { result, needsRuntime: status === 'done' });
    } catch (e) {
      // 异常绝不穿透：取消 / 未知错误都转成可展示的状态
      if (e instanceof CanceledError) {
        result = { status: 'canceled' };
        store.updateJob(jobId, 'canceled', { result });
        const content = '⏹ 已取消本次任务，已有版本保持不变。';
        const mid = store.addMessage(projectId, 'agent', 'system', content);
        emit('message', { id: mid, role: 'agent', agent: 'system', content });
      } else {
        console.error('job failed', e?.stack || e);
        result = { status: 'failed', error: String(e?.message || e) };
        store.updateJob(jobId, 'failed', { result });
        const content = `任务异常：${result.error}。已有版本不受影响，可重试。`;
        const mid = store.addMessage(projectId, 'agent', 'system', content);
        emit('message', { id: mid, role: 'agent', agent: 'system', content });
      }
    } finally {
      clearInterval(heartbeat);
      emit('done', { ...result, elapsed: Date.now() - startedAt });
      open = false;
      try { await writer.close(); } catch {}
    }
  })();
  return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
