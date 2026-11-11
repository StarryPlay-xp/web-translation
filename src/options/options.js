/* 设置页 */
(async function () {
  const L = window.WT_LANG;
  const C = window.WT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const form = $('providerForm');

  let settings = await C.getSettings();
  let providers = await C.getProviders();
  let selectedId = settings.activeProviderId;
  if (!providers.some((p) => p.id === selectedId)) selectedId = providers[0].id;
  let dirty = false;

  let tipTimer = null;
  function showSaved(text = '已保存') {
    $('savedTip').textContent = text;
    $('savedTip').hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => ($('savedTip').hidden = true), 1500);
  }

  // ======================= 模型配置 =======================
  for (const preset of C.PROVIDER_PRESETS) $('presetSelect').add(new Option(preset.label, preset.key));

  const AVATAR_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb', '#dc2626'];
  /** 用名称首字母 + 固定配色生成头像，便于在列表中区分 */
  function paintAvatar(el, name) {
    const text = (name || '?').trim() || '?';
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    el.textContent = Array.from(text)[0].toUpperCase();
    el.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  const protocolLabel = (p) => (p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI');

  function renderProviderList() {
    const ul = $('providerList');
    ul.innerHTML = '';
    for (const p of providers) {
      const li = document.createElement('li');
      li.className = p.id === selectedId ? 'selected' : '';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      paintAvatar(avatar, p.name);
      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      const nameText = document.createElement('span');
      nameText.textContent = p.name || '未命名';
      name.appendChild(nameText);
      if (p.id === settings.activeProviderId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '使用中';
        name.appendChild(tag);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const metaText = document.createElement('span');
      metaText.textContent = `${protocolLabel(p)} · ${p.model || '未填模型'}`;
      meta.appendChild(metaText);
      if (!p.apiKey) {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = '\u00a0· 未填 Key';
        meta.appendChild(warn);
      }
      info.append(name, meta);
      li.append(avatar, info);
      li.title = p.name || '未命名';
      li.addEventListener('click', () => selectProvider(p.id));
      ul.appendChild(li);
    }
  }

  /** 表单顶部：头像、名称、协议与模型 */
  function renderFormHead() {
    const name = form.elements.name.value.trim() || '未命名';
    const model = form.elements.model.value.trim();
    paintAvatar($('formAvatar'), name);
    $('formTitle').textContent = name;
    $('formSub').textContent = `${protocolLabel({ protocol: form.elements.protocol.value })} 协议 · ${model || '未填模型'}`;
  }

  function updateUseButton() {
    const active = selectedId === settings.activeProviderId;
    const btn = $('useProvider');
    btn.disabled = active;
    btn.textContent = active ? '✓ 当前使用中' : '设为当前使用';
    btn.classList.toggle('is-active', active);
  }

  function setDirty(v) {
    dirty = v;
    $('dirtyTip').hidden = !v;
  }

  function fillForm(p) {
    for (const key of ['name', 'protocol', 'baseURL', 'apiKey', 'model', 'temperature', 'maxTokens', 'extraBody']) {
      form.elements[key].value = p[key] === undefined || p[key] === null ? '' : p[key];
    }
    form.elements.apiKey.type = 'password';
    $('toggleKey').textContent = '显示';
    $('testResult').hidden = true;
    $('extraDetails').open = !!(p.extraBody && String(p.extraBody).trim());
    updateUseButton();
    $('deleteProvider').disabled = providers.length <= 1;
    $('deleteProvider').title = providers.length <= 1 ? '至少需要保留一个模型配置' : '';
    updateEndpointPreview();
    renderFormHead();
    setDirty(false);
  }

  function readForm() {
    const cur = providers.find((p) => p.id === selectedId) || {};
    const v = (k) => form.elements[k].value.trim();
    return Object.assign({}, cur, {
      name: v('name') || '未命名',
      protocol: v('protocol'),
      baseURL: v('baseURL'),
      apiKey: v('apiKey'),
      model: v('model'),
      temperature: v('temperature'),
      maxTokens: Number(v('maxTokens')) || 8192,
      extraBody: v('extraBody')
    });
  }

  function updateEndpointPreview() {
    try {
      const url = window.WT_LLM.buildEndpoint({
        protocol: form.elements.protocol.value,
        baseURL: form.elements.baseURL.value
      });
      $('endpointPreview').textContent = '实际请求地址：' + url;
    } catch (_) {
      $('endpointPreview').textContent = '';
    }
  }

  function selectProvider(id) {
    if (id === selectedId) return;
    if (dirty && !confirm('当前配置有未保存的修改，确定放弃吗？')) return;
    selectedId = id;
    renderProviderList();
    fillForm(providers.find((p) => p.id === id));
  }

  function validateExtraBody(text) {
    if (!text) return null;
    try {
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) return '额外请求参数必须是 JSON 对象，例如 {"key": "value"}';
      return null;
    } catch (e) {
      return '额外请求参数不是合法的 JSON：' + e.message;
    }
  }

  form.addEventListener('input', (e) => {
    setDirty(true);
    if (e.target.name === 'baseURL' || e.target.name === 'protocol') updateEndpointPreview();
    if (['name', 'model', 'protocol'].includes(e.target.name)) renderFormHead();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = readForm();
    const err = validateExtraBody(p.extraBody);
    if (err) {
      $('extraDetails').open = true;
      return showResult('err', err);
    }
    providers = providers.map((x) => (x.id === selectedId ? p : x));
    await C.saveProviders(providers);
    setDirty(false);
    renderProviderList();
    showSaved();
  });

  $('toggleKey').addEventListener('click', () => {
    const input = form.elements.apiKey;
    input.type = input.type === 'password' ? 'text' : 'password';
    $('toggleKey').textContent = input.type === 'password' ? '显示' : '隐藏';
  });

  function showResult(kind, text) {
    const el = $('testResult');
    el.className = 'result ' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  $('testProvider').addEventListener('click', async () => {
    const p = readForm();
    const err = validateExtraBody(p.extraBody);
    if (err) return showResult('err', err);
    const sample = 'こんにちは。今日はいい天気ですね。';
    showResult('loading', '正在测试…');
    $('testProvider').disabled = true;
    const resp = await chrome.runtime.sendMessage({
      type: 'translate',
      provider: Object.assign({}, p, { id: p.id + '__test' }),
      segments: [sample],
      from: 'ja',
      to: settings.targetLang,
      noCache: true
    });
    $('testProvider').disabled = false;
    if (resp && resp.ok) {
      showResult('ok', `连接成功！\n原文：${sample}\n译文：${resp.translations[0]}`);
    } else {
      showResult('err', `连接失败：${(resp && resp.error) || '未知错误'}${resp && resp.detail ? '\n服务端返回：' + resp.detail : ''}`);
    }
  });

  $('useProvider').addEventListener('click', async () => {
    settings = await C.saveSettings({ activeProviderId: selectedId });
    updateUseButton();
    renderProviderList();
    showSaved('已设为当前使用');
  });

  $('deleteProvider').addEventListener('click', async () => {
    if (providers.length <= 1) return;
    const p = providers.find((x) => x.id === selectedId);
    if (!confirm(`确定删除模型配置“${p.name}”吗？`)) return;
    providers = providers.filter((x) => x.id !== selectedId);
    await C.saveProviders(providers);
    if (settings.activeProviderId === selectedId) {
      settings = await C.saveSettings({ activeProviderId: providers[0].id });
    }
    selectedId = providers[0].id;
    renderProviderList();
    fillForm(providers[0]);
    showSaved('已删除');
  });

  $('addProvider').addEventListener('click', async () => {
    if (dirty && !confirm('当前配置有未保存的修改，确定放弃吗？')) return;
    const preset = C.PROVIDER_PRESETS.find((x) => x.key === $('presetSelect').value);
    const p = {
      id: C.genId(),
      name: preset.label.replace(/（.*）/, ''),
      protocol: preset.protocol,
      baseURL: preset.baseURL,
      apiKey: '',
      model: preset.model,
      temperature: '',
      maxTokens: 8192,
      extraBody: ''
    };
    providers.push(p);
    await C.saveProviders(providers);
    selectedId = p.id;
    renderProviderList();
    fillForm(p);
    form.elements.name.focus();
  });

  renderProviderList();
  fillForm(providers.find((p) => p.id === selectedId));

  // ======================= 普通设置（修改即保存） =======================
  for (const l of L.LANGUAGES) $('targetLang').add(new Option(l.name, l.code));

  const settingEls = document.querySelectorAll('[data-setting]');
  function renderSettings() {
    for (const el of settingEls) {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key] === undefined ? '' : settings[key];
    }
  }
  renderSettings();

  for (const el of settingEls) {
    el.addEventListener('change', async () => {
      const key = el.dataset.setting;
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number') {
        value = Number(el.value);
        if (!Number.isFinite(value) || el.value === '') value = C.DEFAULT_SETTINGS[key];
        if (el.min !== '') value = Math.max(Number(el.min), value);
        if (el.max !== '') value = Math.min(Number(el.max), value);
        el.value = value;
      } else value = el.value;
      settings = await C.saveSettings({ [key]: value });
      showSaved();
    });
  }

  // ======================= 自动翻译网站 =======================
  function renderSites() {
    const ul = $('siteList');
    ul.innerHTML = '';
    if (!settings.autoSites.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '暂无';
      ul.appendChild(li);
      return;
    }
    for (const host of settings.autoSites) {
      const li = document.createElement('li');
      li.textContent = host;
      const btn = document.createElement('button');
      btn.textContent = '✕';
      btn.title = '移除';
      btn.addEventListener('click', async () => {
        settings = await C.saveSettings({ autoSites: settings.autoSites.filter((h) => h !== host) });
        renderSites();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }
  renderSites();

  async function addSite() {
    let v = $('siteInput').value.trim();
    if (!v) return;
    try {
      v = new URL(v.includes('://') ? v : 'https://' + v).hostname;
    } catch (_) {
      return alert('域名格式不正确');
    }
    if (!settings.autoSites.includes(v)) {
      settings = await C.saveSettings({ autoSites: settings.autoSites.concat(v) });
    }
    $('siteInput').value = '';
    renderSites();
  }
  $('addSite').addEventListener('click', addSite);
  $('siteInput').addEventListener('keydown', (e) => e.key === 'Enter' && addSite());

  // 其他页面（如弹窗）修改了设置时同步显示
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      C.getSettings().then((s) => {
        settings = s;
        renderSettings();
        renderSites();
        renderProviderList();
        updateUseButton();
      });
    }
  });

  // ======================= 快捷键 =======================
  chrome.commands.getAll((cmds) => {
    const names = { 'toggle-translate': '翻译/还原', 'toggle-mode': '切换显示方式' };
    const box = $('shortcuts');
    box.innerHTML = '';
    const list = cmds.filter((c) => names[c.name]);
    if (!list.length) box.textContent = '未设置';
    for (const c of list) {
      const item = document.createElement('span');
      item.className = 'item';
      const kbd = document.createElement('kbd');
      kbd.textContent = c.shortcut || '未设置';
      item.append(kbd, names[c.name]);
      box.appendChild(item);
    }
  });
  $('shortcutLink').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  // ======================= 左侧导航高亮 =======================
  const navLinks = Array.from(document.querySelectorAll('#nav a'));
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute('href')));
  function updateNav() {
    let idx = 0;
    sections.forEach((sec, i) => {
      if (sec.getBoundingClientRect().top <= 120) idx = i;
    });
    // 滚动到底部时高亮最后一项
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) idx = sections.length - 1;
    navLinks.forEach((a, i) => a.classList.toggle('active', i === idx));
  }
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
})();
