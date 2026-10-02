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

/** 主模型 + 另一模型作备用通道。备用通道仅当两个备用 Secret 都配置时才改用它们，否则与主通道同一套地址和密钥。 */
export function channelsFor(env, id, { attempts = 3, backupAttempts = 2 } = {}) {
  const list = catalog(env);
  const main = list.find((m) => m.id === id) || list[0];
  const other = list.find((m) => m.id !== main.id);
  const backupBase = String(env?.ANTHROPIC_BACKUP_BASE_URL || '').trim();
  const backupToken = String(env?.ANTHROPIC_BACKUP_AUTH_TOKEN || '').trim();
  const backup = backupBase && backupToken ? { baseUrl: backupBase, authToken: backupToken } : {};
  return [
    { model: main.model, label: `主模型 ${short(main.model)}`, attempts },
    { model: other.model, label: `备用模型 ${short(other.model)}`, attempts: backupAttempts, ...backup },
  ];
}

/** 赛马第 i 路使用的模型：混合模式下两个模型交替 */
export function laneModelId(choice, i) {
  if (choice === 'mixed') return i % 2 === 0 ? 'deepseek' : 'glm';
  return choice;
}
