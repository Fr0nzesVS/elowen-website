(() => {
  "use strict";

  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
  const BUCKET = "shorts-videos";
  const ICONS = {
    heart: '<svg viewBox="0 0 24 24"><path d="M20.8 8.7c0 4.2-8.8 10-8.8 10s-8.8-5.8-8.8-10a4.7 4.7 0 0 1 8.8-2.3 4.7 4.7 0 0 1 8.8 2.3z"/></svg>',
    comment: '<svg viewBox="0 0 24 24"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.5a7.5 7.5 0 1 1 17-4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15 9l6 6m0-6-6 6"/></svg>',
    unmuted: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13"/></svg>'
  };
  const feed = document.querySelector("#feed");
  const template = document.querySelector("#short-template");
  const emptyState = document.querySelector("#empty-state");
  const status = document.querySelector("#status");
  const setupOverlay = document.querySelector("#setup-overlay");
  const setupError = document.querySelector("#setup-error");
  const uploadOverlay = document.querySelector("#upload-overlay");
  const uploadForm = document.querySelector("#upload-form");
  const uploadError = document.querySelector("#upload-error");
  const fileInput = document.querySelector("#video-file");
  const preview = document.querySelector("#preview-video");
  const configStorageKey = "kadr-supabase-config";
  const activeSessionKey = "kadr-supabase-session";
  const supportedCategories = ["Для тебя", "Путешествия", "Природа", "Музыка", "Еда"];
  let config = null;
  let user = null;
  let profile = null;
  let session = null;
  let videos = [];
  let likedVideoIds = new Set();
  let activeCategory = "Для тебя";
  let previewUrl = "";
  let commentVideoId = "";
  let statusTimer = 0;
  let observer = null;

  function showStatus(message, duration = 4000) {
    status.textContent = message;
    window.clearTimeout(statusTimer);
    if (message) statusTimer = window.setTimeout(() => { status.textContent = ""; }, duration);
  }

  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function getStoredConfig() {
    const publishedConfig = window.SHORTS_CONFIG || {};
    let localConfig = {};
    const saved = window.localStorage.getItem(configStorageKey);
    if (saved) {
      try {
        localConfig = JSON.parse(saved);
      } catch {
        throw new Error("Сохранённые настройки подключения повреждены. Удали их и подключи проект ещё раз.");
      }
    }
    const url = String(localConfig.url || publishedConfig.url || "").trim().replace(/\/+$/, "");
    const anonKey = String(localConfig.anonKey || publishedConfig.anonKey || "").trim();
    if (!url && !anonKey) return null;
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Supabase Project URL указан неправильно. Пример: https://your-project.supabase.co");
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
      throw new Error("Для подключения Supabase требуется безопасный HTTPS-адрес проекта.");
    }
    if (!anonKey || /service[_-]?role|secret/i.test(anonKey)) {
      throw new Error("Укажи публичный Supabase publishable/anon key, а не секретный ключ.");
    }
    return { url, anonKey };
  }

  function getSavedSessionKey() {
    return `${activeSessionKey}:${new URL(config.url).host}`;
  }

  async function decodeResponse(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(`Supabase вернул ошибку HTTP ${response.status}. Проверь настройки проекта.`);
      throw new Error("Supabase вернул неожиданный ответ. Проверь адрес проекта.");
    }
  }

  async function authRequest(path, body) {
    let response;
    try {
      response = await fetch(`${config.url}/auth/v1/${path}`, {
        method: "POST",
        headers: { apikey: config.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error("Не удалось подключиться к Supabase. Проверь интернет, адрес проекта и CORS-настройки.");
    }
    const result = await decodeResponse(response);
    if (!response.ok) {
      throw new Error(result?.msg || result?.message || result?.error_description || result?.error || `Ошибка авторизации Supabase (${response.status}).`);
    }
    return result;
  }

  function saveSession(nextSession) {
    session = {
      access_token: nextSession.access_token,
      refresh_token: nextSession.refresh_token,
      expires_at: nextSession.expires_at || Math.floor(Date.now() / 1000) + (nextSession.expires_in || 3600),
      user: nextSession.user
    };
    window.localStorage.setItem(getSavedSessionKey(), JSON.stringify(session));
    user = session.user;
  }

  function readSession() {
    const saved = window.localStorage.getItem(getSavedSessionKey());
    if (!saved) return null;
    try {
      const stored = JSON.parse(saved);
      return stored.access_token && stored.refresh_token && stored.user?.id ? stored : null;
    } catch {
      throw new Error("Сохранённая сессия пользователя повреждена. Удали подключение и подключись заново.");
    }
  }

  async function ensureSession() {
    if (!session) session = readSession();
    if (session && session.expires_at > Math.floor(Date.now() / 1000) + 45) {
      user = session.user;
      return session;
    }
    if (session?.refresh_token) {
      const refreshed = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      saveSession(refreshed);
      return session;
    }
    const created = await authRequest("signup", { data: {} });
    if (!created.access_token || !created.refresh_token || !created.user?.id) {
      throw new Error("Supabase не создал гостевую сессию. Включи Anonymous Sign-Ins в настройках Auth.");
    }
    saveSession(created);
    return session;
  }

  async function supabaseRequest(path, options = {}, retry = true) {
    await ensureSession();
    let response;
    try {
      response = await fetch(`${config.url}${path}`, {
        ...options,
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${session.access_token}`,
          ...(options.body && !(options.body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
          ...options.headers
        }
      });
    } catch {
      throw new Error("Не удалось связаться с Supabase. Проверь интернет-соединение.");
    }
    if (response.status === 401 && retry && session.refresh_token) {
      session.expires_at = 0;
      await ensureSession();
      return supabaseRequest(path, options, false);
    }
    const result = await decodeResponse(response);
    if (!response.ok) {
      const detail = result?.message || result?.msg || result?.error_description || result?.hint;
      throw new Error(detail || `Ошибка Supabase (${response.status}). Проверь разрешения базы данных.`);
    }
    return result;
  }

  function api(table, query = "", options = {}) {
    return supabaseRequest(`/rest/v1/${table}${query ? `?${query}` : ""}`, options);
  }

  async function ensureProfile() {
    await ensureSession();
    const found = await api("profiles", `select=id,username&id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (found.length) {
      profile = found[0];
      return profile;
    }
    const fallbackUsername = `creator_${user.id.slice(0, 8)}`;
    const created = await api("profiles", "", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ id: user.id, username: fallbackUsername })
    });
    profile = created[0];
    return profile;
  }

  function setEmpty(title, description, canUpload = false) {
    document.querySelector("#empty-title").textContent = title;
    document.querySelector("#empty-description").textContent = description;
    document.querySelector("#empty-setup").hidden = config !== null;
    emptyState.hidden = false;
    let uploadButton = document.querySelector("#empty-upload");
    if (canUpload && config) {
      if (!uploadButton) {
        uploadButton = document.createElement("button");
        uploadButton.id = "empty-upload";
        uploadButton.type = "button";
        uploadButton.className = "subtle-button";
        uploadButton.textContent = "Загрузить первое видео";
        uploadButton.addEventListener("click", openUpload);
        emptyState.append(uploadButton);
      }
      uploadButton.hidden = false;
    } else if (uploadButton) {
      uploadButton.hidden = true;
    }
  }

  function formatCount(count) {
    return new Intl.NumberFormat("ru-RU", {
      notation: count >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(count);
  }

  function videoPublicUrl(path) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return `${config.url}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
  }

  function resetObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const card = entry.target;
        card.dataset.visible = String(entry.isIntersecting && entry.intersectionRatio >= 0.65);
        if (!entry.isIntersecting) {
          card.removeAttribute("data-paused-by-user");
        }
      }
      updatePlayback();
    }, { root: feed, threshold: [0, 0.65, 0.9] });
    feed.querySelectorAll(".short").forEach((card) => observer.observe(card));
    requestAnimationFrame(updatePlayback);
  }

  function updatePlayback() {
    if (document.visibilityState === "hidden") {
      videos.forEach((video) => {
        const card = document.querySelector(`[data-video-id="${CSS.escape(video.id)}"]`);
        if (card) card.querySelector("video").pause();
      });
      return;
    }
    const candidates = [...feed.querySelectorAll(".short:not([hidden])")]
      .filter((card) => card.dataset.visible === "true")
      .sort((a, b) => {
        const root = feed.getBoundingClientRect();
        const middle = root.top + root.height / 2;
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return Math.abs(aRect.top + aRect.height / 2 - middle) - Math.abs(bRect.top + bRect.height / 2 - middle);
      });
    const selected = candidates[0];
    for (const card of feed.querySelectorAll(".short")) {
      const video = card.querySelector("video");
      if (card === selected && !card.dataset.pausedByUser) {
        video.play().catch(() => {
          card.classList.add("paused");
          showStatus("Нажми на видео, чтобы воспроизвести его.");
        });
      } else {
        video.pause();
      }
      if (card !== selected && card.dataset.visible === "true") {
        card.removeAttribute("data-paused-by-user");
      }
    }
  }

  function buildCard(item, position) {
    const card = template.content.firstElementChild.cloneNode(true);
    const video = card.querySelector("video");
    const count = (relation) => Number(relation?.[0]?.count || 0);
    const username = Array.isArray(item.profiles) ? item.profiles[0]?.username : item.profiles?.username;
    card.dataset.videoId = item.id;
    card.id = `short-${item.id}`;
    card.dataset.ownerId = item.user_id;
    card.dataset.category = item.category;
    card.dataset.title = item.title;
    card.dataset.username = username || "creator";
    card.dataset.likeCount = String(count(item.likes));
    video.src = videoPublicUrl(item.video_path);
    video.setAttribute("aria-label", `${item.title} — @${card.dataset.username}`);
    card.querySelector(".creator-name").textContent = `@${card.dataset.username}`;
    card.querySelector(".video-title").textContent = item.title;
    card.querySelector(".video-category").textContent = `#${item.category}`;
    card.querySelector(".video-index").textContent = `${String(position + 1).padStart(2, "0")} / ${String(videos.length).padStart(2, "0")}`;

    const likeButton = card.querySelector(".like-button");
    likeButton.querySelector(".action-icon").innerHTML = ICONS.heart;
    likeButton.setAttribute("aria-pressed", String(likedVideoIds.has(item.id)));
    likeButton.setAttribute("aria-label", likedVideoIds.has(item.id) ? "Убрать отметку «Нравится»" : "Нравится");
    likeButton.querySelector(".like-count").textContent = formatCount(count(item.likes));
    likeButton.classList.toggle("liked", likedVideoIds.has(item.id));

    const commentButton = card.querySelector(".comment-button");
    commentButton.querySelector(".action-icon").innerHTML = ICONS.comment;
    commentButton.querySelector(".comment-count").textContent = formatCount(count(item.comments));
    card.querySelector(".share-button .action-icon").innerHTML = ICONS.share;
    card.querySelector(".fullscreen-button .action-icon").innerHTML = ICONS.fullscreen;
    card.querySelector(".sound-toggle").innerHTML = ICONS.muted;
    card.querySelector(".sound-indicator").innerHTML = `${ICONS.muted}<span>ЗВУК ВЫКЛЮЧЕН</span>`;
    card.querySelector(".play-toggle").addEventListener("click", () => togglePlayback(card));
    video.addEventListener("play", () => card.classList.remove("paused"));
    video.addEventListener("pause", () => {
      if (card.dataset.visible === "true") card.classList.add("paused");
    });
    video.addEventListener("error", () => {
      card.classList.add("paused");
      showStatus(`Не удалось загрузить видео «${item.title}». Проверьте подключение и настройки Storage.`);
    });
    card.querySelector(".sound-toggle").addEventListener("click", () => toggleMute(card));
    likeButton.addEventListener("click", () => toggleLike(card, item.id));
    commentButton.addEventListener("click", () => openComments(item.id, item.title));
    card.querySelector(".share-button").addEventListener("click", () => shareVideo(card));
    card.querySelector(".fullscreen-button").addEventListener("click", () => toggleFullscreen(card));
    return card;
  }

  async function loadFeed() {
    emptyState.hidden = videos.length > 0;
    setEmpty("Загружаем видео…", "Получаем опубликованные видео из Supabase.");
    try {
      await ensureSession();
      await ensureProfile();
      const rows = await api(
        "shorts",
        "select=id,user_id,title,category,video_path,created_at,profiles(username),likes(count),comments(count)&order=created_at.desc&limit=500"
      );
      const likedRows = rows.length
        ? await api("likes", `select=video_id&user_id=eq.${encodeURIComponent(user.id)}&video_id=in.${encodeURIComponent(`(${rows.map((row) => row.id).join(",")})`)}`)
        : [];
      videos = rows;
      likedVideoIds = new Set(likedRows.map((row) => row.video_id));
      feed.querySelectorAll(".short").forEach((card) => card.remove());
      rows.forEach((row, index) => feed.insertBefore(buildCard(row, index), emptyState));
      emptyState.hidden = rows.length > 0;
      if (!rows.length) setEmpty("Здесь пока нет видео", "Загрузи первое видео MP4 — после публикации оно будет доступно в этой ленте.", true);
      activeCategory = document.querySelector(".category.active")?.dataset.category || "Для тебя";
      applyFilters();
      resetObserver();
      const sharedId = location.hash.slice("#short-".length);
      if (location.hash.startsWith("#short-")) {
        const sharedCard = document.getElementById(`short-${sharedId}`);
        if (sharedCard) sharedCard.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return true;
    } catch (error) {
      videos = [];
      feed.querySelectorAll(".short").forEach((card) => card.remove());
      setEmpty("Не удалось загрузить ленту", describeError(error), !config);
      if (!config) document.querySelector("#empty-setup").hidden = false;
      console.error("Failed to load the Supabase Shorts feed:", error);
      return false;
    }
  }

  function applyFilters() {
    const query = document.querySelector("#search").value.trim().toLocaleLowerCase("ru");
    const wantedCategory = activeCategory;
    const cards = [...feed.querySelectorAll(".short")];
    for (const card of cards) {
      const categoryMatches = wantedCategory === "Для тебя" || card.dataset.category === wantedCategory;
      const text = `${card.dataset.title} ${card.dataset.username} ${card.dataset.category}`.toLocaleLowerCase("ru");
      const searchMatches = !query || text.includes(query);
      card.hidden = !(categoryMatches && searchMatches);
      if (card.hidden) card.removeAttribute("data-visible");
    }
    const anyMatches = cards.some((card) => !card.hidden);
    if (videos.length && !anyMatches) setEmpty("Ничего не нашлось", "Попробуй другой поиск или выбери другую категорию.");
    else if (videos.length) emptyState.hidden = true;
    feed.scrollTop = 0;
    requestAnimationFrame(updatePlayback);
  }

  function selectCategory(category) {
    if (!supportedCategories.includes(category)) return;
    activeCategory = category;
    document.querySelectorAll(".category").forEach((button) => {
      const selected = button.dataset.category === category;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    applyFilters();
  }

  function togglePlayback(card) {
    const video = card.querySelector("video");
    if (video.paused) {
      card.removeAttribute("data-paused-by-user");
      video.play().then(() => card.classList.remove("paused")).catch((error) => {
        card.classList.add("paused");
        showStatus(`Не удалось воспроизвести видео: ${describeError(error)}`);
      });
    } else {
      card.dataset.pausedByUser = "true";
      video.pause();
      card.classList.add("paused");
    }
    card.querySelector(".play-toggle").setAttribute("aria-label", video.paused ? "Воспроизвести видео" : "Поставить видео на паузу");
  }

  function toggleMute(card) {
    const video = card.querySelector("video");
    video.muted = !video.muted;
    card.querySelector(".sound-toggle").innerHTML = video.muted ? ICONS.muted : ICONS.unmuted;
    card.querySelector(".sound-toggle").setAttribute("aria-label", video.muted ? "Включить звук" : "Выключить звук");
    card.querySelector(".sound-indicator").innerHTML = video.muted
      ? `${ICONS.muted}<span>ЗВУК ВЫКЛЮЧЕН</span>`
      : `${ICONS.unmuted}<span>ЗВУК ВКЛЮЧЁН</span>`;
  }

  async function toggleLike(card, videoId) {
    const button = card.querySelector(".like-button");
    const countElement = card.querySelector(".like-count");
    const isLiked = likedVideoIds.has(videoId);
    button.disabled = true;
    try {
      if (isLiked) {
        await api("likes", `video_id=eq.${encodeURIComponent(videoId)}&user_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
        likedVideoIds.delete(videoId);
      } else {
        await api("likes", "", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ video_id: videoId, user_id: user.id })
        });
        likedVideoIds.add(videoId);
      }
      const current = Number(card.dataset.likeCount || 0) + (isLiked ? -1 : 1);
      card.dataset.likeCount = String(Math.max(0, current));
      countElement.textContent = formatCount(Math.max(0, current));
      button.setAttribute("aria-pressed", String(!isLiked));
      button.setAttribute("aria-label", isLiked ? "Нравится" : "Убрать отметку «Нравится»");
      button.classList.toggle("liked", !isLiked);
      showStatus(isLiked ? "Отметка «Нравится» удалена." : "Видео понравилось.");
    } catch (error) {
      showStatus(`Не удалось сохранить отметку: ${describeError(error)}`);
      console.error("Failed to save a like:", error);
    } finally {
      button.disabled = false;
    }
  }

  function appendComment(row, username, text) {
    const item = document.createElement("article");
    item.className = "comment";
    const author = document.createElement("strong");
    author.textContent = `@${username || "creator"}`;
    const body = document.createElement("p");
    body.textContent = text;
    item.append(author, body);
    const first = document.querySelector("#comment-list").firstChild;
    document.querySelector("#comment-list").insertBefore(item, first);
    if (row?.id) item.dataset.commentId = row.id;
  }

  async function openComments(videoId, title) {
    commentVideoId = videoId;
    document.querySelector("#comments-title").textContent = "Комментарии";
    document.querySelector("#comment-list").replaceChildren();
    document.querySelector("#comments-overlay").classList.add("open");
    document.querySelector("#comment-input").focus();
    try {
      const rows = await api(
        "comments",
        `select=id,body,created_at,profiles(username)&video_id=eq.${encodeURIComponent(videoId)}&order=created_at.asc`
      );
      const list = document.querySelector("#comment-list");
      list.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "panel-copy";
        empty.textContent = `«${title}» — первым оставь комментарий.`;
        list.append(empty);
      } else {
        rows.forEach((row) => {
          const author = Array.isArray(row.profiles) ? row.profiles[0]?.username : row.profiles?.username;
          appendComment(row, author, row.body);
        });
        list.querySelectorAll(".comment").forEach((comment) => list.append(comment));
      }
    } catch (error) {
      document.querySelector("#comment-list").textContent = `Не удалось загрузить комментарии: ${describeError(error)}`;
      console.error("Failed to load comments:", error);
    }
  }

  async function shareVideo(card) {
    const shareData = {
      title: card.dataset.title,
      text: `@${card.dataset.username} — ${card.dataset.title}`,
      url: `${location.href.split("#")[0]}#short-${encodeURIComponent(card.dataset.videoId)}`
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareData.url);
        showStatus("Ссылка на ленту скопирована.");
      } else {
        throw new Error("Копирование недоступно. Открой сайт по HTTPS и попробуй ещё раз.");
      }
    } catch (error) {
      if (error.name !== "AbortError") showStatus(`Не удалось поделиться ссылкой: ${describeError(error)}`);
    }
  }

  async function toggleFullscreen(card) {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (card.requestFullscreen) {
        await card.requestFullscreen();
      } else {
        const video = card.querySelector("video");
        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else throw new Error("Полноэкранный режим не поддерживается этим браузером.");
      }
    } catch (error) {
      showStatus(`Не удалось открыть полноэкранный режим: ${describeError(error)}`);
    }
  }

  async function openUpload() {
    if (!config) {
      showStatus("Сначала подключи бесплатный проект Supabase.");
      openSetup();
      return;
    }
    try {
      await ensureSession();
      if (!profile) await ensureProfile();
      document.querySelector("#video-username").value = profile.username;
      uploadError.textContent = "";
      uploadOverlay.classList.add("open");
    } catch (error) {
      showStatus(`Не удалось подготовить загрузку: ${describeError(error)}`);
      console.error("Failed to prepare video upload:", error);
    }
  }

  function showPreview() {
    const file = fileInput.files?.[0];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    preview.pause();
    preview.removeAttribute("src");
    preview.classList.remove("visible");
    uploadError.textContent = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".mp4") || (file.type && file.type !== "video/mp4")) {
      fileInput.value = "";
      uploadError.textContent = "Выбери видеофайл MP4.";
      return;
    }
    if (!file.size || file.size > MAX_VIDEO_BYTES) {
      fileInput.value = "";
      uploadError.textContent = "Видео пустое или больше лимита 50 МБ. Выбери файл меньшего размера.";
      return;
    }
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.classList.add("visible");
    document.querySelector("#video-title").value = file.name.replace(/\.mp4$/i, "").slice(0, 120);
  }

  function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function uploadFile(file, path) {
    await ensureSession();
    const response = await fetch(`${config.url}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "video/mp4",
        "Cache-Control": "3600",
        "x-upsert": "false"
      },
      body: file
    });
    const result = await decodeResponse(response);
    if (!response.ok) throw new Error(result?.message || result?.error || `Загрузка видео не удалась (${response.status}). Проверьте доступ к Storage.`);
  }

  async function deleteUploadedFile(path) {
    return supabaseRequest(`/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: [path] })
    });
  }

  async function publishVideo(event) {
    event.preventDefault();
    uploadError.textContent = "";
    const file = fileInput.files?.[0];
    const title = document.querySelector("#video-title").value.trim();
    const username = document.querySelector("#video-username").value.trim().replace(/^@/, "").toLowerCase();
    const category = document.querySelector("#video-category-select").value;
    if (!file || !file.name.toLowerCase().endsWith(".mp4") || (file.type && file.type !== "video/mp4")) {
      uploadError.textContent = "Выбери видеофайл MP4.";
      return;
    }
    if (!file.size || file.size > MAX_VIDEO_BYTES) {
      uploadError.textContent = "Размер видео должен быть от 1 байта до 50 МБ.";
      return;
    }
    if (!/^[A-Za-z0-9_]{2,24}$/.test(username)) {
      uploadError.textContent = "Имя: 2–24 символа, только латинские буквы, цифры и _.";
      return;
    }
    const publishButton = document.querySelector("#publish-video");
    publishButton.disabled = true;
    publishButton.textContent = "Загружаем видео…";
    try {
      await ensureSession();
      await ensureProfile();
      await api(`profiles`, `id=eq.${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ username })
      });
      profile.username = username;
      document.querySelector("#video-username").value = username;

      const path = `${user.id}/${randomId()}.mp4`;
      await uploadFile(file, path);
      try {
        await api("shorts", "", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: user.id, title, category, video_path: path })
        });
      } catch (databaseError) {
        try {
          await deleteUploadedFile(path);
        } catch (cleanupError) {
          throw new Error(`Не удалось опубликовать видео: ${describeError(databaseError)} Не удалось удалить загруженный файл: ${describeError(cleanupError)}`);
        }
        throw databaseError;
      }
      preview.pause();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      uploadForm.reset();
      preview.removeAttribute("src");
      preview.classList.remove("visible");
      uploadOverlay.classList.remove("open");
      showStatus("Видео опубликовано и сохранено в облаке.");
      await loadFeed();
    } catch (error) {
      uploadError.textContent = describeError(error);
      console.error("Failed to publish video:", error);
    } finally {
      publishButton.disabled = false;
      publishButton.textContent = "Опубликовать видео";
    }
  }

  function openSetup() {
    document.querySelector("#project-url").value = config?.url || "";
    document.querySelector("#publishable-key").value = config?.anonKey || "";
    setupError.textContent = "";
    document.querySelector("#connection-state").textContent = config
      ? `Подключено к ${new URL(config.url).host}.`
      : "Сначала создай проект Supabase и запусти supabase-schema.sql из папки сайта.";
    setupOverlay.classList.add("open");
  }

  async function saveConfiguration(event) {
    event.preventDefault();
    setupError.textContent = "";
    const previous = config;
    const savedBefore = window.localStorage.getItem(configStorageKey);
    const newConfig = {
      url: document.querySelector("#project-url").value.trim().replace(/\/+$/, ""),
      anonKey: document.querySelector("#publishable-key").value.trim()
    };
    if (!newConfig.url || !newConfig.anonKey || /service[_-]?role|secret/i.test(newConfig.anonKey)) {
      setupError.textContent = "Введи HTTPS Project URL и публичный publishable/anon key. Секретные ключи использовать нельзя.";
      return;
    }
    try {
      config = newConfig;
      window.localStorage.setItem(configStorageKey, JSON.stringify(newConfig));
      session = null;
      user = null;
      profile = null;
      await ensureSession();
      await ensureProfile();
      setupOverlay.classList.remove("open");
      showStatus("Supabase подключён. Можно загружать видео.");
      await loadFeed();
    } catch (error) {
      config = previous;
      session = null;
      user = null;
      profile = null;
      if (savedBefore) window.localStorage.setItem(configStorageKey, savedBefore);
      else window.localStorage.removeItem(configStorageKey);
      setupError.textContent = `${describeError(error)} Если впервые настроил проект, включи Anonymous Sign-Ins и выполни supabase-schema.sql.`;
      console.error("Failed to connect the Supabase project:", error);
    }
  }

  function closeOverlay(overlay) {
    overlay.classList.remove("open");
    if (overlay === uploadOverlay) preview.pause();
  }

  function attachEvents() {
    document.querySelector("#open-upload").addEventListener("click", openUpload);
    document.querySelector("#mobile-upload").addEventListener("click", openUpload);
    document.querySelectorAll(".open-setup").forEach((button) => button.addEventListener("click", openSetup));
    document.querySelector("#open-setup").addEventListener("click", openSetup);
    document.querySelector("#mobile-settings").addEventListener("click", openSetup);
    document.querySelector("#setup-form").addEventListener("submit", saveConfiguration);
    document.querySelector("#forget-config").addEventListener("click", () => {
      window.localStorage.removeItem(configStorageKey);
      if (config) window.localStorage.removeItem(`${activeSessionKey}:${new URL(config.url).host}`);
      config = null;
      session = null;
      user = null;
      profile = null;
      videos = [];
      feed.querySelectorAll(".short").forEach((card) => card.remove());
      setupError.textContent = "Сохранённое подключение удалено с этого устройства.";
      try {
        config = getStoredConfig();
      } catch (error) {
        setupError.textContent = describeError(error);
      }
      if (config) {
        loadFeed();
      } else {
        setEmpty("Подключи Supabase", "Добавь URL проекта и публичный ключ, чтобы загружать и смотреть видео.");
        document.querySelector("#empty-setup").hidden = false;
      }
    });
    document.querySelectorAll(".close-overlay").forEach((button) => button.addEventListener("click", () => {
      closeOverlay(button.closest(".overlay"));
    }));
    document.querySelectorAll(".overlay").forEach((overlay) => overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOverlay(overlay);
    }));
    document.querySelector("#comment-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.querySelector("#comment-input");
      const body = input.value.trim();
      if (!body || !commentVideoId) return;
      const sendButton = event.currentTarget.querySelector("button");
      sendButton.disabled = true;
      try {
        await ensureSession();
        await ensureProfile();
        const inserted = await api("comments", "", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ video_id: commentVideoId, user_id: user.id, body })
        });
        const item = videos.find((video) => video.id === commentVideoId);
        document.querySelector("#comment-list").querySelector(".panel-copy")?.remove();
        appendComment(inserted[0], profile.username, body);
        input.value = "";
        if (item) {
          if (!Array.isArray(item.comments) || !item.comments.length) item.comments = [{ count: 0 }];
          item.comments[0].count += 1;
        }
        const count = document.querySelector(`[data-video-id="${CSS.escape(commentVideoId)}"] .comment-count`);
        if (count) count.textContent = formatCount(item.comments[0].count);
      } catch (error) {
        const message = document.createElement("p");
        message.className = "form-error";
        message.setAttribute("role", "alert");
        message.textContent = `Не удалось отправить комментарий: ${describeError(error)}`;
        document.querySelector("#comment-list").append(message);
        console.error("Failed to add a comment:", error);
      } finally {
        sendButton.disabled = false;
      }
    });
    fileInput.addEventListener("change", showPreview);
    uploadForm.addEventListener("submit", publishVideo);
    document.querySelector("#search").addEventListener("input", applyFilters);
    document.querySelectorAll(".category").forEach((button) => button.addEventListener("click", () => selectCategory(button.dataset.category)));
    document.querySelectorAll("[data-category-link]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      selectCategory(link.dataset.categoryLink);
    }));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        document.querySelectorAll(".overlay.open").forEach(closeOverlay);
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") &&
        !event.target.matches("input, select, textarea") &&
        !document.querySelector(".overlay.open")) {
        event.preventDefault();
        feed.scrollBy({ top: (event.key === "ArrowDown" ? 1 : -1) * feed.clientHeight, behavior: "smooth" });
      }
    });
    document.addEventListener("visibilitychange", updatePlayback);
  }

  async function initialize() {
    attachEvents();
    try {
      config = getStoredConfig();
    } catch (error) {
      console.error("Invalid Supabase configuration:", error);
      setEmpty("Проверь настройки подключения", describeError(error));
      openSetup();
      return;
    }
    if (!config) {
      setEmpty("Подключи бесплатный Supabase", "Добавь адрес проекта и публичный ключ, чтобы загружать реальные MP4-видео и хранить их в облаке.");
      document.querySelector("#empty-setup").hidden = false;
      return;
    }
    await loadFeed();
  }

  initialize();
})();
