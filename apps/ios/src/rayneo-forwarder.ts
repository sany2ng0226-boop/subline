import { RayNeo } from '../native-plugin/rayneo';

function flag(key: string): boolean {
  return localStorage.getItem(`subline.rayneo.${key}`) === 'true';
}
function configuration(): number | undefined {
  const raw = localStorage.getItem('subline.rayneo.businessId');
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 && id <= 255 ? id : undefined;
}
let lastPartialAt = -Infinity;

export async function forwardRayNeoText(text: string, final: boolean): Promise<void> {
  try {
    if (!flag('enabled')) return;
    const now = performance.now();
    if (!final && now - lastPartialAt < 250) return;
    // Rate-limit attempted partials too, including dry-run logging.
    if (!final) lastPartialAt = now;
    const businessId = configuration();
    if (!flag('experimental') || businessId === undefined) {
      console.debug('[RayNeo] dry run: experimental flag and caller businessId required', { final, bytes: new TextEncoder().encode(text).length });
      return;
    }
    const status = await RayNeo.getStatus();
    // Read gates again after the asynchronous boundary so disabling takes effect immediately.
    if (!status.connected || !flag('enabled') || !flag('experimental') || configuration() !== businessId) {
      console.debug('[RayNeo] disconnected or forwarding disabled');
      return;
    }
    await RayNeo.sendText({ text, final, experimental: true, businessId });
  } catch (error) { console.debug('[RayNeo] forwarding refused/failed', error); }
}

export const rayneoDebug = {
  scan: (timeoutMs = 15000) => RayNeo.scan({ timeoutMs }),
  connect: (id: string) => RayNeo.connect({ id }),
  status: () => RayNeo.getStatus(),
  log: () => RayNeo.getLog(),
  async sendTest(text: string) {
    const businessId = configuration();
    if (!flag('experimental') || businessId === undefined) throw new Error('Set experimental=true and a verified businessId first');
    return RayNeo.sendText({ text, final: true, experimental: true, businessId });
  },
};
declare global { interface Window { __rayneo: typeof rayneoDebug } }
if (typeof window !== 'undefined') window.__rayneo = rayneoDebug;
