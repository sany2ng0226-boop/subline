// 主窗口只显示应用自己的页面：页内跳转到别处一律拦下，外部网页交给系统浏览器打开。
// 字幕与译文来自识别结果和用户配置的翻译服务，不应有能力把窗口带到任意地址。

/** 目标地址是否仍是应用页面本身（同一文档，仅 hash/查询不同；开发时为同源的开发服务器）。 */
export function isAppNavigation(target: string, appUrl: string): boolean {
  let next: URL;
  let app: URL;
  try { next = new URL(target); app = new URL(appUrl); } catch { return false; }
  if (next.protocol !== app.protocol) return false;
  if (app.protocol === 'file:') return next.pathname === app.pathname;
  return next.origin === app.origin;
}

/** 可以交给系统浏览器的外部地址：只放行 http(s)。 */
export function isExternalWebUrl(target: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(target).protocol); } catch { return false; }
}
