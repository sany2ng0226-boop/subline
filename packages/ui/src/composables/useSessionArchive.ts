import { watch } from 'vue';
import { suggestArchiveTitle } from '@rt/core';
import { i18n } from '../i18n';
import { bridge } from '../bridge';
import { fmtDateTime } from '../utils/datetime';
import { archiveErrorKey } from '../utils/archiveError';
import {
  lines,
  recording,
  recordBusy,
  errorText,
  archiveSnapshot,
  clearTranscript,
  ensureStopped,
  hasUnsavedContent,
  lastArchivedAt,
  canUndoDelete,
  undoDelete,
} from './useTranscription';
import { persistRecoveryNow } from './useRecovery';

declare const __INTERNAL_BUILD__: boolean;
const internalBuild = typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__;

/** 归档文件夹仅内部版提供（且需宿主实现归档库） */
export function foldersEnabled(): boolean {
  return internalBuild && !!bridge().getArchiveLibrary;
}

export function defaultArchiveName(): string {
  return fmtDateTime(Date.now());
}

/** 生成不与现有归档重名的默认名 */
export async function suggestArchiveName(): Promise<string> {
  let name = foldersEnabled() ? suggestArchiveTitle(archiveSnapshot(), defaultArchiveName()) : defaultArchiveName();
  try {
    const names = new Set((await bridge().listArchives()).map((a) => a.name));
    if (names.has(name)) {
      let i = 2;
      while (names.has(`${name} (${i})`)) i += 1;
      name = `${name} (${i})`;
    }
  } catch {
    /* 取不到列表就用默认名 */
  }
  return name;
}

/** 保存当前主页内容为归档，成功后清空主页 */
export async function archiveSession(name: string, folderId?: string | null): Promise<void> {
  await bridge().saveArchive(name.trim() || defaultArchiveName(), archiveSnapshot(), foldersEnabled() ? folderId : undefined);
  clearTranscript();
  lastArchivedAt.value = Date.now();
  // 归档后立即清掉崩溃暂存（关窗前归档后宿主马上退出，等不到下一次写入）
  persistRecoveryNow();
}

// 关闭确认框里选「归档并退出」：先停录（等最后一句定稿），再按默认名归档到上次使用的文件夹。
async function archiveBeforeClose(): Promise<boolean> {
  try {
    await ensureStopped();
    // 撤销期内选「归档并退出」：把刚清空的内容找回来再归档，而不是让它随退出消失
    if (!lines.length && canUndoDelete.value) undoDelete();
    if (!lines.length) return true;
    const folderId = foldersEnabled() ? (await bridge().getArchiveLibrary!()).lastFolderId : undefined;
    await archiveSession(await suggestArchiveName(), folderId);
    return true;
  } catch (error) {
    errorText.value = i18n.global.t(archiveErrorKey(error, 'archive.operationFailed'));
    console.error('[archive:before-close]', error);
    return false;
  }
}

/**
 * 关闭保护：有未归档内容、或清空后仍在撤销期时，让宿主在关窗 / 退出 / 离开页面前确认。
 * 由 mountApp 注册一次。
 */
export function registerCloseGuard(): void {
  const { t, locale } = i18n.global;
  watch(
    () => [hasUnsavedContent.value, recording.value || recordBusy.value, canUndoDelete.value, locale.value] as const,
    ([unsaved, live, undoable]) => {
      const detail = live ? 'main.closeDetailRecording' : unsaved ? 'main.closeDetail' : 'main.closeUndoable';
      bridge().setCloseGuard?.(unsaved || undoable ? {
        message: t('main.closeMessage'),
        detail: t(detail),
        archive: t('main.closeArchive'),
        discard: t('main.closeDiscard'),
        cancel: t('main.closeCancel'),
      } : null);
    },
    { immediate: true },
  );
  bridge().onArchiveBeforeClose?.(archiveBeforeClose);
}
