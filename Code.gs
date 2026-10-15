/***********************************************************************
 * 寶寶買衣攻略器 — Apps Script 後端（JSON API 版）
 *
 * 前端放在 GitHub Pages，透過 fetch POST 呼叫本 Web App。
 * 所有請求格式：{ action, token, data }
 * 所有回應格式：{ ok: true, ... } 或 { ok: false, error, code }
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   AI_API_KEY            OpenAI API key
 *   SPREADSHEET_ID        Google Sheet ID
 *   UPLOAD_FOLDER_ID      存放尺寸表照片的 Drive 資料夾 ID
 *   GOOGLE_CLIENT_ID      Google OAuth Web Client ID（xxx.apps.googleusercontent.com）
 *   ALLOWED_EMAILS        允許登入的 Gmail，逗號分隔
 *   OPENAI_MODEL_VISION   （選填）預設 gpt-4.1-mini
 *   OPENAI_MODEL_TEXT     （選填）預設 gpt-4.1-mini
 ***********************************************************************/

const PROPS = PropertiesService.getScriptProperties();
const SESSION_TTL_SEC = 21600; // CacheService 上限 6 小時
const MAX_IMAGE_BASE64_LEN = 12 * 1024 * 1024;

/* ===================================================================
 * Config
 * =================================================================== */
function getCfg() {
  const key = PROPS.getProperty('AI_API_KEY');
  const ssId = PROPS.getProperty('SPREADSHEET_ID');
  const folderId = PROPS.getProperty('UPLOAD_FOLDER_ID');
  const visionModel = PROPS.getProperty('OPENAI_MODEL_VISION') || 'gpt-4.1-mini';
  const textModel = PROPS.getProperty('OPENAI_MODEL_TEXT') || 'gpt-4.1-mini';

  if (!key) throw new Error('Missing Script property: AI_API_KEY');
  if (!ssId) throw new Error('Missing Script property: SPREADSHEET_ID');
  if (!folderId) throw new Error('Missing Script property: UPLOAD_FOLDER_ID');

  return { key, ssId, folderId, visionModel, textModel };
}

/* ===================================================================
 * Web entry points
 * =================================================================== */
const ACTIONS = {
  me: (data, user) => ({ ok: true, user }),
  logout: (data, user, token) => { CacheService.getScriptCache().remove('sess_' + token); return { ok: true }; },

  extract: (data) => extractSizeChart(data),
  uploadAndExtract: (data) => uploadAndExtract_(data),
  decide: (data) => decideSize(data),

  saveFeedback: (data, user) => saveFeedbackData(data, user),
  getReferenceItems: () => getReferenceItems(),

  addSizeRecord: (data, user) => addSizeRecord(data, user),
  getSizeRecords: () => ({ ok: true, rows: getSizeRecords() })
};

function doPost(e) {
  let out;
  try {
    const body = (e && e.postData && e.postData.contents) || '{}';
    const req = JSON.parse(body);
    const action = String(req.action || '');

    if (action === 'ping') {
      out = ping();
    } else if (action === 'login') {
      out = login_(req.data || {});
    } else {
      const fn = ACTIONS[action];
      if (!fn) throw new Error('Unknown action: ' + action);
      const user = requireUser_(req.token);
      out = fn(req.data || {}, user, req.token);
    }
  } catch (err) {
    out = { ok: false, error: (err && err.message) ? err.message : String(err), code: (err && err.code) || '' };
  }
  return json_(out);
}

function doGet() {
  return json_(ping());
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ping() {
  return { ok: true, time: new Date().toISOString(), version: 'v2-api+login' };
}

/* ===================================================================
 * Auth：Google ID token → 白名單 → session token（存在 CacheService）
 * =================================================================== */
function authError_(msg, code) {
  const e = new Error(msg);
  e.code = code || 'AUTH';
  return e;
}

function getAllowedEmails_() {
  return String(PROPS.getProperty('ALLOWED_EMAILS') || '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function verifyGoogleIdToken_(idToken) {
  const clientId = PROPS.getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('Missing Script property: GOOGLE_CLIENT_ID');
  if (!idToken) throw authError_('缺少 Google 登入憑證');

  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw authError_('Google 登入憑證無效，請重新登入');

  const info = JSON.parse(res.getContentText());
  if (info.aud !== clientId) throw authError_('登入憑證的 Client ID 不符');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(info.iss) === -1) throw authError_('登入憑證來源不正確');
  if (String(info.email_verified) !== 'true') throw authError_('此 Google 帳號 email 尚未驗證');
  if (Number(info.exp) * 1000 < Date.now()) throw authError_('登入憑證已過期');

  return {
    email: String(info.email || '').toLowerCase(),
    name: String(info.name || ''),
    picture: String(info.picture || '')
  };
}

function login_(data) {
  const user = verifyGoogleIdToken_(data.credential);
  const allowed = getAllowedEmails_();
  if (!allowed.length) throw new Error('伺服器尚未設定 ALLOWED_EMAILS');
  if (allowed.indexOf(user.email) === -1) {
    throw authError_('此帳號沒有使用權限：' + user.email, 'FORBIDDEN');
  }

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(user), SESSION_TTL_SEC);
  return { ok: true, token, user, expires_in: SESSION_TTL_SEC };
}

function requireUser_(token) {
  if (!token) throw authError_('請先登入');
  const raw = CacheService.getScriptCache().get('sess_' + String(token));
  if (!raw) throw authError_('登入已過期，請重新登入');
  const user = JSON.parse(raw);
  // 每次都重新檢查白名單：從 ALLOWED_EMAILS 移除後立即失效
  if (getAllowedEmails_().indexOf(user.email) === -1) throw authError_('此帳號的權限已被移除', 'FORBIDDEN');
  return user;
}

/**
 * 在編輯器手動執行一次：觸發授權、建立工作表、檢查設定。
 */
function setupCheck() {
  const result = {};
  ['AI_API_KEY', 'SPREADSHEET_ID', 'UPLOAD_FOLDER_ID', 'GOOGLE_CLIENT_ID', 'ALLOWED_EMAILS'].forEach(k => {
    result[k] = PROPS.getProperty(k) ? 'OK' : 'MISSING';
  });
  ensureBaseSheets_();
  result.spreadsheet = openSs_().getName();
  result.folder = DriveApp.getFolderById(getCfg().folderId).getName();
  result.allowed = getAllowedEmails_();
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true }); // 觸發外部連線授權
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* ===================================================================
 * Sheets helpers
 * =================================================================== */
let SS_CACHE_ = null;
function openSs_() {
  if (!SS_CACHE_) SS_CACHE_ = SpreadsheetApp.openById(getCfg().ssId);
  return SS_CACHE_;
}

function ensureSheet_(name, header) {
  const ss = openSs_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  if (header && header.length) {
    const lastCol = sh.getLastColumn();
    const lastRow = sh.getLastRow();
    if (lastRow === 0) {
      sh.appendRow(header);
    } else {
      const existing = sh.getRange(1, 1, 1, Math.max(1, lastCol)).getValues()[0].map(String);
      const nonEmpty = existing.some(x => String(x || '').trim());
      if (!nonEmpty) {
        sh.getRange(1, 1, 1, header.length).setValues([header]);
      } else {
        header.forEach(h => {
          if (existing.indexOf(h) === -1) {
            sh.getRange(1, sh.getLastColumn() + 1).setValue(h);
            existing.push(h);
          }
        });
      }
    }
  }
  return sh;
}

function getHeaderMap_(sh) {
  const lastCol = Math.max(1, sh.getLastColumn());
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const map = {};
  header.forEach((h, i) => { if (h) map[h] = i + 1; });
  return { header, map };
}

function appendByHeader_(sh, obj) {
  const normalized = {};
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null) normalized[k] = '';
    else if (v instanceof Date) normalized[k] = v;
    else if (typeof v === 'object') {
      try { normalized[k] = JSON.stringify(v); } catch (e) { normalized[k] = String(v); }
    } else normalized[k] = v;
  });

  const hm = getHeaderMap_(sh);
  Object.keys(normalized).forEach(k => {
    if (!hm.map[k]) sh.getRange(1, sh.getLastColumn() + 1).setValue(k);
  });

  const hm2 = getHeaderMap_(sh);
  const row = new Array(hm2.header.length).fill('');
  Object.keys(normalized).forEach(k => {
    const col = hm2.map[k];
    if (col) row[col - 1] = normalized[k];
  });
  sh.appendRow(row);
}

function readSheetObjects_(sh) {
  const values = sh.getDataRange().getValues();
  if (!values || values.length <= 1) return [];
  const header = values[0].map(h => String(h || '').trim());
  return values.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = row[i]; });
    return o;
  });
}

const BABY_PROFILE_HEADER = ['date', 'baby_age_months', 'height_cm', 'weight_kg', 'note', 'created_by', 'created_at'];
const REFERENCE_HEADER = [
  'id', 'created_at', 'created_by',
  'brand', 'category', 'category_des',
  'style_note',
  'baby_age_months',
  'labeled_size',
  'shoulder_cm', 'length_cm', 'chest_cm', 'sleeve_cm',
  'waist_cm', 'pants_length_cm', 'inseam_cm', 'hip_cm',
  'fit_feedback', 'note', 'image_file_id',
  'fit_struct_json', 'fit_code', 'fit_parts', 'fold_level',
  'fit_confidence', 'fit_updated_at', 'fit_rationale'
];

function ensureBaseSheets_() {
  ensureSheet_('baby_profile', BABY_PROFILE_HEADER);
  ensureSheet_('reference_items', REFERENCE_HEADER);
}

function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtDate_(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ===================================================================
 * Baby profile（身高體重）
 * =================================================================== */
function addSizeRecord(payload, user) {
  ensureBaseSheets_();
  const sh = ensureSheet_('baby_profile', BABY_PROFILE_HEADER);

  const height = numOrNull_(payload && payload.height_cm);
  const weight = numOrNull_(payload && payload.weight_kg);
  if (height === null || weight === null) throw new Error('請填寫身高和體重');

  const age = numOrNull_(payload && payload.baby_age_months);

  appendByHeader_(sh, {
    date: payload && payload.date ? new Date(payload.date + 'T00:00:00') : new Date(),
    baby_age_months: age === null ? '' : Math.floor(age),
    height_cm: height,
    weight_kg: weight,
    note: String((payload && payload.note) || ''),
    created_by: user ? user.email : '',
    created_at: new Date()
  });
  return { ok: true };
}

function getSizeRecords() {
  ensureBaseSheets_();
  const sh = ensureSheet_('baby_profile', BABY_PROFILE_HEADER);
  return readSheetObjects_(sh)
    .map(r => ({
      date: fmtDate_(r.date),
      baby_age_months: numOrNull_(r.baby_age_months),
      height_cm: numOrNull_(r.height_cm),
      weight_kg: numOrNull_(r.weight_kg),
      note: String(r.note || '')
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** 取最新一筆（依日期，而不是依列順序；欄位依表頭讀取） */
function getLatestBabyProfile_() {
  const rows = getSizeRecords().filter(r => r.height_cm !== null || r.weight_kg !== null);
  if (!rows.length) return { date: null, baby_age_months: null, height_cm: 80, weight_kg: 10, note: '', is_default: true };
  return rows[0];
}

/* ===================================================================
 * Drive upload
 * =================================================================== */
function parseDataUrl_(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) throw new Error('圖片格式不正確');
  if (m[2].length > MAX_IMAGE_BASE64_LEN) throw new Error('圖片太大，請換一張較小的照片');
  return { mimeType: m[1], b64: m[2] };
}

function uploadImage(base64DataUrl, filename) {
  const cfg = getCfg();
  const p = parseDataUrl_(base64DataUrl);
  const bytes = Utilities.base64Decode(p.b64);
  const blob = Utilities.newBlob(bytes, p.mimeType, filename || ('upload_' + Date.now() + '.jpg'));
  const file = DriveApp.getFolderById(cfg.folderId).createFile(blob);
  return { fileId: file.getId(), name: file.getName(), url: file.getUrl() };
}

/** 回饋頁用：上傳到 Drive（留存照片）＋ 直接用原圖解析 */
function uploadAndExtract_(data) {
  const up = uploadImage(data.dataUrl, data.filename);
  const res = extractSizeChart({ imageDataUrl: data.dataUrl });
  res.fileId = up.fileId;
  return res;
}

/* ===================================================================
 * reference_items：儲存穿著回饋
 * =================================================================== */
function saveReferenceItems(payload, user) {
  ensureBaseSheets_();
  const sh = ensureSheet_('reference_items', REFERENCE_HEADER);

  const brand = String((payload && payload.brand) || '');
  const category = String((payload && payload.category) || 'other');
  const imageFileId = String((payload && payload.image_file_id) || '');
  const now = new Date();

  const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  const selected = rows.filter(r => r && (r.selected === true || r.selected === 'true' || r.selected === 1));
  if (!selected.length) throw new Error('No selected rows to save');

  const savedIds = [];

  selected.forEach(r => {
    const labeled = String(r.size || r.labeled_size || '').trim();
    if (!labeled) return;

    const id = 'REF_' + Utilities.getUuid().slice(0, 8);
    const fitText = String(r.fit_feedback || '');

    const ageRaw = r.baby_age_months;
    const age = (ageRaw === null || ageRaw === undefined || ageRaw === '') ? '' : Math.floor(Number(ageRaw));

    const measures = {
      shoulder_cm: numOrNull_(r.shoulder),
      length_cm: numOrNull_(r.length),
      chest_cm: numOrNull_(r.chest),
      sleeve_cm: numOrNull_(r.sleeve),
      waist_cm: numOrNull_(r.waist),
      pants_length_cm: numOrNull_(r.pants_length),
      inseam_cm: numOrNull_(r.inseam),
      hip_cm: numOrNull_(r.hip)
    };

    // 1) 規則解析為主  2) category=other 且規則不確定時才用 AI
    let parsedFit = parseFitFeedbackDeterministic_(fitText, category);
    const needAI =
      category === 'other' && fitText.trim() &&
      (parsedFit.fit_code === 'UNKNOWN' ||
        (Array.isArray(parsedFit.parts) && parsedFit.parts.length === 1 && parsedFit.parts[0] === 'overall'));

    if (needAI) {
      try { parsedFit = parseFitFeedbackWithAI_(fitText, category); } catch (e) { /* AI 失敗就用規則結果 */ }
    }
    parsedFit = gateFitPartsByCategory_(parsedFit, category, measures);

    appendByHeader_(sh, {
      id,
      created_at: now,
      created_by: user ? user.email : '',
      brand,
      category,
      category_des: String(r.category_des || ''),
      style_note: String(r.style_note || ''),
      baby_age_months: age,
      labeled_size: labeled,

      shoulder_cm: measures.shoulder_cm,
      length_cm: measures.length_cm,
      chest_cm: measures.chest_cm,
      sleeve_cm: measures.sleeve_cm,
      waist_cm: measures.waist_cm,
      pants_length_cm: measures.pants_length_cm,
      inseam_cm: measures.inseam_cm,
      hip_cm: measures.hip_cm,

      fit_feedback: fitText,
      note: String(r.note || ''),
      image_file_id: imageFileId,

      fit_struct_json: JSON.stringify(parsedFit),
      fit_code: String(parsedFit.fit_code || ''),
      fit_parts: Array.isArray(parsedFit.parts) ? parsedFit.parts.join(',') : '',
      fold_level: (parsedFit.fold_level === null || parsedFit.fold_level === undefined) ? '' : parsedFit.fold_level,
      fit_confidence: String(parsedFit.confidence || ''),
      fit_updated_at: now,
      fit_rationale: String(parsedFit.rationale || '')
    });

    savedIds.push(id);
  });

  if (!savedIds.length) throw new Error('No valid rows saved (missing size)');
  return { ok: true, saved_ids: savedIds, count: savedIds.length };
}

/** 前端送單筆扁平欄位 */
function saveFeedbackData(payload, user) {
  ensureBaseSheets_();
  const p = payload || {};
  if (!String(p.brand || '').trim()) throw new Error('請填寫品牌');
  if (!String(p.labeled_size || '').trim()) throw new Error('請填寫尺寸');

  const row = {
    selected: true,
    size: String(p.labeled_size || '').trim(),
    shoulder: numOrNull_(p.shoulder_cm),
    length: numOrNull_(p.length_cm),
    chest: numOrNull_(p.chest_cm),
    sleeve: numOrNull_(p.sleeve_cm),
    waist: numOrNull_(p.waist_cm),
    pants_length: numOrNull_(p.pants_length_cm),
    inseam: numOrNull_(p.inseam_cm),
    hip: numOrNull_(p.hip_cm),
    fit_feedback: String(p.fit_feedback || ''),
    note: String(p.note || ''),
    category_des: String(p.category_des || ''),
    style_note: String(p.style_note || ''),
    baby_age_months: numOrNull_(p.baby_age_months)
  };

  return saveReferenceItems({
    brand: String(p.brand || '').trim(),
    category: String(p.category || 'other'),
    image_file_id: String(p.image_file_id || ''),
    rows: [row]
  }, user);
}

function getReferenceItems() {
  ensureBaseSheets_();
  const sh = ensureSheet_('reference_items', REFERENCE_HEADER);

  const rows = readSheetObjects_(sh).map(r => ({
    id: String(r.id || ''),
    brand: String(r.brand || ''),
    category: String(r.category || ''),
    category_des: String(r.category_des || ''),
    labeled_size: String(r.labeled_size || ''),
    fit_feedback: String(r.fit_feedback || ''),
    style_note: String(r.style_note || ''),
    note: String(r.note || ''),
    baby_age_months: numOrNull_(r.baby_age_months),
    created_date: fmtDate_(r.created_at),
    _ts: r.created_at ? new Date(r.created_at).getTime() || 0 : 0,

    shoulder_cm: numOrNull_(r.shoulder_cm),
    length_cm: numOrNull_(r.length_cm),
    chest_cm: numOrNull_(r.chest_cm),
    sleeve_cm: numOrNull_(r.sleeve_cm),
    waist_cm: numOrNull_(r.waist_cm),
    pants_length_cm: numOrNull_(r.pants_length_cm),
    inseam_cm: numOrNull_(r.inseam_cm),
    hip_cm: numOrNull_(r.hip_cm),
    image_file_id: String(r.image_file_id || ''),

    fit_code: String(r.fit_code || ''),
    fit_parts: String(r.fit_parts || ''),
    fold_level: (r.fold_level === '' || r.fold_level == null) ? '' : r.fold_level,
    fit_rationale: String(r.fit_rationale || '')
  }));

  rows.sort((a, b) => b._ts - a._ts);
  rows.forEach(r => delete r._ts);
  return { ok: true, count: rows.length, rows };
}

/* ===================================================================
 * OpenAI Responses API
 * =================================================================== */
function openaiResponses_(model, userContent, textFormatOrNull) {
  const cfg = getCfg();
  const payload = { model, input: [{ role: 'user', content: userContent }] };
  if (textFormatOrNull) payload.text = { format: textFormatOrNull };

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('[OpenAI API ERROR] 狀態: ' + code + ', 訊息: ' + text.slice(0, 300));

  const json = JSON.parse(text);
  const outText = (json.output_text && String(json.output_text).trim()) ? String(json.output_text) : extractResponsesText_(json);
  if (!outText) throw new Error('OpenAI 回傳內容結構異常：找不到文字輸出');
  return outText;
}

function extractResponsesText_(respJson) {
  const out = [];
  const output = respJson && respJson.output;
  if (!Array.isArray(output)) return '';
  output.forEach(item => {
    const content = item && item.content;
    if (!Array.isArray(content)) return;
    content.forEach(c => { if (c && typeof c.text === 'string') out.push(c.text); });
  });
  return out.join('\n').trim();
}

function safeJsonParse_(text) {
  if (!text) throw new Error('Empty AI response');
  let s = String(text).trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/g, '').trim();

  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in AI response');

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('Unclosed JSON object in AI response');
}

function ensureExtractShape_(x) {
  const out = (x && typeof x === 'object') ? x : {};
  out.brand = (out.brand === undefined) ? null : out.brand;
  out.category = out.category || 'other';
  out.unit = out.unit || 'cm';
  out.note = (out.note === undefined) ? '' : String(out.note);
  out.sizes = Array.isArray(out.sizes) ? out.sizes : [];
  out.confidence = out.confidence || (out.sizes.length ? 'medium' : 'low');

  out.sizes = out.sizes.map(r => {
    const rr = (r && typeof r === 'object') ? r : {};
    return {
      size: String(rr.size == null ? '' : rr.size).trim(),
      shoulder: numOrNull_(rr.shoulder),
      length: numOrNull_(rr.length),
      chest: numOrNull_(rr.chest),
      sleeve: numOrNull_(rr.sleeve),
      waist: numOrNull_(rr.waist),
      pants_length: numOrNull_(rr.pants_length),
      inseam: numOrNull_(rr.inseam),
      hip: numOrNull_(rr.hip)
    };
  }).filter(r => r.size);

  return out;
}

function normalizeExtracted_(obj) {
  if (obj && Array.isArray(obj.sizes)) return ensureExtractShape_(obj);

  const table = obj && (obj['尺寸表'] || obj.size_table || obj.SizeTable);
  if (Array.isArray(table)) {
    const pick = (r, keys) => { for (const k of keys) if (r[k] != null) return r[k]; return null; };
    const sizes = table.map(r => ({
      size: String(pick(r, ['size', '尺寸', '尺碼']) || '').trim(),
      shoulder: numOrNull_(pick(r, ['shoulder', '肩寬', '肩宽'])),
      length: numOrNull_(pick(r, ['length', '衣長', '衣长'])),
      chest: numOrNull_(pick(r, ['chest', '胸圍', '胸寬', '胸围', '胸宽'])),
      sleeve: numOrNull_(pick(r, ['sleeve', '袖長', '袖长'])),
      waist: numOrNull_(pick(r, ['waist', '腰圍', '腰围'])),
      pants_length: numOrNull_(pick(r, ['pants_length', '褲長', '裤长'])),
      inseam: numOrNull_(pick(r, ['inseam', '內長', '内长'])),
      hip: numOrNull_(pick(r, ['hip', '臀圍', '臀围']))
    })).filter(x => x.size);

    return ensureExtractShape_({
      brand: obj.brand == null ? null : obj.brand,
      category: obj.category || 'other',
      unit: 'cm', sizes,
      confidence: obj.confidence || 'medium',
      note: obj.note || ''
    });
  }

  return ensureExtractShape_({ brand: null, category: 'other', unit: 'cm', sizes: [], confidence: 'low', note: 'not a size chart' });
}

/* ===================================================================
 * 解析尺寸表
 * input: { imageDataUrl? , imageFileId?, text? }
 * =================================================================== */
function extractSizeChart(input) {
  ensureBaseSheets_();
  const cfg = getCfg();

  const content = [{
    type: 'input_text',
    text:
`你是「嬰幼兒服飾尺寸表抽取器」。
請從圖片或文字抽取尺寸表，並且只輸出 JSON（不得包含任何其他文字）。

【輸出格式】(key 必須是英文、不可中文)
{
  "brand": null或字串,
  "category": "top|pants|outerwear|tights|set|other",
  "unit": "cm",
  "sizes": [
    { "size":"90", "shoulder":27, "length":37.5, "chest":34.5, "sleeve":29.5,
      "waist":null, "pants_length":null, "inseam":null, "hip":null }
  ],
  "confidence":"high|medium|low",
  "note":""
}

【規則】
- 單位一律 cm（若原表非 cm 請換算；不確定寫 note）
- sizes 必須是陣列
- 沒有的欄位填 null
- 若不是尺寸表，回傳：
{ "unit":"cm", "sizes":[], "confidence":"low", "note":"not a size chart" }`
  }];

  if (input && input.imageDataUrl) {
    parseDataUrl_(input.imageDataUrl); // 驗證格式與大小
    content.push({ type: 'input_image', image_url: input.imageDataUrl });
  } else if (input && input.imageFileId) {
    const blob = DriveApp.getFileById(input.imageFileId).getBlob();
    const mime = blob.getContentType() || 'image/png';
    content.push({ type: 'input_image', image_url: 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes()) });
  }

  if (input && input.text && String(input.text).trim()) {
    content.push({ type: 'input_text', text: '文字內容：\n' + String(input.text).trim() });
  }
  if (content.length === 1) throw new Error('請提供尺寸表照片或文字');

  const outText = openaiResponses_(cfg.visionModel, content, { type: 'json_object' });
  const extracted = normalizeExtracted_(safeJsonParse_(outText));
  return { ok: true, extracted, debug: { model: cfg.visionModel, raw_preview: String(outText).slice(0, 300) } };
}

/* ===================================================================
 * 幫選尺寸
 * =================================================================== */
function getRefData_() {
  ensureBaseSheets_();
  return readSheetObjects_(ensureSheet_('reference_items', REFERENCE_HEADER));
}

function normalizeDecision_(obj, candidates) {
  const d = (obj && typeof obj === 'object') ? obj : {};
  let rec = String(d.recommended_size || d.size || d.recommend || '').trim();

  if (rec && candidates.length && candidates.indexOf(rec) === -1) {
    const hit = candidates.find(c => rec.indexOf(c) >= 0);
    rec = hit || '';
  }

  const reasons = (Array.isArray(d.reasons) ? d.reasons : []).map(String).filter(Boolean).slice(0, 2);
  let risk = String(d.risk_note || d.risk || '').trim();
  if (risk.length > 20) risk = risk.slice(0, 20);

  return { recommended_size: rec, reasons, risk_note: risk };
}

function ruleFallbackDecision_(baby, refs, sizes, candidates) {
  const babyHeight = (baby && baby.height_cm) || 80;
  const babyWeight = (baby && baby.weight_kg) || 10;

  let pick = candidates.indexOf('90') >= 0 ? '90' : (candidates[0] || '');
  const candNums = candidates.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const candMax = candNums[candNums.length - 1];

  if ((babyHeight >= 85 || babyWeight >= 12) && candMax) pick = String(candMax);

  const mapBySize = {};
  (sizes || []).forEach(r => { if (r && r.size) mapBySize[String(r.size)] = r; });
  const sMin = mapBySize[String(candNums[0])];
  if (sMin) {
    const len = numOrNull_(sMin.length), slv = numOrNull_(sMin.sleeve);
    if (((len !== null && len < 32) || (slv !== null && slv < 23)) && candMax) pick = String(candMax);
  }

  return {
    recommended_size: pick,
    reasons: ['候選中選' + pick + '，較符合不反折/舒適', '參考寶寶身高體重與既有紀錄'],
    risk_note: '仍建議量衣長'
  };
}

function decideSize(payload) {
  ensureBaseSheets_();
  const cfg = getCfg();

  const baby = getLatestBabyProfile_();
  const refs = getRefData_();

  const extracted = ensureExtractShape_(payload && payload.extracted ? payload.extracted : {});
  if (payload && payload.category) extracted.category = payload.category;

  const candidates = String((payload && payload.candidates) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!candidates.length) throw new Error('請至少提供一個候選尺寸');

  const preference = String((payload && payload.preference) || '').trim();

  // (A) 數值相似度
  const numeric = pickByNumericSimilarityV3_(baby, refs, extracted.sizes, candidates, extracted.category);
  if (numeric && numeric.ok && numeric.pick && candidates.indexOf(numeric.pick) >= 0 && numeric.debug.goodRefsCount > 0) {
    return {
      ok: true,
      decision: {
        recommended_size: numeric.pick,
        reasons: ['依歷史實穿尺寸數值相似度', '優先避免反折或過長'],
        risk_note: '仍建議看衣長'
      },
      debug: { mode: 'numeric_similarity', numeric, candidates, baby }
    };
  }

  // (B) AI
  const userContent = [
    {
      type: 'input_text',
      text:
`你是寶寶買衣服攻略器，要在 candidates 中選出 1 個 recommended_size。

【固定偏好】
- 不反折
- 舒適優先

【本次需求 preference】
${preference || '（未提供）'}

【判斷規則】
1) 優先參考 reference_items 中「實穿剛好 / 舒適 / 不用反折」的紀錄
2) 若某尺寸曾出現「需要反折 / 偏大」，請避免選擇
3) 若 extracted_size_chart 有多個尺寸，請比較肩寬、衣長、袖長（或褲長）
4) 僅能在 candidates 中選 1 個

【輸出格式】只輸出 JSON：
{"recommended_size":"90","reasons":["...","..."],"risk_note":"..."}

限制：
- reasons 最多 2 點
- risk_note 最多 20 字
- recommended_size 必須在 candidates 內`
    },
    {
      type: 'input_text',
      text: JSON.stringify({
        baby,
        reference_items: refs.slice(-100).map(r => {
          const o = Object.assign({}, r);
          delete o.fit_struct_json; delete o.image_file_id; delete o.created_by;
          return o;
        }),
        extracted_size_chart: extracted,
        candidates,
        preference
      })
    }
  ];

  let decision, rawPreview = '';
  try {
    const outText = openaiResponses_(cfg.textModel, userContent, { type: 'json_object' });
    rawPreview = String(outText).slice(0, 200);
    decision = normalizeDecision_(safeJsonParse_(outText), candidates);
  } catch (e) {
    decision = { recommended_size: '' };
    rawPreview = 'AI error: ' + e.message;
  }

  // (C) 規則保底
  let mode = 'ai';
  if (!decision.recommended_size) {
    decision = ruleFallbackDecision_(baby, refs, extracted.sizes, candidates);
    decision.risk_note = decision.risk_note || 'AI回空，已用規則';
    mode = 'rule_fallback';
  }

  return { ok: true, decision, debug: { mode, candidates, baby, raw_preview: rawPreview } };
}

function pickByNumericSimilarityV3_(baby, refs, extractedSizes, candidates, category) {
  const cat = String(category || 'other');
  const refRows = (Array.isArray(refs) ? refs : []).filter(r => String(r.category || '') === cat);
  const candSet = new Set((candidates || []).map(String));
  const refInCand = refRows.filter(r => candSet.has(String(r.labeled_size || '')));

  function isTopOversized_(text) {
    const t = String(text || '');
    const oversized = /版型較大|偏大|太大|寬鬆|寬松|鬆|偏寬|偏宽/.test(t);
    const noFold = /不用折|不需折|不用反折|不需要反折|袖子不用折|袖子不需折/.test(t);
    return oversized && noFold;
  }

  let upperBoundSizeNum = null;
  if (cat === 'top') {
    refInCand.forEach(r => {
      if (isTopOversized_(r.fit_feedback || r.note || '')) {
        const n = Number(r.labeled_size);
        if (Number.isFinite(n)) upperBoundSizeNum = (upperBoundSizeNum === null) ? n : Math.min(upperBoundSizeNum, n);
      }
    });
  }

  const sizeMap = {};
  (extractedSizes || []).forEach(s => { if (s && s.size != null) sizeMap[String(s.size)] = s; });

  const first = (extractedSizes && extractedSizes[0]) ? extractedSizes[0] : {};
  const target = {
    shoulder_cm: numOrNull_(first.shoulder),
    length_cm: numOrNull_(first.length),
    chest_cm: numOrNull_(first.chest),
    sleeve_cm: numOrNull_(first.sleeve)
  };

  function dist_(refRow) {
    let sum = 0, cnt = 0;
    ['shoulder_cm', 'length_cm', 'chest_cm', 'sleeve_cm'].forEach(k => {
      const tv = target[k], rv = numOrNull_(refRow[k]);
      if (tv === null || rv === null) return;
      sum += Math.abs(tv - rv); cnt++;
    });
    return cnt ? sum / cnt : 9999;
  }

  const scored = (candidates || []).map(sz => {
    const sizeStr = String(sz);
    const ref = refInCand.find(r => String(r.labeled_size || '') === sizeStr);
    let pseudoRef = ref;
    if (!pseudoRef && sizeMap[sizeStr]) {
      const ex = sizeMap[sizeStr];
      pseudoRef = { labeled_size: sizeStr, shoulder_cm: ex.shoulder, length_cm: ex.length, chest_cm: ex.chest, sleeve_cm: ex.sleeve };
    }
    const avgNear = pseudoRef ? dist_(pseudoRef) : 9999;

    let penalty = 0;
    const sizeNum = Number(sizeStr);
    if (cat === 'top' && upperBoundSizeNum !== null && Number.isFinite(sizeNum) && sizeNum > upperBoundSizeNum) {
      penalty += (sizeNum - upperBoundSizeNum) * 3.0;
    }
    return { size: sizeStr, score: -avgNear - penalty, avgNear, penalty };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    ok: true,
    pick: (scored[0] && scored[0].size) || (candidates[0] || ''),
    debug: { category: cat, goodRefsCount: refInCand.length, upperBoundSizeNum, target, scored }
  };
}

/* ===================================================================
 * 合身回饋結構化
 * =================================================================== */
function parseFitFeedbackWithAI_(fitText, category) {
  const cfg = getCfg();
  const text = String(fitText || '').trim();
  if (!text) return { fit_code: '', parts: [], fold_level: null, confidence: 'low', rationale: 'empty' };

  const userContent = [
    {
      type: 'input_text',
      text:
`你是「嬰幼兒穿著回饋結構化器」。
我會給你一段中文穿著回饋（自然語句），請你只輸出 JSON（不得包含任何其他文字）。

【輸出 JSON 格式】
{
  "fit_code": "OK|LOOSE|TIGHT|TOO_BIG|TOO_SMALL",
  "parts": ["overall|sleeve|length|chest|waist|pants_length|hip"],
  "fold_level": 0|1|2|null,
  "confidence": "high|medium|low",
  "rationale": "一句話原因(<=30字)"
}

【判斷規則】
- 如果提到「要反折/反摺/捲袖/捲褲」=> fold_level 至少 1；若提到「反折兩次/很多次」=> 2
- parts 請根據回饋提到的部位判斷，沒明確就用 ["overall"]
- fit_code:
  - 太大/偏大/鬆/寬/長很多 => TOO_BIG 或 LOOSE（很多就 TOO_BIG）
  - 太小/偏小/緊/卡 => TOO_SMALL 或 TIGHT（很多就 TOO_SMALL）
  - 剛好/舒適/合身/不用反折 => OK
- 若內容模糊 => confidence=low，parts=["overall"]`
    },
    { type: 'input_text', text: JSON.stringify({ category: category || 'other', fit_feedback: text }) }
  ];

  const parsed = safeJsonParse_(openaiResponses_(cfg.textModel, userContent, { type: 'json_object' }));
  const parts = Array.isArray(parsed.parts) ? parsed.parts.map(x => String(x).trim()).filter(Boolean) : [];
  let fold = parsed.fold_level;
  if (fold === '' || fold === undefined) fold = null;
  if (fold !== null) {
    const n = Number(fold);
    fold = Number.isFinite(n) ? Math.max(0, Math.min(2, Math.floor(n))) : null;
  }
  return {
    fit_code: String(parsed.fit_code || '').trim(),
    parts: parts.length ? parts : ['overall'],
    fold_level: fold,
    confidence: String(parsed.confidence || 'low').trim(),
    rationale: String(parsed.rationale || '').trim().slice(0, 30)
  };
}

function parseFitFeedbackDeterministic_(text, category) {
  const t = String(text || '').trim().toLowerCase();
  const cat = String(category || '').toLowerCase();
  const isTop = (cat === 'top' || cat === 'outerwear');
  const isBottom = (cat === 'pants' || cat === 'tights');
  const has = (re) => re.test(t);

  const negFold = has(/(不用|不需|無需|免|不需要)\s*(反折|折|折袖|折褲)/);
  const posFold = has(/(要|需要|必須|得)\s*(反折|折|折袖|折褲)/) || has(/反折|折袖|折褲/);

  const oversized = has(/版型較大|偏大|太大|寬鬆|宽松|鬆|偏寬|偏宽|大一點|oversize|loose/) || has(/稍長|有點長|略長/);
  const tight = has(/偏小|太小|緊|卡|勒|tight/);
  const comfy = has(/舒適|刚好|剛好|合身|剛剛好|ok|perfect|不需反折|不用反折|不用折/);

  const mentionSleeve = has(/袖|袖子|袖長|袖长/);
  const mentionLength = has(/衣長|衣长|長度|太長|过长|過長/);
  const mentionChest = has(/胸|胸圍|胸围|胸寬|胸宽/);
  const mentionWaist = has(/腰|腰圍|腰围/);
  const mentionPants = has(/褲|裤|褲子|裤子|褲長|裤长|褲管|裤管/);
  const mentionHip = has(/臀|臀圍|臀围/);
  const mentionInseam = has(/內長|内长|inseam/);

  const fold_level = negFold ? 0 : (posFold ? 1 : 0);

  let fit_code = '';
  if (tight) fit_code = 'TIGHT';
  if (oversized) fit_code = 'LOOSE';
  if (comfy && !oversized && !tight) fit_code = 'OK';
  if (oversized && comfy) fit_code = 'LOOSE';
  if (tight && comfy) fit_code = 'TIGHT';
  if (!fit_code) fit_code = 'UNKNOWN';

  let parts = [];
  if (isTop) {
    if (mentionSleeve) parts.push('sleeve');
    if (mentionLength) parts.push('length');
    if (mentionChest) parts.push('chest');
    if (fold_level >= 1 && !mentionSleeve) parts.push('overall');
    if (!parts.length && (oversized || tight)) parts.push('overall');
  } else if (isBottom) {
    if (mentionPants) parts.push('pants_length');
    if (mentionWaist) parts.push('waist');
    if (mentionHip) parts.push('hip');
    if (mentionInseam) parts.push('inseam');
    if (fold_level >= 1 && !mentionPants) parts.push('overall');
    if (!parts.length && (oversized || tight)) parts.push('overall');
  } else {
    if (mentionSleeve) parts.push('sleeve');
    if (mentionLength) parts.push('length');
    if (mentionPants) parts.push('pants_length');
    if (mentionWaist) parts.push('waist');
    if (mentionHip) parts.push('hip');
    if (mentionInseam) parts.push('inseam');
    if (fold_level >= 1) parts.push('overall');
    if (!parts.length) parts.push('overall');
  }
  parts = Array.from(new Set(parts));

  const notes = [];
  if (oversized) notes.push('偏大/寬鬆');
  if (tight) notes.push('偏緊/偏小');
  if (comfy) notes.push('舒適/合身');
  if (negFold) notes.push('不用反折');
  if (!negFold && fold_level >= 1) notes.push('需要反折');

  return { fit_code, parts: parts.length ? parts : ['overall'], fold_level, confidence: 'rule', rationale: notes.join('、').slice(0, 30) };
}

function gateFitPartsByCategory_(parsedFit, category, measures) {
  const cat = String(category || 'other').toLowerCase();
  const topParts = new Set(['sleeve', 'length', 'shoulder', 'chest', 'overall']);
  const pantsParts = new Set(['pants_length', 'waist', 'hip', 'inseam', 'overall']);

  const m = measures || {};
  const hasTop = m.shoulder_cm != null || m.length_cm != null || m.chest_cm != null || m.sleeve_cm != null;
  const hasPants = m.waist_cm != null || m.pants_length_cm != null || m.inseam_cm != null || m.hip_cm != null;

  const isTop = (cat === 'top' || cat === 'outerwear');
  const isPants = (cat === 'pants' || cat === 'tights');
  const isSet = (cat === 'set') || (hasTop && hasPants);

  let parts = Array.isArray(parsedFit && parsedFit.parts) ? parsedFit.parts.map(String) : [];
  if (isSet) parts = parts.filter(p => topParts.has(p) || pantsParts.has(p));
  else if (isTop || (hasTop && !hasPants)) parts = parts.filter(p => topParts.has(p));
  else if (isPants || (hasPants && !hasTop)) parts = parts.filter(p => pantsParts.has(p));
  else parts = parts.filter(p => topParts.has(p) || pantsParts.has(p));
  parts = Array.from(new Set(parts));
  if (!parts.length) parts = ['overall'];

  return {
    fit_code: String((parsedFit && parsedFit.fit_code) || ''),
    parts,
    fold_level: (parsedFit && parsedFit.fold_level !== undefined) ? parsedFit.fold_level : null,
    confidence: String((parsedFit && parsedFit.confidence) || 'low'),
    rationale: String((parsedFit && parsedFit.rationale) || '').slice(0, 30)
  };
}

/**
 * 批次補跑既有資料的結構化欄位（在編輯器手動執行）
 *   backfillFitFeedbackBatch()  /  backfillFitFeedbackBatch({ limit: 50, force: true })
 */
function backfillFitFeedbackBatch(arg) {
  let limit = 50, force = false;
  if (typeof arg === 'number') limit = arg;
  else if (arg && typeof arg === 'object') { if (arg.limit != null) limit = Number(arg.limit); force = arg.force === true; }
  const MAX = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;

  ensureBaseSheets_();
  const sh = ensureSheet_('reference_items', REFERENCE_HEADER);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return { ok: true, updated: 0, skipped: 0, total: 0 };

  const col = {};
  values[0].map(h => String(h || '').trim()).forEach((h, i) => { if (h) col[h] = i; });

  const now = new Date();
  let updated = 0, skipped = 0;
  const setCell = (r, k, v) => { if (col[k] != null) sh.getRange(r, col[k] + 1).setValue(v); };

  for (let r = 1; r < values.length && updated < MAX; r++) {
    const row = values[r];
    const feedback = String(row[col.fit_feedback] || '').trim();
    if (!feedback) { skipped++; continue; }
    if (!force && String(row[col.fit_struct_json] || '').trim()) { skipped++; continue; }

    const p = parseFitFeedbackDeterministic_(feedback, String(row[col.category] || 'other'));
    setCell(r + 1, 'fit_struct_json', JSON.stringify(p));
    setCell(r + 1, 'fit_code', p.fit_code);
    setCell(r + 1, 'fit_parts', p.parts.join(','));
    setCell(r + 1, 'fold_level', p.fold_level == null ? '' : p.fold_level);
    setCell(r + 1, 'fit_confidence', p.confidence);
    setCell(r + 1, 'fit_updated_at', now);
    setCell(r + 1, 'fit_rationale', p.rationale);
    updated++;
  }
  return { ok: true, updated, skipped, total: values.length - 1, force, limit: MAX };
}
