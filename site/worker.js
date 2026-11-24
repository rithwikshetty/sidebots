// Serves the film with byte ranges. Safari plays a video only from a server that
// answers a Range request with 206 and the bytes asked for, and static assets
// always answer with the whole file.

// The film this running copy of the Worker last read, with the ETag static
// assets gave its bytes. Static assets don't say the film's size, so answering
// a range takes the whole film, and every range of that film is cut from this
// one. A deploy that changes only the film can leave this copy running, and the
// film's new ETag has it read again.
let kept;

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 200) return response;
    const headers = new Headers(response.headers);
    headers.set("Accept-Ranges", "bytes");
    // Only a GET has a range.
    const range = request.method === "GET" && /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    if (!range) return new Response(response.body, { headers });

    const etag = headers.get("ETag");
    if (kept?.etag !== etag) kept = { etag, film: await response.blob() };
    const { film } = kept;
    const [, from, to] = range;
    const start = from === "" ? Math.max(film.size - Number(to), 0) : Number(from);
    const end = from === "" || to === "" ? film.size - 1 : Math.min(Number(to), film.size - 1);
    if (from === "" && to === "" || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${film.size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${film.size}`);
    return new Response(film.slice(start, end + 1), { status: 206, headers });
  },
};
