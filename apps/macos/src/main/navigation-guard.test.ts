import { describe, expect, it } from 'vitest';
import { isAppNavigation, isExternalWebUrl } from './navigation-guard';

describe('isAppNavigation', () => {
  const packaged = 'file:///Applications/Subline.app/Contents/Resources/app.asar/out/renderer/index.html';
  it('打包版只允许停留在自己的页面', () => {
    expect(isAppNavigation(`${packaged}#/archive`, packaged)).toBe(true);
    expect(isAppNavigation('file:///etc/passwd', packaged)).toBe(false);
    expect(isAppNavigation('https://example.com/', packaged)).toBe(false);
    expect(isAppNavigation('javascript:alert(1)', packaged)).toBe(false);
  });
  it('开发时允许同源的开发服务器，拒绝其他来源', () => {
    expect(isAppNavigation('http://localhost:5173/src/main.ts', 'http://localhost:5173/')).toBe(true);
    expect(isAppNavigation('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
    expect(isAppNavigation('http://evil.test/', 'http://localhost:5173/')).toBe(false);
  });
  it('无法解析的地址一律拒绝', () => {
    expect(isAppNavigation('not a url', packaged)).toBe(false);
    expect(isAppNavigation(packaged, '')).toBe(false);
  });
});

describe('isExternalWebUrl', () => {
  it('只放行 http 与 https', () => {
    expect(isExternalWebUrl('https://github.com/sany2ng0226-boop/subline')).toBe(true);
    expect(isExternalWebUrl('http://example.com')).toBe(true);
    expect(isExternalWebUrl('file:///etc/passwd')).toBe(false);
    expect(isExternalWebUrl('x-apple.systempreferences:')).toBe(false);
    expect(isExternalWebUrl('')).toBe(false);
  });
});
