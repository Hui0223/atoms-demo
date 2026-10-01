// atoms-ui：生成应用时自动注入的基础样式库（设计系统）
// 目的：①模型无需输出大段 CSS → 输出更短、更快、更不易截断；②不同模型产出的视觉质量下限一致。
// 模型自己的 <style> 位于其后，可覆盖这里的任何规则。
export const ATOMS_UI_CLASSES = 'app(页面容器) header(顶部区) h-title/h-sub(标题/副标题) card(卡片) grid-2/grid-3/grid-auto(网格) row(横向排列) col(纵向排列) spacer(撑开) btn btn-primary btn-ghost btn-danger btn-sm(按钮) input/select/textarea(表单控件，直接写标签即可) badge badge-primary/badge-success/badge-warn/badge-danger(标签) list/item(列表与列表项) muted(次要文字) empty(空状态) stat/stat-value/stat-label(统计数字) toolbar(工具栏) tabs/tab/tab.active(标签页) modal-mask/modal(弹窗) progress/progress>i(进度条) fade-in(入场动画)';

export const ATOMS_UI_CSS = `:root{--primary:#6366f1;--bg:#f6f7fb;--card:#ffffff;--text:#1f2333;--muted:#6b7085;--border:#e6e8f0;--success:#16a34a;--warn:#d97706;--danger:#dc2626;--radius:14px;--shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px rgba(16,24,40,.06)}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;background:var(--bg);color:var(--text);line-height:1.55;font-size:15px}
.app{max-width:1080px;margin:0 auto;padding:28px 20px 48px}
.header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}.h-title{font-size:26px;font-weight:700;margin:0;letter-spacing:-.3px}.h-sub{color:var(--muted);margin:4px 0 0;font-size:14px}
h1,h2,h3{line-height:1.3}h2{font-size:18px;margin:0 0 12px}h3{font-size:16px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.grid-2,.grid-3,.grid-auto{display:grid;gap:16px}.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-auto{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.col{display:flex;flex-direction:column;gap:10px}.spacer{flex:1}
.btn{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:hover{border-color:var(--primary);color:var(--primary)}.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}.btn-primary:hover{filter:brightness(1.08);color:#fff}
.btn-ghost{background:transparent;border-color:transparent}.btn-danger{color:var(--danger)}.btn-danger:hover{border-color:var(--danger);color:var(--danger)}.btn-sm{padding:5px 10px;font-size:13px;border-radius:8px}
input,select,textarea{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 12px;outline:none;transition:border-color .15s,box-shadow .15s;max-width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 18%,transparent)}
input[type=checkbox],input[type=radio]{width:auto;accent-color:var(--primary)}
.badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:12px;background:color-mix(in srgb,var(--muted) 14%,transparent);color:var(--muted)}
.badge-primary{background:color-mix(in srgb,var(--primary) 14%,transparent);color:var(--primary)}.badge-success{background:#e8f7ee;color:var(--success)}.badge-warn{background:#fff4e0;color:var(--warn)}.badge-danger{background:#fdecec;color:var(--danger)}
.list{display:flex;flex-direction:column;gap:8px;padding:0;margin:0;list-style:none}.item{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--card);border:1px solid var(--border);border-radius:12px;transition:box-shadow .15s,transform .15s}.item:hover{box-shadow:var(--shadow)}
.muted{color:var(--muted)}.empty{text-align:center;color:var(--muted);padding:32px 12px;border:1px dashed var(--border);border-radius:12px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}.stat-value{font-size:24px;font-weight:700;color:var(--primary)}.stat-label{font-size:13px;color:var(--muted)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.tabs{display:inline-flex;background:color-mix(in srgb,var(--muted) 10%,transparent);padding:3px;border-radius:10px;gap:2px}.tab{border:none;background:none;padding:6px 14px;border-radius:8px;cursor:pointer;font:inherit;color:var(--muted)}.tab.active{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.modal-mask{position:fixed;inset:0;background:rgba(15,18,30,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}.modal{background:var(--card);border-radius:16px;padding:20px;width:min(440px,100%);box-shadow:0 20px 60px rgba(0,0,0,.25)}
.progress{height:8px;background:color-mix(in srgb,var(--muted) 15%,transparent);border-radius:99px;overflow:hidden}.progress>i{display:block;height:100%;background:var(--primary);border-radius:99px;transition:width .3s}
.fade-in{animation:atomsFade .25s ease}@keyframes atomsFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(max-width:720px){.grid-2,.grid-3{grid-template-columns:1fr}.app{padding:18px 14px 36px}.h-title{font-size:22px}}`;

export function injectDesignSystem(html) {
  if (!html || html.includes('data-atoms-ui')) return html;
  const tag = `<style data-atoms-ui>${ATOMS_UI_CSS}</style>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) {
    // 放在 <head> 开头：模型自己的 <style> 在其后，优先级更高
    return html.replace(m[0], m[0] + '\n' + tag);
  }
  return html.replace(/<html[^>]*>/i, (h) => h + '<head>' + tag + '</head>');
}

// 迭代修改时先剥离基础样式库再交给模型（减少上下文、避免模型误改基础库），落库前再注入
export function stripDesignSystem(html) {
  return String(html || '').replace(/\n?<style data-atoms-ui>[\s\S]*?<\/style>/, '');
}
