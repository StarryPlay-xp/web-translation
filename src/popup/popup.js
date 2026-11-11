/* 工具栏弹窗 */
(async function () {
  const L = window.WT_LANG;
  const C = window.WT_CONFIG;
  const $ = (id) => document.getElementById(id);

  let settings = await C.getSettings();
  const providers = await C.getProviders();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let pageState = null;

  // ---------- 下拉框 ----------
  function fillLangSelect(select, withAuto) {
    select.innerHTML = '';
    if (withAuto) select.add(new Option('自动检测', 'auto'));
    for (const l of L.LANGUAGES) select.add(new Option(l.name, l.code));
  }
  fillLangSelect($('sourceLang'), true);
  fillLangSelect($('targetLang'), false);
  $('targetLang').value = settings.targetLang;

  for (const p of providers) $('provider').add(new Option(`${p.name}（${p.model || '未填模型'}）`, p.id));
  $('provider').value = providers.some((p) => p.id === settings.activeProviderId)
    ? settings.activeProviderId
    : providers[0] && providers[0].id;

  function updateKeyWarning() {
    const p = providers.find((x) => x.id === $('provider').value);
    const isLocal = p && /localhost|127\.0\.0\.1/.test(p.baseURL || '');
    $('keyWarning').hidden = !p || !!p.apiKey || isLocal;
  }
  updateKeyWarning();

  function renderMode() {
    for (const b of $('displayMode').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.value === settings.displayMode);
    }
  }
  renderMode();

  // ---------- 与页面通信 ----------
  async function sendToTab(message) {
    if (!tab || tab.id === undefined) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {
      // 插件安装前就打开的页面没有 content script，尝试注入
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content/content.css'] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/shared/languages.js', 'src/shared/config.js', 'src/content/content.js']
        });
        await new Promise((r) => setTimeout(r, 300)); // 等待页面语言检测完成
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (e) {
        return null;
      }
    }
  }

  function renderPageState() {
    const ok = !!(pageState && pageState.ok);
    $('unsupported').hidden = ok;
    $('toggle').disabled = !ok;
    $('autoSite').disabled = !ok;
    $('sourceLang').disabled = !ok;
    if (!ok) {
      $('host').textContent = '此网站';
      return;
    }
    $('detected').textContent = pageState.detectedLang !== 'auto' ? `（检测到：${L.langName(pageState.detectedLang)}）` : '';
    $('sourceLang').value = pageState.sourceOverride || 'auto';
    $('toggle').textContent = pageState.enabled ? '显示原文' : '翻译此页面';
    $('toggle').classList.toggle('on', pageState.enabled);
    $('host').textContent = pageState.host || '此网站';
    $('autoSite').checked = settings.autoSites.includes(pageState.host);
  }

  pageState = await sendToTab({ type: 'getState' });
  renderPageState();

  // ---------- 事件 ----------
  $('toggle').addEventListener('click', async () => {
    pageState = await sendToTab({ type: 'toggle' });
    renderPageState();
  });

  $('sourceLang').addEventListener('change', async (e) => {
    pageState = await sendToTab({ type: 'setSourceLang', lang: e.target.value });
    renderPageState();
  });

  $('targetLang').addEventListener('change', async (e) => {
    settings = await C.saveSettings({ targetLang: e.target.value });
  });

  $('provider').addEventListener('change', async (e) => {
    settings = await C.saveSettings({ activeProviderId: e.target.value });
    updateKeyWarning();
  });

  $('displayMode').addEventListener('click', async (e) => {
    const v = e.target.dataset && e.target.dataset.value;
    if (!v) return;
    settings = await C.saveSettings({ displayMode: v });
    renderMode();
  });

  $('autoSite').addEventListener('change', async (e) => {
    const host = pageState && pageState.host;
    if (!host) return;
    const set = new Set(settings.autoSites);
    if (e.target.checked) set.add(host);
    else set.delete(host);
    settings = await C.saveSettings({ autoSites: Array.from(set) });
    if (e.target.checked && !pageState.enabled) {
      pageState = await sendToTab({ type: 'start' });
      renderPageState();
    }
  });

  const openOptions = () => chrome.runtime.openOptionsPage();
  $('openOptions').addEventListener('click', openOptions);
  $('gotoOptions').addEventListener('click', openOptions);
  $('shortcutLink').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  chrome.commands.getAll((cmds) => {
    const c = cmds.find((x) => x.name === 'toggle-translate');
    $('shortcut').textContent = c && c.shortcut ? `快捷键：${c.shortcut} 翻译/还原` : '未设置快捷键';
  });
})();
