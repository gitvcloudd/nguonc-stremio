import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { server, registerGrant } = await import("../src/server.js");

test("serves a decrypted playlist with CDN segments, including .html segments, directly", async () => {
  const originalFetch = globalThis.fetch;
  const playlistUrl = "https://embed4.streamc.xyz/secret/playlist";
  const embedUrl = "https://embed4.streamc.xyz/episode";
  const segmentUrl = "https://sings4.amass2.top/movie/streamaaa0000.html";
  const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXTINF:10.0,\n${segmentUrl}\n#EXTINF:10.0,\nrelative.html\n#EXT-X-ENDLIST\n`;
  const upstreamRequests = [];
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    upstreamRequests.push(String(url));
    return Promise.resolve(new Response(playlist, { status: 200 }));
  };
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const token = registerGrant(playlistUrl, embedUrl, null);
    const route = `${origin}/hls/${token}?u=${encodeURIComponent(playlistUrl)}`;
    const response = await originalFetch(route, { headers: { Range: "bytes=0-" } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /#EXTM3U/);
    assert.ok(body.includes(segmentUrl));
    assert.ok(body.includes("https://embed4.streamc.xyz/secret/relative.html"));
    assert.ok(body.includes('URI="https://embed4.streamc.xyz/key.bin"'));
    assert.ok(!body.includes(`${origin}/hls/`));
    assert.deepEqual(upstreamRequests, [playlistUrl]);

    const other = await originalFetch(`${origin}/hls/${token}?u=${encodeURIComponent(segmentUrl)}`);
    assert.equal(other.status, 403);
    assert.deepEqual(upstreamRequests, [playlistUrl]);
  } finally {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
