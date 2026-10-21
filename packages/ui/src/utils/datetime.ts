// 渲染层共用的日期/时间格式化

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch 毫秒 -> HH:MM:SS（对话行的时间戳） */
export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** epoch 毫秒 -> HH:MM（顶栏归档时刻） */
export function fmtHourMinute(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** epoch 毫秒 -> YYYY-MM-DD HH:MM（归档名/列表日期） */
export function fmtDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
