// 模型调用层（Anthropic Messages 兼容接口）：流式输出 + 超时 + 取消 + 四层防线中的「重试」「备用通道」
// （「节流」在 pipeline 中通过错峰启动实现，「降级模板」在 pipeline 兜底）

export class LlmError extends Error {
  constructor(message, { retryable = false, kind = 'error', status, retryAfterMs = null, drill = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.kind = kind; // rate_limit | quota | timeout | truncated | network | auth | config | canceled | error
    this.status = status;
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
    this.drill = !!drill;
  }
}
export class StoppedError extends Error { constructor(msg) { super(msg || '已提前结束'); this.kind = 'stopped'; } }
export class CanceledError extends Error { constructor() { super('用户已取消'); this.kind = 'canceled'; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function classifyError(e) {
  if (e instanceof LlmError || e instanceof CanceledError || e instanceof StoppedError) return e;
  const msg = String(e?.message || e);
  const drill = msg.startsWith('[故障演练]');
  if (/4006|daily free allocation|neurons|quota|额度/i.test(msg)) return new LlmError('模型额度不足', { kind: 'quota', drill });
  if (/429|rate.?limit|3040|capacity|too many|访问量过大/i.test(msg)) return new LlmError('模型繁忙（限流）', { retryable: true, kind: 'rate_limit', status: 429, drill });
  if (/timeout|timed out|超时/i.test(msg)) return new LlmError('模型响应超时', { retryable: true, kind: 'timeout', drill });
  if (/network|fetch failed|ECONN|ENOTFOUND|无法连接/i.test(msg)) return new LlmError('无法连接模型服务', { retryable: true, kind: 'network', drill });
  if (/5\d\d|internal|unavailable|reset/i.test(msg)) return new LlmError('模型服务暂时不可用', { retryable: true, kind: 'error', status: 500, drill });
  return new LlmError('模型服务暂时不可用', { retryable: true, kind: 'error', drill });
}

/** 给用户看的模型错误。不带上游响应体、不带 URL / 密钥。 */
export function friendlyError(err) {
  if (!err) return '模型服务暂时不可用';
  if (err instanceof CanceledError || err?.kind === 'canceled') return '已取消';
  if (err instanceof StoppedError || err?.kind === 'stopped') return String(err.message || '已提前结束');
  const raw = String(err.message || '');
  const e = err instanceof LlmError ? err : (err.kind ? err : classifyError(err));
  const kind = e.kind || '';
  const status = e.status || 0;
  const drill = !!(e.drill || raw.startsWith('[故障演练]'));
  if (drill) {
    if (kind === 'rate_limit' || status === 429 || /429/.test(raw)) return '[故障演练] 模型繁忙（模拟 429）';
    if (kind === 'timeout') return '[故障演练] 模型响应超时';
    if (kind === 'quota') return '[故障演练] 模型额度不足';
    return '[故障演练] 模型服务暂时不可用';
  }
  if (kind === 'rate_limit' || status === 429) return '模型繁忙（限流），已自动重试/切换';
  if (kind === 'quota' || status === 402) return '模型额度不足';
  if (kind === 'auth' || status === 401 || status === 403) return '模型接口鉴权失败';
  if (kind === 'timeout') return '模型响应超时';
  if (kind === 'truncated') return '模型输出被截断';
  if (kind === 'config') return '模型接口未配置';
  if (kind === 'network') return '无法连接模型服务';
  if (status >= 500 || kind === 'error') return '模型服务暂时不可用';
  return '模型服务暂时不可用';
}

/**
 * Retry-After：delta-seconds（可带小数）或 HTTP-date。
 * 无法解析时返回 null；日期已过时返回 0。
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (header == null) return null;
  const s = String(header).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const sec = Number(s);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.round(sec * 1000);
  }
  // 只接受带月份英文或 ISO 日期的 HTTP-date，避免 Date.parse('-1') 这类误判
  if (!/[A-Za-z]{3}/.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

/**
 * 下一次重试等多久。指数退避 1s→2s→4s（封顶 4s）再加抖动；
 * 可重试的 429/503 若带 Retry-After，取 max(backoff, retryAfter)，总等待封顶 8s。
 * attempt 从 1 起，表示「刚刚失败的是第几次」。只有还会再试一次时才需要调用。
 */
export function computeRetryWait(attempt, { retryAfterMs = null, status = 0, retryable = false, jitter = 0 } = {}) {
  const base = Math.min(4000, 1000 * 2 ** Math.max(0, (attempt | 0) - 1));
  const j = Math.max(0, Math.min(400, jitter | 0));
  const backoff = base + j;
  let wait = backoff;
  if (retryable && (status === 429 || status === 503) && retryAfterMs != null && Number.isFinite(Number(retryAfterMs))) {
    const capped = Math.min(8000, Math.max(0, Number(retryAfterMs)));
    wait = Math.min(8000, Math.max(backoff, capped));
  }
  return { wait, backoff, base };
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
  try { body = (await res.text()).slice(0, 300); } catch {}
  const st = res.status;
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  // 响应体只进服务端日志，不进入 Error.message，避免顺着 SSE / 日志面板漏给用户
  if (body) console.error('llm upstream status', st, body.slice(0, 180));
  const base = { status: st, retryAfterMs };
  if (st === 401 || st === 403) return new LlmError('模型接口鉴权失败', { ...base, kind: 'auth' });
  if (st === 429) return new LlmError('模型繁忙（限流）', { ...base, retryable: true, kind: 'rate_limit' });
  if (st === 402 || /quota|余额|insufficient|credit/i.test(body)) return new LlmError('模型额度不足', { ...base, kind: 'quota' });
  if (st === 503 || st >= 500) return new LlmError('模型服务暂时不可用', { ...base, retryable: true, kind: 'error' });
  return new LlmError('模型请求失败', base);
}

/**
 * 单次流式调用
 * @returns {Promise<{text:string, truncated:boolean}>}
 */
export async function streamChat(env, { model, messages, maxTokens = 4096, temperature = 0.4, deadline, onDelta, checkCancel, stopSignal, idleMs = 35_000, firstTokenMs = 45_000, baseUrl, authToken }) {
  // stopSignal：外部中止（用户取消 / 赛马已决出胜者），为一个只会 reject 的 Promise
  const guard = (p, ms, label) => (stopSignal ? Promise.race([withTimeout(p, ms, label), stopSignal]) : withTimeout(p, ms, label));
  const remain = () => (deadline ? deadline - Date.now() : 120_000);
  if (remain() < 3000) throw new LlmError('时间预算已用尽', { kind: 'timeout' });
  const base = String(baseUrl || env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  const token = authToken || env.ANTHROPIC_AUTH_TOKEN;
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
          const msg = j.error?.message || '';
          console.error('llm stream error', j.error?.type || '', String(msg).slice(0, 180));
          throw classifyError(new Error(String(j.error?.type || 'stream error')));
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
          throw new LlmError('[故障演练] 模拟上游 429', { retryable: true, kind: 'rate_limit', status: 429, drill: true });
        }
        const r = await streamChat(env, { ...opts, model: ch.model, baseUrl: ch.baseUrl, authToken: ch.authToken });
        if (r.truncated && opts.failOnTruncate) throw new LlmError('输出被截断（触达 max_tokens）', { kind: 'truncated' });
        return { ...r, model: ch.model, channel: ci === 0 ? 'primary' : 'backup' };
      } catch (e) {
        if (e instanceof CanceledError || e?.kind === 'stopped') throw e;
        lastErr = classifyError(e);
        const left = opts.deadline ? opts.deadline - Date.now() : 60_000;
        console.error('llm attempt failed', ch.label, attempt, lastErr.kind, lastErr.status || '', lastErr.message);
        log({ level: 'warn', text: `${ch.label} 第 ${attempt} 次调用失败：${friendlyError(lastErr)}` });
        if (lastErr.kind === 'quota' || lastErr.kind === 'auth' || lastErr.kind === 'config') break; // 重试无意义，直接换通道 / 降级
        if (!lastErr.retryable || attempt >= ch.attempts) break;
        const jitter = Math.floor(Math.random() * 400);
        const { wait } = computeRetryWait(attempt, { retryAfterMs: lastErr.retryAfterMs, status: lastErr.status, retryable: lastErr.retryable, jitter });
        // 等待放不进截止时间就放弃本通道，换下一条（不把 Retry-After 睡过预算）
        if (left < wait + 8000) { log({ level: 'warn', text: '剩余时间不足，跳过重试' }); break; }
        const hinted = (lastErr.status === 429 || lastErr.status === 503) && lastErr.retryAfterMs != null;
        log({ level: 'info', text: `${(wait / 1000).toFixed(1)}s 后进行第 ${attempt + 1} 次重试（指数退避 + 抖动${hinted ? '，已参考 Retry-After' : ''}）` });
        await sleep(wait);
      }
    }
  }
  throw lastErr || new LlmError('所有模型通道均不可用');
}
