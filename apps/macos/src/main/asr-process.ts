// ASR 识别子进程（Electron utilityProcess，完整 Node）。
// VAD + SenseVoice 推理都在这里跑，主进程因此永不被识别阻塞；
// 独立进程也隔离了原生崩溃（挂了主进程仍在，可报错重启）。
import { TranscriptionPipeline } from './pipeline';
import { AppleSpeechClient, assertAppleSpeechSupported } from './apple-speech-client';
import type { AsrToMain, MainToAsr } from '../shared/types';

// utilityProcess 子进程通过 process.parentPort 与主进程通信（Electron 提供）
const parentPort = process.parentPort;

let pipeline: TranscriptionPipeline | null = null;
let apple: AppleSpeechClient | null = null;

const dispose = () => apple?.dispose();
process.on('exit', dispose);
process.on('SIGTERM', () => { dispose(); process.exit(0); });

function post(msg: AsrToMain): void {
  parentPort.postMessage(msg);
}

parentPort.on('message', (e: { data: MainToAsr }) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        if (msg.modelId === 'apple-speech') {
          assertAppleSpeechSupported();
          if (!msg.appleHelperPath) throw new Error('Apple 语音识别服务未随应用安装');
          apple = new AppleSpeechClient(msg.appleHelperPath, msg.language, (event) => {
            post(event);
            if (event.type === 'error') setImmediate(() => process.exit(1));
          });
          void apple.ready.then(() => post({ type: 'ready' })).catch(() => {
            // The client already reported the error; an exit lets the next start rebuild the worker.
            setImmediate(() => process.exit(1));
          });
          break;
        }
        // 构造里会加载模型并预热（冷启动开销发生在这里，主进程不受影响）
        pipeline = new TranscriptionPipeline(msg.modelsDir, msg.modelId, msg.language, {
          onSegment: (payload) => post({ type: 'segment', payload }),
          onPartial: (payload) => post({ type: 'partial', payload }),
        });
        post({ type: 'ready' });
        break;
      case 'audio':
        if (apple) apple.acceptWaveform(msg.samples);
        else pipeline?.acceptWaveform(msg.samples);
        break;
      case 'flush':
        if (apple) {
          void apple.flush(msg.requestId).then(() => post({ type: 'flushed', requestId: msg.requestId }))
            .catch((error: Error) => post({ type: 'error', message: error.message }));
          break;
        }
        pipeline?.flush();
        post({ type: 'flushed', requestId: msg.requestId });
        break;
      case 'reset':
        if (apple) apple.reset();
        else pipeline?.reset();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
});
