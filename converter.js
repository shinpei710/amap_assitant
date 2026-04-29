(function initConverter(root, factory) {
  const converter = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = converter;
  }
  root.amap_assitantConverter = converter;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConverter() {
  const JP_PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
  ];

  const DEFAULT_SOURCE = "amap_assitant";

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u3000/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function safeDecode(value) {
    let current = String(value || "");
    for (let index = 0; index < 2; index += 1) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) return current;
        current = decoded;
      } catch {
        return current;
      }
    }
    return current;
  }

  function cleanLabel(value) {
    return safeDecode(String(value || ""))
      .replace(/\+/g, " ")
      .replace(/\/@[-0-9.,a-z]+.*$/i, "")
      .replace(/!.*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeAmapName(value, fallback = "目的地") {
    const cleaned = cleanLabel(value)
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[,\n\r\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleaned || /^https?:\/\//i.test(cleaned)) return fallback;
    return cleaned.slice(0, 80);
  }

  function normalizePrecisionText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .replace(/[−ー―‐‑–—]/g, "-")
      .toLowerCase();
  }

  function extractSubAddressTokens(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/[−ー―‐‑–—]/g, "-")
      .replace(/\s+/g, " ");
    const matches = [];
    const pattern = /(^|[^0-9一二三四五六七八九十百千-])((?:地下)?(?:[0-9]+|[一二三四五六七八九十百千]+)(?:号棟|棟|号室|室|階|f))/gi;
    for (const match of normalized.matchAll(pattern)) {
      matches.push(match[2]);
    }
    return [...new Set(matches)];
  }

  function buildSubAddressPrecisionNotice(input, resolvedName) {
    const tokens = extractSubAddressTokens(input);
    if (!tokens.length) return "";

    const resolved = normalizePrecisionText(resolvedName);
    const missing = tokens.filter((token) => !resolved.includes(normalizePrecisionText(token)));
    if (!missing.length) return "";

    const target = resolvedName ? `「${resolvedName}」` : "候选地址";
    return `输入里的楼栋/楼层信息（${missing.join("、")}）没有被地址数据源确认；当前坐标只精确到 ${target} 附近，请在高德中自行确认。`;
  }

  function extractFirstUrl(text) {
    const normalized = normalizeText(text);
    const match = normalized.match(/https?:\/\/[^\s<>"'）)]+/i);
    return match ? match[0] : "";
  }

  function isGoogleMapsHost(hostname) {
    const host = String(hostname || "").toLowerCase();
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

  function isGoogleMapsUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!isGoogleMapsHost(url.hostname)) return false;
      if (url.hostname.toLowerCase() === "maps.app.goo.gl") return true;
      if (url.hostname.toLowerCase() === "goo.gl") return url.pathname.startsWith("/maps");
      return url.pathname.startsWith("/maps") || url.searchParams.has("q");
    } catch {
      return false;
    }
  }

  function isShortGoogleMapsUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      return host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"));
    } catch {
      return false;
    }
  }

  function decimal(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampCoord(lat, lng) {
    if (lat === null || lng === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return {
      lat: Number(lat.toFixed(7)),
      lng: Number(lng.toFixed(7))
    };
  }

  function parseLatLngPair(pair, hint) {
    const match = String(pair || "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;

    const first = decimal(match[1]);
    const second = decimal(match[2]);
    if (first === null || second === null) return null;

    if (hint === "lnglat" || (Math.abs(first) > 90 && Math.abs(second) <= 90)) {
      return clampCoord(second, first);
    }
    return clampCoord(first, second);
  }

  function extractCoordinatesFromGoogleText(text) {
    const decoded = safeDecode(text);
    const candidates = [];

    const atMatches = [...decoded.matchAll(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,[^/?#\s]*)?/g)];
    for (const match of atMatches) {
      const coords = clampCoord(decimal(match[1]), decimal(match[2]));
      if (coords) candidates.push({ ...coords, source: "@lat,lng" });
    }

    const dataMatches = [...decoded.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
    for (const match of dataMatches) {
      const coords = clampCoord(decimal(match[1]), decimal(match[2]));
      if (coords) candidates.push({ ...coords, source: "!3d!4d" });
    }

    const reversedDataMatches = [...decoded.matchAll(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/g)];
    for (const match of reversedDataMatches) {
      const coords = clampCoord(decimal(match[2]), decimal(match[1]));
      if (coords) candidates.push({ ...coords, source: "!2d!3d" });
    }

    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function extractQueryCoordinates(url) {
    const coordKeys = ["query", "q", "ll", "center", "destination", "daddr"];
    for (const key of coordKeys) {
      const value = url.searchParams.get(key);
      const coords = parseLatLngPair(value, "latlng");
      if (coords) return { ...coords, source: `query:${key}` };
    }
    return null;
  }

  function extractGoogleLabel(url) {
    const keys = ["query", "q", "destination", "daddr"];
    for (const key of keys) {
      const value = url.searchParams.get(key);
      if (value && !parseLatLngPair(value)) return cleanLabel(value);
    }

    const parts = url.pathname.split("/").map(cleanLabel).filter(Boolean);
    const markerIndex = parts.findIndex((part) => part === "place" || part === "search" || part === "dir");
    if (markerIndex >= 0 && parts[markerIndex + 1]) {
      return cleanLabel(parts[markerIndex + 1]);
    }

    return "";
  }

  function parseGoogleMapsUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    if (!isGoogleMapsUrl(url.href)) return null;

    const decodedHref = safeDecode(url.href);
    const coords = extractQueryCoordinates(url) || extractCoordinatesFromGoogleText(decodedHref);
    const label = extractGoogleLabel(url);

    return {
      kind: "google-url",
      url: url.href,
      label,
      coords,
      isShort: isShortGoogleMapsUrl(url.href)
    };
  }

  function extractPrefecture(text) {
    const value = normalizeText(text);
    return JP_PREFECTURES.find((prefecture) => value.includes(prefecture)) || "";
  }

  function isLikelyDetailedJapaneseAddress(text) {
    const value = normalizeText(text);
    const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
    const hasAddressNumber = /[0-9０-９]/.test(value) && /丁目|番地?|号|-\s*[0-9０-９]|－\s*[0-9０-９]/.test(value);
    const hasMunicipality = /[都道府県市区町村郡]/.test(value);
    return hasJapanese && hasAddressNumber && hasMunicipality;
  }

  function stripUrlFromText(text, url) {
    return normalizeText(String(text || "").replace(url, " ")).trim();
  }

  function analyzeInput(rawInput) {
    const input = normalizeText(rawInput);
    const url = extractFirstUrl(input);
    if (url) {
      const parsed = parseGoogleMapsUrl(url);
      if (parsed) {
        const residue = stripUrlFromText(input, url);
        return {
          ...parsed,
          rawInput: input,
          keyword: parsed.label || "",
          residue
        };
      }
    }

    const coords = parseLatLngPair(input);
    if (coords) {
      return {
        kind: "coordinates",
        rawInput: input,
        keyword: "",
        label: "坐标位置",
        coords
      };
    }

    return {
      kind: "address",
      rawInput: input,
      keyword: input,
      label: "",
      coords: null,
      prefecture: extractPrefecture(input)
    };
  }

  function fixedCoord(value) {
    return Number(value).toFixed(7).replace(/0+$/g, "").replace(/\.$/, "");
  }

  function encodeQuery(value) {
    return encodeURIComponent(String(value || ""));
  }

  function encodeParamValue(key, value) {
    if (["position", "to", "center"].includes(key)) {
      return String(value)
        .split(",")
        .map((part) => encodeQuery(part))
        .join(",");
    }
    return encodeQuery(value);
  }

  function buildQuery(params) {
    return Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
      .map(([key, value]) => `${encodeQuery(key)}=${encodeParamValue(key, value)}`)
      .join("&");
  }

  function buildAmapMarker({ coords, name, src = DEFAULT_SOURCE }) {
    const label = sanitizeAmapName(name);
    const position = `${fixedCoord(coords.lng)},${fixedCoord(coords.lat)}`;
    return `https://uri.amap.com/marker?${buildQuery({
      position,
      name: label,
      coordinate: "wgs84",
      callnative: "1",
      src
    })}`;
  }

  function buildIosAmapMarker({ coords, name, src = DEFAULT_SOURCE }) {
    const label = sanitizeAmapName(name);
    return `iosamap://viewMap?${buildQuery({
      sourceApplication: src,
      lat: fixedCoord(coords.lat),
      lon: fixedCoord(coords.lng),
      poiname: label,
      dev: "1"
    })}`;
  }

  function buildAndroidAmapMarker({ coords, name, src = DEFAULT_SOURCE }) {
    const label = sanitizeAmapName(name);
    return `androidamap://viewMap?${buildQuery({
      sourceApplication: src,
      lat: fixedCoord(coords.lat),
      lon: fixedCoord(coords.lng),
      poiname: label,
      dev: "1"
    })}`;
  }

  function buildAmapSearch({ keyword, coords, city, src = DEFAULT_SOURCE }) {
    const safeKeyword = coords ? sanitizeAmapName(keyword) : keyword;
    const params = {
      keyword: safeKeyword || "日本",
      city,
      view: "map",
      callnative: "1",
      src
    };
    if (coords) {
      params.center = `${fixedCoord(coords.lng)},${fixedCoord(coords.lat)}`;
    }
    return `https://uri.amap.com/search?${buildQuery(params)}`;
  }

  function buildAmapLinks({ coords, name, keyword, city }) {
    const links = {
      search: buildAmapSearch({ keyword: keyword || name, coords, city })
    };
    if (coords) {
      links.marker = buildAmapMarker({ coords, name: name || keyword });
      links.appMarkerIos = buildIosAmapMarker({ coords, name: name || keyword });
      links.appMarkerAndroid = buildAndroidAmapMarker({ coords, name: name || keyword });
    }
    return links;
  }

  function normalizeNominatimResult(item) {
    const lat = decimal(item.lat);
    const lng = decimal(item.lon);
    const coords = clampCoord(lat, lng);
    if (!coords) return null;

    return {
      id: String(item.place_id || `${item.lat},${item.lon}`),
      name: item.name || item.display_name || "目的地",
      displayName: item.display_name || item.name || "目的地",
      type: [item.class, item.type].filter(Boolean).join(" / "),
      provider: "nominatim",
      importance: Number(item.importance || 0),
      coords
    };
  }

  function normalizeGsiResult(item, index = 0) {
    const coordinates = item?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

    const lng = decimal(coordinates[0]);
    const lat = decimal(coordinates[1]);
    const coords = clampCoord(lat, lng);
    if (!coords) return null;

    const title = item?.properties?.title || "住所候補";
    const source = item?.properties?.dataSource ? ` / ${item.properties.dataSource}` : "";

    return {
      id: `gsi-${index}-${title}`,
      name: title,
      displayName: title,
      type: `国土地理院${source}`,
      provider: "gsi",
      importance: 1,
      coords
    };
  }

  function buildNominatimUrl(query) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("countrycodes", "jp");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "ja,zh-CN,en");
    url.searchParams.set("q", normalizeText(query));
    return url.href;
  }

  function isLikelyJapanCoords(coords) {
    if (!coords) return false;
    return coords.lat >= 20 && coords.lat <= 46 && coords.lng >= 122 && coords.lng <= 154;
  }

  return {
    analyzeInput,
    buildAmapLinks,
    buildAndroidAmapMarker,
    buildAmapMarker,
    buildAmapSearch,
    buildIosAmapMarker,
    buildSubAddressPrecisionNotice,
    buildNominatimUrl,
    cleanLabel,
    extractFirstUrl,
    extractPrefecture,
    extractSubAddressTokens,
    isGoogleMapsUrl,
    isLikelyJapanCoords,
    isLikelyDetailedJapaneseAddress,
    isShortGoogleMapsUrl,
    normalizeGsiResult,
    normalizeNominatimResult,
    normalizeText,
    parseGoogleMapsUrl,
    parseLatLngPair,
    sanitizeAmapName
  };
});
