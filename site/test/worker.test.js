import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

/** Static assets as the Worker uses them: the whole of `film` for every request, with `etag` for its bytes and no word of its size. `answers` holds each answer it gave. */
function fakeAssets(film, etag) {
  const answers = [];
  const fetch = async (request) => {
    const answer = new Response(request.method === "HEAD" ? null : film, { headers: { ETag: etag, "Content-Type": "video/mp4" } });
    answers.push(answer);
    return answer;
  };
  return { ASSETS: { fetch }, answers };
}

/** Asks the Worker for the film, with `range` when there is one, and returns the answer's status, its `Content-Range` and its body. */
async function ask(env, range, method = "GET") {
  const answer = await worker.fetch(new Request("https://sidebots.app/film.mp4", { method, headers: range ? { Range: range } : {} }), env);
  return [answer.status, answer.headers.get("Content-Range"), await answer.text()];
}

test("a range of the film comes back as its bytes with the film's size, and a range past its end is refused", async () => {
  const env = fakeAssets("0123456789", '"ranges"');

  assert.deepEqual(await ask(env, "bytes=0-1"), [206, "bytes 0-1/10", "01"]);
  assert.deepEqual(await ask(env, "bytes=2-4"), [206, "bytes 2-4/10", "234"]);
  assert.deepEqual(await ask(env, "bytes=7-"), [206, "bytes 7-9/10", "789"]);
  assert.deepEqual(await ask(env, "bytes=-3"), [206, "bytes 7-9/10", "789"]);
  assert.deepEqual(await ask(env, "bytes=0-99"), [206, "bytes 0-9/10", "0123456789"]);
  assert.deepEqual(await ask(env, "bytes=10-"), [416, "bytes */10", ""]);
  assert.deepEqual(await ask(env, "bytes=-"), [416, "bytes */10", ""]);
});

test("the film is read once for every range asked of it, and again when a deploy changes it", async () => {
  const first = fakeAssets("0123456789", '"first film"');
  await ask(first, "bytes=0-1");
  await ask(first, "bytes=2-4");
  assert.equal(first.answers.filter((answer) => answer.bodyUsed).length, 1);

  // The Worker's code is the same, so the copy that kept the first film goes on running.
  const second = fakeAssets("abcdefghijklmnop", '"second film"');
  assert.deepEqual(await ask(second, "bytes=2-4"), [206, "bytes 2-4/16", "cde"]);
  assert.deepEqual(await ask(second, "bytes=12-"), [206, "bytes 12-15/16", "mnop"]);
  assert.equal(second.answers.filter((answer) => answer.bodyUsed).length, 1);
});

test("a request with no range gets the whole film, and so does one whose range the Worker doesn't answer", async () => {
  const env = fakeAssets("0123456789", '"whole"');

  assert.deepEqual(await ask(env), [200, null, "0123456789"]);
  assert.deepEqual(await ask(env, "bytes=0-1,5-6"), [200, null, "0123456789"]);
  // Only a GET has a range, and a HEAD has no body to cut one from.
  assert.deepEqual(await ask(env, "bytes=0-1", "HEAD"), [200, null, ""]);
});
