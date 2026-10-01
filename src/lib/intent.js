// 新需求 / 增量修改 的规则分类。纯函数，不访问模型。
// 关键词重叠用中文二元组（与 qa.js featureCovered 同一套切分），重叠推向「修改」。

const NEW_VERB = /做一个|做个|帮我做|生成一个|生成一款|创建一个|创建一款|写一个|写一款|开发一个|开发一款|来个|来一个|新建|再做一个|再做个|再来一个|另做|另起|换成一个全新的|做一款|新做一个|另外做|另外做一个/;
const NEW_NOUN = /应用|工具|网站|网页|页面|游戏|系统|app|小程序|计算器|看板|软件/;
const FRESH = /再做|另做|全新|新建|另起|另外做/;
const EDIT_RES = [
  /改成|修改|调整|改为/,
  /加一个|加个|增加|添加|加上|新增/,
  /删除|去掉|移除|删掉/,
  /修复|修一下/,
  /颜色|字体|按钮|布局|字号|主题|背景|圆角|主色|配色/,
  /这个|当前|上面|现有|原来的/,
  /^把/,
];
// 太泛、几乎每个需求都会撞上的二元组，不参与重叠判断
const STOP = new Set(['一个', '一下', '这个', '那个', '我们', '可以', '应用', '工具', '网站', '页面', '功能', '需要', '帮我', '做一', '生成', '创建', '当前', '增加', '添加', '修改', '使用', '以及', '什么', '怎么', '一下']);

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

function gramsOf(text) {
  const grams = new Set();
  const f = String(text || '').toLowerCase();
  for (const seg of f.split(/[^\u4e00-\u9fa5a-z0-9]+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(seg)) { if (seg.length >= 3 && seg.length <= 24) grams.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) grams.add(seg.slice(i, i + 2));
  }
  for (const s of STOP) grams.delete(s);
  return grams;
}

// needle 的二元组有多少出现在 hay 里（0..1）
function cover(needle, hay) {
  if (!needle.size) return 0;
  const h = String(hay || '').toLowerCase();
  let hit = 0;
  for (const g of needle) if (h.includes(g)) hit++;
  return hit / needle.size;
}

function contextParts(ctx) {
  const c = ctx || {};
  const plan = c.plan && typeof c.plan === 'object' ? c.plan : {};
  const features = Array.isArray(plan.features) ? plan.features : (Array.isArray(c.plan) ? c.plan : []);
  const titles = [c.title, plan.title].filter((s) => s && String(s).trim().length >= 2);
  const corpus = [c.title, c.prompt, plan.title, plan.summary, typeof c.plan === 'string' ? c.plan : '', ...features].filter(Boolean).join('\n');
  return { titles, features, corpus };
}

// 某一短语的二元组命中率 ≥ 50% 即视为被提到（与 qa.js featureCovered 同阈值）
function phraseHit(phrase, hay) {
  const g = gramsOf(phrase);
  if (!g.size) return false;
  return cover(g, hay) >= 0.5;
}

/**
 * @returns {{ intent: 'new'|'edit'|'unsure', confidence: number, reason: string }}
 */
export function classifyIntent(text, ctx = {}) {
  const raw = String(text || '').trim();
  const t = raw.replace(/\s+/g, '');
  if (!t) return { intent: 'unsure', confidence: 0, reason: '空输入' };

  const reasons = [];
  const forEdit = t.replace(/换成一个全新的/g, '');
  const hasNewVerb = NEW_VERB.test(t);
  const hasNewNoun = NEW_NOUN.test(t.toLowerCase());
  let newScore = 0;
  let editScore = 0;

  if (hasNewVerb && hasNewNoun) { newScore += 0.72; reasons.push('新应用措辞'); }
  else if (hasNewVerb) { newScore += 0.38; reasons.push('有新建动词'); }
  if (FRESH.test(t)) { newScore += 0.12; reasons.push('明确要另起'); }

  let editHits = 0;
  for (const re of EDIT_RES) if (re.test(forEdit)) editHits++;
  if (/换成/.test(forEdit) && !/换成一个全新/.test(t)) editHits++;
  if (editHits) {
    editScore += Math.min(0.8, 0.34 + (editHits - 1) * 0.16);
    reasons.push('修改类表述');
  }
  // 短句又没有「做一个全新应用」的动词，多半是在改当前页
  if (t.length <= 20 && !hasNewVerb) { editScore += 0.25; reasons.push('短请求'); }
  if (t.length <= 12 && editHits) editScore += 0.12;

  const { titles, features, corpus } = contextParts(ctx);
  const titleHit = titles.some((p) => phraseHit(p, t));
  const featureHit = features.some((p) => phraseHit(p, t));
  const topic = t.replace(NEW_VERB, ' ').replace(NEW_NOUN, ' ').replace(/把|改成|修改|调整|增加|添加|删除|去掉|修复|这个|当前/g, ' ');
  const reqCover = cover(gramsOf(topic), corpus);
  if (titleHit) {
    editScore += 0.48;
    newScore -= 0.28;
    reasons.push('提到了当前应用');
  } else if (featureHit || (reqCover >= 0.5 && gramsOf(topic).size >= 2)) {
    editScore += 0.32;
    newScore -= 0.18;
    reasons.push('关键词与当前项目重叠');
  } else if (reqCover >= 0.34 && gramsOf(topic).size >= 2) {
    editScore += 0.14;
    newScore -= 0.08;
  }
  if (hasNewVerb && hasNewNoun && !titleHit && !featureHit && reqCover < 0.4) {
    newScore += 0.18;
    reasons.push('主题与当前项目不重叠');
  }

  newScore = clamp01(newScore);
  editScore = clamp01(editScore);

  let intent;
  let confidence;
  if (newScore >= 0.6 && editScore >= 0.52) {
    intent = 'unsure';
    confidence = Math.min(newScore, editScore);
    reasons.push('新旧信号混合');
  } else if (newScore >= 0.6 && newScore >= editScore + 0.12) {
    intent = 'new';
    confidence = Math.min(0.96, newScore);
  } else if (editScore >= 0.4 && editScore >= newScore) {
    intent = 'edit';
    confidence = Math.min(0.96, Math.max(editScore, 0.55));
  } else if (newScore > editScore + 0.05 && newScore >= 0.45) {
    intent = newScore >= 0.75 ? 'new' : 'unsure';
    confidence = newScore;
    if (intent === 'unsure') reasons.push('信号不足');
  } else if (editScore > newScore && editScore >= 0.35) {
    intent = 'edit';
    confidence = editScore;
  } else {
    intent = 'unsure';
    confidence = Math.max(newScore, editScore, 0.3);
    reasons.push('信号不足');
  }
  return { intent, confidence: round2(confidence), reason: reasons.join('，') || '规则判断' };
}
