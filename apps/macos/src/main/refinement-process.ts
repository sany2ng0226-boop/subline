import { runOfflineRefinement, type RefinementJob, type RefinementWorkerMessage } from './offline-refinement';

const parentPort = process.parentPort;

function post(message: RefinementWorkerMessage): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

async function run(job: RefinementJob): Promise<void> {
  try {
    const revision = await runOfflineRefinement(job, progress => post({ type: 'progress', progress }));
    post({ type: 'result', revision });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) {
  let started = false;
  parentPort.on('message', (event: { data: RefinementJob }) => {
    if (started) return;
    started = true;
    void run(event.data);
  });
} else {
  process.once('message', (job: RefinementJob) => { void run(job); });
}
