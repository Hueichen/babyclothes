(() => {
  'use strict';

  /* ================================================================
   * Constants
   * ================================================================ */
  const CFG = window.APP_CONFIG || {};
  const SESSION_KEY = 'bsa.session.v1';
  const DRAFT_KEY = 'bsa.lastBrand.v1';

  const CATS = [
    ['top', '上衣'], ['pants', '褲子'], ['outerwear', '外套'],
    ['tights', '內搭 / 褲襪'], ['set', '套裝'], ['other', '其他']
  ];
  const CAT_LABEL = Object.fromEntries(CATS);
  const TOP_FIELDS = [['shoulder', '肩寬'], ['length', '衣長'], ['chest', '胸圍'], ['sleeve', '袖長']];
  const BOTTOM_FIELDS = [['waist', '腰圍'], ['pants_length', '褲長'], ['inseam', '內長'], ['hip', '臀圍']];
  const ALL_FIELDS = TOP_FIELDS.concat(BOTTOM_FIELDS);
  const FIT_CHIPS = ['剛好舒適', '不用反折', '稍微偏大', '需要反折', '袖子偏長', '褲管偏長', '偏小偏緊'];
  const PAGES = { decide: '幫選尺寸', feedback: '新增回饋', body: '寶寶體型', records: '穿著紀錄' };

  /* ================================================================
   * Utils
   * ================================================================ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmt = (v) => (v == null || v === '') ? '' : String(v);
  const todayLocal = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

  function groupsFor(cat) {
    if (cat === 'top' || cat === 'outerwear') return [['上衣', TOP_FIELDS]];
    if (cat === 'pants' || cat === 'tights') return [['褲子', BOTTOM_FIELDS]];
    return [['上衣', TOP_FIELDS], ['褲子', BOTTOM_FIELDS]];
  }

  function toast(msg, type = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function busy(btn, label, fn) {
    if (btn.disabled) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
    try { return await fn(); }
    finally { btn.disabled = false; btn.innerHTML = html; }
  }

  function storeGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }
  function storeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

  /** 手機照片縮到長邊 2000px JPEG，上傳更快，文字仍清楚 */
  async function imageToDataUrl(file, maxSide = 2000, quality = 0.85) {
    const readRaw = () => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
    });
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return c.toDataURL('image/jpeg', quality);
    } catch {
      return readRaw();
    }
  }

  function fillCatSelect(sel, withAll) {
    sel.innerHTML = (withAll ? '<option value="">全部類型</option>' : '') +
      CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }

  /* ================================================================
   * API
   * ================================================================ */
  let session = storeGet(SESSION_KEY);

  async function api(action, data) {
    let res;
    try {
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        // text/plain = simple request，不會觸發 CORS preflight（Apps Script 不支援 OPTIONS）
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: session && session.token, data: data || {} }),
        redirect: 'follow'
      });
    } catch {
      throw new Error('連不到伺服器，請檢查網路');
    }
    if (!res.ok) throw new Error('伺服器錯誤（HTTP ' + res.status + '）');

    let json;
    try { json = await res.json(); }
    catch { throw new Error('伺服器回應格式錯誤，請確認 Apps Script 部署權限為「所有人」'); }

    if (!json.ok) {
      const err = new Error(json.error || '未知錯誤');
      err.code = json.code;
      if ((json.code === 'AUTH' || json.code === 'FORBIDDEN') && action !== 'login') onAuthLost(err.message);
      throw err;
    }
    return json;
  }

  /* ================================================================
   * Auth
   * ================================================================ */
  let gsiReady = false;

  function waitForGsi(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        if (window.google && google.accounts && google.accounts.id) return resolve();
        if (Date.now() - t0 > timeout) return reject(new Error('Google 登入元件載入失敗'));
        setTimeout(check, 100);
      })();
    });
  }

  async function initGsi() {
    try { await waitForGsi(); }
    catch (e) { $('#login-msg').textContent = e.message + '，請重新整理頁面'; return; }

    google.accounts.id.initialize({
      client_id: CFG.GOOGLE_CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true
    });
    google.accounts.id.renderButton($('#gsi-button'), {
      type: 'standard', theme: 'outline', size: 'large', shape: 'pill',
      text: 'signin_with', locale: 'zh-TW', width: 280
    });
    gsiReady = true;
    if (!$('#login-screen').hidden && !storeGet('bsa.loggedOut')) google.accounts.id.prompt();
  }

  async function onCredential(resp) {
    const msg = $('#login-msg');
    msg.style.color = 'var(--ink-2)';
    msg.textContent = '登入中…';
    try {
      const r = await api('login', { credential: resp.credential });
      session = { token: r.token, user: r.user };
      storeSet(SESSION_KEY, session);
      storeSet('bsa.loggedOut', null);
      msg.textContent = '';
      showApp();
      toast('歡迎，' + (r.user.name || r.user.email), 'ok');
    } catch (e) {
      msg.style.color = '';
      msg.textContent = e.message;
      if (e.code === 'FORBIDDEN' && gsiReady) google.accounts.id.disableAutoSelect();
    }
  }

  function onAuthLost(message) {
    session = null;
    storeSet(SESSION_KEY, null);
    showLogin(message);
    if (gsiReady) google.accounts.id.prompt(); // 已授權過的帳號會自動重新登入
  }

  async function logout() {
    closeSheet();
    try { await api('logout'); } catch { /* ignore */ }
    if (gsiReady) google.accounts.id.disableAutoSelect();
    session = null;
    storeSet(SESSION_KEY, null);
    storeSet('bsa.loggedOut', true);
    showLogin('');
  }

  function showLogin(message) {
    $('#app').hidden = true;
    $('#login-screen').hidden = false;
    $('#login-msg').style.color = '';
    $('#login-msg').textContent = message || '';
  }

  function showApp() {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    const u = (session && session.user) || {};
    const initial = (u.name || u.email || '?').trim().charAt(0).toUpperCase();
    const av = $('#user-avatar');
    if (u.picture) { av.src = u.picture; av.hidden = false; $('#user-initial').textContent = ''; }
    else { av.hidden = true; $('#user-initial').textContent = initial; }
    $('#sheet-avatar').src = u.picture || '';
    $('#sheet-avatar').hidden = !u.picture;
    $('#sheet-name').textContent = u.name || '';
    $('#sheet-email').textContent = u.email || '';
    route();
  }

  /* ---------- account sheet ---------- */
  function openSheet() { $('#sheet').hidden = false; }
  function closeSheet() { $('#sheet').hidden = true; }

  /* ================================================================
   * Router
   * ================================================================ */
  function route() {
    let page = (location.hash || '').replace('#', '');
    if (!PAGES[page]) page = 'decide';
    $$('.page').forEach(p => { p.hidden = p.dataset.page !== page; });
    $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === page));
    $('#page-title').textContent = PAGES[page];
    document.title = PAGES[page] + '・寶寶買衣攻略器';
    window.scrollTo(0, 0);
    if (page === 'body') loadBody(false);
    if (page === 'records') loadRecords(false);
  }

  /* ================================================================
   * Shared: measurement inputs
   * ================================================================ */
  function measureInputsHtml(cat, values, attr) {
    return groupsFor(cat).map(([label, fields]) => {
      const head = groupsFor(cat).length > 1 ? `<div class="group-label">${label}</div>` : '';
      return head + fields.map(([k, l]) => `
        <label class="m-field"><span>${l}</span>
          <input type="number" inputmode="decimal" step="0.1" ${attr}="${k}" value="${esc(fmt(values[k]))}" placeholder="–">
        </label>`).join('');
    }).join('');
  }

  /* ================================================================
   * Page: 幫選尺寸
   * ================================================================ */
  const dc = { cards: [] };

  function dcCategory() { return $('#dc-category').value || 'other'; }

  function dcAddCard(init = {}) {
    const c = { id: uid(), include: true, size: '' };
    ALL_FIELDS.forEach(([k]) => { c[k] = num(init[k]); });
    c.size = String(init.size ?? '').trim();
    dc.cards.push(c);
    return c;
  }

  function dcRender() {
    const box = $('#dc-cards');
    const cat = dcCategory();
    if (!dc.cards.length) {
      box.innerHTML = `<div class="empty"><b>還沒有尺寸</b>拍一張商品的尺寸表，或手動新增要比較的尺寸</div>`;
    } else {
      box.innerHTML = dc.cards.map(c => `
        <div class="size-card ${c.include ? '' : 'off'}" data-id="${c.id}">
          <div class="size-card-top">
            <input class="size-input" data-f="size" value="${esc(c.size)}" placeholder="尺寸，如 90" autocomplete="off" aria-label="尺寸">
            <label class="toggle" title="列入候選">
              <input type="checkbox" data-f="include" ${c.include ? 'checked' : ''}>
              <span class="track"></span>
            </label>
            <button class="icon-btn" data-act="del" type="button" aria-label="刪除">
              <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>
            </button>
          </div>
          <div class="measure-grid">${measureInputsHtml(cat, c, 'data-m')}</div>
        </div>`).join('');
    }
    dcCount();
  }

  function dcCount() {
    const n = dc.cards.filter(c => c.include && c.size.trim()).length;
    $('#dc-count').textContent = dc.cards.length ? `${n} 個候選` : '';
  }

  function dcBind() {
    fillCatSelect($('#dc-category'));
    $('#dc-category').value = 'top';
    $('#dc-category').addEventListener('change', dcRender);

    const box = $('#dc-cards');
    box.addEventListener('input', (e) => {
      const card = e.target.closest('.size-card'); if (!card) return;
      const c = dc.cards.find(x => x.id === card.dataset.id); if (!c) return;
      if (e.target.dataset.f === 'size') c.size = e.target.value;
      if (e.target.dataset.m) c[e.target.dataset.m] = num(e.target.value);
      dcCount();
    });
    box.addEventListener('change', (e) => {
      if (e.target.dataset.f !== 'include') return;
      const card = e.target.closest('.size-card');
      const c = dc.cards.find(x => x.id === card.dataset.id);
      c.include = e.target.checked;
      card.classList.toggle('off', !c.include);
      dcCount();
    });
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="del"]'); if (!btn) return;
      const id = btn.closest('.size-card').dataset.id;
      dc.cards = dc.cards.filter(x => x.id !== id);
      dcRender();
    });

    $('#dc-add').addEventListener('click', () => {
      dcAddCard();
      dcRender();
      const inputs = $$('.size-input', box);
      inputs[inputs.length - 1]?.focus();
    });

    $('#dc-photo').addEventListener('click', () => $('#dc-file').click());
    $('#dc-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await busy($('#dc-photo'), 'AI 解析中…', async () => {
        try {
          const dataUrl = await imageToDataUrl(file);
          const r = await api('extract', { imageDataUrl: dataUrl });
          applyExtractToDecide(r.extracted);
        } catch (err) { toast(err.message, 'err', 4000); }
      });
    });

    $('#dc-run').addEventListener('click', () => busy($('#dc-run'), '思考中…', runDecide));
  }

  function applyExtractToDecide(ex) {
    const sizes = (ex && ex.sizes) || [];
    if (!sizes.length) { toast('沒抓到尺寸表，換張清楚一點的照片，或改用手動新增', 'err', 4200); return; }
    if (ex.brand && !$('#dc-brand').value.trim()) $('#dc-brand').value = ex.brand;
    if (ex.category && CAT_LABEL[ex.category]) $('#dc-category').value = ex.category;
    dc.cards = [];
    sizes.forEach(s => dcAddCard(s));
    dcRender();
    $('#dc-result').innerHTML = '';
    toast(`解析出 ${sizes.length} 個尺寸，請確認數值`, 'ok');
  }

  async function runDecide() {
    const valid = dc.cards.filter(c => c.size.trim());
    const cands = valid.filter(c => c.include).map(c => c.size.trim());
    if (!cands.length) { toast('請至少新增一個尺寸並列入候選', 'err'); return; }

    const brand = $('#dc-brand').value.trim();
    const category = dcCategory();
    const sizes = valid.map(c => {
      const o = { size: c.size.trim() };
      ALL_FIELDS.forEach(([k]) => { o[k] = c[k] ?? null; });
      return o;
    });

    try {
      const r = await api('decide', {
        extracted: { brand, category, unit: 'cm', sizes },
        candidates: Array.from(new Set(cands)).join(','),
        brand, category
      });
      renderDecision(r.decision, r.debug);
    } catch (err) { toast(err.message, 'err', 4000); }
  }

  function renderDecision(d, debug) {
    const modeText = {
      numeric_similarity: '依實穿紀錄數值比對',
      ai: 'AI 綜合判斷',
      ai_fallback: 'AI 綜合判斷',
      rule_fallback: '規則保底判斷'
    }[(debug && debug.mode) || ''] || '';
    const reasons = Array.isArray(d.reasons) ? d.reasons : (d.reasons ? [d.reasons] : []);
    $('#dc-result').innerHTML = `
      <div class="result">
        <div class="result-label">建議購買尺寸</div>
        <div class="result-size">${esc(d.recommended_size || '—')}</div>
        ${modeText ? `<span class="result-mode">${modeText}</span>` : ''}
        ${reasons.length ? `<ul>${reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${d.risk_note ? `<div class="result-risk">⚠ ${esc(d.risk_note)}</div>` : ''}
        <details class="debug"><summary>除錯資訊</summary><pre>${esc(JSON.stringify(debug, null, 2))}</pre></details>
      </div>`;
    setTimeout(() => $('#dc-result .result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }

  /* ================================================================
   * Page: 新增回饋
   * ================================================================ */
  const fb = { measures: {}, imageFileId: '', extracted: null };

  function fbRenderMeasures() {
    $('#fb-measures').innerHTML = measureInputsHtml($('#fb-category').value, fb.measures, 'data-m');
  }

  function fbRenderFitChips() {
    const text = $('#fb-fit').value;
    $('#fb-fit-chips').innerHTML = FIT_CHIPS.map(t =>
      `<button type="button" class="chip ${text.includes(t) ? 'on' : ''}" data-chip="${esc(t)}">${esc(t)}</button>`).join('');
  }

  function fbBind() {
    fillCatSelect($('#fb-category'));
    $('#fb-category').value = 'top';
    const last = storeGet(DRAFT_KEY);
    if (last) { $('#fb-brand').value = last.brand || ''; if (last.category) $('#fb-category').value = last.category; }

    $('#fb-category').addEventListener('change', fbRenderMeasures);
    $('#fb-measures').addEventListener('input', (e) => {
      if (e.target.dataset.m) fb.measures[e.target.dataset.m] = num(e.target.value);
    });

    $('#fb-fit').addEventListener('input', fbRenderFitChips);
    $('#fb-fit-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]'); if (!chip) return;
      const t = chip.dataset.chip;
      const el = $('#fb-fit');
      const parts = el.value.split(/[、,，]\s*/).map(s => s.trim()).filter(Boolean);
      const i = parts.indexOf(t);
      if (i >= 0) parts.splice(i, 1); else parts.push(t);
      el.value = parts.join('、');
      fbRenderFitChips();
    });

    $('#fb-photo').addEventListener('click', () => $('#fb-file').click());
    $('#fb-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await busy($('#fb-photo'), '上傳並解析中…', async () => {
        try {
          const dataUrl = await imageToDataUrl(file);
          const r = await api('uploadAndExtract', { dataUrl, filename: file.name || 'size-chart.jpg' });
          fb.imageFileId = r.fileId || '';
          fb.extracted = r.extracted;
          const sizes = (r.extracted && r.extracted.sizes) || [];
          if (!sizes.length) { toast('沒抓到尺寸表，可以直接手動填寫', 'err', 4000); $('#fb-pick').hidden = true; return; }
          if (r.extracted.brand && !$('#fb-brand').value.trim()) $('#fb-brand').value = r.extracted.brand;
          if (r.extracted.category && CAT_LABEL[r.extracted.category]) { $('#fb-category').value = r.extracted.category; fbRenderMeasures(); }
          $('#fb-pick-chips').innerHTML = sizes.map((s, i) =>
            `<button type="button" class="chip size-chip" data-i="${i}">${esc(s.size)}</button>`).join('');
          $('#fb-pick').hidden = false;
          toast('解析完成，選一個你買的尺寸', 'ok');
        } catch (err) { toast(err.message, 'err', 4000); }
      });
    });

    $('#fb-pick-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-i]'); if (!chip) return;
      const s = fb.extracted.sizes[Number(chip.dataset.i)];
      $$('#fb-pick-chips .chip').forEach(c => c.classList.toggle('on', c === chip));
      $('#fb-size').value = s.size || '';
      fb.measures = {};
      ALL_FIELDS.forEach(([k]) => { fb.measures[k] = num(s[k]); });
      fbRenderMeasures();
    });

    $('#fb-save').addEventListener('click', () => busy($('#fb-save'), '儲存中…', fbSave));
    fbRenderMeasures();
    fbRenderFitChips();
  }

  async function fbSave() {
    const brand = $('#fb-brand').value.trim();
    const size = $('#fb-size').value.trim();
    if (!brand) { toast('請填寫品牌', 'err'); $('#fb-brand').focus(); return; }
    if (!size) { toast('請填寫尺寸', 'err'); $('#fb-size').focus(); return; }

    const m = fb.measures;
    const category = $('#fb-category').value;
    const payload = {
      brand, category,
      category_des: $('#fb-catdes').value.trim(),
      baby_age_months: num($('#fb-age').value),
      labeled_size: size,
      shoulder_cm: m.shoulder ?? null, length_cm: m.length ?? null, chest_cm: m.chest ?? null, sleeve_cm: m.sleeve ?? null,
      waist_cm: m.waist ?? null, pants_length_cm: m.pants_length ?? null, inseam_cm: m.inseam ?? null, hip_cm: m.hip ?? null,
      fit_feedback: $('#fb-fit').value.trim(),
      style_note: $('#fb-style').value.trim(),
      image_file_id: fb.imageFileId || ''
    };

    try {
      await api('saveFeedback', payload);
      storeSet(DRAFT_KEY, { brand, category });
      toast('已儲存這筆穿著紀錄', 'ok');
      records.stale = true;
      // 保留品牌 / 類型 / 月齡，清掉單件內容
      ['#fb-size', '#fb-catdes', '#fb-style', '#fb-fit'].forEach(s => { $(s).value = ''; });
      fb.measures = {}; fb.imageFileId = ''; fb.extracted = null;
      $('#fb-pick').hidden = true;
      fbRenderMeasures(); fbRenderFitChips();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { toast(err.message, 'err', 4000); }
  }

  /* ================================================================
   * Page: 寶寶體型
   * ================================================================ */
  const body = { loaded: false, stale: true };

  function bdBind() {
    $('#bd-date').value = todayLocal();
    $('#bd-save').addEventListener('click', () => busy($('#bd-save'), '儲存中…', async () => {
      const height = num($('#bd-height').value), weight = num($('#bd-weight').value);
      if (!$('#bd-date').value || height === null || weight === null) { toast('請填寫日期、身高和體重', 'err'); return; }
      const age = num($('#bd-age').value);
      try {
        await api('addSizeRecord', {
          date: $('#bd-date').value,
          baby_age_months: age === null ? null : Math.max(0, Math.floor(age)),
          height_cm: height, weight_kg: weight,
          note: $('#bd-note').value.trim()
        });
        toast('已儲存', 'ok');
        ['#bd-height', '#bd-weight', '#bd-note'].forEach(s => { $(s).value = ''; });
        body.stale = true;
        loadBody(true);
      } catch (err) { toast(err.message, 'err', 4000); }
    }));
    $('#bd-reload').addEventListener('click', () => loadBody(true));
  }

  async function loadBody(force) {
    if (!force && !body.stale) return;
    const list = $('#bd-list');
    list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const r = await api('getSizeRecords');
      body.stale = false;
      const rows = r.rows || [];
      if (!rows.length) { list.innerHTML = '<div class="empty"><b>尚無紀錄</b>先新增一次身高體重，幫選尺寸會更準</div>'; return; }
      list.innerHTML = rows.map(x => `
        <div class="body-row">
          <div class="body-date"><b>${esc(x.date || '—')}</b>${x.baby_age_months != null ? esc(x.baby_age_months) + ' 個月' : ''}</div>
          <div class="metric"><b>${esc(fmt(x.height_cm) || '—')}</b><small>cm</small></div>
          <div class="metric"><b>${esc(fmt(x.weight_kg) || '—')}</b><small>kg</small></div>
          ${x.note ? `<div class="body-note">${esc(x.note)}</div>` : ''}
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty"><b>載入失敗</b>${esc(err.message)}</div>`;
    }
  }

  /* ================================================================
   * Page: 穿著紀錄
   * ================================================================ */
  const records = { rows: [], stale: true, openId: null };

  function rcBind() {
    fillCatSelect($('#rc-cat'), true);
    $('#rc-q').addEventListener('input', rcRender);
    $('#rc-cat').addEventListener('change', rcRender);
    $('#rc-reload').addEventListener('click', () => loadRecords(true));
    $('#rc-list').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit-id]');
      if (ed) { openEdit(ed.dataset.editId); return; }
      const tr = e.target.closest('tr.rc-row'); if (!tr) return;
      toggleRecordRow(tr);
    });
    $('#rc-list').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr.rc-row'); if (!tr) return;
      e.preventDefault(); toggleRecordRow(tr);
    });
  }

  function toggleRecordRow(tr) {
    const open = !tr.classList.contains('open');
    tr.classList.toggle('open', open);
    records.openId = open ? tr.dataset.id : null;
    tr.setAttribute('aria-expanded', String(open));
    const d = tr.nextElementSibling;
    if (d && d.classList.contains('rc-detail')) d.hidden = !open;
  }

  async function loadRecords(force) {
    if (!force && !records.stale) return;
    $('#rc-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const r = await api('getReferenceItems');
      records.rows = r.rows || [];
      records.stale = false;
      rcRender();
    } catch (err) {
      $('#rc-list').innerHTML = `<div class="empty"><b>載入失敗</b>${esc(err.message)}</div>`;
    }
  }

  function fitPills(r) {
    const out = [];
    const code = String(r.fit_code || '').toUpperCase();
    if (code === 'OK') out.push('<span class="pill ok">剛好</span>');
    else if (code === 'LOOSE' || code === 'TOO_BIG') out.push('<span class="pill loose">偏大</span>');
    else if (code === 'TIGHT' || code === 'TOO_SMALL') out.push('<span class="pill tight">偏小</span>');
    if (Number(r.fold_level) >= 1) out.push('<span class="pill fold">需反折</span>');
    return out.join('');
  }

  function rcRender() {
    const q = $('#rc-q').value.trim().toLowerCase();
    const cat = $('#rc-cat').value;
    const rows = records.rows.filter(r => {
      if (cat && r.category !== cat) return false;
      if (!q) return true;
      return [r.brand, r.category_des, r.style_note, r.fit_feedback, r.labeled_size].join(' ').toLowerCase().includes(q);
    });
    $('#rc-count').textContent = records.rows.length ? `${rows.length} / ${records.rows.length} 筆` : '';

    if (!rows.length) {
      $('#rc-list').innerHTML = records.rows.length
        ? '<div class="empty"><b>沒有符合的紀錄</b>換個關鍵字試試</div>'
        : '<div class="empty"><b>還沒有穿著紀錄</b>到「回饋」新增寶寶穿過的衣服</div>';
      return;
    }

    const dash = '<span class="muted">–</span>';
    const body = rows.map(r => {
      const measures = ALL_FIELDS
        .map(([k, l]) => [l, r[k + '_cm']])
        .filter(([, v]) => v !== null && v !== undefined && v !== '');
      const catText = r.category_des || CAT_LABEL[r.category] || '';
      return `
        <tr class="rc-row${records.openId === r.id ? ' open' : ''}" data-id="${esc(r.id)}" tabindex="0" aria-expanded="${records.openId === r.id}">
          <td class="c-brand">${r.brand ? esc(r.brand) : dash}</td>
          <td class="c-cat">${catText ? esc(catText) : dash}</td>
          <td class="c-size">${r.labeled_size ? esc(r.labeled_size) : dash}</td>
          <td class="c-fb"><div class="clamp">${fitPills(r)}${r.fit_feedback ? esc(r.fit_feedback) : (fitPills(r) ? '' : dash)}</div></td>
          <td class="c-style"><div class="clamp">${r.style_note ? esc(r.style_note) : dash}</div></td>
          <td class="c-age">${r.baby_age_months != null ? esc(r.baby_age_months) : dash}</td>
        </tr>
        <tr class="rc-detail"${records.openId === r.id ? '' : ' hidden'}>
          <td colspan="6">
            <div class="rc-detail-inner">
              ${measures.length
                ? `<div class="kv">${measures.map(([l, v]) => `<div><small>${l}</small><b>${esc(v)}</b></div>`).join('')}</div>`
                : '<p class="muted">此筆沒有尺寸數值</p>'}
              ${r.fit_feedback ? `<p><b>回饋</b>${esc(r.fit_feedback)}</p>` : ''}
              ${r.style_note ? `<p><b>款式</b>${esc(r.style_note)}</p>` : ''}
              ${r.note ? `<p><b>備註</b>${esc(r.note)}</p>` : ''}
              ${r.created_date ? `<p class="muted">紀錄於 ${esc(r.created_date)}</p>` : ''}
              <button class="btn btn-tonal btn-block rc-edit" type="button" data-edit-id="${esc(r.id)}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>
                編輯這筆
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

    $('#rc-list').innerHTML = `
      <div class="table-wrap">
        <table class="rc-table">
          <thead><tr>
            <th class="c-brand">品牌</th><th class="c-cat">分類</th><th class="c-size">size</th>
            <th class="c-fb">回饋</th><th class="c-style">款式/花色</th><th class="c-age">月齡</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="table-hint">點一列看尺寸細節・表格可左右滑動</p>`;
  }


  /* ================================================================
   * 編輯穿著紀錄
   * ================================================================ */
  const ed = { id: null, measures: {}, lastFocus: null };

  function toggleFitChip(textarea, t) {
    const parts = textarea.value.split(/[、,，]\s*/).map(x => x.trim()).filter(Boolean);
    const i = parts.indexOf(t);
    if (i >= 0) parts.splice(i, 1); else parts.push(t);
    textarea.value = parts.join('、');
  }

  function edRenderChips() {
    const text = $('#ed-fit').value;
    $('#ed-fit-chips').innerHTML = FIT_CHIPS.map(t =>
      `<button type="button" class="chip ${text.includes(t) ? 'on' : ''}" data-chip="${esc(t)}">${esc(t)}</button>`).join('');
  }

  function edRenderMeasures() {
    $('#ed-measures').innerHTML = measureInputsHtml($('#ed-category').value, ed.measures, 'data-m');
  }

  function openEdit(id) {
    const r = records.rows.find(x => x.id === id);
    if (!r) { toast('找不到這筆紀錄，請重新整理', 'err'); return; }
    ed.id = id;
    ed.lastFocus = document.activeElement;
    ed.measures = {};
    ALL_FIELDS.forEach(([k]) => { ed.measures[k] = num(r[k + '_cm']); });

    $('#ed-brand').value = r.brand || '';
    $('#ed-category').value = CAT_LABEL[r.category] ? r.category : 'other';
    $('#ed-size').value = r.labeled_size || '';
    $('#ed-age').value = r.baby_age_months ?? '';
    $('#ed-catdes').value = r.category_des || '';
    $('#ed-fit').value = r.fit_feedback || '';
    $('#ed-style').value = r.style_note || '';
    $('#ed-note').value = r.note || '';
    edRenderMeasures();
    edRenderChips();

    $('#edit-sheet').hidden = false;
    document.body.classList.add('no-scroll');
    $('.edit-body').scrollTop = 0;
  }

  function closeEdit() {
    $('#edit-sheet').hidden = true;
    document.body.classList.remove('no-scroll');
    ed.id = null;
    if (ed.lastFocus && ed.lastFocus.focus) ed.lastFocus.focus();
  }

  async function saveEdit() {
    const brand = $('#ed-brand').value.trim();
    const size = $('#ed-size').value.trim();
    if (!brand) { toast('請填寫品牌', 'err'); $('#ed-brand').focus(); return; }
    if (!size) { toast('請填寫尺寸', 'err'); $('#ed-size').focus(); return; }

    const cat = $('#ed-category').value;
    const shown = new Set(groupsFor(cat).flatMap(([, f]) => f.map(([k]) => k)));
    const m = {};
    ALL_FIELDS.forEach(([k]) => { m[k] = shown.has(k) ? (ed.measures[k] ?? null) : null; });

    const payload = {
      id: ed.id,
      brand, category: cat,
      category_des: $('#ed-catdes').value.trim(),
      labeled_size: size,
      baby_age_months: num($('#ed-age').value),
      shoulder_cm: m.shoulder, length_cm: m.length, chest_cm: m.chest, sleeve_cm: m.sleeve,
      waist_cm: m.waist, pants_length_cm: m.pants_length, inseam_cm: m.inseam, hip_cm: m.hip,
      fit_feedback: $('#ed-fit').value.trim(),
      style_note: $('#ed-style').value.trim(),
      note: $('#ed-note').value.trim()
    };

    try {
      const r = await api('updateFeedback', payload);
      const i = records.rows.findIndex(x => x.id === payload.id);
      if (i >= 0 && r.item) records.rows[i] = r.item;
      records.openId = payload.id;
      closeEdit();
      rcRender();
      toast('已更新', 'ok');
    } catch (err) { toast(err.message, 'err', 4000); }
  }

  function edBind() {
    fillCatSelect($('#ed-category'));
    $('#ed-category').addEventListener('change', edRenderMeasures);
    $('#ed-measures').addEventListener('input', (e) => {
      if (e.target.dataset.m) ed.measures[e.target.dataset.m] = num(e.target.value);
    });
    $('#ed-fit').addEventListener('input', edRenderChips);
    $('#ed-fit-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]'); if (!chip) return;
      toggleFitChip($('#ed-fit'), chip.dataset.chip);
      edRenderChips();
    });
    $$('[data-close-edit]').forEach(el => el.addEventListener('click', closeEdit));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#edit-sheet').hidden) closeEdit(); });
    $('#ed-save').addEventListener('click', () => busy($('#ed-save'), '儲存中…', saveEdit));
  }

  /* ================================================================
   * Boot
   * ================================================================ */
  function boot() {
    window.__booted = true;
    $('#login-msg').textContent = '';
    if (!window.APP_CONFIG) { showLogin('config.js 沒有載入或內容有語法錯誤（常見：引號、逗號）'); return; }
    dcBind(); fbBind(); bdBind(); rcBind(); edBind();
    dcRender();

    window.addEventListener('hashchange', () => { if (!$('#app').hidden) route(); });
    $('#user-btn').addEventListener('click', openSheet);
    $('#sheet').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeSheet(); });
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-ping').addEventListener('click', () => busy($('#btn-ping'), '測試中…', async () => {
      try { const r = await api('ping'); toast('連線正常（' + r.version + '）', 'ok'); }
      catch (err) { toast(err.message, 'err', 4000); }
    }));

    const unset = !CFG.API_URL || /YOUR_/.test(CFG.API_URL) || !CFG.GOOGLE_CLIENT_ID || /YOUR_/.test(CFG.GOOGLE_CLIENT_ID);
    if (unset) { showLogin('尚未設定 config.js 的 API_URL 與 GOOGLE_CLIENT_ID'); return; }

    initGsi();

    if (session && session.token) {
      showApp(); // 先顯示畫面，背景驗證 session
      api('me').then(r => { session.user = r.user; storeSet(SESSION_KEY, session); }).catch(() => { /* onAuthLost 已處理 */ });
    } else {
      showLogin('');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
