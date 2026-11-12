/**
 * Marine Assist – WhatsApp job alerts (Google Apps Script)
 *
 * The portal calls this web app with {type:"job"|"case", id}. The script does NOT trust
 * anything else the caller sends: it reads the request itself from Firestore, checks it
 * is new, finds matching businesses, and sends each one an approved WhatsApp template.
 *
 * Setup (details in the chat guide):
 *  1. Paste this file into a new Apps Script project (script.google.com).
 *  2. Project Settings → Script Properties → add:
 *       WA_TOKEN     = your permanent System User access token from Meta
 *       WA_PHONE_ID  = your WhatsApp "Phone number ID" (not the phone number itself)
 *       TEST_TO      = your own WhatsApp number for testing, e.g. 9607771234
 *  3. Edit CFG below (SITE_URL especially).
 *  4. Run testSend() once from the editor and approve the permissions.
 *  5. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *     Copy the web app URL into CONFIG.alertsUrl in the portal.
 *  6. Optional: add a daily time trigger for cleanupOldKeys().
 */

const CFG = {
  PROJECT_ID: 'marine-assist-ae874',
  API_KEY: '',             // not needed: Firestore reads here are public. Leave empty so a referrer-restricted key isn't required.
  SITE_URL: 'https://vaddever.github.io/marine-assist/',  // ← change to where the portal is hosted
  WA_VERSION: 'v25.0',                                    // Meta Graph API version
  TEMPLATE: 'job_request_alert',                              // approved template name
  LANG: 'en',                                             // template language code as approved in WhatsApp Manager
  COUNTRY_CODE: '960',
  MAX_AGE_MIN: 120,        // ignore requests older than this (stops re-sending old jobs)
  MAX_PER_REQUEST: 25,     // most businesses alerted for one request
  MAX_PER_DAY: 300         // safety cap on messages per day (controls cost)
};

/* ---------------- web app entry ---------------- */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  const type = String(body.type || ''), id = String(body.id || '');
  if (!['job', 'case'].includes(type) || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return out({ ok: false, error: 'bad request' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return out({ ok: false, error: 'busy' });
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'sent_' + type + '_' + id;
    if (props.getProperty(key)) return out({ ok: true, skipped: 'already notified' });
    props.setProperty(key, String(Date.now()));          // mark first so repeats are ignored
    const result = type === 'job' ? alertForJob(id) : alertForCase(id);
    console.log(JSON.stringify({ type, id, result }));
    return out({ ok: true, result });
  } catch (err) {
    console.error(err);
    return out({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return out({ ok: true, service: 'Marine Assist alerts' }); }

/* ---------------- request types ---------------- */
function alertForJob(jobId) {
  const job = fsGet('jobs/' + jobId);
  if (!job) return 'job not found';
  if (job.status !== 'open') return 'job not open';
  if (!isRecent(job.createdAt)) return 'job too old';

  const sub = fsGet('config/subscription');
  const providers = fsList('providers').filter(p => matches(p, job.category, job.atoll) && subscribed(p, sub));
  const label = categoryLabel(job.category);
  const where = [job.island, job.atoll].filter(String).join(', ') || 'the Maldives';
  const link = CFG.SITE_URL + '#requests';
  let sent = 0, failed = 0;
  providers.slice(0, CFG.MAX_PER_REQUEST).forEach(p => {
    if (!underDailyCap()) return;
    const r = sendTemplate(waNumber(p), [label, where, job.title, link]);
    r.ok ? sent++ : failed++;
  });
  return { matched: providers.length, sent, failed };
}

function alertForCase(caseId) {
  const c = fsGet('cases/' + caseId);
  if (!c) return 'case not found';
  if (c.source !== 'direct') return 'not a direct request';
  if (!isRecent(c.createdAt)) return 'case too old';
  const p = fsGet('providers/' + c.providerId);
  if (!p || p.status !== 'approved' || p.paused || p.waAlerts === false) return 'provider not alertable';
  if (!subscribed(p, fsGet('config/subscription'))) return 'provider subscription expired';
  if (!underDailyCap()) return 'daily cap reached';
  const where = [c.island, c.atoll].filter(String).join(', ') || 'the Maldives';
  const r = sendTemplate(waNumber(p), [categoryLabel(c.category), where, c.title, CFG.SITE_URL + '#register']);
  return { sent: r.ok ? 1 : 0, failed: r.ok ? 0 : 1 };
}

/* ---------------- matching ---------------- */
function matches(p, category, atoll) {
  if (p.status !== 'approved' || p.paused || p.waAlerts === false) return false;
  if (!(p.categories || []).includes(category)) return false;
  const cov = p.coverage || [];
  return !atoll || p.atoll === atoll || cov.includes(atoll) || cov.includes('ALL');
}
// Same rule as the portal: free period from approval, or a paid subscription that hasn't run out
function subscribed(p, sub) {
  if (!sub || !sub.enabled) return true;
  const trialEnd = (Number(p.approvedAt) || Number(p.createdAt) || 0) + (Number(sub.freeDays) || 0) * 864e5;
  return Math.max(trialEnd, Number(p.subUntil) || 0) > Date.now();
}
function waNumber(p) {
  const d = String(p.whatsapp || p.phone || '').replace(/\D/g, '').replace(/^960/, '');
  return d.length === 7 ? CFG.COUNTRY_CODE + d : '';
}
function categoryLabel(id) {
  try {
    const c = fsGet('config/categories');
    const hit = c && (c.items || []).find(i => i.id === id);
    if (hit) return hit.label;
  } catch (e) {}
  return id || 'service';
}
function isRecent(ms) { return typeof ms === 'number' && Date.now() - ms < CFG.MAX_AGE_MIN * 60000; }
function underDailyCap() {
  const props = PropertiesService.getScriptProperties();
  const key = 'day_' + Utilities.formatDate(new Date(), 'Indian/Maldives', 'yyyy-MM-dd');
  const n = Number(props.getProperty(key) || 0);
  if (n >= CFG.MAX_PER_DAY) return false;
  props.setProperty(key, String(n + 1));
  return true;
}

/* ---------------- WhatsApp ---------------- */
function sendTemplate(to, params) {
  if (!to) return { ok: false, error: 'no valid number' };
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('WA_TOKEN'), phoneId = props.getProperty('WA_PHONE_ID');
  if (!token || !phoneId) throw new Error('Set WA_TOKEN and WA_PHONE_ID in Script Properties');
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'template',
    template: {
      name: CFG.TEMPLATE,
      language: { code: CFG.LANG },
      components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: clean(t) })) }]
    }
  };
  const res = UrlFetchApp.fetch('https://graph.facebook.com/' + CFG.WA_VERSION + '/' + phoneId + '/messages', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  const ok = res.getResponseCode() === 200;
  if (!ok) console.warn('WhatsApp error for ' + to + ': ' + res.getContentText());
  return { ok, code: res.getResponseCode() };
}
// Template parameters can't contain new lines, tabs or more than 4 spaces in a row
function clean(t) { return (String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 300)) || '-'; }

/* ---------------- Firestore REST (read-only, public rules) ---------------- */
function fsBase() { return 'https://firestore.googleapis.com/v1/projects/' + CFG.PROJECT_ID + '/databases/(default)/documents/'; }
function fsGet(path) {
  const r = UrlFetchApp.fetch(fsBase() + path + (CFG.API_KEY ? '?key=' + CFG.API_KEY : ''), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  return fromDoc(JSON.parse(r.getContentText()));
}
function fsList(col) {
  const out = []; let token = '';
  do {
    const url = fsBase() + col + '?pageSize=300' + (CFG.API_KEY ? '&key=' + CFG.API_KEY : '') + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Firestore list failed: ' + r.getContentText());
    const j = JSON.parse(r.getContentText());
    (j.documents || []).forEach(d => out.push(fromDoc(d)));
    token = j.nextPageToken || '';
  } while (token);
  return out;
}
function fromDoc(d) { const o = { id: d.name.split('/').pop() }; const f = d.fields || {}; for (const k in f) o[k] = val(f[k]); return o; }
function val(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) { const o = {}, f = v.mapValue.fields || {}; for (const k in f) o[k] = val(f[k]); return o; }
  return null;
}

/* ---------------- helpers ---------------- */
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Run from the editor: sends one sample alert to TEST_TO. */
function testSend() {
  const to = String(PropertiesService.getScriptProperties().getProperty('TEST_TO') || '').replace(/\D/g, '');
  if (!to) throw new Error('Add TEST_TO in Script Properties, e.g. 9607771234');
  const r = sendTemplate(to, ['Engine repair and service', 'Hulhumalé, Kaafu', 'Test alert: outboard won’t start', CFG.SITE_URL + '#requests']);
  console.log(JSON.stringify(r));
}

/** Run from the editor: lists which businesses would get an alert for a job, without sending. */
function previewJob(jobId) {
  const job = fsGet('jobs/' + (jobId || ''));
  if (!job) return console.log('job not found');
  const sub = fsGet('config/subscription');
  const list = fsList('providers').filter(p => matches(p, job.category, job.atoll) && subscribed(p, sub));
  console.log(list.map(p => p.name + ' → ' + waNumber(p)).join('\n') || 'no matching businesses');
}

/** Optional daily trigger: removes "already sent" markers older than 7 days. */
function cleanupOldKeys() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties(), week = 7 * 864e5;
  Object.keys(all).forEach(k => {
    if (k.startsWith('sent_') && Date.now() - Number(all[k]) > week) props.deleteProperty(k);
    if (k.startsWith('day_') && k < 'day_' + Utilities.formatDate(new Date(Date.now() - week), 'Indian/Maldives', 'yyyy-MM-dd')) props.deleteProperty(k);
  });
}

/* ---------------- one-time setup helpers ---------------- */

/** Run from the editor: shows the status of your sending number as Meta sees it. */
function checkNumber() {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch('https://graph.facebook.com/' + CFG.WA_VERSION + '/' + props.getProperty('WA_PHONE_ID') +
    '?fields=display_phone_number,verified_name,code_verification_status,name_status,quality_rating,status',
    { headers: { Authorization: 'Bearer ' + props.getProperty('WA_TOKEN') }, muteHttpExceptions: true });
  console.log(res.getContentText());
}

/**
 * Run ONCE from the editor to register your sending number with the Cloud API
 * (fixes error #133010 "Account not registered").
 * Put a 6-digit PIN in Script Properties as WA_PIN first. If the number already has
 * two-step verification, use that existing PIN; otherwise the PIN you choose becomes it. Keep it safe.
 */
function registerNumber() {
  const props = PropertiesService.getScriptProperties();
  const pin = String(props.getProperty('WA_PIN') || '');
  if (!/^\d{6}$/.test(pin)) throw new Error('Add WA_PIN (6 digits) in Script Properties first');
  const res = UrlFetchApp.fetch('https://graph.facebook.com/' + CFG.WA_VERSION + '/' + props.getProperty('WA_PHONE_ID') + '/register', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ messaging_product: 'whatsapp', pin: pin }),
    headers: { Authorization: 'Bearer ' + props.getProperty('WA_TOKEN') }, muteHttpExceptions: true
  });
  console.log(res.getResponseCode() + ' ' + res.getContentText());
}

/**
 * Run from the editor: lists your message templates with their exact language codes and status.
 * Needs WA_WABA_ID in Script Properties (WhatsApp Business Account ID, shown on the API Setup page).
 */
function listTemplates() {
  const props = PropertiesService.getScriptProperties();
  const waba = props.getProperty('WA_WABA_ID');
  if (!waba) throw new Error('Add WA_WABA_ID (WhatsApp Business Account ID) in Script Properties first');
  const res = UrlFetchApp.fetch('https://graph.facebook.com/' + CFG.WA_VERSION + '/' + waba +
    '/message_templates?fields=name,language,status,category&limit=100',
    { headers: { Authorization: 'Bearer ' + props.getProperty('WA_TOKEN') }, muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (!j.data) return console.log(res.getContentText());
  console.log(j.data.map(t => `${t.name}  |  language: ${t.language}  |  ${t.status}  |  ${t.category}`).join('\n') || 'No templates found in this account');
}
