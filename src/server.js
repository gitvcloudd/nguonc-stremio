/**
 * NguonC Stremio Addon – Node.js (Render) v1.0.4
 * + HLS bridge/proxy so playlist is played via our server IP (same IP that got the grant).
 */

import http from "node:http";
import { decryptStreamCEnvelope } from "./crypto.js";

const VERSION = "1.0.4";
const PORT = process.env.PORT || 3000;
const NGUONC_ORIGIN = "https://phim.nguonc.com";
const NGUONC_API = NGUONC_ORIGIN + "/api";
const CINEMETA = "https://v3-cinemeta.strem.io";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "86400"
};

// In-memory grant cache: token -> { playlistUrl, embedUrl, expires }
const grants = new Map();
const GRANT_TTL_MS = 25 * 60 * 1000; // 25 min

function sendJson(res, data, status = 200, extra = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...CORS,
    ...extra
  });
  res.end(body);
}

function sendText(res, msg, status = 200, extra = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...extra });
  res.end(msg);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function fromB64url(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

function makeToken() {
  return b64url(cryptoGetRandom(16));
}
function cryptoGetRandom(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

function pruneGrants() {
  const now = Date.now();
  for (const [k, v] of grants) {
    if (v.expires < now) grants.delete(k);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

function buildManifest(origin) {
  return {
    id: "community.nguonc",
    version: VERSION,
    name: "NguonC",
    description: "Nguồn C (phim.nguonc.com) – Vietsub / Thuyết minh / Lồng tiếng",
    logo: origin + "/logo.svg",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { adult: false, configurable: false }
  };
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#111827"/><path d="M58 188V68h34l72 73V68h34v120h-31L92 112v76H58z" fill="#22c55e"/><circle cx="194" cy="188" r="18" fill="#f8fafc"/></svg>`;
}

async function searchNguonC(keyword) {
  if (!keyword) return { items: [], error: null };
  try {
    const data = await fetchJson(`${NGUONC_API}/films/search?keyword=${encodeURIComponent(keyword)}`);
    return { items: Array.isArray(data?.items) ? data.items : [], error: null };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

async function getFilmDetail(slug) {
  try {
    const data = await fetchJson(`${NGUONC_API}/film/${encodeURIComponent(slug)}`);
    return { movie: data?.movie || data || null, error: null };
  } catch (e) {
    return { movie: null, error: e.message };
  }
}

async function getCinemeta(type, id) {
  try {
    const data = await fetchJson(`${CINEMETA}/meta/${type}/${id}.json`);
    return { meta: data?.meta || null, error: null };
  } catch (e) {
    return { meta: null, error: e.message };
  }
}

function pickBestMatch(items, meta) {
  if (!items?.length) return null;
  const year = meta?.releaseInfo ? String(meta.releaseInfo).slice(0, 4) : null;
  const names = [meta?.name, meta?.originalName, ...(meta?.alternativeNames || [])]
    .filter(Boolean).map(n => n.toLowerCase());
  let best = null, bestScore = -1;
  for (const it of items) {
    let score = 0;
    const itName = (it.name || "").toLowerCase();
    const itOrigin = (it.origin_name || it.original_name || "").toLowerCase();
    const itYear = String(it.year || "");
    for (const n of names) {
      if (!n) continue;
      if (itName === n || itOrigin === n) score += 6;
      else if (itName.includes(n.slice(0, 10)) || n.includes(itName.slice(0, 10))) score += 3;
      else if (itOrigin.includes(n.slice(0, 10))) score += 2;
    }
    if (year && itYear === year) score += 4;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return { item: bestScore >= 1 ? best : (items[0] || null), score: bestScore };
}

function extractServers(movie) {
  const result = [];
  const episodes = movie?.episodes || movie?.server || movie?.servers || [];
  if (Array.isArray(episodes)) {
    for (const srv of episodes) {
      const serverName = srv.server_name || srv.name || srv.n || "Server";
      const items = srv.items || srv.server_data || srv.list || srv.i || [];
      if (!Array.isArray(items)) continue;
      for (const ep of items) {
        const embed = ep.embed || ep.link_embed || ep.url || ep.e || null;
        if (!embed || typeof embed !== "string") continue;
        result.push({
          server: serverName,
          episode: ep.name || ep.slug || ep.n || "Full",
          embed: embed.trim(),
          hasStreamC: /streamc\.xyz|embed\.php/i.test(embed)
        });
      }
    }
  }
  return result;
}

async function scrapeEmbedsFromPage(slug) {
  try {
    const res = await fetch(`${NGUONC_ORIGIN}/phim/${encodeURIComponent(slug)}`, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html", "Accept-Language": "vi-VN,vi;q=0.9" }
    });
    if (!res.ok) return { items: [], error: `http_${res.status}` };
    const html = await res.text();
    const m = html.match(/<script[^>]+id=["']nc-episode-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return { items: [], error: "no_nc_episode_data_script" };
    let raw = m[1].trim().replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
    const data = JSON.parse(raw);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.servers) ? data.servers : Array.isArray(data?.data) ? data.data : [];
    const out = [];
    for (const s of rows) {
      const serverName = s.server_name || s.name || "Server";
      const items = s.items || s.list || [];
      for (const x of items) {
        const embed = x.embed || x.link_embed || x.url || null;
        if (embed) out.push({ server: serverName, episode: x.name || x.episode_name || "Full", embed, hasStreamC: true });
      }
    }
    return { items: out, error: null };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

function isValidStreamCEmbed(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" &&
      (u.hostname === "streamc.xyz" || u.hostname.endsWith(".streamc.xyz")) &&
      u.pathname === "/embed.php" &&
      /^[a-f0-9]{32}$/i.test(u.searchParams.get("hash") || "");
  } catch { return false; }
}

function bootstrapPayload() {
  return {
    action: "bootstrap",
    referrer: NGUONC_ORIGIN + "/",
    frame_origins: [NGUONC_ORIGIN],
    request_grant: true,
    playlist_format: "hls",
    pretty_url: true,
    path_chunks: true,
    bootstrap_format: "aesgcm-v1"
  };
}

function openEnvelope(envelope, embedUrl) {
  const payload = decryptStreamCEnvelope(envelope, embedUrl);
  if (payload?.turnstileEnabled || payload?.issue === "turnstile_response") throw new Error("turnstile_required");
  if (payload?.preissued?.playlist) return payload.preissued.playlist;
  let m3u8 = payload?.url || payload?.playlist || payload?.src || payload?.file || null;
  if (!m3u8 && Array.isArray(payload?.sources)) {
    const s = payload.sources.find(x => (x.file || x.src || x.url || "").includes(".m3u8"));
    m3u8 = s?.file || s?.src || s?.url || null;
  }
  if (typeof m3u8 === "string" && m3u8.includes("http")) return m3u8;
  throw new Error("no_playlist keys=" + Object.keys(payload || {}).join(","));
}

async function resolveStreamFromEmbed(embedUrl) {
  if (!isValidStreamCEmbed(embedUrl)) throw new Error("invalid_embed_url");
  const embedOrigin = new URL(embedUrl).origin;

  const res = await fetch(embedUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "application/json",
      "Origin": embedOrigin,
      "Referer": embedUrl
    },
    body: JSON.stringify(bootstrapPayload())
  });
  if (!res.ok) throw new Error("bootstrap_http_" + res.status);
  const data = await res.json();
  let envelope = data?.format === "aesgcm-v1" ? data : data?.envelope?.format === "aesgcm-v1" ? data.envelope : null;
  if (!envelope) throw new Error("no_envelope");
  const playlistUrl = openEnvelope(envelope, embedUrl);
  return { playlistUrl, embedUrl };
}

function languageLabel(serverName) {
  const n = (serverName || "").toLowerCase();
  if (/thuyết minh|thuyet minh|tm\b/.test(n)) return "Thuyết minh";
  if (/lồng tiếng|long tieng|lt\b/.test(n)) return "Lồng tiếng";
  return "Vietsub";
}

function episodeMatches(epName, season, episode) {
  if (!episode) return true;
  const s = String(epName || "").toLowerCase();
  const ep = String(episode);
  return s.includes(`tập ${ep}`) || s.includes(`tap ${ep}`) || s.includes(`ep ${ep}`) ||
    s.includes(`e${ep}`) || s === ep || s.includes(`${season}x${ep}`) ||
    s.includes(`s${season}e${ep}`) || new RegExp(`(?:^|\\D)${ep}(?:\\D|$)`).test(s);
}

function registerGrant(playlistUrl, embedUrl) {
  pruneGrants();
  const token = makeToken();
  grants.set(token, {
    playlistUrl,
    embedUrl,
    expires: Date.now() + GRANT_TTL_MS
  });
  return token;
}

/**
 * Fetch upstream URL with streamc-friendly headers.
 */
async function fetchUpstream(targetUrl, embedUrl, rangeHeader) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
    "Origin": new URL(embedUrl).origin,
    "Referer": embedUrl
  };
  if (rangeHeader) headers["Range"] = rangeHeader;
  return fetch(targetUrl, { headers });
}

/**
 * Rewrite m3u8 so all segment / sub-playlist URLs go through our proxy.
 */
function rewriteM3u8(body, baseUrl, token, origin) {
  const base = new URL(baseUrl);
  const lines = body.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      // Keep tags; rewrite URI="..." inside tags if present
      if (/URI="/i.test(t)) {
        out.push(t.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = new URL(uri, base).href;
          const proxied = `${origin}/hls/${token}?u=${encodeURIComponent(abs)}`;
          return `URI="${proxied}"`;
        }));
      } else {
        out.push(line);
      }
      continue;
    }
    // Segment or sub-playlist URL
    try {
      const abs = new URL(t, base).href;
      out.push(`${origin}/hls/${token}?u=${encodeURIComponent(abs)}`);
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function handleHlsProxy(req, res, token, targetUrl, origin) {
  const grant = grants.get(token);
  if (!grant || grant.expires < Date.now()) {
    return sendText(res, "grant expired", 410);
  }

  const range = req.headers.range || null;
  let upstream;
  try {
    upstream = await fetchUpstream(targetUrl, grant.embedUrl, range);
  } catch (e) {
    return sendText(res, "upstream fetch failed: " + e.message, 502);
  }

  const status = upstream.status;
  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = /mpegurl|m3u8|application\/vnd\.apple\.mpegurl|text\/plain/i.test(contentType) ||
    targetUrl.includes(".m3u8") || targetUrl.includes("mpegurl");

  if (isPlaylist && status >= 200 && status < 300) {
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, targetUrl, token, origin);
    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-cache",
      ...CORS
    });
    return res.end(rewritten);
  }

  // Binary segment (ts / m4s / key) – stream through
  const headers = { ...CORS };
  const ct = upstream.headers.get("content-type");
  if (ct) headers["Content-Type"] = ct;
  const cl = upstream.headers.get("content-length");
  if (cl) headers["Content-Length"] = cl;
  const cr = upstream.headers.get("content-range");
  if (cr) headers["Content-Range"] = cr;
  const ar = upstream.headers.get("accept-ranges");
  if (ar) headers["Accept-Ranges"] = ar;
  headers["Cache-Control"] = "public, max-age=3600";

  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

async function handleStream(type, id, origin) {
  const parts = id.split(":");
  const imdbId = parts[0];
  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  if (!imdbId?.startsWith("tt")) return { streams: [] };

  const stremioType = type === "series" ? "series" : "movie";
  const { meta } = await getCinemeta(stremioType, imdbId);
  if (!meta) return { streams: [] };

  const queries = [meta.originalName, meta.name,
    meta.name && meta.releaseInfo ? `${meta.name} ${String(meta.releaseInfo).slice(0, 4)}` : null
  ].filter(Boolean);

  let match = null, detail = null;
  for (const q of queries) {
    const { items } = await searchNguonC(q);
    const picked = pickBestMatch(items, meta);
    match = picked?.item;
    if (match?.slug) {
      const d = await getFilmDetail(match.slug);
      detail = d.movie;
      if (detail) break;
    }
  }
  if (!detail) return { streams: [] };

  let candidates = extractServers(detail);
  if (!candidates.length && match?.slug) {
    const scraped = await scrapeEmbedsFromPage(match.slug);
    candidates = scraped.items || [];
  }
  if (!candidates.length) return { streams: [] };

  if (type === "series" && episode) {
    const filtered = candidates.filter(c => episodeMatches(c.episode, season, episode));
    if (filtered.length) candidates = filtered;
  }

  const toTry = candidates.filter(c => c.hasStreamC !== false).slice(0, 4);
  const streams = [];
  const seen = new Set();

  await Promise.all(toTry.map(async (c) => {
    try {
      const { playlistUrl, embedUrl } = await resolveStreamFromEmbed(c.embed);
      if (!playlistUrl || seen.has(playlistUrl)) return;
      seen.add(playlistUrl);

      const token = registerGrant(playlistUrl, embedUrl);
      // Bridge URL – player requests our server, we fetch from streamc with grant IP
      const bridged = `${origin}/hls/${token}?u=${encodeURIComponent(playlistUrl)}`;

      const lang = languageLabel(c.server);
      streams.push({
        url: bridged,
        title: `NguonC • ${lang}`,
        name: `${c.server} • ${c.episode}`,
        behaviorHints: {
          bingeGroup: `nguonc-${match.slug}-${lang}`,
          notWebReady: false,
          proxyHeaders: {
            request: {
              "User-Agent": USER_AGENT,
              "Referer": embedUrl,
              "Origin": new URL(embedUrl).origin
            }
          }
        }
      });
    } catch (e) {
      console.log("[resolve]", c.server, e.message);
    }
  }));

  streams.sort((a, b) => {
    const rank = t => t.includes("Vietsub") ? 0 : t.includes("Thuyết minh") ? 1 : 2;
    return rank(a.title) - rank(b.title);
  });
  return { streams };
}

async function handleDebug(url, origin) {
  const imdb = url.searchParams.get("id") || "tt0111161";
  const type = url.searchParams.get("type") || "movie";
  const result = await handleStream(type, imdb, origin);
  return {
    version: VERSION,
    request: { type, id: imdb },
    streamCount: result.streams?.length || 0,
    streams: result.streams,
    note: "URLs are bridged via /hls/{token} so playback uses server IP"
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const origin = `https://${host}`;
    const url = new URL(req.url || "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (path === "/" || path === "/manifest.json") {
      return sendJson(res, buildManifest(origin));
    }

    if (path === "/logo.svg") {
      const svg = logoSvg();
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400", ...CORS });
      return res.end(svg);
    }

    if (path === "/debug") {
      const data = await handleDebug(url, origin);
      return sendJson(res, data);
    }

    // HLS bridge: /hls/{token}?u=<encoded upstream url>
    const hlsMatch = path.match(/^\/hls\/([A-Za-z0-9_-]+)$/);
    if (hlsMatch) {
      const token = hlsMatch[1];
      const target = url.searchParams.get("u");
      if (!target) return sendText(res, "missing u", 400);
      let decoded;
      try { decoded = decodeURIComponent(target); } catch { decoded = target; }
      return handleHlsProxy(req, res, token, decoded, origin);
    }

    const streamMatch = path.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/i);
    if (streamMatch) {
      const type = streamMatch[1].toLowerCase();
      const id = decodeURIComponent(streamMatch[2]);
      const result = await handleStream(type, id, origin);
      return sendJson(res, result, 200, { "Cache-Control": "no-cache" });
    }

    sendText(res, `NguonC Stremio Addon v${VERSION}\nManifest: /manifest.json\nDebug: /debug?id=tt0111161`);
  } catch (err) {
    console.error("[NguonC]", err?.stack || err);
    sendJson(res, { error: "internal", message: String(err?.message || err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`NguonC Stremio Addon v${VERSION} listening on port ${PORT}`);
});
