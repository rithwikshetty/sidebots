// Serves the film with byte ranges. Safari plays a video only from a server that
// answers a Range request with 206 and the bytes asked for, and static assets
// always answer with the whole file.
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 200) return response;
    const headers = new Headers(response.headers);
    headers.set("Accept-Ranges", "bytes");
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    if (!range) return new Response(response.body, { headers });

    const body = await response.arrayBuffer();
    const size = body.byteLength;
    const [, from, to] = range;
    const start = from === "" ? Math.max(size - Number(to), 0) : Number(from);
    const end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1);
    if (from === "" && to === "" || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};
