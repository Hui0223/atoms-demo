// 模型白名单：前端只能在这两个之间选择；确切模型名可通过 wrangler.toml [vars] 覆盖
export function catalog(env) {
  return [
    { id: 'deepseek', model: env.MODEL_DEEPSEEK || 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'glm', model: env.MODEL_GLM || 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
  ];
}

export const CHOICES = ['deepseek', 'glm', 'mixed'];
export const resolveChoice = (c) => (CHOICES.includes(c) ? c : 'deepseek');

const short = (m) => String(m || '').split('/').pop();

/** 主模型 + 另一模型作备用通道 */
export function channelsFor(env, id, { attempts = 3, backupAttempts = 2 } = {}) {
  const list = catalog(env);
  const main = list.find((m) => m.id === id) || list[0];
  const other = list.find((m) => m.id !== main.id);
  return [
    { model: main.model, label: `主模型 ${short(main.model)}`, attempts },
    { model: other.model, label: `备用模型 ${short(other.model)}`, attempts: backupAttempts },
  ];
}

/** 赛马第 i 路使用的模型：混合模式下两个模型交替 */
export function laneModelId(choice, i) {
  if (choice === 'mixed') return i % 2 === 0 ? 'deepseek' : 'glm';
  return choice;
}
