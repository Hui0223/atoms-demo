// 模型调用层（Anthropic Messages 兼容接口）：流式输出 + 超时 + 取消 + 四层防线中的「重试」「备用通道」
// （「节流」在 pipeline 中通过错峰启动实现，「降级模板」在 pipeline 兜底）

export class LlmError extends Error {
  constructor(message, { retryable = false, kind = 'error', status } = {}) {
    super(message);
    this.retryable = retryable;
    this.kind = kind; // rate_limit | quota | timeout | truncated | canceled | error
    this.status = status;
  }
}
export class StoppedError extends Error { constructor(msg) { super(msg || '已提前结束'); this.kind = 'stopped'; } }
export class CanceledError extends Error { constructor() { super('用户已取消'); this.kind = 'canceled'; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function classifyError(e) {
  if (e instanceof LlmError || e instanceof CanceledError) return e;
  const msg = String(e?.message || e);
  if (/4006|daily free allocation|neurons|quota|额度/i.test(msg)) return new LlmError('模型额度已用尽：' + msg.slice(0, 160), { kind: 'quota' });
  if (/429|rate.?limit|3040|capacity|too many|访问量过大/i.test(msg)) return new LlmError('上游限流（429）：' + msg.slice(0, 160), { retryable: true, kind: 'rate_limit', status: 429 });
  if (/timeout|timed out|超时/i.test(msg)) return new LlmError('模型响应超时', { retryable: true, kind: 'timeout' });
  if (/5\d\d|internal|unavailable|network|fetch failed|reset/i.test(msg)) return new LlmError('上游服务异常：' + msg.slice(0, 160), { retryable: true, kind: 'error', status: 500 });
  return new LlmError('模型调用失败：' + msg.slice(0, 160), { retryable: true });
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new LlmError(label || '模型响应超时', { retryable: true, kind: 'timeout' })), ms); })])
    .finally(() => clearTimeout(t));
}

// ---------- Anthropic Messages API（兼容接口）----------
// 鉴权与地址只来自 Worker Secret：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（不写进代码与仓库）
function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  return { system, messages: rest };
}

async function httpError(res) {
  let body = '';
  try { body = (await res.text()).slice(0, 200); } catch {}
  const st = res.status;
  if (st === 401 || st === 403) return new LlmError(`模型接口鉴权失败（${st}）`, { kind: 'auth', status: st });
  if (st === 429) return new LlmError(`上游限流（429）：${body}`, { retryable: true, kind: 'rate_limit', status: 429 });
  if (st === 402 || /quota|余额|insufficient|credit/i.test(body)) return new LlmError(`模型额度不足（${st}）`, { kind: 'quota', status: st });
  if (st >= 500) return new LlmError(`上游服务异常（${st}）：${body}`, { retryable: true, status: st });
  return new LlmError(`模型请求失败（${st}）：${body}`, { status: st });
}

/**
 * 单次流式调用
 * @returns {Promise<{text:string, truncated:boolean}>}
 */
export async function streamChat(env, { model, messages, maxTokens = 4096, temperature = 0.4, deadline, onDelta, checkCancel, stopSignal, idleMs = 35_000, firstTokenMs = 45_000 }) {
  // stopSignal：外部中止（用户取消 / 赛马已决出胜者），为一个只会 reject 的 Promise
  const guard = (p, ms, label) => (stopSignal ? Promise.race([withTimeout(p, ms, label), stopSignal]) : withTimeout(p, ms, label));
  const remain = () => (deadline ? deadline - Date.now() : 120_000);
  if (remain() < 3000) throw new LlmError('时间预算已用尽', { kind: 'timeout' });
  const base = String(env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  const token = env.ANTHROPIC_AUTH_TOKEN;
  if (!base || !token) throw new LlmError('未配置模型接口（缺少 Secret）', { kind: 'config' });

  const { system, messages: msgs } = toAnthropic(messages);
  const body = { model, max_tokens: maxTokens, temperature, stream: true, messages: msgs, thinking: { type: 'disabled' } };
  if (system) body.system = system;
  const ctrl = new AbortController();
  let res;
  try {
    res = await guard(fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
      body: JSON.stringify(body), signal: ctrl.signal,
    }), Math.min(firstTokenMs, remain()), '模型首包超时');
  } catch (e) { ctrl.abort(); throw e; }
  if (!res.ok) throw await httpError(res);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', reasoning = 0, truncated = false, lastCancelCheck = Date.now(), ended = false, thinkN = 0;
  try {
    while (!ended) {
      const budget = Math.min(idleMs, remain());
      if (budget <= 0) { truncated = true; throw new LlmError('生成超出时间预算，已中断', { kind: 'timeout' }); }
      const { value, done } = await guard(reader.read(), budget, '模型输出停滞，已中断');
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        // 省 CPU：思考增量只计数、不解析
        if (line.includes('"thinking_delta"')) { reasoning += line.length - 80; if (onDelta && ++thinkN % 60 === 0) onDelta({ delta: '', text, reasoning }); continue; }
        if (line.includes('"ping"')) continue;
        let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) { text += d.text; onDelta && onDelta({ delta: d.text, text, reasoning }); }
          else if (d.type === 'thinking_delta') { reasoning += (d.thinking || '').length; onDelta && onDelta({ delta: '', text, reasoning }); }
        } else if (j.type === 'message_delta') {
          if (j.delta?.stop_reason === 'max_tokens') truncated = true;
        } else if (j.type === 'message_stop') {
          ended = true;
        } else if (j.type === 'error') {
          const msg = j.error?.message || JSON.stringify(j.error || j).slice(0, 160);
          throw classifyError(new Error(`${j.error?.type || 'error'}: ${msg}`));
        }
      }
      if (checkCancel && Date.now() - lastCancelCheck > 1500) {
        lastCancelCheck = Date.now();
        if (await checkCancel()) throw new CanceledError();
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { ctrl.abort(); } catch {}
  }
  return { text, truncated };
}

/**
 * 带重试和备用通道的调用
 * channels: [{ model, label, attempts }]
 * simulate: 'none' | 'primary429' | 'alldown'
 * runtimeError 等其他值在这里忽略，故障演练的运行时注入不走模型调用
 */
export async function resilientChat(env, opts, { channels, simulate = 'none', log = () => {} }) {
  let lastErr;
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci];
    if (ci > 0) log({ level: 'warn', text: `切换到备用通道：${ch.label}` });
    for (let attempt = 1; attempt <= ch.attempts; attempt++) {
      if (opts.isStopped && opts.isStopped()) throw opts.isStopped();
      try {
        if (simulate === 'alldown' || (simulate === 'primary429' && ci === 0)) {
          throw new LlmError('[故障演练] 模拟上游 429：该模型当前访问量过大，请您稍后再试', { retryable: true, kind: 'rate_limit', status: 429 });
        }
        const r = await streamChat(env, { ...opts, model: ch.model });
        if (r.truncated && opts.failOnTruncate) throw new LlmError('输出被截断（触达 max_tokens）', { kind: 'truncated' });
        return { ...r, model: ch.model, channel: ci === 0 ? 'primary' : 'backup' };
      } catch (e) {
        if (e instanceof CanceledError || e?.kind === 'stopped') throw e;
        lastErr = classifyError(e);
        const left = opts.deadline ? opts.deadline - Date.now() : 60_000;
        log({ level: 'warn', text: `${ch.label} 第 ${attempt} 次调用失败：${lastErr.message}` });
        if (lastErr.kind === 'quota' || lastErr.kind === 'auth' || lastErr.kind === 'config') break; // 重试无意义，直接换通道 / 降级
        if (!lastErr.retryable || attempt >= ch.attempts) break;
        const backoff = Math.min(4000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        if (left < backoff + 8000) { log({ level: 'warn', text: '剩余时间不足，跳过重试' }); break; }
        log({ level: 'info', text: `${(backoff / 1000).toFixed(1)}s 后进行第 ${attempt + 1} 次重试（指数退避 + 抖动）` });
        await sleep(backoff);
      }
    }
  }
  throw lastErr || new LlmError('所有模型通道均不可用');
}
