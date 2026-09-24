/**
 * NguonC Stremio Addon – Node.js server (Render / VPS) v1.0.3
 * Same logic as CF Worker version, but runs as standard HTTP server.
 */

import http from "node:http";
import { decryptStreamCEnvelope } from "./crypto.js";

const VERSION = "1.0.3";
const PORT = process.env.PORT || 3000;
const NGUONC_ORIGIN = "https://phim.nguonc.com";
const NGUONC_API = NGUONC_ORIGIN + "/api";
const CINEMETA = "https://v3-cinemeta.strem.io";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

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

function sendText(res, msg, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
  res.end(msg);
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
  if (typeof m3u8 === "string" && m3u8.includes(".m3u8")) return m3u8;
  throw new Error("no_playlist keys=" + Object.keys(payload || {}).join(","));
}

async function resolveStreamFromEmbed(embedUrl) {
  if (!isValidStreamCEmbed(embedUrl)) throw new Error("invalid_embed_url");
  const embedOrigin = new URL(embedUrl).origin;
  const debug = { attempts: [] };

  // POST bootstrap
  try {
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
    debug.attempts.push({ method: "POST bootstrap", status: res.status });
    if (res.ok) {
      const data = await res.json();
      let envelope = data?.format === "aesgcm-v1" ? data : data?.envelope?.format === "aesgcm-v1" ? data.envelope : null;
      if (envelope) return { m3u8: openEnvelope(envelope, embedUrl), debug };
      debug.attempts[0].bodyPreview = JSON.stringify(data).slice(0, 300);
    } else {
      debug.attempts[0].bodyPreview = (await res.text().catch(() => "")).slice(0, 200);
    }
  } catch (e) {
    debug.attempts.push({ method: "POST bootstrap", error: e.message });
  }

  // GET then POST
  try {
    const getRes = await fetch(embedUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": NGUONC_ORIGIN + "/"
      }
    });
    debug.attempts.push({ method: "GET embed", status: getRes.status });
    if (getRes.ok) {
      const res2 = await fetch(embedUrl, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "*/*",
          "Content-Type": "application/json",
          "Origin": embedOrigin,
          "Referer": embedUrl
        },
        body: JSON.stringify(bootstrapPayload())
      });
      debug.attempts.push({ method: "POST after GET", status: res2.status });
      if (res2.ok) {
        const data = await res2.json();
        let envelope = data?.format === "aesgcm-v1" ? data : data?.envelope?.format === "aesgcm-v1" ? data.envelope : null;
        if (envelope) return { m3u8: openEnvelope(envelope, embedUrl), debug };
      }
    }
  } catch (e) {
    debug.attempts.push({ method: "GET+POST", error: e.message });
  }

  // POST with NguonC referer
  try {
    const res = await fetch(embedUrl, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Origin": NGUONC_ORIGIN,
        "Referer": NGUONC_ORIGIN + "/"
      },
      body: JSON.stringify(bootstrapPayload())
    });
    debug.attempts.push({ method: "POST referer=nguonc", status: res.status });
    if (res.ok) {
      const data = await res.json();
      let envelope = data?.format === "aesgcm-v1" ? data : data?.envelope?.format === "aesgcm-v1" ? data.envelope : null;
      if (envelope) return { m3u8: openEnvelope(envelope, embedUrl), debug };
    }
  } catch (e) {
    debug.attempts.push({ method: "POST referer=nguonc", error: e.message });
  }

  throw new Error("all_bootstrap_failed: " + JSON.stringify(debug.attempts));
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

async function handleStream(type, id) {
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
      const { m3u8 } = await resolveStreamFromEmbed(c.embed);
      if (m3u8 && !seen.has(m3u8)) {
        seen.add(m3u8);
        const lang = languageLabel(c.server);
        streams.push({
          url: m3u8,
          title: `NguonC • ${lang}`,
          name: `${c.server} • ${c.episode}`,
          behaviorHints: { bingeGroup: `nguonc-${match.slug}-${lang}`, notWebReady: false }
        });
      }
    } catch (_) {}
  }));

  streams.sort((a, b) => {
    const rank = t => t.includes("Vietsub") ? 0 : t.includes("Thuyết minh") ? 1 : 2;
    return rank(a.title) - rank(b.title);
  });
  return { streams };
}

async function handleDebug(url) {
  const imdb = url.searchParams.get("id") || "tt0111161";
  const type = url.searchParams.get("type") || "movie";
  const steps = {};

  const cm = await getCinemeta(type === "series" ? "series" : "movie", imdb);
  steps.cinemeta = { ok: !!cm.meta, error: cm.error, name: cm.meta?.name, originalName: cm.meta?.originalName, year: cm.meta?.releaseInfo };
  if (!cm.meta) return { version: VERSION, request: { type, id: imdb }, steps, streamCount: 0, streams: [] };

  const queries = [cm.meta.originalName, cm.meta.name,
    cm.meta.name && cm.meta.releaseInfo ? `${cm.meta.name} ${String(cm.meta.releaseInfo).slice(0, 4)}` : null
  ].filter(Boolean);
  steps.queries = queries;
  steps.searches = [];

  let match = null, detail = null, detailInfo = null;
  for (const q of queries) {
    const sr = await searchNguonC(q);
    const picked = pickBestMatch(sr.items, cm.meta);
    steps.searches.push({
      query: q, error: sr.error, itemCount: sr.items.length,
      sample: sr.items.slice(0, 3).map(it => ({ name: it.name, origin: it.origin_name || it.original_name, year: it.year, slug: it.slug })),
      bestScore: picked?.score, bestSlug: picked?.item?.slug, bestName: picked?.item?.name
    });
    if (picked?.item?.slug && !detail) {
      match = picked.item;
      detailInfo = await getFilmDetail(match.slug);
      detail = detailInfo.movie;
    }
  }

  steps.match = match ? { slug: match.slug, name: match.name } : null;
  steps.detail = { ok: !!detail, error: detailInfo?.error, hasEpisodes: Array.isArray(detail?.episodes), episodesLength: detail?.episodes?.length };

  let candidates = detail ? extractServers(detail) : [];
  steps.extractFromApi = { count: candidates.length, sample: candidates.slice(0, 3).map(c => ({ server: c.server, episode: c.episode, embed: c.embed.slice(0, 90) })) };

  if (!candidates.length && match?.slug) {
    const scraped = await scrapeEmbedsFromPage(match.slug);
    candidates = scraped.items || [];
    steps.scrapePage = { count: candidates.length, error: scraped.error };
  }

  steps.resolve = [];
  for (const c of candidates.slice(0, 2)) {
    try {
      const { m3u8, debug } = await resolveStreamFromEmbed(c.embed);
      steps.resolve.push({ server: c.server, episode: c.episode, embed: c.embed.slice(0, 90), ok: true, m3u8: m3u8.slice(0, 120), attempts: debug.attempts });
    } catch (e) {
      steps.resolve.push({ server: c.server, episode: c.episode, embed: c.embed.slice(0, 90), ok: false, error: e.message });
    }
  }

  const final = await handleStream(type, imdb);
  return { version: VERSION, request: { type, id: imdb }, steps, streamCount: final.streams?.length || 0, streams: final.streams };
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (path === "/" || path === "/manifest.json") {
      const origin = `https://${req.headers.host || "localhost"}`;
      return sendJson(res, buildManifest(origin));
    }

    if (path === "/logo.svg") {
      const svg = logoSvg();
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400", ...CORS });
      return res.end(svg);
    }

    if (path === "/debug") {
      const data = await handleDebug(url);
      return sendJson(res, data);
    }

    const streamMatch = path.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/i);
    if (streamMatch) {
      const type = streamMatch[1].toLowerCase();
      const id = decodeURIComponent(streamMatch[2]);
      const result = await handleStream(type, id);
      return sendJson(res, result, 200, { "Cache-Control": "public, max-age=120" });
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
