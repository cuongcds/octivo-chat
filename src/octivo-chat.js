/**
 * Octivo Chat — embeddable widget for `website` channels with
 * website_theme = 'customize'. Self-contained: injects its own CSS + DOM
 * into the host page, so it can be dropped into any third-party site via
 * a single <script> tag. Independent from assets/plugins/livechat/
 * (used by the salon-booking/cashback/genlinks themes) — no shared code,
 * so this widget can evolve without risking those flows.
 *
 * Supports image attachments (JPG/PNG/GIF/WEBP, up to 8MB) via the
 * composer's attach button, and an emoji picker (emoji-picker-element,
 * lazy-loaded on first use — same library used elsewhere in this CRM).
 * On desktop, the header also has a full-screen toggle (expand the docked
 * popup to fill the viewport, and shrink it back) — state persists across
 * close/reopen within the same page session, but not across reloads.
 *
 * Usage:
 *   <script src=".../octivo-chat.js" data-channel="@abc123" async></script>
 *   // optional, any time after the script tag:
 *   window.OctivoChat.init({
 *     name: 'Jane', phone: '0901234567', autoOpen: true,
 *     showBubble: false,        // hide the floating button; open() from your own UI instead
 *     onClose: function () {},  // fired whenever the popup is closed
 *   });
 *   document.querySelector('#my-chat-button').addEventListener('click', OctivoChat.open);
 *   window.addEventListener('octivochat:close', function (e) { ... }); // same close notification as an event
 */
(function (global, document) {
  'use strict';

  var CSS_HREF = currentScriptBase() + 'octivo-chat.css';
  var API_BASE = currentScriptOrigin();
  var POLL_MS = 5000;
  var LS_PREFIX = 'octivo_chat_';

  var EMOJI_PICKER_SRC = 'https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js';
  var IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  var state = {
    channelSourceId: '',
    orgId: '',
    config: null,
    appUserCode: '',
    chatId: '',
    accessToken: '',
    open: false,
    lastMessageId: 0,
    pollTimer: null,
    sending: false,
    pendingInit: null,
    ready: false,
    showBubble: true,
    onClose: null,
    selectedFile: null,
    previewObjectUrl: '',
    fullscreen: false,
  };

  function currentScriptBase() {
    var src = document.currentScript ? document.currentScript.src : '';
    if (!src) return '/assets/plugins/octivo-chat/';
    return src.slice(0, src.lastIndexOf('/') + 1);
  }

  function currentScriptOrigin() {
    var src = document.currentScript ? document.currentScript.src : '';
    if (!src) return '';
    try {
      return new URL(src).origin;
    } catch (e) {
      return '';
    }
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var INPUT_MAX_LINES = 6;

  /** Grows the composer textarea to fit its content, capped at INPUT_MAX_LINES. */
  function autoResizeInput(el) {
    if (!el) return;
    var style = window.getComputedStyle(el);
    var lineHeight = parseFloat(style.lineHeight) || 20;
    var paddingTop = parseFloat(style.paddingTop) || 0;
    var paddingBottom = parseFloat(style.paddingBottom) || 0;
    var extra = paddingTop + paddingBottom;
    var maxHeight = lineHeight * INPUT_MAX_LINES + extra;

    el.style.height = 'auto';
    var targetHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = targetHeight + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  /**
   * Black or white, whichever reads better on top of the given hex color —
   * so the bubble/send icon and label stay legible regardless of how light
   * or dark the channel's configured primary_color is (relative luminance,
   * WCAG-style approximation).
   */
  function contrastColorFor(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return '#fff';
    var value = match[1];
    var r = parseInt(value.slice(0, 2), 16) / 255;
    var g = parseInt(value.slice(2, 4), 16) / 255;
    var b = parseInt(value.slice(4, 6), 16) / 255;
    var luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.6 ? '#182433' : '#fff';
  }

  function formatTime(value) {
    if (!value) return '';
    var d = typeof value === 'number'
      ? new Date(value * 1000)
      : new Date(String(value).replace(' ', 'T'));
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var opts = sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  }

  // ---- localStorage helpers (namespaced per org, distinct from GuestProfile's `salon_*` keys) ----

  function lsGet(key) {
    try { return localStorage.getItem(LS_PREFIX + key) || ''; } catch (e) { return ''; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, value); } catch (e) { /* ignore */ }
  }

  function orgKey(suffix) {
    return 'org_' + state.orgId + '_' + suffix;
  }

  function loadStoredSession() {
    state.appUserCode = lsGet('app_user_code');
    state.chatId = lsGet(orgKey('chat_id'));
    state.accessToken = lsGet(orgKey('access_token'));
  }

  function storeSession() {
    if (state.appUserCode) lsSet('app_user_code', state.appUserCode);
    if (state.chatId) lsSet(orgKey('chat_id'), state.chatId);
    if (state.accessToken) lsSet(orgKey('access_token'), state.accessToken);
  }

  function hasStoredSession() {
    return !!(state.appUserCode && state.chatId && state.accessToken);
  }

  // ---- DOM ----

  function injectCss() {
    if (document.querySelector('link[data-octivo-chat-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-octivo-chat-css', '1');
    document.head.appendChild(link);
  }

  function buildDom() {
    if ($('.octivo-chat-root')) return;

    var root = document.createElement('div');
    root.className = 'octivo-chat-root';
    root.innerHTML =
      '<button type="button" class="octivo-chat-fab octivo-chat-fab--right octivo-chat-hidden" id="octivoChatFab" aria-label="Chat">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
        '<span class="octivo-chat-fab__label octivo-chat-hidden" id="octivoChatFabLabel"></span>' +
      '</button>' +
      '<div class="octivo-chat-panel octivo-chat-hidden octivo-chat-panel--right" id="octivoChatPanel" aria-hidden="true">' +
        '<div class="octivo-chat-panel__backdrop" id="octivoChatBackdrop"></div>' +
        '<div class="octivo-chat-panel__sheet" role="dialog" aria-label="Chat">' +
          '<header class="octivo-chat-panel__header">' +
            '<div><h2 id="octivoChatTitle">Chat</h2><p class="octivo-chat-panel__sub" id="octivoChatSubtitle">Hỗ trợ trực tuyến</p></div>' +
            '<div class="octivo-chat-panel__header-actions">' +
              '<button type="button" class="octivo-chat-icon-btn octivo-chat-fullscreen-btn" id="octivoChatFullscreen" aria-label="Full screen" title="Mở rộng toàn màn hình">' +
                '<svg class="octivo-chat-icon-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4"/></svg>' +
                '<svg class="octivo-chat-icon-collapse octivo-chat-hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4v4a1 1 0 01-1 1H4M15 4v4a1 1 0 001 1h4M9 20v-4a1 1 0 00-1-1H4M15 20v-4a1 1 0 011-1h4"/></svg>' +
              '</button>' +
              '<button type="button" class="octivo-chat-icon-btn" id="octivoChatClose" aria-label="Close">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
              '</button>' +
            '</div>' +
          '</header>' +
          '<div class="octivo-chat-gate octivo-chat-hidden" id="octivoChatGate">' +
            '<p id="octivoChatGateGreeting"></p>' +
            '<div id="octivoChatGateNameField">' +
              '<label for="octivoChatGateName">Họ tên</label>' +
              '<input type="text" id="octivoChatGateName" autocomplete="name" maxlength="80" placeholder="Nhập họ tên của bạn">' +
            '</div>' +
            '<div id="octivoChatGatePhoneField">' +
              '<label for="octivoChatGatePhone">Số điện thoại</label>' +
              '<input type="tel" id="octivoChatGatePhone" autocomplete="tel" maxlength="15" placeholder="Nhập số điện thoại của bạn">' +
            '</div>' +
            '<div class="octivo-chat-gate__error" id="octivoChatGateError"></div>' +
            '<button type="button" class="octivo-chat-btn" id="octivoChatGateSubmit">Bắt đầu trò chuyện</button>' +
          '</div>' +
          '<div class="octivo-chat-panel__messages octivo-chat-hidden" id="octivoChatMessages"></div>' +
          '<div class="octivo-chat-panel__composer octivo-chat-hidden" id="octivoChatComposer">' +
            '<div class="octivo-chat-emoji octivo-chat-hidden" id="octivoChatEmoji"><emoji-picker></emoji-picker></div>' +
            '<div class="octivo-chat-panel__preview octivo-chat-hidden" id="octivoChatPreview">' +
              '<div class="octivo-chat-panel__preview-inner">' +
                '<img src="" alt="" class="octivo-chat-panel__preview-img" id="octivoChatPreviewImg">' +
                '<span class="octivo-chat-panel__preview-name" id="octivoChatPreviewName"></span>' +
                '<button type="button" class="octivo-chat-icon-btn octivo-chat-panel__preview-remove" id="octivoChatPreviewRemove" aria-label="Remove attachment">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="octivo-chat-panel__input-row">' +
              '<input type="file" id="octivoChatFile" class="octivo-chat-file-input" accept="image/jpeg,image/png,image/gif,image/webp" tabindex="-1" aria-hidden="true">' +
              '<div class="octivo-chat-input-wrap">' +
                '<button type="button" class="octivo-chat-tool octivo-chat-tool--attach" id="octivoChatAttachBtn" aria-label="Attach image" title="Gửi ảnh">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' +
                '</button>' +
                '<textarea id="octivoChatInput" rows="1" maxlength="2000" placeholder="Nhập tin nhắn…"></textarea>' +
                '<button type="button" class="octivo-chat-tool octivo-chat-tool--emoji" id="octivoChatEmojiBtn" aria-label="Emoji" title="Emoji">🙂</button>' +
              '</div>' +
              '<button type="button" class="octivo-chat-btn octivo-chat-send" id="octivoChatSend" aria-label="Send">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="octivo-chat-toast" id="octivoChatToast"></div>';
    document.body.appendChild(root);
  }

  function toast(message) {
    var el = $('#octivoChatToast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('octivo-chat-toast--show');
    setTimeout(function () { el.classList.remove('octivo-chat-toast--show'); }, 2200);
  }

  function applyConfigToDom() {
    var cfg = state.config;
    if (!cfg) return;

    var root = $('.octivo-chat-root');
    if (root) {
      var primary = cfg.theme.primary_color || '#206bc4';
      root.style.setProperty('--oc-accent', primary);
      root.style.setProperty('--oc-accent-light', primary);
      root.style.setProperty('--oc-accent-contrast', contrastColorFor(primary));
      root.style.setProperty('--oc-surface', cfg.theme.background_color || '#fff');
      root.style.setProperty('--oc-text', cfg.theme.text_color || '#182433');
      root.style.setProperty('--oc-offset-x', (cfg.widget_offset_x != null ? cfg.widget_offset_x : 16) + 'px');
      root.style.setProperty('--oc-offset-y', (cfg.widget_offset_y != null ? cfg.widget_offset_y : 16) + 'px');
    }

    var fab = $('#octivoChatFab');
    var panel = $('#octivoChatPanel');
    if (cfg.widget_position === 'left') {
      if (fab) { fab.classList.remove('octivo-chat-fab--right'); fab.classList.add('octivo-chat-fab--left'); }
      if (panel) { panel.classList.remove('octivo-chat-panel--right'); panel.classList.add('octivo-chat-panel--left'); }
    }

    var fabLabel = $('#octivoChatFabLabel');
    if (fab && fabLabel) {
      var buttonText = (cfg.widget_button_text || '').trim();
      if (buttonText) {
        fabLabel.textContent = buttonText;
        fabLabel.classList.remove('octivo-chat-hidden');
        fab.classList.add('octivo-chat-fab--labeled');
      } else {
        fabLabel.classList.add('octivo-chat-hidden');
        fab.classList.remove('octivo-chat-fab--labeled');
      }
    }

    var title = $('#octivoChatTitle');
    if (title) title.textContent = cfg.display_name || 'Chat';

    var greetingEl = $('#octivoChatGateGreeting');
    if (greetingEl) greetingEl.textContent = cfg.widget_greeting || 'Vui lòng để lại thông tin để bắt đầu trò chuyện.';

    var nameField = $('#octivoChatGateNameField');
    if (nameField) nameField.classList.toggle('octivo-chat-hidden', !cfg.widget_require_name);
    var phoneField = $('#octivoChatGatePhoneField');
    if (phoneField) phoneField.classList.toggle('octivo-chat-hidden', !cfg.widget_require_phone);
  }

  // ---- Validation (same rules as assets/salon/js/guest-profile.js) ----

  function validateName(name) {
    var n = (name || '').trim();
    return n.length >= 2 && n.length <= 80;
  }

  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '').replace(/^84/, '0');
    return d.indexOf('0') === 0 ? d : '0' + d;
  }

  function validatePhone(phone) {
    return /^0[3-9]\d{8}$/.test(phone);
  }

  // ---- Network ----

  function apiUrl(path) {
    return (API_BASE || '') + path;
  }

  function fetchConfig() {
    return fetch(apiUrl('/embed/@' + state.channelSourceId + '/config'), { credentials: 'omit' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Widget config not found');
        state.orgId = String(data.organization_id);
        state.config = data;
        return data;
      });
  }

  function saveInformation(name, phone) {
    var payload = new URLSearchParams();
    payload.set('name', name);
    payload.set('phone', phone);
    if (state.appUserCode) payload.set('code', state.appUserCode);
    return fetch(apiUrl('/save-information'), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: payload.toString(),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.error_message || 'Could not save information');
        return data;
      });
    });
  }

  function touchOrganization() {
    var params = new URLSearchParams();
    params.set('app_user_code', state.appUserCode);
    params.set('organization_id', state.orgId);
    return fetch(apiUrl('/touch-organization') + '?' + params.toString(), { credentials: 'omit' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Could not start chat session');
        state.chatId = data.chat_id || '';
        state.accessToken = data.access_token || '';
        storeSession();
        return data;
      });
  }

  function authHeaders() {
    return state.accessToken ? { Authorization: 'Bearer ' + state.accessToken } : {};
  }

  function fetchMessages(sinceId) {
    var params = new URLSearchParams();
    params.set('chat_id', state.chatId);
    if (sinceId > 0) params.set('since_id', String(sinceId));
    return fetch(apiUrl('/salon-booking/chat/messages') + '?' + params.toString(), {
      credentials: 'omit',
      headers: authHeaders(),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Could not load messages');
        return data.messages || [];
      });
  }

  function sendMessage(text, file) {
    var options;
    if (file) {
      var form = new FormData();
      form.append('chat_id', state.chatId);
      if (text) form.append('text', text);
      form.append('file', file);
      options = { method: 'POST', credentials: 'omit', headers: authHeaders(), body: form };
    } else {
      options = {
        method: 'POST',
        credentials: 'omit',
        headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8' }, authHeaders()),
        body: JSON.stringify({ chat_id: state.chatId, text: text }),
      };
    }
    return fetch(apiUrl('/salon-booking/chat/send'), options).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.error_message || 'Could not send message');
        return data;
      });
    });
  }

  // ---- Messages rendering ----

  /**
   * The staff-facing API (api/Conversation.php) uses snake_case
   * (photo_url/sent_at); the guest-chat endpoints this widget actually talks
   * to (Landing::guestChatMessages/Send, via landing_format_public_message())
   * return camelCase (photo/sentAt/isMine) — keep both readable in case a
   * future response shape changes, but camelCase is what's live today.
   */
  function renderMessage(msg) {
    var mine = msg.isMine != null ? !!msg.isMine : msg.source === 'page';
    var wrapperCls = 'octivo-chat-message ' + (mine ? 'octivo-chat-message--mine' : 'octivo-chat-message--theirs');
    var bubbleCls = 'octivo-chat-bubble ' + (mine ? 'octivo-chat-bubble--mine' : 'octivo-chat-bubble--theirs');
    var photo = msg.photo || msg.photo_url;
    var body = '<div>' + escapeHtml(msg.text || '').replace(/\n/g, '<br>') + '</div>';
    if (msg.type === 'photo' && photo) {
      // A real <a href> here (even target="_blank") can end up navigating
      // the whole widget's host page away if a popup blocker forces the
      // browser to open it in the same tab/frame instead. Use a plain
      // <button> and open the full-size image via window.open() ourselves,
      // so a failed/blocked popup never falls back to an in-page navigation.
      body = '<button type="button" class="octivo-chat-lightbox-trigger" data-photo-url="' + escapeHtml(photo) + '">' +
        '<img class="octivo-chat-bubble__img" src="' + escapeHtml(photo) + '" alt="" loading="lazy"></button>' +
        (msg.text ? body : '');
    }
    var time = '<div class="octivo-chat-message__time">' + formatTime(msg.sentAt || msg.sent_at) + '</div>';
    return '<div class="' + wrapperCls + '" data-id="' + escapeHtml(msg.id) + '"><div class="' + bubbleCls + '">' + body + '</div>' + time + '</div>';
  }

  function mergeMessages(messages, replace) {
    var box = $('#octivoChatMessages');
    if (!box) return;
    if (replace) box.innerHTML = '';
    if (!messages.length && replace) {
      box.innerHTML = '<p class="octivo-chat-panel__empty">Chưa có tin nhắn. Hãy gửi lời chào!</p>';
      state.lastMessageId = 0;
      return;
    }
    var empty = box.querySelector('.octivo-chat-panel__empty');
    if (empty) empty.remove();
    messages.forEach(function (msg) {
      var id = parseInt(msg.id, 10) || 0;
      if (id <= 0 || box.querySelector('[data-id="' + msg.id + '"]')) return;
      box.insertAdjacentHTML('beforeend', renderMessage(msg));
      if (id > state.lastMessageId) state.lastMessageId = id;
    });
    box.scrollTop = box.scrollHeight;
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      if (!state.open) return;
      fetchMessages(state.lastMessageId).then(function (messages) {
        mergeMessages(messages, false);
      }).catch(function () { /* ignore transient errors */ });
    }, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function showChatUi() {
    $('#octivoChatGate').classList.add('octivo-chat-hidden');
    $('#octivoChatMessages').classList.remove('octivo-chat-hidden');
    $('#octivoChatComposer').classList.remove('octivo-chat-hidden');
    $('#octivoChatMessages').innerHTML = '<p class="octivo-chat-panel__empty">Đang tải tin nhắn…</p>';
    state.lastMessageId = 0;
    fetchMessages(0).then(function (messages) {
      mergeMessages(messages, true);
    }).catch(function (err) {
      $('#octivoChatMessages').innerHTML = '<p class="octivo-chat-panel__empty">' + escapeHtml(err.message) + '</p>';
    });
    startPolling();
  }

  function showGateUi() {
    $('#octivoChatGate').classList.remove('octivo-chat-hidden');
    $('#octivoChatMessages').classList.add('octivo-chat-hidden');
    $('#octivoChatComposer').classList.add('octivo-chat-hidden');
  }

  // ---- Session bootstrap (reuse > mechanism 2 > mechanism 1) ----

  /**
   * Starts a session from validated (name, phone) — used by both mechanism 1
   * (gate form submit) and mechanism 2 (init() with name/phone supplied).
   */
  function startSessionWith(name, phone) {
    return saveInformation(name, phone).then(function (data) {
      state.appUserCode = data.code || state.appUserCode;
      return touchOrganization();
    });
  }

  function resolveSession(initOptions) {
    if (hasStoredSession()) {
      // Reused session always wins — ignore whatever init() passed, per design.
      return touchOrganization().then(function () {
        state.ready = true;
        return { reused: true };
      });
    }

    var name = (initOptions && initOptions.name || '').trim();
    var phone = initOptions && initOptions.phone ? normalizePhone(initOptions.phone) : '';
    var cfg = state.config;
    var needsName = cfg.widget_require_name;
    var needsPhone = cfg.widget_require_phone;
    var nameOk = !needsName || validateName(name);
    var phoneOk = !needsPhone || validatePhone(phone);

    if (nameOk && phoneOk && (needsName || needsPhone) && (name || phone)) {
      // Mechanism 2: caller supplied enough valid info up front.
      return startSessionWith(name, phone).then(function () {
        state.ready = true;
        return { reused: false, auto: true };
      });
    }

    // Mechanism 1: fall back to the gate overlay (pre-filling whatever was valid).
    var nameInput = $('#octivoChatGateName');
    var phoneInput = $('#octivoChatGatePhone');
    if (nameInput && nameOk) nameInput.value = name;
    if (phoneInput && phoneOk) phoneInput.value = phone;
    state.ready = true;
    return Promise.resolve({ reused: false, auto: false });
  }

  function bindGate() {
    var submit = $('#octivoChatGateSubmit');
    if (!submit || submit._bound) return;
    submit._bound = true;
    submit.addEventListener('click', function () {
      var cfg = state.config;
      var name = (($('#octivoChatGateName') || {}).value || '').trim();
      var phone = normalizePhone((($('#octivoChatGatePhone') || {}).value || ''));
      var errorEl = $('#octivoChatGateError');

      if (cfg.widget_require_name && !validateName(name)) {
        errorEl.textContent = 'Vui lòng nhập họ tên (ít nhất 2 ký tự)';
        return;
      }
      if (cfg.widget_require_phone && !validatePhone(phone)) {
        errorEl.textContent = 'Vui lòng nhập số điện thoại hợp lệ';
        return;
      }
      errorEl.textContent = '';
      submit.disabled = true;
      startSessionWith(name, phone)
        .then(function () {
          showChatUi();
          if (state.pendingInit && state.pendingInit.autoOpen) openPanel();
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Không thể bắt đầu trò chuyện';
        })
        .finally(function () {
          submit.disabled = false;
        });
    });
  }

  /** Lazy-loads emoji-picker-element (same CDN/version used elsewhere in this CRM) only when the picker is first opened. */
  var emojiPickerLoadPromise = null;
  function ensureEmojiPickerLoaded() {
    if (emojiPickerLoadPromise) return emojiPickerLoadPromise;
    emojiPickerLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.type = 'module';
      s.textContent = "import '" + EMOJI_PICKER_SRC + "';";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
      // Module scripts don't reliably fire onload in all browsers when
      // inlined this way — resolve optimistically shortly after; the
      // <emoji-picker> custom element upgrades itself once defined.
      setTimeout(resolve, 300);
    });
    return emojiPickerLoadPromise;
  }

  function clearAttachment() {
    var fileInput = $('#octivoChatFile');
    var preview = $('#octivoChatPreview');
    if (state.previewObjectUrl) {
      URL.revokeObjectURL(state.previewObjectUrl);
      state.previewObjectUrl = '';
    }
    state.selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (preview) preview.classList.add('octivo-chat-hidden');
  }

  function showAttachmentPreview(file) {
    var preview = $('#octivoChatPreview');
    var previewImg = $('#octivoChatPreviewImg');
    var previewName = $('#octivoChatPreviewName');
    if (!file || !preview) return;

    if (state.previewObjectUrl) {
      URL.revokeObjectURL(state.previewObjectUrl);
    }
    state.selectedFile = file;
    state.previewObjectUrl = URL.createObjectURL(file);
    if (previewImg) previewImg.src = state.previewObjectUrl;
    if (previewName) previewName.textContent = file.name || 'Ảnh đính kèm';
    preview.classList.remove('octivo-chat-hidden');
  }

  function bindComposer() {
    var send = $('#octivoChatSend');
    var input = $('#octivoChatInput');
    if (!send || send._bound) return;
    send._bound = true;

    function doSend(e) {
      if (e) e.preventDefault();
      var text = (input.value || '').trim();
      var file = state.selectedFile;
      if ((!text && !file) || state.sending) return;
      state.sending = true;
      send.classList.add('is-sending');
      sendMessage(text, file)
        .then(function (data) {
          input.value = '';
          autoResizeInput(input);
          clearAttachment();
          if (data.message) mergeMessages([data.message], false);
        })
        .catch(function (err) {
          toast(err.message || 'Không gửi được tin nhắn');
        })
        .finally(function () {
          state.sending = false;
          send.classList.remove('is-sending');
        });
    }

    send.addEventListener('click', doSend);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    input.addEventListener('input', function () { autoResizeInput(input); });
    autoResizeInput(input);

    var attachBtn = $('#octivoChatAttachBtn');
    var fileInput = $('#octivoChatFile');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        if (!file) { clearAttachment(); return; }
        if (IMAGE_MIME_TYPES.indexOf(file.type) === -1) {
          toast('Chỉ hỗ trợ ảnh JPG, PNG, GIF hoặc WEBP');
          clearAttachment();
          return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          toast('Ảnh vượt quá dung lượng cho phép (8MB)');
          clearAttachment();
          return;
        }
        showAttachmentPreview(file);
      });
    }
    var previewRemove = $('#octivoChatPreviewRemove');
    if (previewRemove) {
      previewRemove.addEventListener('click', clearAttachment);
    }

    var emojiBtn = $('#octivoChatEmojiBtn');
    var emojiWrap = $('#octivoChatEmoji');
    if (emojiBtn && emojiWrap) {
      emojiBtn.addEventListener('click', function () {
        var willOpen = emojiWrap.classList.contains('octivo-chat-hidden');
        if (willOpen) {
          ensureEmojiPickerLoaded().then(function () {
            emojiWrap.classList.remove('octivo-chat-hidden');
            var picker = emojiWrap.querySelector('emoji-picker');
            if (picker && !picker._octivoBound) {
              picker._octivoBound = true;
              picker.addEventListener('emoji-click', function (e) {
                input.value += e.detail.unicode;
                input.focus();
              });
            }
          });
        } else {
          emojiWrap.classList.add('octivo-chat-hidden');
        }
      });
      document.addEventListener('click', function (e) {
        if (emojiWrap.classList.contains('octivo-chat-hidden')) return;
        if (e.target.closest('#octivoChatEmoji') || e.target.closest('#octivoChatEmojiBtn')) return;
        emojiWrap.classList.add('octivo-chat-hidden');
      });
    }
  }

  function bindChrome() {
    var fab = $('#octivoChatFab');
    if (fab && !fab._bound) {
      fab._bound = true;
      fab.addEventListener('click', openPanel);
    }
    var close = $('#octivoChatClose');
    if (close && !close._bound) {
      close._bound = true;
      close.addEventListener('click', closePanel);
    }
    var fullscreenBtn = $('#octivoChatFullscreen');
    if (fullscreenBtn && !fullscreenBtn._bound) {
      fullscreenBtn._bound = true;
      fullscreenBtn.addEventListener('click', toggleFullscreen);
    }
    var backdrop = $('#octivoChatBackdrop');
    if (backdrop && !backdrop._bound) {
      backdrop._bound = true;
      backdrop.addEventListener('click', closePanel);
    }

    // Delegated: message list content (including photo bubbles) is
    // inserted dynamically via insertAdjacentHTML, so bind once on the
    // stable container rather than per-message.
    var messagesBox = $('#octivoChatMessages');
    if (messagesBox && !messagesBox._bound) {
      messagesBox._bound = true;
      messagesBox.addEventListener('click', function (e) {
        var trigger = e.target.closest('.octivo-chat-lightbox-trigger');
        if (!trigger) return;
        e.preventDefault();
        var url = trigger.getAttribute('data-photo-url');
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      });
    }
  }

  function openPanel() {
    var panel = $('#octivoChatPanel');
    if (!panel) return;
    panel.classList.remove('octivo-chat-hidden');
    panel.setAttribute('aria-hidden', 'false');
    state.open = true;
    applyFullscreenState();
    if (hasStoredSession()) {
      showChatUi();
    } else {
      showGateUi();
    }
  }

  /** Desktop-only: expand the popup to fill the viewport, or shrink it back to the docked corner panel. Persists across close/reopen within the same page session (not across reloads). */
  function toggleFullscreen() {
    state.fullscreen = !state.fullscreen;
    applyFullscreenState();
  }

  function applyFullscreenState() {
    var panel = $('#octivoChatPanel');
    var btn = $('#octivoChatFullscreen');
    if (!panel || !btn) return;
    panel.classList.toggle('octivo-chat-panel--fullscreen', state.fullscreen);
    btn.setAttribute('aria-label', state.fullscreen ? 'Exit full screen' : 'Full screen');
    btn.setAttribute('title', state.fullscreen ? 'Thu nhỏ' : 'Mở rộng toàn màn hình');
    var expandIcon = btn.querySelector('.octivo-chat-icon-expand');
    var collapseIcon = btn.querySelector('.octivo-chat-icon-collapse');
    if (expandIcon) expandIcon.classList.toggle('octivo-chat-hidden', state.fullscreen);
    if (collapseIcon) collapseIcon.classList.toggle('octivo-chat-hidden', !state.fullscreen);
  }

  function closePanel() {
    var panel = $('#octivoChatPanel');
    if (!panel) return;
    var wasOpen = state.open;
    panel.classList.add('octivo-chat-hidden');
    panel.setAttribute('aria-hidden', 'true');
    state.open = false;
    stopPolling();
    if (wasOpen) {
      notifyClose();
    }
  }

  /**
   * Notifies the host page a popup close happened, via both mechanisms
   * requested: the onClose callback passed to init(), and a CustomEvent on
   * window (for sites that prefer addEventListener / multiple listeners).
   */
  function notifyClose() {
    if (typeof state.onClose === 'function') {
      try {
        state.onClose();
      } catch (e) {
        if (global.console) console.error('[OctivoChat] onClose callback threw', e);
      }
    }
    try {
      global.dispatchEvent(new CustomEvent('octivochat:close', {
        detail: { channel: state.channelSourceId },
      }));
    } catch (e) {
      // Older browsers without CustomEvent constructor support — silently skip.
    }
  }

  /** Reveals the floating bubble, unless the host opted out via init({ showBubble: false }) to drive open() from its own button instead. */
  function revealFab() {
    if (!state.showBubble) return;
    var fab = $('#octivoChatFab');
    if (fab) fab.classList.remove('octivo-chat-hidden');
  }

  // ---- Public API ----

  function readDataAttr() {
    var el = document.currentScript || document.querySelector('script[data-channel]');
    return el ? (el.getAttribute('data-channel') || '') : '';
  }

  /** data-show-bubble="false" on the <script> tag, for sites that only use the auto-init (no manual init() call). */
  function readShowBubbleDataAttr() {
    var el = document.currentScript || document.querySelector('script[data-channel]');
    return el ? el.getAttribute('data-show-bubble') !== 'false' : true;
  }

  function init(options) {
    options = options || {};
    state.pendingInit = options;
    state.showBubble = options.showBubble !== false;
    state.onClose = typeof options.onClose === 'function' ? options.onClose : null;
    var channel = String(options.channel || readDataAttr() || '').replace(/^@/, '');
    if (!channel) {
      return Promise.reject(new Error('OctivoChat.init: missing channel'));
    }
    state.channelSourceId = channel;

    injectCss();
    buildDom();
    bindChrome();
    bindGate();
    bindComposer();

    return fetchConfig()
      .then(function () {
        loadStoredSession();
        applyConfigToDom();
        return resolveSession(options);
      })
      .then(function (result) {
        revealFab();
        if (options.autoOpen && (result.reused || result.auto)) {
          openPanel();
        }
        return result;
      })
      .catch(function (err) {
        // Widget stays hidden if config/session bootstrap fails (e.g. domain not
        // whitelisted, channel not found) — fail closed, never break the host page.
        if (global.console) console.error('[OctivoChat]', err.message || err);
      });
  }

  global.OctivoChat = {
    init: init,
    open: openPanel,
    close: closePanel,
  };

  // Auto-init when the script tag carries data-channel, mirroring common
  // chat-widget embed patterns (Intercom/Crisp-style single <script> drop-in).
  // data-show-bubble="false" covers sites that only ever use this auto-init
  // (no manual OctivoChat.init() call) but still want to drive open() from
  // their own button — onClose still needs a manual init({ onClose }) call.
  if (readDataAttr()) {
    var autoInit = function () { init({ showBubble: readShowBubbleDataAttr() }); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoInit);
    } else {
      autoInit();
    }
  }
})(typeof window !== 'undefined' ? window : this, document);
