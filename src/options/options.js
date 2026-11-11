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

  function renderProviderList() {
    const ul = $('providerList');
    ul.innerHTML = '';
    for (const p of providers) {
      const li = document.createElement('li');
      li.className = p.id === selectedId ? 'selected' : '';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name || '未命名';
      if (p.id === settings.activeProviderId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '使用中';
        name.appendChild(tag);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${p.model || '未填模型'}${p.apiKey ? '' : ' · 未填 Key'}`;
      li.append(name, meta);
      li.addEventListener('click', () => selectProvider(p.id));
      ul.appendChild(li);
    }
  }

  function fillForm(p) {
    for (const key of ['name', 'protocol', 'baseURL', 'apiKey', 'model', 'temperature', 'maxTokens', 'extraBody']) {
      form.elements[key].value = p[key] === undefined || p[key] === null ? '' : p[key];
    }
    form.elements.apiKey.type = 'password';
    $('toggleKey').textContent = '显示';
    $('testResult').hidden = true;
    $('useProvider').disabled = p.id === settings.activeProviderId;
    $('deleteProvider').disabled = providers.length <= 1;
    updateEndpointPreview();
    dirty = false;
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
    dirty = true;
    if (e.target.name === 'baseURL' || e.target.name === 'protocol') updateEndpointPreview();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = readForm();
    const err = validateExtraBody(p.extraBody);
    if (err) return showResult('err', err);
    providers = providers.map((x) => (x.id === selectedId ? p : x));
    await C.saveProviders(providers);
    dirty = false;
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
    $('useProvider').disabled = true;
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
        $('useProvider').disabled = selectedId === settings.activeProviderId;
      });
    }
  });

  // ======================= 快捷键 =======================
  chrome.commands.getAll((cmds) => {
    const names = { 'toggle-translate': '翻译/还原', 'toggle-mode': '切换显示方式' };
    $('shortcuts').textContent =
      cmds
        .filter((c) => names[c.name])
        .map((c) => `${c.shortcut || '未设置'} ${names[c.name]}`)
        .join('；') || '未设置';
  });
  $('shortcutLink').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
})();
