import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Only archive/attachment identifiers cross the protocol boundary; paths stay in the host. */
export async function archiveAudioResponse(
  request: Request,
  resolvePath: (archiveId: string, recordingId: string) => string | null | Promise<string | null>,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const match = /^subline-audio:\/\/archive\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(request.url);
  if (!match) return new Response(null, { status: 404 });

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await resolvePath(match[1]!, match[2]!);
    if (!path) return new Response(null, { status: 404 });
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
      await file.close();
      return new Response(null, { status: 404 });
    }
    const size = stat.size;
    const headers = new Headers({
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // Range applies to GET; HEAD reports the complete representation without opening a stream.
    if (request.method === 'HEAD' || size === 0 && !request.headers.has('range')) {
      await file.close();
      return new Response(null, { status: 200, headers });
    }
    let start = 0;
    let end = size - 1;
    const range = request.headers.get('range');
    if (range !== null) {
      const bounds = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let valid = !!bounds && !!(bounds[1] || bounds[2]) && size > 0;
      if (bounds && valid) {
        if (!bounds[1]) {
          const suffix = Number(bounds[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        } else {
          start = Number(bounds[1]);
          end = bounds[2] ? Number(bounds[2]) : size - 1;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start;
          end = Math.min(end, size - 1);
        }
      }
      if (!valid) {
        await file.close();
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));
    }
    const stream = file.createReadStream({ start, end, autoClose: true, signal: request.signal, highWaterMark: 64 * 1024 });
    // Bound the Web stream queue in bytes rather than counting whole PCM chunks.
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
    const response = new Response(body, {
      status: range === null ? 200 : 206,
      headers,
    });
    file = undefined; // The stream now owns the open handle, including cancellation and read errors.
    return response;
  } catch {
    await file?.close().catch(() => {});
    return new Response(null, { status: 404 });
  }
}
