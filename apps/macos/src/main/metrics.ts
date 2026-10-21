import { MetricsAggregator, type PipelineMetrics } from '@rt/core';

interface MetricsDependencies {
  settings(): { enabled: boolean; engine: string; cloud: { baseURL: string } };
  online(): boolean;
  publish(metrics: PipelineMetrics): void;
  fetch: typeof fetch;
}

/** Session-scoped sampling and probes; no credentials from translation settings enter HEAD requests. */
export function createMetricsController(deps: MetricsDependencies) {
  const aggregator = new MetricsAggregator();
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let endpoint: string | undefined;
  let nextProbe = 0;
  let probe: AbortController | undefined;
  let cloudRttMs: number | undefined;
  let degraded = false;
  const stop = () => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    probe?.abort();
    probe = undefined;
  };
  const tick = () => {
    const settings = deps.settings();
    const cloud = settings.enabled && settings.engine === 'cloud';
    const activeEndpoint = cloud ? settings.cloud.baseURL : undefined;
    if (endpoint !== activeEndpoint) {
      generation++;
      probe?.abort();
      probe = undefined;
      endpoint = activeEndpoint;
      nextProbe = 0;
      degraded = false;
      cloudRttMs = undefined;
    }
    const online = deps.online();
    if (cloud && online && !probe && Date.now() >= nextProbe) {
      nextProbe = Date.now() + 15_000;
      const current = generation;
      const controller = new AbortController();
      probe = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const started = Date.now();
      void (async () => {
        try {
          const url = new URL(endpoint!);
          // Embedded URL credentials and query parameters can contain user secrets.
          url.username = ''; url.password = ''; url.search = ''; url.hash = '';
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported endpoint');
          const response = await deps.fetch(url, {
            method: 'HEAD', signal: controller.signal, credentials: 'omit', redirect: 'error',
          });
          if (!response.ok) throw new Error(`HEAD ${response.status}`);
          if (generation === current) {
            cloudRttMs = Date.now() - started;
            degraded = false;
          }
        } catch {
          if (generation === current) { degraded = true; cloudRttMs = undefined; }
        } finally {
          clearTimeout(timeout);
          if (probe === controller) probe = undefined;
        }
      })();
    }
    deps.publish({ ...aggregator.snapshot(), engine: cloud ? 'cloud' : 'local',
      network: !online ? 'offline' : cloud && degraded ? 'degraded' : 'online',
      ...(cloud && cloudRttMs !== undefined ? { cloudRttMs } : {}),
    });
  };
  return {
    aggregator,
    start() {
      stop();
      aggregator.reset(); endpoint = undefined; nextProbe = 0; degraded = false; cloudRttMs = undefined;
      timer = setInterval(tick, 1_000);
    },
    stop,
  };
}
