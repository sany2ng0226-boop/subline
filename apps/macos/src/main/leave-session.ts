export async function resolveLeaveSession(
  response: number,
  archive: () => Promise<boolean>,
  clearRecovery: () => Promise<void>,
): Promise<boolean> {
  if (response === 2) return false;
  if (response !== 1 && !await archive()) return false;
  await clearRecovery();
  return true;
}
