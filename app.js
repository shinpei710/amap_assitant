const Converter = window.amap_assitantConverter;

const elements = {
  form: document.querySelector("[data-form]"),
  input: document.querySelector("[data-input]"),
  convertButton: document.querySelector("[data-convert]"),
  openButton: document.querySelector("[data-convert-open]"),
  status: document.querySelector("[data-status]"),
  resultPanel: document.querySelector("[data-result]"),
  busyPanel: document.querySelector("[data-busy-panel]"),
  busyTitle: document.querySelector("[data-busy-title]"),
  busyText: document.querySelector("[data-busy-text]"),
  resultTitle: document.querySelector("[data-result-title]"),
  resultMeta: document.querySelector("[data-result-meta]"),
  primaryLink: document.querySelector("[data-primary-link]"),
  copyButton: document.querySelector("[data-copy]"),
  searchLink: document.querySelector("[data-search-link]"),
  googleLink: document.querySelector("[data-google-link]"),
  candidates: document.querySelector("[data-candidates]"),
  preview: document.querySelector("[data-preview]"),
  previewEmpty: document.querySelector("[data-preview-empty]"),
  previewFrame: document.querySelector("[data-preview-frame]"),
  notices: document.querySelector("[data-notices]"),
  serverState: document.querySelector("[data-server-state]")
};

const BROWSER_MODE = "auto";

const state = {
  current: null,
  shouldOpenAfterConvert: false
};

function setStatus(text, tone = "neutral") {
  elements.status.textContent = text;
  elements.status.dataset.tone = tone;
  if (!elements.busyPanel.hidden && document.body.dataset.busy === "true") {
    elements.busyText.textContent = text;
  }
}

function setBusy(isBusy) {
  elements.convertButton.disabled = isBusy;
  elements.openButton.disabled = isBusy;
  elements.convertButton.setAttribute("aria-busy", String(isBusy));
  elements.openButton.setAttribute("aria-busy", String(isBusy));
  document.body.dataset.busy = String(isBusy);
  if (isBusy) {
    elements.busyPanel.hidden = false;
    elements.busyPanel.dataset.state = "busy";
    elements.busyTitle.textContent = "转换中";
    elements.searchLink.hidden = true;
    elements.busyText.textContent = elements.status.textContent || "正在处理。";
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function buildOsmPreviewUrl(coords) {
  const lat = Number(coords.lat);
  const lng = Number(coords.lng);
  const delta = 0.0045;
  const bbox = [
    (lng - delta).toFixed(6),
    (lat - delta).toFixed(6),
    (lng + delta).toFixed(6),
    (lat + delta).toFixed(6)
  ].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat.toFixed(7)},${lng.toFixed(7)}`;
}

function setPreview(coords) {
  if (!coords) {
    elements.preview.hidden = true;
    elements.previewFrame.removeAttribute("src");
    elements.previewEmpty.hidden = false;
    return;
  }

  elements.previewFrame.src = buildOsmPreviewUrl(coords);
  elements.preview.hidden = false;
  elements.previewEmpty.hidden = true;
}

function getPrimaryLink(links) {
  if (links.marker) return links.marker;
  return links.search;
}

function getAppLink(links) {
  const userAgent = navigator.userAgent || "";
  const isiOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(userAgent);

  if (isiOS) return links.appMarkerIos || "";
  if (isAndroid) return links.appMarkerAndroid || "";
  return "";
}

function openWithAppFallback(result) {
  const webLink = getPrimaryLink(result.links);
  const appLink = getAppLink(result.links);
  if (!appLink) {
    window.location.href = webLink;
    return;
  }

  setStatus("正在尝试打开高德 App；跳转失败可点手动跳转。", "ok");
  showManualFallback(getPrimaryLink(result.links));
  window.location.href = appLink;
}

function showManualFallback(link) {
  elements.busyPanel.hidden = false;
  elements.busyPanel.dataset.state = "ready";
  elements.busyTitle.textContent = "已尝试跳转";
  elements.busyText.textContent = "如果高德 App 没有打开，可以使用备用链接。";
  elements.searchLink.href = link;
  elements.searchLink.hidden = false;
}

function hideManualFallback() {
  elements.busyPanel.hidden = true;
  elements.busyPanel.dataset.state = "idle";
  elements.searchLink.hidden = true;
  elements.searchLink.removeAttribute("href");
}

function showNotices(notices) {
  elements.notices.innerHTML = "";
  elements.notices.hidden = !notices.length;
  for (const notice of notices) {
    const item = document.createElement("li");
    item.textContent = notice;
    elements.notices.append(item);
  }
}

function setResult(result) {
  state.current = result;

  const primaryLink = getPrimaryLink(result.links);
  elements.resultPanel.classList.remove("is-fresh");
  window.requestAnimationFrame(() => {
    elements.resultPanel.classList.add("is-fresh");
  });
  elements.resultPanel.hidden = false;
  elements.resultTitle.textContent = result.title;
  elements.resultMeta.textContent = result.meta;
  elements.primaryLink.hidden = false;
  elements.primaryLink.href = primaryLink;
  elements.primaryLink.textContent = getAppLink(result.links)
    ? "尝试打开高德 App"
    : "打开高德地点";
  elements.copyButton.disabled = !primaryLink;

  if (result.links.search) {
    showManualFallback(primaryLink);
  } else {
    hideManualFallback();
  }

  if (result.sourceGoogleUrl) {
    elements.googleLink.href = result.sourceGoogleUrl;
    elements.googleLink.hidden = false;
  } else {
    elements.googleLink.hidden = true;
  }

  setPreview(result.coords);
  showNotices(result.notices || []);
}

function setFailureResult({ title, meta, sourceGoogleUrl, notices }) {
  state.current = null;
  elements.resultPanel.hidden = false;
  elements.resultTitle.textContent = title;
  elements.resultMeta.textContent = meta;
  elements.primaryLink.hidden = true;
  elements.primaryLink.removeAttribute("href");
  elements.copyButton.disabled = true;
  hideManualFallback();
  if (sourceGoogleUrl) {
    elements.googleLink.href = sourceGoogleUrl;
    elements.googleLink.hidden = false;
  } else {
    elements.googleLink.hidden = true;
  }
  setPreview(null);
  showNotices(notices || []);
}

function renderCandidates(candidates, onPick) {
  elements.candidates.innerHTML = "";
  elements.candidates.hidden = !candidates.length;

  candidates.forEach((candidate, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `candidate-row${index === 0 ? " is-selected" : ""}`;
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(candidate.displayName)}</strong>
        <small>${escapeHtml(candidate.type || "OpenStreetMap")}</small>
      </span>
      <span class="candidate-coords">${candidate.coords.lat.toFixed(5)}, ${candidate.coords.lng.toFixed(5)}</span>
    `;
    button.addEventListener("click", () => {
      [...elements.candidates.querySelectorAll(".candidate-row")].forEach((row) => row.classList.remove("is-selected"));
      button.classList.add("is-selected");
      onPick(candidate);
    });
    elements.candidates.append(button);
  });
}

async function copyPrimaryLink() {
  if (!state.current) return;
  const link = getPrimaryLink(state.current.links);
  try {
    await navigator.clipboard.writeText(link);
    setStatus("已复制高德链接。", "ok");
  } catch {
    setStatus("复制失败，可以长按主按钮复制链接。", "warn");
  }
}

async function expandShortUrlIfNeeded(input, analysis) {
  if (!analysis.url || !analysis.isShort) return { input, expandedUrl: "", notice: "" };
  if (!location.protocol.startsWith("http")) {
    return {
      input,
      expandedUrl: "",
      notice: "当前不是通过本地服务打开，无法自动展开 Google 短链接。"
    };
  }

  setStatus("正在展开短链接。");
  const response = await fetch(`/api/expand?mode=${encodeURIComponent(BROWSER_MODE)}&url=${encodeURIComponent(analysis.url)}`);
  const payload = await response.json();
  if (!payload.ok || !payload.expandedUrl) {
    return {
      input,
      expandedUrl: "",
      notice: payload.error ? `短链接展开失败：${payload.error}` : "短链接展开失败。"
    };
  }

  const notices = [];
  if (payload.browserAttempted && payload.browserError) {
    notices.push(`短链接解析失败：${payload.browserError}`);
  } else if (payload.browserAttempted) {
    notices.push("已尝试解析，但最终 Google 链接里仍没有坐标。");
  }

  return {
    input: `${payload.expandedUrl}\n${input}`,
    expandedUrl: payload.expandedUrl,
    notice: notices.join(" ")
  };
}

async function geocodeAddress(query) {
  const url = `/api/geocode?mode=${encodeURIComponent(BROWSER_MODE)}&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { "accept": "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "地理编码失败");
  }
  return payload;
}

function resultFromCoords({ analysis, coords, name, title, meta, sourceGoogleUrl, notices }) {
  const keyword = name || analysis.keyword || analysis.rawInput || "目的地";
  const city = analysis.prefecture || Converter.extractPrefecture(keyword);
  const links = Converter.buildAmapLinks({
    coords,
    name: keyword,
    keyword,
    city
  });

  return {
    title,
    meta,
    coords,
    links,
    sourceGoogleUrl,
    notices
  };
}

async function convert({ openAfter = false } = {}) {
  const rawInput = elements.input.value;
  if (!Converter.normalizeText(rawInput)) {
    setStatus("先粘贴一个日本地址或 Google Maps 链接。", "warn");
    elements.input.focus();
    return;
  }

  setBusy(true);
  state.shouldOpenAfterConvert = openAfter;
  elements.resultPanel.hidden = true;
  elements.candidates.hidden = true;
  hideManualFallback();
  setPreview(null);
  setStatus(openAfter ? "正在转换，成功后会打开高德。" : "正在解析输入。");

  const notices = [];
  try {
    let analysis = Converter.analyzeInput(rawInput);
    const expanded = await expandShortUrlIfNeeded(rawInput, analysis);
    if (expanded.notice) notices.push(expanded.notice);
    if (expanded.expandedUrl) {
      setStatus("短链接已展开，正在解析坐标。");
      analysis = Converter.analyzeInput(expanded.input);
    }

    if (analysis.coords) {
      const result = resultFromCoords({
        analysis,
        coords: analysis.coords,
        name: analysis.keyword || analysis.label,
        title: analysis.kind === "google-url" ? "已提取 Google 坐标" : "已识别坐标",
        meta: `${analysis.coords.lat.toFixed(6)}, ${analysis.coords.lng.toFixed(6)} -> 高德 WGS84`,
        sourceGoogleUrl: analysis.url || expanded.expandedUrl,
        notices: [
          ...notices,
          Converter.isLikelyJapanCoords(analysis.coords) ? "" : "这个坐标不像日本范围内的位置，请打开前核对。"
        ].filter(Boolean)
      });
      setResult(result);
      setStatus("转换完成。", "ok");
      if (openAfter) openWithAppFallback(result);
      return;
    }

    if (analysis.kind === "google-url") {
      const sourceGoogleUrl = analysis.url || expanded.expandedUrl || "";
      setFailureResult({
        title: "Google 链接没有坐标",
        meta: "短链接已展开，但最终链接里没有可提取的经纬度。",
        sourceGoogleUrl,
        notices: [
          ...notices,
          "这个工具不会用地点名做猜测转换；请在 Google 地图里打开该地点后，复制带坐标的分享链接，或直接粘贴经纬度。"
        ]
      });
      setStatus("转换失败：Google 链接里没有坐标。", "warn");
      return;
    }

    const query = analysis.keyword || analysis.rawInput;
    if (!Converter.isLikelyDetailedJapaneseAddress(query)) {
      setFailureResult({
        title: "没有可靠转换依据",
        meta: "请输入日本详细地址、带坐标的 Google 链接，或直接粘贴经纬度。",
        sourceGoogleUrl: "",
        notices: [
          ...notices,
          "不会用地点名或关键词做候选猜测，因为这正是高德海外搜索不可靠的部分。"
        ]
      });
      setStatus("转换失败：输入不像日本详细地址。", "warn");
      return;
    }

    setStatus("正在解析详细地址。");
    let geocodePayload = null;
    let candidates = [];
    try {
      geocodePayload = await geocodeAddress(query);
      candidates = geocodePayload.results || [];
      if (geocodePayload.notices?.length) notices.push(...geocodePayload.notices);
    } catch (error) {
      notices.push(`Google Maps 地址解析失败：${error.message}`);
    }

    if (candidates.length) {
      const buildCandidateResult = (candidate) => {
        const sourceGoogleUrl = candidate.sourceGoogleUrl || geocodePayload?.sourceGoogleUrl || "";
        return resultFromCoords({
          analysis,
          coords: candidate.coords,
          name: candidate.displayName || query,
          title: "已用 Google Maps 解析地址",
          meta: `${candidate.coords.lat.toFixed(6)}, ${candidate.coords.lng.toFixed(6)} -> 高德 WGS84`,
          sourceGoogleUrl,
          notices: [
            ...notices
          ].filter(Boolean)
        });
      };

      const firstResult = buildCandidateResult(candidates[0]);
      setResult(firstResult);
      renderCandidates(candidates.length > 1 ? candidates : [], (candidate) => setResult(buildCandidateResult(candidate)));
      setStatus("转换完成。", "ok");
      if (openAfter) openWithAppFallback(firstResult);
      return;
    }

    setFailureResult({
      title: "详细地址没有解析出坐标",
      meta: "Google Maps 浏览器搜索没有返回可靠坐标，因此不生成高德关键词搜索链接。",
      sourceGoogleUrl: "",
      notices: [
        ...notices,
        "可以换成更完整的日文地址，或从 Google 地图复制带坐标的链接。"
      ]
    });
    setStatus("转换失败：没有可靠坐标。", "warn");
  } catch (error) {
    setStatus(`转换失败：${error.message}`, "warn");
  } finally {
    setBusy(false);
    state.shouldOpenAfterConvert = false;
  }
}

async function checkServerState() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    elements.serverState.textContent = response.ok ? "本地服务已连接" : "静态模式";
    elements.serverState.dataset.state = response.ok ? "ok" : "warn";
  } catch {
    elements.serverState.textContent = "静态模式";
    elements.serverState.dataset.state = "warn";
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  convert({ openAfter: false });
});

elements.openButton.addEventListener("click", () => convert({ openAfter: true }));
elements.primaryLink.addEventListener("click", (event) => {
  if (!state.current) return;
  event.preventDefault();
  openWithAppFallback(state.current);
});
elements.copyButton.addEventListener("click", copyPrimaryLink);

document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.input.value = button.dataset.example;
    elements.input.focus();
  });
});

setPreview(null);
checkServerState();

if (window.lucide) {
  window.lucide.createIcons();
}
