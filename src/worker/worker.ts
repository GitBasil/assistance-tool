// Off-main-thread gzip for upload batches.
const g = self as any;
g.onmessage = async (e: MessageEvent<{ id: number; s: string }>) => {
  const { id, s } = e.data;
  try {
    const cs = new g.CompressionStream('gzip');
    const b = await new Response(new Blob([s]).stream().pipeThrough(cs)).arrayBuffer();
    g.postMessage({ id, b }, [b]);
  } catch {
    g.postMessage({ id, b: null });
  }
};
