/** OpenAI SSE transport: partial text is provisional until the explicit completion marker. */
export async function readTranslationStream(response: Response, onPartial: (text: string) => void): Promise<string> {
  if (!response.body) throw new Error('翻译流没有响应内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', completed = false, finishReason: string | null = null;
  let lastPublished = -Infinity;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || completed) return;
    if (data === '[DONE]') { completed = true; return; }
    const chunk = JSON.parse(data) as { error?: { message?: string }; choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }> };
    if (chunk.error) throw new Error(chunk.error.message ?? '翻译流返回错误');
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const addition = choice?.delta?.content;
    if (addition != null && typeof addition !== 'string') throw new Error('翻译流内容格式无效');
    if (addition) {
      text += addition;
      const now = performance.now();
      // Send the first readable text immediately; batch subsequent updates to avoid per-token UI churn.
      if (text.trim() && now - lastPublished >= 80) { onPartial(text.trim()); lastPublished = now; }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
      }
      if (done) { if (buffer.trim()) consume(buffer.replace(/\r$/, '')); break; }
    }
    if (!completed) throw new Error('翻译流提前结束，未收到完成标记');
    if (finishReason !== 'stop') throw new Error(`翻译未完整生成 (${finishReason})`);
    if (!text.trim()) throw new Error('翻译端点返回空译文');
    return text.trim();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
