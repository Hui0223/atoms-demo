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
  const emit = (event, data) => {
    if (!open) return;
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => { open = false; });
  };
  const simulate = ['primary429', 'alldown'].includes(body.simulate) ? body.simulate : 'none';
  const jctx = { env, store, jobId, projectId, emit, simulate, demo: !!body.demo, modelChoice };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => emit('ping', { elapsed: Date.now() - startedAt }), 5000);

  (async () => {
    emit('job', { id: jobId, type, userMessageId: umid });
    let result;
    try {
      result = type === 'edit' ? await runEdit(jctx, { request: text, baseVersionId: body.baseVersionId || row.current_version_id }) : await runGenerate(jctx, { prompt: text, lanes: body.lanes ?? 2 });
      store.updateJob(jobId, result.status === 'done' ? 'done' : result.status, { result });
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
