const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const Converter = require("./converter");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 7000;
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 18000);
const BROWSER_STABLE_NO_COORD_MS = Number(process.env.BROWSER_STABLE_NO_COORD_MS || 10000);
const GEOCODE_LIMIT = 5;
const ADDRESS_BROWSER_MODES = new Set(["auto", "browser", "auto-headed", "headed"]);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isAllowedGoogleMapsHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "maps.google.com" ||
    host === "www.google.com" ||
    host === "google.com" ||
    host === "maps.google.co.jp" ||
    host === "www.google.co.jp" ||
    host === "google.co.jp"
  );
}

function isProbablyMapsUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === "maps.app.goo.gl") return true;
  if (host === "goo.gl") return url.pathname.startsWith("/maps");
  if (host.includes("google.")) {
    return url.pathname.startsWith("/maps") || url.searchParams.has("q");
  }
  return false;
}

function fetchUserAgent() {
  const contact = process.env.CONTACT_EMAIL || "local-development";
  return `amap_assitant/0.1 (${contact})`;
}

function looksLikeStructuredJapaneseAddress(query) {
  const value = Converter.normalizeText(query);
  return (
    /[都道府県]/.test(value) &&
    /[市区町村郡]/.test(value) &&
    (/[0-9０-９]/.test(value) || /丁目|番地?|号/.test(value))
  );
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = Converter.normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function buildGeocodeQueries(query) {
  const normalized = Converter.normalizeText(query).replace(/\+/g, " ");
  const commaParts = normalized
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  const withoutCountry = normalized.replace(/\s*,?\s*(Japan|日本)\s*$/i, "");
  const withoutPostal = normalized.replace(/〒?\s*\d{3}-?\d{4}/g, " ");
  const queries = [normalized, withoutCountry, withoutPostal];

  if (commaParts.length > 1) {
    queries.push(commaParts[0]);
    queries.push(commaParts.slice(0, 2).join(", "));
  }

  return uniqueStrings(queries);
}

function safeResolveLocation(currentUrl, location) {
  try {
    return new URL(location, currentUrl);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasExtractableGoogleCoords(rawUrl) {
  return Boolean(Converter.parseGoogleMapsUrl(rawUrl)?.coords);
}

function normalizeBrowserLaunchMode(mode) {
  return mode === "auto-headed" || mode === "headed" ? "headed" : "headless";
}

function buildGoogleMapsSearchUrl(query) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", Converter.normalizeText(query));
  url.searchParams.set("hl", "ja");
  return url;
}

function findChromiumExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchDevToolsJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!response.ok) {
    throw new Error(`DevTools ${pathname} 返回 ${response.status}`);
  }
  return response.json();
}

async function waitForDevToolsTarget(port, processRef, stderrRef) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(`Chromium 已退出：${stderrRef.text.trim() || `exit ${processRef.exitCode}`}`);
    }

    try {
      const targets = await fetchDevToolsJson(port, "/json/list");
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // DevTools endpoint is not ready yet.
    }
    await sleep(180);
  }

  throw new Error("等待 Chromium DevTools 超时");
}

class DevToolsSocket {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.handshakeBuffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const port = Number(this.url.port || 80);
      const requestPath = `${this.url.pathname}${this.url.search}`;
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${this.url.hostname}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n");

      const fail = (error) => {
        if (!this.connected) reject(error);
      };

      this.socket = net.createConnection({ host: this.url.hostname, port }, () => {
        this.socket.write(request);
      });
      this.socket.once("error", fail);
      this.socket.on("data", (chunk) => {
        if (!this.connected) {
          this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
          const marker = this.handshakeBuffer.indexOf("\r\n\r\n");
          if (marker === -1) return;

          const head = this.handshakeBuffer.subarray(0, marker).toString("utf8");
          if (!head.startsWith("HTTP/1.1 101")) {
            reject(new Error(`WebSocket 握手失败：${head.split("\r\n")[0] || "unknown"}`));
            this.close();
            return;
          }

          this.connected = true;
          const rest = this.handshakeBuffer.subarray(marker + 4);
          this.handshakeBuffer = Buffer.alloc(0);
          if (rest.length) this.handleFrames(rest);
          resolve();
          return;
        }

        this.handleFrames(chunk);
      });
      this.socket.once("close", () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("DevTools WebSocket 已关闭"));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    this.writeFrame(Buffer.from(payload, "utf8"), 0x1);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  writeFrame(payload, opcode) {
    const length = payload.length;
    const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
    const header = Buffer.alloc(headerLength);
    header[0] = 0x80 | opcode;
    if (length < 126) {
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }

    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  handleFrames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        const unmasked = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x1) {
        this.handleMessage(payload.toString("utf8"));
      } else if (opcode === 0x9) {
        this.writeFrame(payload, 0xA);
      } else if (opcode === 0x8) {
        this.close();
        return;
      }
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "DevTools 调用失败"));
    } else {
      pending.resolve(message);
    }
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

async function fetchNoFollow(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url.href, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "amap_assitant-link-expander/0.1",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      headers: {
        "user-agent": fetchUserAgent(),
        "accept": "application/json"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url.hostname} 返回 ${response.status}: ${text.slice(0, 80)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestRedirectStep(url) {
  let response = await fetchNoFollow(url, "HEAD");
  if ((response.status === 405 || response.status === 403 || response.status === 400) && !response.headers.get("location")) {
    response = await fetchNoFollow(url, "GET");
  }
  return response;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    if (!candidate?.coords) continue;
    const key = `${candidate.coords.lat.toFixed(6)},${candidate.coords.lng.toFixed(6)},${candidate.displayName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= GEOCODE_LIMIT) break;
  }

  return unique;
}

async function geocodeWithGsi(query) {
  const url = new URL("https://msearch.gsi.go.jp/address-search/AddressSearch");
  url.searchParams.set("q", query);

  const payload = await fetchJson(url);
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item, index) => Converter.normalizeGsiResult(item, index))
    .filter(Boolean);
}

async function geocodeWithNominatim(query) {
  const url = new URL(Converter.buildNominatimUrl(query));
  const payload = await fetchJson(url);
  if (!Array.isArray(payload)) return [];

  return payload
    .map(Converter.normalizeNominatimResult)
    .filter(Boolean);
}

async function geocodeJapaneseQuery(query) {
  const structuredAddress = looksLikeStructuredJapaneseAddress(query);
  const providers = structuredAddress
    ? [geocodeWithGsi, geocodeWithNominatim]
    : [geocodeWithNominatim, geocodeWithGsi];
  const queries = buildGeocodeQueries(query);

  const notices = [];
  const results = [];

  for (const candidateQuery of queries) {
    for (const provider of providers) {
      try {
        const candidates = await provider(candidateQuery);
        results.push(...candidates.map((candidate) => ({
          ...candidate,
          query: candidate.query || candidateQuery
        })));
      } catch (error) {
        notices.push(`${candidateQuery}: ${error.message}`);
      }
      if (uniqueCandidates(results).length >= GEOCODE_LIMIT) break;
    }
    if (uniqueCandidates(results).length >= GEOCODE_LIMIT) break;
  }

  return {
    providerOrder: structuredAddress ? ["gsi", "nominatim"] : ["nominatim", "gsi"],
    queries,
    results: uniqueCandidates(results),
    notices
  };
}

async function expandGoogleMapsUrl(rawUrl) {
  const start = new URL(rawUrl);
  if (!["http:", "https:"].includes(start.protocol)) {
    throw new Error("只支持 http/https 链接");
  }
  if (!isAllowedGoogleMapsHost(start.hostname) || !isProbablyMapsUrl(start)) {
    throw new Error("只允许展开 Google Maps 链接");
  }

  let current = start;
  const hops = [current.href];

  for (let index = 0; index < MAX_REDIRECTS; index += 1) {
    const response = await requestRedirectStep(current);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = safeResolveLocation(current, location);
      if (!next) throw new Error("重定向地址无效");
      if (!["http:", "https:"].includes(next.protocol) || !isAllowedGoogleMapsHost(next.hostname)) {
        throw new Error("重定向目标不在 Google Maps 白名单内");
      }
      current = next;
      hops.push(current.href);
      continue;
    }

    return {
      expandedUrl: current.href,
      finalStatus: response.status,
      hops
    };
  }

  throw new Error("重定向次数过多");
}

function collectAllowedBrowserUrl(rawUrl, result) {
  if (!rawUrl) return result;
  try {
    const url = new URL(rawUrl);
    if (isAllowedGoogleMapsHost(url.hostname) && isProbablyMapsUrl(url)) {
      result.urls.push(url.href);
      if (hasExtractableGoogleCoords(url.href)) {
        result.coordUrl = url.href;
      }
    }
  } catch {
    // Ignore non-URL values from the browser while it is still loading.
  }
  return result;
}

async function expandGoogleMapsUrlWithBrowser(rawUrl, launchMode = "headless") {
  const start = new URL(rawUrl);
  if (!["http:", "https:"].includes(start.protocol)) {
    throw new Error("只支持 http/https 链接");
  }
  if (!isAllowedGoogleMapsHost(start.hostname) || !isProbablyMapsUrl(start)) {
    throw new Error("只允许浏览器解析 Google Maps 链接");
  }

  const executable = findChromiumExecutable();
  if (!executable) {
    throw new Error("找不到 Chromium/Chrome，可设置 CHROME_PATH");
  }

  const headed = launchMode === "headed";
  if (headed && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("当前没有 DISPLAY/WAYLAND_DISPLAY，无法启动有头浏览器");
  }

  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amap_assitant-chrome-"));
  const stderrRef = { text: "" };
  const chromeArgs = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=ja-JP",
    "--window-size=1280,900",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "about:blank"
  ];

  if (!headed) {
    chromeArgs.unshift("--headless=new");
    chromeArgs.splice(5, 0, "--disable-background-networking");
  }

  const chrome = spawn(executable, chromeArgs, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  chrome.stderr.on("data", (chunk) => {
    stderrRef.text += chunk.toString("utf8");
    if (stderrRef.text.length > 3000) {
      stderrRef.text = stderrRef.text.slice(-3000);
    }
  });

  let devtools = null;
  try {
    const wsUrl = await waitForDevToolsTarget(port, chrome, stderrRef);
    devtools = new DevToolsSocket(wsUrl);
    await devtools.connect();
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    await devtools.send("Page.navigate", { url: start.href });

    const deadline = Date.now() + BROWSER_TIMEOUT_MS;
    const seen = [];
    let lastUrl = "";
    let stableSince = Date.now();
    let best = collectAllowedBrowserUrl(start.href, { urls: [], coordUrl: "" });
    const noCoordStableLimit = headed ? BROWSER_TIMEOUT_MS : BROWSER_STABLE_NO_COORD_MS;

    while (Date.now() < deadline) {
      let currentUrl = "";
      try {
        const evaluated = await devtools.send("Runtime.evaluate", {
          expression: "location.href",
          returnByValue: true
        });
        currentUrl = evaluated.result?.result?.value || "";
      } catch {
        // The page may be between navigations.
      }

      if (currentUrl && currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        stableSince = Date.now();
        seen.push(currentUrl);
        best = collectAllowedBrowserUrl(currentUrl, best);
      }

      try {
        const history = await devtools.send("Page.getNavigationHistory");
        const entries = history.result?.entries || [];
        for (const entry of entries) {
          if (entry.url && !seen.includes(entry.url)) {
            seen.push(entry.url);
            best = collectAllowedBrowserUrl(entry.url, best);
          }
        }
      } catch {
        // Navigation history is best-effort.
      }

      if (best.coordUrl) break;
      if (best.urls.length && Date.now() - stableSince > noCoordStableLimit) break;
      await sleep(500);
    }

    const uniqueUrls = uniqueStrings(best.urls);
    const expandedUrl = best.coordUrl || uniqueUrls[uniqueUrls.length - 1] || "";
    if (!expandedUrl) {
      throw new Error("Chromium 没有解析出 Google Maps 目标链接");
    }

    return {
      expandedUrl,
      finalStatus: 200,
      hops: uniqueUrls,
      browserFinalUrl: lastUrl,
      browserFoundCoords: hasExtractableGoogleCoords(expandedUrl),
      launchMode
    };
  } finally {
    if (devtools) devtools.close();
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    fs.rm(userDataDir, { recursive: true, force: true }, () => {});
  }
}

async function expandGoogleMapsUrlAuto(rawUrl, mode) {
  const forcedBrowserMode = mode === "headed" ? "headed" : "headless";
  const autoBrowserMode = mode === "auto-headed" ? "headed" : "headless";

  if (mode === "browser" || mode === "headed") {
    const browserResult = await expandGoogleMapsUrlWithBrowser(rawUrl, forcedBrowserMode);
    return {
      ...browserResult,
      mode,
      browserAttempted: true
    };
  }

  const redirectResult = await expandGoogleMapsUrl(rawUrl);
  const shouldTryBrowser = ["auto", "auto-headed"].includes(mode) && !hasExtractableGoogleCoords(redirectResult.expandedUrl);
  if (!shouldTryBrowser) {
    return {
      ...redirectResult,
      mode: "redirect",
      browserAttempted: false
    };
  }

  try {
    const browserResult = await expandGoogleMapsUrlWithBrowser(rawUrl, autoBrowserMode);
    return {
      ...browserResult,
      redirectExpandedUrl: redirectResult.expandedUrl,
      redirectHops: redirectResult.hops,
      mode: autoBrowserMode === "headed" ? "headed" : "browser",
      browserAttempted: true
    };
  } catch (error) {
    return {
      ...redirectResult,
      mode: "redirect",
      browserAttempted: true,
      browserError: error.message
    };
  }
}

async function geocodeJapaneseAddressWithGoogleBrowser(query, mode = "auto") {
  if (!ADDRESS_BROWSER_MODES.has(mode)) {
    throw new Error("mode 只支持 auto/browser/auto-headed/headed");
  }

  const searchUrl = buildGoogleMapsSearchUrl(query);
  const launchMode = normalizeBrowserLaunchMode(mode);
  const browserResult = await expandGoogleMapsUrlWithBrowser(searchUrl.href, launchMode);
  const parsed = Converter.parseGoogleMapsUrl(browserResult.expandedUrl);
  if (!parsed?.coords) {
    throw new Error("Google Maps 搜索结果里没有可提取坐标");
  }

  const subAddressTokens = Converter.extractSubAddressTokens(query);
  const precisionNotice = subAddressTokens.length
    ? `已用 Google Maps 搜索完整地址并取得坐标；输入里包含 ${subAddressTokens.join("、")}，打开高德后请确认楼栋/楼层位置。`
    : "";

  return {
    providerOrder: ["google-browser"],
    queries: [Converter.normalizeText(query)],
    sourceGoogleUrl: browserResult.expandedUrl,
    browserFinalUrl: browserResult.browserFinalUrl,
    browserHops: browserResult.hops,
    browserFoundCoords: browserResult.browserFoundCoords,
    launchMode,
    precisionNotice,
    results: [{
      id: `google-browser-${parsed.coords.lat},${parsed.coords.lng}`,
      name: parsed.label || query,
      displayName: parsed.label || query,
      type: launchMode === "headed" ? "Google Maps 可见浏览器" : "Google Maps 后台浏览器",
      provider: "google-browser",
      importance: 1,
      coords: parsed.coords,
      sourceGoogleUrl: browserResult.expandedUrl,
      precisionNotice
    }],
    notices: []
  };
}

function serveStatic(req, res, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${decodeURIComponent(normalizedPath)}`);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } else {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Server error");
      }
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES.get(ext) || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=60"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/api/expand") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const target = requestUrl.searchParams.get("url");
      if (!target) {
        sendJson(res, 400, { ok: false, error: "缺少 url 参数" });
        return;
      }

      try {
        const mode = requestUrl.searchParams.get("mode") || "auto";
        if (!["redirect", "browser", "headed", "auto", "auto-headed"].includes(mode)) {
          sendJson(res, 400, { ok: false, error: "mode 只支持 redirect/browser/headed/auto/auto-headed" });
          return;
        }
        const result = await expandGoogleMapsUrlAuto(target, mode);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === "/api/geocode") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const query = Converter.normalizeText(requestUrl.searchParams.get("q"));
      if (!query) {
        sendJson(res, 400, { ok: false, error: "缺少 q 参数" });
        return;
      }
      if (query.length > 300) {
        sendJson(res, 400, { ok: false, error: "地址过长，请缩短后再试" });
        return;
      }
      if (!Converter.isLikelyDetailedJapaneseAddress(query)) {
        sendJson(res, 400, { ok: false, error: "只支持日本详细地址，不用地点名做候选猜测" });
        return;
      }

      try {
        const mode = requestUrl.searchParams.get("mode") || "auto";
        if (!ADDRESS_BROWSER_MODES.has(mode)) {
          sendJson(res, 400, { ok: false, error: "mode 只支持 auto/browser/auto-headed/headed" });
          return;
        }
        const result = await geocodeJapaneseAddressWithGoogleBrowser(query, mode);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: error.message });
      }
      return;
    }

    serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`amap_assitant running at http://localhost:${PORT}`);
});
