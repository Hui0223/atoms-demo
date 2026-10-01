// 仅在 Workers 打包时使用（wrangler 将 .html 作为文本模块导入）
import kanban from './kanban.html';
import mortgage from './mortgage.html';
import profile from './profile.html';
import pomodoro from './pomodoro.html';
import generic from './generic.html';
export default { kanban, mortgage, profile, pomodoro, generic };
