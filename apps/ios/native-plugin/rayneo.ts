import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface RayNeoStatus {
  state: string;
  connected: boolean;
  writable: boolean;
  authenticated: false;
  id: string;
  devices: { id: string; name: string }[];
}
export interface RayNeoPlugin {
  scan(options: { timeoutMs?: number }): Promise<RayNeoStatus>;
  connect(options: { id: string }): Promise<RayNeoStatus>;
  disconnect(): Promise<RayNeoStatus>;
  getStatus(): Promise<RayNeoStatus>;
  getLog(): Promise<{ entries: string[] }>;
  sendText(options: { text: string; final: boolean; experimental: boolean; businessId: number }): Promise<{
    submitted: boolean; displayVerified: false;
  }>;
  addListener(event: 'rayneoStatus', listener: (status: RayNeoStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'rayneoLog', listener: (log: { message: string }) => void): Promise<PluginListenerHandle>;
}
export const RayNeo = registerPlugin<RayNeoPlugin>('RayNeo');
