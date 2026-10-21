// 应用设置的本地持久化：存到 electron userData/settings.json。
// 纯逻辑（默认值生成 / 字段补齐 / 旧版本兼容）已下沉到 @rt/core，这里只做 macOS 的同步读写。
// API Key 落盘时经 safeStorage 加密为 apiKeyEnc（密钥由系统钥匙串管理，明文不落盘）；
// 内存中的 AppSettings 保持明文，供翻译请求与设置页显示/编辑使用。
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { makeDefaults, withDefaults, mergeSettings, type SettingsPatch } from '@rt/core';
import type { AppSettings } from '../shared/types';

/** 按系统偏好语言生成默认设置（电子环境下读取系统语言） */
function defaults(): AppSettings {
  // 优先用系统偏好语言（getLocale 返回的是 Chromium/应用语言，开发环境常为 en-US）。
  const settings = makeDefaults([
    ...(app.getPreferredSystemLanguages?.() ?? []),
    app.getSystemLocale?.() ?? '',
    app.getLocale(),
  ]);
  settings.translation = { ...settings.translation, enabled: false, engine: 'hy-mt2-7b' };
  return settings;
}

let cached: AppSettings | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 反序列化层解密：磁盘上的 apiKeyEnc（base64 密文）解密后注入 apiKey，再交给
 * withDefaults（它只认识 AppSettings 的已知字段，密文字段在这一层摘出）。
 * 旧版明文 apiKey 的文件不含 apiKeyEnc，原样读出即可，下次保存自动转加密。
 */
function decryptApiKey(raw: unknown): unknown {
  const cloud = ((raw as Record<string, unknown> | null)?.translation as
    | Record<string, unknown>
    | undefined)?.cloud as Record<string, unknown> | undefined;
  const enc = cloud?.apiKeyEnc;
  if (cloud && typeof enc === 'string' && enc) {
    try {
      cloud.apiKey = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch (err) {
      // 解密失败（如钥匙串条目丢失）：按未配置处理，用户需在设置里重填
      console.error('API Key 解密失败:', (err as Error).message);
      cloud.apiKey = '';
    }
  }
  return raw;
}

/** 生成落盘对象：可用 safeStorage 时 apiKey 以密文（apiKeyEnc）持久化，明文置空 */
function persistable(s: AppSettings): unknown {
  const key = s.translation.cloud.apiKey;
  if (!key || !safeStorage.isEncryptionAvailable()) {
    // 无 key 或系统加密不可用（无钥匙串环境）：保持明文落盘，保证功能可用
    return s;
  }
  return {
    ...s,
    translation: {
      ...s.translation,
      cloud: {
        ...s.translation.cloud,
        apiKey: '',
        apiKeyEnc: safeStorage.encryptString(key).toString('base64'),
      },
    },
  };
}

export function loadSettings(): AppSettings {
  if (cached) {
    return cached;
  }
  try {
    cached = withDefaults(
      decryptApiKey(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))),
      defaults()
    );
  } catch {
    cached = defaults();
  }
  return cached;
}

export function saveSettings(next: SettingsPatch): AppSettings {
  cached = mergeSettings(loadSettings(), next);
  try {
    // 先写 .tmp 再原子 rename：进程中途退出不会留下半截 JSON 损坏设置
    const file = settingsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persistable(cached), null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('保存设置失败:', (err as Error).message);
  }
  return cached;
}
