// ============================================================
// 云同步配置模板
// ------------------------------------------------------------
// 用法：复制这一份，改名成 sync-config.js，再把三项填上。
//   copy sync-config.example.js sync-config.js      （Windows PowerShell）
//
// 三项都填上 = 开启同步；不建这个文件、或清空任意一项 = 纯本地模式。
//
// owner : GitHub 用户名
// repo  : 仓库名，必须设为 Private（私有），否则记录对全网可见
// token : fine-grained token，只给这一个仓库的 Contents 读写权限
//         建议设置尽可能短的有效期，过期后页面会提示「令牌无效或已过期（401）」
//
// 注意：sync-config.js 已被 .gitignore 排除，不要把它提交到任何仓库。
// ============================================================

window.NOTES_SYNC = {
  owner: 'your-github-name',
  repo: 'your-data-repo',
  path: 'records.json',
  token: 'github_pat_xxxxxxxxxxxxxxxxxxxx',
};
