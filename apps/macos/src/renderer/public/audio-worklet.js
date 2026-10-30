// 在音频线程采集 PCM，攒到 2048 样本(128ms@16kHz)再发给主线程，降低消息频率。
// 作为静态资源原样加载（addModule('audio-worklet.js')），不经过打包。
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return;
      this.stopped = true;
      if (this.offset) {
        this.port.postMessage(this.buffer.slice(0, this.offset));
        this.offset = 0;
      }
      this.port.postMessage({ type: 'flushed', id: event.data.id });
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }
    let read = 0;
    while (read < channel.length) {
      const n = Math.min(channel.length - read, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(read, read + n), this.offset);
      this.offset += n;
      read += n;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
