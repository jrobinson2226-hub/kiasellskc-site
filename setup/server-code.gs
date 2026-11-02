/**
 * Kia's CRM server.
 * Runs in Kia's Google account (kiasellskc@gmail.com) as a Google Apps Script web app.
 * Lofty stays the main record: every read and write goes straight to Lofty's API.
 * This script also signs people in, sends email from Kia's Gmail, and adds events to her Google Calendar.
 *
 * One-time setup (see SETUP.md for the click-by-click version):
 *   1. Project Settings > Script properties > add LOFTY_API_KEY = the key from Lofty (Settings > Integrations > API).
 *   2. Set APP_URL below to the app's web address.
 *   3. Run testLofty() from the editor. It should log Kia's name and the number of contacts.
 *   4. Run setupLogins(). It logs one invite link for Kia and one for Jason.
 *   5. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Paste the /exec URL into config.js.
 */

var APP_URL = 'https://kiasellskc.com/crm/';
var TZ = 'America/Chicago';
var PEOPLE = [
  { uid: 'kia', name: 'Kia Robinson', email: 'kiasellskc@gmail.com', role: 'owner' },
  { uid: 'jason', name: 'Jason Robinson', email: 'jrobinson2226@gmail.com', role: 'admin' }
];
var GROUPS = ['Active Buyer', 'Sphere', 'Cold', 'Missing Info'];
var SESSION_DAYS = 90;
var LEADS_CACHE_SECONDS = 90;
var LOFTY = 'https://api.lofty.com';

/* =============================== setup helpers =============================== */

function testLofty() {
  var me = lofty('GET', '/v1.0/me');
  var page = lofty('GET', '/v1.0/leads?limit=1&offset=0');
  Logger.log('Connected to Lofty as ' + [me.firstName, me.lastName].join(' ') + ' (' + me.email + '). Contacts: ' +
    (page._metadata && page._metadata.total));
  // Touch Gmail and Calendar once so Google asks for those permissions now.
  GmailApp.getAliases(); CalendarApp.getDefaultCalendar().getName();
  Logger.log('Gmail and Google Calendar permissions are set.');
}

function setupLogins() {
  PEOPLE.forEach(function (p) {
    var code = randomId(32);
    props().setProperty('inv:' + code, JSON.stringify({ uid: p.uid, name: p.name, email: p.email, role: p.role, exp: Date.now() + 14 * 864e5 }));
    Logger.log(p.name + ': ' + APP_URL + '?invite=' + code);
  });
}

/* ==================================== HTTP ==================================== */

function doGet() { return out({ ok: true, service: 'kia-crm' }); }

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out({ ok: false, error: 'bad_request' }); }
  try { return out(handle(req)); }
  catch (err) {
    var m = String((err && err.message) || err);
    console.error(m);
    return out({ ok: false, error: m.indexOf('lofty_') === 0 ? m : 'server_error', detail: m.slice(0, 300) });
  }
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle(req) {
  var res = handleInner(req);
  try { if (res && res.ok && !res.skipStats) countActivity(req); } catch (e) { console.warn('stats: ' + e); }
  if (res) delete res.skipStats;
  return res;
}

function handleInner(req) {
  var a = req.action;
  if (a === 'login') return login(req.email, req.password);
  if (a === 'acceptInvite') return acceptInvite(req.code, req.password);
  if (a === 'inviteInfo') return inviteInfo(req.code);
  if (a === 'contact') return websiteContact(req);
  if (a === 'listings') return publicListings(!!req.fresh);
  if (a === 'finderLead') return finderLead(req);
  if (a === 'openHouseLead') return openHouseLead(req);
  if (a === 'openHouseFinish') return openHouseFinish(req);
  if (a === 'homeValueLead') return homeValueLead(req);

  var me = sessionUser(req.token);
  if (!me) return { ok: false, error: 'not_signed_in' };

  switch (a) {
    case 'logout': props().deleteProperty('sess:' + req.token); return { ok: true };
    case 'whoami': return { ok: true, me: publicUser(me) };
    case 'leads': return { ok: true, rows: leadRows(!!req.fresh), asOf: new Date().toISOString() };
    case 'today': return today();
    case 'lead': return leadDetail(req.leadId);
    case 'logCall': return logCall(me, req);
    case 'logText': return logText(me, req);
    case 'sendEmail': return sendEmail(me, req);
    case 'addNote': return addNote(req);
    case 'addFollowUp': return addFollowUp(req);
    case 'finishTask': return finishTask(req);
    case 'updateLead': return updateLead(req);
    case 'createLead': return createLead(req);
    case 'invite': return invite(me, req);
    case 'scorecard': return { ok: true, card: scorecardData() };
    default: return { ok: false, error: 'unknown_action' };
  }
}

/* ==================================== Lofty ==================================== */

function apiKey() {
  var k = props().getProperty('LOFTY_API_KEY');
  if (!k) throw new Error('lofty_no_key');
  return k.trim();
}

/** Calls Lofty. Tries the API-key header first; falls back to Bearer if Lofty refuses it. */
function lofty(method, path, body) {
  var key = apiKey();
  var schemes = [props().getProperty('LOFTY_AUTH') || 'token', 'Bearer'];
  for (var i = 0; i < schemes.length; i++) {
    var opts = {
      method: method.toLowerCase(),
      headers: { Authorization: schemes[i] + ' ' + key, 'X-Error-Status': 'true' },
      contentType: 'application/json',
      muteHttpExceptions: true
    };
    if (body !== undefined) opts.payload = JSON.stringify(body);
    var res = UrlFetchApp.fetch(LOFTY + path, opts);
    var code = res.getResponseCode(), text = res.getContentText();
    if (code === 401 && i === 0) continue;
    if (code === 401) throw new Error('lofty_auth');
    if (i === 1 && schemes[0] !== 'Bearer') props().setProperty('LOFTY_AUTH', 'Bearer');
    var json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
    if (code >= 400) throw new Error('lofty_' + code + ': ' + String(text).slice(0, 200));
    return json;
  }
}

/* ================================ contact list ================================ */

function compactLead(L) {
  var d = function (s) { return s ? new Date(String(s).slice(0, 19) + 'Z') : null; };
  var now = Date.now();
  var days = function (x) { return x ? Math.floor((now - x.getTime()) / 864e5) : null; };
  var ymd = function (x) { return x ? Utilities.formatDate(x, TZ, 'yyyy-MM-dd') : null; };
  var tagNames = (L.tags || []).map(function (t) { return typeof t === 'string' ? t : t.tagName; }).filter(Boolean);
  var group = GROUPS.filter(function (g) { return tagNames.indexOf(g) >= 0; })[0] || 'Ungrouped';
  var touch = d(L.lastTouch);
  var visit = d(L.lastVisit); if (visit && visit.getUTCFullYear() < 1971) visit = null;
  var created = d(L.createTime);
  var inq = L.leadInquiry || {};
  var loc = (inq.locations && inq.locations[0]) || {};
  return {
    id: String(L.leadId),
    name: ((L.firstName || '') + ' ' + (L.lastName || '')).trim(),
    first: L.firstName || '',
    last: L.lastName || '',
    group: group,
    tags: tagNames,
    source: L.source || '',
    area: L.city || loc.city || loc.zipCode || '',
    state: L.state || '',
    priceMin: inq.priceMin > 0 ? inq.priceMin : null,
    priceMax: inq.priceMax > 0 ? inq.priceMax : null,
    score: L.score == null ? null : L.score,
    created: ymd(created),
    lastTouch: ymd(touch),
    lastVisit: ymd(visit),
    daysSinceTouch: days(touch),
    daysSinceVisit: days(visit),
    daysSinceCreated: days(created),
    unsubscribed: L.unsubscription === true,
    canCall: L.cannotCall === false,
    canText: L.cannotText === false,
    phone: (L.phones && L.phones[0]) || '',
    email: (L.emails && L.emails[0]) || ''
  };
}

function leadRows(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var n = Number(cache.get('rows:n') || 0);
    if (n) {
      var parts = cache.getAll(Array.apply(null, Array(n)).map(function (_, i) { return 'rows:' + i; }));
      var joined = '', okAll = true;
      for (var i = 0; i < n; i++) { if (parts['rows:' + i] == null) { okAll = false; break; } joined += parts['rows:' + i]; }
      if (okAll) return JSON.parse(joined);
    }
  }
  var all = [], offset = 0, scrollId = null;
  for (var guard = 0; guard < 40; guard++) {
    var url = '/v1.0/leads?limit=100&offset=' + offset + (scrollId ? '&scrollId=' + encodeURIComponent(scrollId) : '');
    var body = lofty('GET', url);
    if (!scrollId && body._metadata) scrollId = body._metadata.scrollId;
    var page = body.leads || [];
    all = all.concat(page);
    if (page.length < 100) break;
    offset += 100;
  }
  var rows = all.filter(function (L) { return !(L.source === 'Other' && L.firstName === 'Lofty'); }).map(compactLead);
  putRows(rows);
  return rows;
}

function putRows(rows) {
  var cache = CacheService.getScriptCache(), s = JSON.stringify(rows), size = 90000, map = {}, n = 0;
  for (var i = 0; i < s.length; i += size) { map['rows:' + n] = s.substring(i, i + size); n++; }
  map['rows:n'] = String(n);
  try { cache.putAll(map, LEADS_CACHE_SECONDS); } catch (e) { cache.remove('rows:n'); }
}

function patchRow(leadId) {
  var cache = CacheService.getScriptCache();
  if (!cache.get('rows:n')) return;
  try {
    var rows = leadRows(false);
    var L = lofty('GET', '/v1.0/leads/' + leadId).lead;
    var c = compactLead(L), found = false;
    rows = rows.map(function (r) { if (r.id === c.id) { found = true; return c; } return r; });
    if (!found) rows.unshift(c);
    putRows(rows);
  } catch (e) { cache.remove('rows:n'); }
}

/* ==================================== Today ==================================== */

function today() {
  var tasks = [], currentId = 0;
  for (var p = 0; p < 5; p++) {
    var res = lofty('GET', '/v2.0/tasks/my-tasks?limit=100&timeZoneCode=' + encodeURIComponent(TZ) + (currentId ? '&currentId=' + currentId : ''));
    var page = res.tasks || [];
    tasks = tasks.concat(page);
    if (page.length < 100) break;
    currentId = page[page.length - 1].id;
  }
  var endOfToday = new Date(Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'23:59:59XXX")).getTime();
  var open = tasks.filter(function (t) { return !t.finishFlag; }).map(slimTask);
  var due = open.filter(function (t) { var w = Date.parse(t.when || ''); return !isNaN(w) && w <= endOfToday; });
  var upcoming = open.filter(function (t) { var w = Date.parse(t.when || ''); return !isNaN(w) && w > endOfToday; })
    .sort(function (a, b) { return Date.parse(a.when) - Date.parse(b.when); }).slice(0, 25);
  due.sort(function (a, b) { return Date.parse(a.when) - Date.parse(b.when); });
  return { ok: true, due: due, upcoming: upcoming };
}

function slimTask(t) {
  return {
    id: String(t.id), leadId: t.leadId ? String(t.leadId) : '', leadName: t.leadName || [t.leadFirstName, t.leadLastName].join(' ').trim(),
    type: t.type || 'Other', content: t.content || t.subject || '', when: t.endAt || t.startAt || '', start: t.startAt || '',
    address: t.address || '', overdue: !!t.overdueFlag, done: !!t.finishFlag
  };
}

/* ================================ one contact ================================ */

function leadDetail(leadId) {
  leadId = cleanId(leadId);
  var L = lofty('GET', '/v1.0/leads/' + leadId).lead;
  var row = compactLead(L);
  row.phones = L.phones || [];
  row.emails = L.emails || [];
  row.leadTypes = L.leadTypes || [];
  row.timeframe = L.buyingTimeFrame || L.sellingTimeFrame || '';
  var timeline = [];
  try {
    var acts = lofty('GET', '/v2.0/leads/' + leadId + '/activities?limit=200&timeZoneCode=' + encodeURIComponent(TZ)).activities || [];
    acts.forEach(function (x) {
      timeline.push({ kind: (x.channel || 'Activity'), at: x.activityTime, direction: x.direction || '', outcome: x.callingOutcome || '',
        subject: x.emailSubject || '', text: x.note || '', how: x.communicationType || '', event: x.emailEventType || '' });
    });
  } catch (e) { console.warn('activities: ' + e); }
  try {
    var notes = lofty('GET', '/v1.0/notes?leadId=' + leadId).notes || [];
    notes.forEach(function (n) { if (!n.deleteFlag) timeline.push({ kind: 'Note', at: n.createTime, text: n.content || '', by: n.creatorName || '' }); });
  } catch (e) { console.warn('notes: ' + e); }
  timeline.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
  var tasks = [];
  try { tasks = (lofty('GET', '/v2.0/tasks?leadId=' + leadId).tasks || []).map(slimTask).filter(function (t) { return !t.done; }); }
  catch (e) { console.warn('tasks: ' + e); }
  return { ok: true, lead: row, timeline: timeline.slice(0, 60), tasks: tasks };
}

function cleanId(x) { var s = String(x || '').replace(/\D/g, ''); if (!s) throw new Error('bad_lead'); return s; }

/* ================================ logging & sending ================================ */

var OUTCOMES = { Talked: 1, VoiceMessage: 1, NoAnswer: 1, BadNumber: 1 };

function logCall(me, r) {
  var leadId = cleanId(r.leadId);
  var body = { leadId: Number(leadId), logType: 'logCall', content: clip(r.note || callWord(r.outcome), 5000),
    leadPhoneNumber: String(r.phone || '').replace(/[^\d+]/g, '').slice(0, 20), outboundOrInbound: r.inbound ? 'inbound' : 'outbound' };
  if (OUTCOMES[r.outcome]) body.callingOutcome = r.outcome;
  if (!body.leadPhoneNumber) throw new Error('need_phone');
  lofty('POST', '/v1.0/logType', body);
  var fu = maybeFollowUp(leadId, r.followUp);
  patchRowLater(leadId);
  return { ok: true, followUp: fu };
}

function callWord(o) {
  return { Talked: 'Talked', VoiceMessage: 'Left a voicemail', NoAnswer: 'No answer', BadNumber: 'Bad number' }[o] || 'Call';
}

function logText(me, r) {
  var leadId = cleanId(r.leadId);
  var msg = String(r.message || '').trim();
  if (!msg) throw new Error('need_message');
  lofty('POST', '/v1.0/logType', { leadId: Number(leadId), logType: 'logText', content: clip(msg, 5000), outboundOrInbound: 'outbound' });
  var fu = maybeFollowUp(leadId, r.followUp);
  patchRowLater(leadId);
  return { ok: true, followUp: fu };
}

function sendEmail(me, r) {
  var leadId = cleanId(r.leadId);
  var to = String(r.to || '').trim(), subject = String(r.subject || '').trim(), body = String(r.body || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('bad_email');
  if (!subject || !body) throw new Error('need_subject_body');
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
    body.split(/\n/).map(escapeHtml).join('<br>') + '</div>';
  GmailApp.sendEmail(to, subject, body, { htmlBody: html, name: 'Kia Robinson' });
  var from = Session.getEffectiveUser().getEmail();
  lofty('POST', '/v1.0/logType', { leadId: Number(leadId), logType: 'logEmail', content: clip(body, 5000), emailSubject: subject, toEmail: to, fromEmail: from, outboundOrInbound: 'outbound' });
  var fu = maybeFollowUp(leadId, r.followUp);
  patchRowLater(leadId);
  return { ok: true, followUp: fu };
}

function addNote(r) {
  var leadId = cleanId(r.leadId), content = String(r.content || '').trim();
  if (!content) throw new Error('need_note');
  lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: clip(content, 2000), isPin: false });
  return { ok: true };
}

/** followUp: {when: 'YYYY-MM-DDTHH:mm', type: 'Call'|'Text'|'Email'|'Appointment'|'Other', note, address, calendar: bool} */
function maybeFollowUp(leadId, f) {
  if (!f || !f.when) return null;
  return createTask(leadId, f);
}

function addFollowUp(r) { return { ok: true, task: createTask(cleanId(r.leadId), r.followUp || r) }; }

function createTask(leadId, f) {
  var type = ['Call', 'Text', 'Email', 'Appointment', 'Other'].indexOf(f.type) >= 0 ? f.type : 'Call';
  var start = parseLocal(f.when);
  var minutes = type === 'Appointment' ? Number(f.minutes || 60) : 15;
  var end = new Date(start.getTime() + minutes * 6e4);
  var iso = function (d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); };
  var lead = null;
  try { lead = lofty('GET', '/v1.0/leads/' + leadId).lead; } catch (e) {}
  var who = lead ? ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() : 'contact';
  var content = String(f.note || '').trim() || (type === 'Appointment' ? 'Showing with ' + who : type + ' ' + who);
  var body = { type: type, content: clip(content, 1000), leadId: Number(leadId), assignedRole: 'Agent',
    startAt: iso(type === 'Appointment' ? start : start), endAt: iso(type === 'Appointment' ? end : start), timeZoneCode: TZ };
  if (f.address) body.address = String(f.address).slice(0, 200);
  var res = lofty('POST', '/v2.0/tasks', body);
  var cal = null;
  if (f.calendar) {
    var title = (type === 'Appointment' ? 'Showing: ' : type + ': ') + who;
    var desc = content + (lead && lead.phones && lead.phones[0] ? '\nPhone: ' + fmtPhone(lead.phones[0]) : '') + '\nOpen in Kia\'s CRM: ' + APP_URL + '#lead=' + leadId;
    var ev = CalendarApp.getDefaultCalendar().createEvent(title, start, end, { description: desc, location: f.address || '' });
    if (type !== 'Appointment') ev.addPopupReminder(10);
    cal = ev.getId();
  }
  return { taskId: res && res.taskId ? String(res.taskId) : null, calendarEventId: cal };
}

function finishTask(r) {
  var id = cleanId(r.taskId);
  lofty('POST', '/v2.0/tasks/' + id + '/finish', {});
  return { ok: true };
}

function parseLocal(s) {
  // 'YYYY-MM-DDTHH:mm' in Kia's time zone
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error('bad_time');
  var probe = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  var off = Utilities.formatDate(probe, TZ, 'XXX'); // e.g. -06:00
  return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00' + off);
}

/* ================================ edit & create ================================ */

function updateLead(r) {
  var leadId = cleanId(r.leadId), p = r.patch || {}, body = {};
  if (p.firstName != null) body.firstName = String(p.firstName).trim().slice(0, 30);
  if (p.lastName != null) body.lastName = String(p.lastName).trim().slice(0, 30);
  if (p.phones) body.phones = p.phones.map(function (x) { return String(x).replace(/[^\d+]/g, '').slice(0, 20); }).filter(Boolean);
  if (p.emails) body.emails = p.emails.map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (p.group && GROUPS.indexOf(p.group) >= 0) {
    body.tagsRemove = GROUPS.filter(function (g) { return g !== p.group; });
    body.tagsAdd = [p.group];
  }
  if (p.priceMin !== undefined || p.priceMax !== undefined || p.city !== undefined) {
    body.inquiry = {};
    if (p.priceMin !== undefined) body.inquiry.priceMin = p.priceMin ? Number(p.priceMin) : -1;
    if (p.priceMax !== undefined) body.inquiry.priceMax = p.priceMax ? Number(p.priceMax) : -1;
    if (p.city) body.inquiry.locations = [{ city: String(p.city).trim(), stateCode: p.state || '' }];
  }
  if (p.consent === true) { body.cannotCall = false; body.cannotText = false; body.cannotEmail = false; }
  if (!Object.keys(body).length) return { ok: true };
  // Tags go in their own call so a tag change can never wipe a contact's other fields.
  var tagPart = {};
  if (body.tagsAdd) { tagPart.tagsAdd = body.tagsAdd; tagPart.tagsRemove = body.tagsRemove; delete body.tagsAdd; delete body.tagsRemove; }
  if (Object.keys(body).length) lofty('PUT', '/v1.0/leads/' + leadId, body);
  if (tagPart.tagsAdd) lofty('PUT', '/v1.0/leads/' + leadId, tagPart);
  patchRowLater(leadId);
  return { ok: true };
}

var LEAD_TYPES = { Buyer: 2, Seller: 1, Investor: 6, Renter: 5, Homeowner: 8, Other: -1 };

function createLead(r) {
  var f = r.lead || {};
  var first = String(f.firstName || '').trim();
  if (!first) throw new Error('need_first_name');
  var group = GROUPS.indexOf(f.group) >= 0 ? f.group : 'Active Buyer';
  var body = {
    firstName: first.slice(0, 30), lastName: String(f.lastName || '').trim().slice(0, 30),
    leadTypes: [LEAD_TYPES[f.type] || 2], source: String(f.source || 'Kia\'s CRM').slice(0, 60),
    tags: [group, 'Added in Kia\'s CRM'],
    cannotCall: !f.consent, cannotText: !f.consent, cannotEmail: !f.consent
  };
  var phone = String(f.phone || '').replace(/[^\d+]/g, ''); if (phone) body.phones = [phone.slice(0, 20)];
  var email = String(f.email || '').trim(); if (email) body.emails = [email];
  var inq = {};
  if (Number(f.priceMin) > 0) inq.priceMin = Number(f.priceMin);
  if (Number(f.priceMax) > 0) inq.priceMax = Number(f.priceMax);
  if (f.city) inq.locations = [{ city: String(f.city).trim(), stateCode: f.state || 'KS' }];
  if (Object.keys(inq).length) body.inquiry = inq;
  if (f.timeframe) body.buyingTimeFrame = String(f.timeframe);
  var res = lofty('POST', '/v1.0/leads', body);
  var leadId = res && res.leadId ? String(res.leadId) : null;
  if (leadId && f.note) { try { lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: clip(f.note, 2000), isPin: false }); } catch (e) {} }
  CacheService.getScriptCache().remove('rows:n');
  return { ok: true, leadId: leadId };
}

function patchRowLater(leadId) { try { patchRow(leadId); } catch (e) {} }

/* ============================ website listings ============================ */

var LISTINGS_CACHE_SECONDS = 3600;

/** Public: Kia's own listings from Lofty (Heartland MLS). Active = full details; sold = photo, neighborhood, date only (no prices). */
function publicListings(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) { var hit = cache.get('listings:v1'); if (hit) return JSON.parse(hit); }
  var active = [], sold = [], next = '', soldNext = '';
  for (var guard = 0; guard < 10; guard++) {
    var q = '/v1.0/listing?agentListings=true&limit=100' + (next ? '&nextPageKey=' + encodeURIComponent(next) : '') +
      (soldNext ? '&soldNextPageKey=' + encodeURIComponent(soldNext) : '');
    var res = lofty('GET', q);
    var a = res.listIng || res.listing || res.listings || [], s = res.soldListing || [];
    if (guard === 0 || next) active = active.concat(a);
    if (guard === 0 || soldNext) sold = sold.concat(s);
    var meta = res._listingMetadata || res.get_listingMetadata || {};
    var moreA = a.length === 100 && meta.nextPageKey, moreS = s.length === 100 && meta.soldNextPageKey;
    next = moreA ? meta.nextPageKey : ''; soldNext = moreS ? meta.soldNextPageKey : '';
    if (!next && !soldNext) break;
  }
  var num = function (x) { var n = Number(x); return isFinite(n) && n > 0 ? n : null; };
  var title = function (s) { return String(s || '').toLowerCase().replace(/(^|[\s\-\/])([a-z])/g, function (m) { return m.toUpperCase(); }).replace(/\b(Ne|Nw|Se|Sw|N|S|E|W)\b/g, function (m) { return m.toUpperCase(); }); };
  var day = function (x) { if (!x) return null; if (typeof x === 'number') return Utilities.formatDate(new Date(x < 1e12 ? x * 1000 : x), TZ, 'yyyy-MM-dd'); return String(x).slice(0, 10); };
  var out = {
    ok: true,
    asOf: new Date().toISOString(),
    active: active.filter(function (L) { return /active|coming|pending|contingent/i.test(L.listingStatus || 'Active'); }).map(function (L) {
      return {
        id: String(L.listingId || ''), mls: String(L.mlsListingId || ''), status: L.listingStatus || 'Active',
        street: title(L.listingStreetName || L.streetAddress), city: title(L.listingCity || L.city), state: L.listingState || 'KS',
        zip: (L.listingZipcode && L.listingZipcode[0]) || '', price: num(L.price),
        beds: num(L.beds || L.bedrooms), baths: num(L.baths || L.bathrooms), sqft: num(L.sqft),
        neighborhood: title(L.subDivisionName), county: L.county || '', built: L.builtYear || null,
        garage: num(L.garageParkingSpaces), type: L.propertyTypeSecondary || L.propertyTypePrimary || '',
        description: clip(L.detailsDescribe || '', 3000), photos: (L.pictureList || []).slice(0, 25),
        listed: day(L.mlsListDateL), brokerage: L.agentOrgName || 'LPT Realty LLC'
      };
    }),
    sold: sold.map(function (L) {
      return {
        mls: String(L.mlsListingId || ''), neighborhood: title(L.subDivisionName),
        city: title(L.listingCity || L.city) || (L.county ? L.county + ' County' : ''),
        sold: day(L.soldDate), photo: (L.pictureList || [])[0] || '', brokerage: L.agentOrgName || 'LPT Realty LLC'
      };
    }).sort(function (a, b) { return String(b.sold).localeCompare(String(a.sold)); })
  };
  try { cache.put('listings:v1', JSON.stringify(out), LISTINGS_CACHE_SECONDS); } catch (e) {}
  return out;
}

/* ============================ program finder leads ============================ */

var JASON_EMAIL = 'jason.robinson@phmloans.com';

/** Public: the Program & Property Finder on kiasellskc.com/programs. Lead goes to Kia's Lofty and Kia gets the email. */
function finderLead(r) {
  var f = r.form || {};
  if (String(f.website || '').trim()) return { ok: true, skipStats: true };
  var cache = CacheService.getScriptCache();
  var hour = Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  var count = Number(cache.get('contact:' + hour) || 0);
  if (count >= 30) return { ok: false, error: 'busy' };
  cache.put('contact:' + hour, String(count + 1), 3700);

  var name = String(f.name || '').replace(/\s+/g, ' ').trim();
  var email = String(f.email || '').trim();
  var phone = String(f.phone || '').replace(/[^\d+]/g, '');
  if (!name) return { ok: false, error: 'need_name' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'bad_phone' };
  if (!email && !phone) return { ok: false, error: 'need_contact' };
  var dupKey = 'finderdup:' + (email || phone).toLowerCase();
  if (cache.get(dupKey)) return { ok: true, skipStats: true };
  cache.put(dupKey, '1', 600);

  var res0 = f.result || {};
  var list = function (x) { return (Array.isArray(x) ? x : []).map(function (v) { return clip(String(v), 60); }).slice(0, 12); };
  var result = res0.address ? {
    address: clip(String(res0.address), 200), county: clip(String(res0.county || ''), 60), state: clip(String(res0.state || ''), 4),
    who: res0.who === 'agent' ? 'agent' : 'buyer', size: Number(res0.size) || null, income: Number(res0.income) || null,
    price: clip(String(res0.price || ''), 60), matches: list(res0.matches), available: list(res0.available), notMatch: list(res0.notMatch)
  } : null;
  var role = { buyer: 'Home buyer', seller: 'Seller or homeowner', agent: 'Real estate agent' }[f.role] || 'Home buyer';
  var parts = name.split(' ');
  var first = parts.shift(), last = parts.join(' ');
  var consent = f.consent === true;
  var body = {
    firstName: first.slice(0, 30), lastName: last.slice(0, 30), leadTypes: [f.role === 'seller' ? 1 : f.role === 'agent' ? -1 : 2],
    source: 'kiasellskc.com program finder', tags: [f.role === 'agent' ? 'Sphere' : 'Active Buyer', 'Website Lead', 'Program Finder'],
    cannotCall: !consent, cannotText: !consent, cannotEmail: !consent
  };
  if (phone) body.phones = [phone.slice(0, 20)];
  if (email) body.emails = [email];
  if (result && result.address) {
    var city = result.address.split(',')[1];
    if (city) body.inquiry = { locations: [{ city: city.trim(), stateCode: result.state || '' }] };
  }
  var res = lofty('POST', '/v1.0/leads', body);
  var leadId = res && res.leadId ? String(res.leadId) : null;

  var msg = clip(String(f.message || '').trim(), 2000);
  var lines = ['Program finder lead: ' + name, '', 'I am a: ' + role];
  if (phone) lines.push('Phone: ' + fmtPhone(phone));
  if (email) lines.push('Email: ' + email);
  lines.push('OK to contact: ' + (consent ? 'Yes' : 'Not checked'));
  if (result) {
    lines.push('', 'Property checked: ' + result.address + (result.county ? ' (' + result.county + ')' : ''));
    var hh = [];
    if (result.size) hh.push(result.size + '-person household');
    if (result.income) hh.push('$' + Math.round(result.income).toLocaleString() + ' income');
    if (result.price) hh.push(result.price);
    if (hh.length) lines.push('They entered: ' + hh.join(', '));
    if (result.matches.length) lines.push('Looks like a fit: ' + result.matches.join(', '));
    if (result.available.length) lines.push('Also available: ' + result.available.join(', '));
    if (result.notMatch.length) lines.push('Not a match: ' + result.notMatch.join(', '));
  } else {
    lines.push('', 'No property checked yet.');
  }
  if (msg) lines.push('', 'Message:', msg);
  var noteText = lines.slice(2).join('\n');
  if (leadId) { try { lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: 'Program finder (kiasellskc.com/programs)\n' + noteText, isPin: true }); } catch (e) {} }
  cache.remove('rows:n');

  try {
    var link = leadId ? APP_URL + '#lead=' + leadId : APP_URL;
    var text = lines.join('\n') + '\n\nOpen in Kia\'s CRM: ' + link;
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' + lines.map(escapeHtml).join('<br>') +
      '<br><br><a href="' + link + '">Open in Kia\'s CRM</a></div>';
    var subj = 'Program finder lead: ' + name + (result ? ' (' + result.address.split(',')[0] + ')' : '');
    var opts = { htmlBody: html, name: 'kiasellskc.com' };
    if (email) opts.replyTo = email;
    GmailApp.sendEmail(PEOPLE[0].email, subj, text, opts);
  } catch (e) { console.warn('notify: ' + e); }
  return { ok: true };
}

/* ============================ open house sign-in ============================ */

/** Public: sign-in at an open house (kiasellskc.com/openhouse). Each visitor becomes a Lofty lead; Kia gets one list when she taps Finish. */
function openHouseLead(r) {
  var f = r.form || {};
  if (String(f.website || '').trim()) return { ok: true, skipStats: true };
  var house = clip(String(f.house || '').trim(), 120);
  if (!house) return { ok: false, error: 'need_house' };
  var cache = CacheService.getScriptCache();
  var hour = Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  var count = Number(cache.get('oh:' + hour) || 0);
  if (count >= 80) return { ok: false, error: 'busy' };
  cache.put('oh:' + hour, String(count + 1), 3700);

  var name = String(f.name || '').replace(/\s+/g, ' ').trim();
  var email = String(f.email || '').trim();
  var phone = String(f.phone || '').replace(/[^\d+]/g, '');
  if (!name) return { ok: false, error: 'need_name' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'bad_phone' };
  if (!email && !phone) return { ok: false, error: 'need_contact' };

  var hasAgent = f.agent === 'yes';
  var timeline = { now: 'Ready now', '3': 'Within 3 months', '6': '3 to 6 months', later: '6+ months', looking: 'Just looking' }[f.timeline] || '';
  var lender = { yes: 'Yes', no: 'No', cash: 'Paying cash' }[f.preapproved] || '';
  var parts = name.split(' '), first = parts.shift(), last = parts.join(' ');
  var consent = f.consent === true;
  var street = house.split(',')[0];
  var body = {
    firstName: first.slice(0, 30), lastName: last.slice(0, 30), leadTypes: [f.sell === true ? 1 : 2],
    source: 'Open house', tags: [hasAgent ? 'Sphere' : 'Active Buyer', 'Open House', ('OH ' + street).slice(0, 40)],
    cannotCall: !consent, cannotText: !consent, cannotEmail: !consent
  };
  if (f.sell === true) body.tags.push('Seller Lead');
  if (hasAgent) body.tags.push('Has Agent');
  if (phone) body.phones = [phone.slice(0, 20)];
  if (email) body.emails = [email];
  var res = lofty('POST', '/v1.0/leads', body);
  var leadId = res && res.leadId ? String(res.leadId) : null;
  var lines = ['Open house sign-in: ' + house, 'Date: ' + Utilities.formatDate(new Date(), TZ, 'EEE MMM d, yyyy h:mm a')];
  lines.push('Working with an agent: ' + (hasAgent ? 'Yes' + (f.agentName ? ' (' + clip(String(f.agentName), 60) + ')' : '') : 'No'));
  if (timeline) lines.push('Timeline: ' + timeline);
  if (lender) lines.push('Pre-approved: ' + lender);
  if (f.sell === true) lines.push('Also needs to sell a home');
  lines.push('OK to contact: ' + (consent ? 'Yes' : 'Not checked'));
  var msg = clip(String(f.message || '').trim(), 1000);
  if (msg) lines.push('', msg);
  if (leadId) { try { lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: lines.join('\n'), isPin: false }); } catch (e) {} }
  CacheService.getScriptCache().remove('rows:n');

  // Keep today's list for this house so Kia can get one email at the end.
  var key = 'ohlist:' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd') + ':' + street.toLowerCase().replace(/[^a-z0-9]/g, '');
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var list = JSON.parse(props().getProperty(key) || '[]');
    list.push({ name: name, phone: phone, email: email, agent: hasAgent, agentName: f.agentName || '', timeline: timeline, lender: lender, sell: f.sell === true, leadId: leadId, at: new Date().toISOString() });
    props().setProperty(key, JSON.stringify(list).slice(0, 8500));
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/** Public: Kia taps Finish on the sign-in tablet; she gets today's list for that house by email. */
function openHouseFinish(r) {
  var house = clip(String(r.house || '').trim(), 120);
  if (!house) return { ok: false, error: 'need_house' };
  var street = house.split(',')[0];
  var key = 'ohlist:' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd') + ':' + street.toLowerCase().replace(/[^a-z0-9]/g, '');
  var list = JSON.parse(props().getProperty(key) || '[]');
  var done = props().getProperty(key + ':sent');
  if (done && Number(done) === list.length) return { ok: true, count: list.length, skipStats: true };
  var rows = list.map(function (v, i) {
    var link = v.leadId ? APP_URL + '#lead=' + v.leadId : APP_URL;
    return '<tr style="border-top:1px solid #eadcd3"><td style="padding:8px 6px">' + (i + 1) + '</td><td style="padding:8px 6px"><a href="' + link + '" style="color:#261511"><b>' + escapeHtml(v.name) + '</b></a><br>' +
      escapeHtml([v.phone ? fmtPhone(v.phone) : '', v.email].filter(Boolean).join(' · ')) + '</td><td style="padding:8px 6px">' +
      escapeHtml([v.agent ? 'Has agent' + (v.agentName ? ': ' + v.agentName : '') : 'No agent', v.timeline, v.lender ? 'Pre-approved: ' + v.lender : '', v.sell ? 'Needs to sell' : ''].filter(Boolean).join(' · ')) + '</td></tr>';
  }).join('');
  var hot = list.filter(function (v) { return !v.agent; }).length;
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#261511;max-width:680px">' +
    '<h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 4px">Open house: ' + escapeHtml(house) + '</h2>' +
    '<p style="margin:0 0 14px;color:#6e5850">' + list.length + ' sign-in' + (list.length === 1 ? '' : 's') + ', ' + hot + ' without an agent. Everyone is in Lofty tagged "Open House" and "OH ' + escapeHtml(street) + '".</p>' +
    (list.length ? '<table style="border-collapse:collapse;width:100%;font-size:13px">' + rows + '</table>' : '<p>No one signed in.</p>') +
    '<p style="margin-top:16px"><a href="' + APP_URL + '" style="color:#261511">Open Kia\'s CRM</a></p></div>';
  GmailApp.sendEmail(PEOPLE[0].email, 'Open house sign-ins: ' + street + ' (' + list.length + ')', 'Open house sign-ins for ' + house + ': ' + list.length, { htmlBody: html, name: "Kia's CRM" });
  props().setProperty(key + ':sent', String(list.length));
  return { ok: true, count: list.length, skipStats: true };
}

/* ============================ home value requests ============================ */

/** Public: "What's my home worth?" (kiasellskc.com/home-value). Seller lead in Lofty + email to Kia. */
function homeValueLead(r) {
  var f = r.form || {};
  if (String(f.website || '').trim()) return { ok: true, skipStats: true };
  var cache = CacheService.getScriptCache();
  var hour = Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  var count = Number(cache.get('contact:' + hour) || 0);
  if (count >= 30) return { ok: false, error: 'busy' };
  cache.put('contact:' + hour, String(count + 1), 3700);
  var address = clip(String(f.address || '').replace(/\s+/g, ' ').trim(), 160);
  var name = String(f.name || '').replace(/\s+/g, ' ').trim();
  var email = String(f.email || '').trim();
  var phone = String(f.phone || '').replace(/[^\d+]/g, '');
  if (!address) return { ok: false, error: 'need_address' };
  if (!name) return { ok: false, error: 'need_name' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'bad_phone' };
  if (!email && !phone) return { ok: false, error: 'need_contact' };
  var dupKey = 'hvdup:' + (email || phone).toLowerCase();
  if (cache.get(dupKey)) return { ok: true, skipStats: true };
  cache.put(dupKey, '1', 600);

  var timeline = { '3': 'Within 3 months', '6': '3 to 6 months', '12': '6 to 12 months', curious: 'Just curious' }[f.timeline] || '';
  var why = { up: 'Moving up', down: 'Downsizing', relocate: 'Relocating', invest: 'Investment property', other: 'Other' }[f.reason] || '';
  var parts = name.split(' '), first = parts.shift(), last = parts.join(' ');
  var consent = f.consent === true;
  var body = {
    firstName: first.slice(0, 30), lastName: last.slice(0, 30), leadTypes: [1], source: 'kiasellskc.com home value',
    tags: ['Active Buyer', 'Website Lead', 'Seller Lead', 'Home Value Request'],
    cannotCall: !consent, cannotText: !consent, cannotEmail: !consent
  };
  if (phone) body.phones = [phone.slice(0, 20)];
  if (email) body.emails = [email];
  var city = address.split(',')[1];
  if (city) body.inquiry = { locations: [{ city: city.trim(), stateCode: '' }] };
  var res = lofty('POST', '/v1.0/leads', body);
  var leadId = res && res.leadId ? String(res.leadId) : null;
  var details = [];
  if (f.beds) details.push(clip(String(f.beds), 4) + ' bed');
  if (f.baths) details.push(clip(String(f.baths), 4) + ' bath');
  if (f.sqft) details.push(clip(String(f.sqft), 8) + ' sq ft');
  var lines = ['Home value request: ' + address];
  if (details.length) lines.push('Home: ' + details.join(', '));
  if (f.updates) lines.push('Updates: ' + clip(String(f.updates), 300));
  if (timeline) lines.push('Thinking of selling: ' + timeline);
  if (why) lines.push('Reason: ' + why);
  if (f.buying === true) lines.push('Will also need to buy');
  if (phone) lines.push('Phone: ' + fmtPhone(phone));
  if (email) lines.push('Email: ' + email);
  lines.push('OK to contact: ' + (consent ? 'Yes' : 'Not checked'));
  var msg = clip(String(f.message || '').trim(), 1500);
  if (msg) lines.push('', msg);
  if (leadId) { try { lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: lines.join('\n'), isPin: true }); } catch (e) {} }
  cache.remove('rows:n');
  try {
    var link = leadId ? APP_URL + '#lead=' + leadId : APP_URL;
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5"><b>' + escapeHtml(name) + '</b> wants to know what their home is worth.<br><br>' +
      lines.map(escapeHtml).join('<br>') + '<br><br><a href="' + link + '">Open in Kia\'s CRM</a></div>';
    var opts = { htmlBody: html, name: 'kiasellskc.com' };
    if (email) opts.replyTo = email;
    GmailApp.sendEmail(PEOPLE[0].email, 'Home value request: ' + address.split(',')[0] + ' (' + name + ')', name + '\n' + lines.join('\n') + '\n\n' + link, opts);
  } catch (e) { console.warn('notify: ' + e); }
  return { ok: true };
}

/* ============================ weekly scorecard ============================ */

var STAT_ACTIONS = { logCall: 'calls', logText: 'texts', sendEmail: 'emails', addNote: 'notes', addFollowUp: 'followups', finishTask: 'done',
  createLead: 'lead_crm', contact: 'lead_website', finderLead: 'lead_finder', openHouseLead: 'lead_openhouse', homeValueLead: 'lead_homevalue' };

function weekKey(d) {
  // Weeks run Saturday to Friday, so Friday's scorecard covers the full week.
  d = d || new Date();
  var ymd = Utilities.formatDate(d, TZ, 'yyyy-MM-dd').split('-').map(Number);
  var u = Number(Utilities.formatDate(d, TZ, 'u')); // 1 = Monday ... 7 = Sunday
  var back = (u % 7 + 1) % 7; // days since Saturday
  var start = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) - back * 864e5);
  return 'stats:' + start.toISOString().slice(0, 10);
}

function countActivity(req) {
  var k = STAT_ACTIONS[req.action];
  if (!k) return;
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var key = weekKey(), st = JSON.parse(props().getProperty(key) || '{}');
    st[k] = (st[k] || 0) + 1;
    if (req.action === 'logCall' && req.outcome) st['call_' + req.outcome] = (st['call_' + req.outcome] || 0) + 1;
    if (/^(logCall|logText|sendEmail)$/.test(req.action) && req.followUp && req.followUp.when) st.followups = (st.followups || 0) + 1;
    props().setProperty(key, JSON.stringify(st));
  } finally { lock.releaseLock(); }
}

function scorecardData() {
  var thisKey = weekKey(), lastKey = weekKey(new Date(Date.now() - 7 * 864e5));
  var cur = JSON.parse(props().getProperty(thisKey) || '{}'), prev = JSON.parse(props().getProperty(lastKey) || '{}');
  var rows = leadRows(true);
  var newLeads = rows.filter(function (r) { return r.daysSinceCreated != null && r.daysSinceCreated < 7; });
  var src = function (r) {
    var t = r.tags || [];
    if (t.indexOf('Open House') >= 0) return 'Open house';
    if (t.indexOf('Program Finder') >= 0) return 'Program finder';
    if (t.indexOf('Home Value Request') >= 0) return 'Home value page';
    if (t.indexOf('Website Lead') >= 0) return 'Website contact form';
    if (t.indexOf("Added in Kia's CRM") >= 0) return "Added in Kia's CRM";
    return r.source || 'Other';
  };
  var bySource = {};
  newLeads.forEach(function (r) { var s = src(r); bySource[s] = (bySource[s] || 0) + 1; });
  var groups = {};
  rows.forEach(function (r) { groups[r.group] = (groups[r.group] || 0) + 1; });
  var t = { due: [], upcoming: [] };
  try { t = today(); } catch (e) {}
  var nextWeekEnd = Date.now() + 7 * 864e5;
  return {
    week: thisKey.slice(6), cur: cur, prev: prev, newLeads: newLeads.length, bySource: bySource,
    newNames: newLeads.slice(0, 15).map(function (r) { return { id: r.id, name: r.name || '(no name)', src: src(r) }; }),
    overdue: (t.due || []).filter(function (x) { return x.overdue; }).length, dueToday: (t.due || []).length,
    nextWeek: (t.upcoming || []).filter(function (x) { return Date.parse(x.when) <= nextWeekEnd; }).length,
    groups: groups, total: rows.length
  };
}

function weeklyScorecard() {
  var d = scorecardData(), c = d.cur, p = d.prev;
  var n = function (o, k) { return o[k] || 0; };
  var pl = function (x, w) { return x + ' ' + w + (x === 1 ? '' : 's'); };
  var diff = function (k) { var a = n(c, k), b = n(p, k); if (!b && !a) return ''; var x = a - b; return '<span style="color:' + (x >= 0 ? '#2f7a4f' : '#a8332b') + ';font-size:12px">' + (x >= 0 ? '+' : '') + x + ' vs last week</span>'; };
  var tile = function (label, k) { return '<td style="padding:12px;border:1px solid #eadcd3;border-radius:10px;text-align:center;width:25%"><div style="font-family:Georgia,serif;font-size:30px">' + n(c, k) + '</div><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6e5850">' + label + '</div>' + diff(k) + '</td>'; };
  var talked = n(c, 'call_Talked'), vm = n(c, 'call_VoiceMessage'), na = n(c, 'call_NoAnswer');
  var srcRows = Object.keys(d.bySource).sort(function (a, b) { return d.bySource[b] - d.bySource[a]; }).map(function (k) { return '<li>' + escapeHtml(k) + ': <b>' + d.bySource[k] + '</b></li>'; }).join('');
  var names = d.newNames.map(function (x) { return '<li><a href="' + APP_URL + '#lead=' + x.id + '" style="color:#261511">' + escapeHtml(x.name) + '</a> <span style="color:#6e5850">(' + escapeHtml(x.src) + ')</span></li>'; }).join('');
  var grp = ['Active Buyer', 'Sphere', 'Cold', 'Missing Info', 'Ungrouped'].filter(function (g) { return d.groups[g]; }).map(function (g) { return g + ' ' + d.groups[g]; }).join(' · ');
  var weekOf = Utilities.formatDate(new Date(d.week + 'T12:00:00Z'), 'UTC', 'MMM d');
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#261511;max-width:640px;line-height:1.5">' +
    '<div style="background:#f6ece6;padding:20px 22px;border-radius:14px"><div style="font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#a7816d">Weekly scorecard</div>' +
    '<div style="font-family:Georgia,serif;font-size:28px">Week of ' + weekOf + '</div></div>' +
    '<h3 style="font-family:Georgia,serif;font-weight:400;margin:22px 0 8px">Your activity</h3>' +
    '<table style="border-collapse:separate;border-spacing:8px;width:100%"><tr>' + tile('Calls', 'calls') + tile('Texts', 'texts') + tile('Emails', 'emails') + tile('Follow-ups done', 'done') + '</tr></table>' +
    '<p style="margin:4px 0 0;color:#6e5850">Calls: ' + talked + ' talked, ' + vm + ' voicemail, ' + na + ' no answer. ' + pl(n(c, 'followups'), 'follow-up') + ' scheduled, ' + pl(n(c, 'notes'), 'note') + '.</p>' +
    '<h3 style="font-family:Georgia,serif;font-weight:400;margin:22px 0 8px">New leads: ' + d.newLeads + '</h3>' +
    (srcRows ? '<ul style="margin:0 0 8px;padding-left:20px">' + srcRows + '</ul>' : '<p style="margin:0">No new leads this week.</p>') +
    (names ? '<ul style="margin:0;padding-left:20px;font-size:13px">' + names + '</ul>' : '') +
    '<h3 style="font-family:Georgia,serif;font-weight:400;margin:22px 0 8px">Coming up</h3>' +
    '<p style="margin:0">' + pl(d.nextWeek, 'follow-up') + ' due in the next 7 days' + (d.overdue ? ', <b style="color:#a8332b">' + d.overdue + ' overdue</b>' : ', nothing overdue') + '.</p>' +
    '<p style="margin:14px 0 0;color:#6e5850;font-size:13px">' + d.total + ' contacts: ' + grp + '.</p>' +
    '<p style="margin:22px 0 0"><a href="' + APP_URL + '" style="background:#261511;color:#f6ece6;padding:10px 18px;border-radius:999px;text-decoration:none">Open Kia\'s CRM</a></p>' +
    '<p style="margin:18px 0 0;color:#a7816d;font-size:12px">Counts include calls, texts and emails logged in Kia\'s CRM. Activity entered directly in Lofty isn\'t counted.</p></div>';
  GmailApp.sendEmail(PEOPLE[0].email, 'Your week: ' + pl(n(c, 'calls'), 'call') + ', ' + pl(n(c, 'texts'), 'text') + ', ' + pl(d.newLeads, 'new lead'), 'Weekly scorecard for the week of ' + weekOf + '. Open in an email app that shows HTML.', { htmlBody: html, name: "Kia's CRM" });
}

/** Run once from the editor: sends the scorecard every Friday around 4 PM Central. */
function setupScorecard() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'weeklyScorecard') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklyScorecard').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(16).inTimezone(TZ).create();
  Logger.log('Scorecard scheduled for Fridays at 4 PM. Sending a sample now.');
  weeklyScorecard();
}

/* ============================ website contact form ============================ */

var INTEREST = { buy: 'Buying', sell: 'Selling', both: 'Buying and selling', exploring: 'Just exploring' };

/** Public: the form on kiasellskc.com. No login. Creates a Lofty lead and emails Kia. */
function websiteContact(r) {
  var f = r.form || {};
  if (String(f.website || '').trim()) return { ok: true, skipStats: true }; // honeypot: bots fill the hidden field
  var cache = CacheService.getScriptCache();
  var hour = Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  var count = Number(cache.get('contact:' + hour) || 0);
  if (count >= 30) return { ok: false, error: 'busy' };
  cache.put('contact:' + hour, String(count + 1), 3700);

  var name = String(f.name || '').replace(/\s+/g, ' ').trim();
  var email = String(f.email || '').trim();
  var phone = String(f.phone || '').replace(/[^\d+]/g, '');
  if (!name) return { ok: false, error: 'need_name' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'bad_phone' };
  if (!email && !phone) return { ok: false, error: 'need_contact' };
  var dupKey = 'contactdup:' + (email || phone).toLowerCase();
  if (cache.get(dupKey)) return { ok: true, skipStats: true };
  cache.put(dupKey, '1', 600);

  var parts = name.split(' ');
  var first = parts.shift(), last = parts.join(' ');
  var interest = INTEREST[f.interest] ? f.interest : 'exploring';
  var types = interest === 'sell' ? [1] : interest === 'both' ? [2, 1] : [2];
  var consent = f.consent === true;
  var body = {
    firstName: first.slice(0, 30), lastName: last.slice(0, 30), leadTypes: types,
    source: 'kiasellskc.com', tags: ['Active Buyer', 'Website Lead'],
    cannotCall: !consent, cannotText: !consent, cannotEmail: !consent
  };
  if (interest === 'sell' || interest === 'both') body.tags.push('Seller');
  if (phone) body.phones = [phone.slice(0, 20)];
  if (email) body.emails = [email];
  var area = clip(String(f.area || '').trim(), 60);
  if (area) body.inquiry = { locations: [{ city: area, stateCode: '' }] };
  var res = lofty('POST', '/v1.0/leads', body);
  var leadId = res && res.leadId ? String(res.leadId) : null;

  var msg = clip(String(f.message || '').trim(), 2000);
  var noteText = 'Website contact form (kiasellskc.com)\nInterested in: ' + INTEREST[interest] +
    (area ? '\nArea: ' + area : '') + '\nOK to contact: ' + (consent ? 'Yes' : 'Not checked') + (msg ? '\n\n' + msg : '');
  if (leadId) { try { lofty('POST', '/v1.0/notes', { leadId: Number(leadId), content: noteText, isPin: true }); } catch (e) {} }
  cache.remove('rows:n');

  try {
    var link = leadId ? APP_URL + '#lead=' + leadId : APP_URL;
    var lines = ['New website lead: ' + name, '', 'Interested in: ' + INTEREST[interest]];
    if (phone) lines.push('Phone: ' + fmtPhone(phone));
    if (email) lines.push('Email: ' + email);
    if (area) lines.push('Area: ' + area);
    lines.push('OK to contact: ' + (consent ? 'Yes' : 'Not checked'));
    if (msg) lines.push('', 'Message:', msg);
    lines.push('', 'Open in Kia\'s CRM: ' + link);
    var text = lines.join('\n');
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
      lines.slice(0, -1).map(escapeHtml).join('<br>') + '<br><a href="' + link + '">Open in Kia\'s CRM</a></div>';
    var opts = { htmlBody: html, name: 'kiasellskc.com' };
    if (email) opts.replyTo = email;
    GmailApp.sendEmail(PEOPLE[0].email, 'New website lead: ' + name, text, opts);
  } catch (e) { console.warn('notify: ' + e); }
  return { ok: true };
}

/* ==================================== logins ==================================== */

function invite(me, r) {
  if (me.role !== 'owner' && me.role !== 'admin') return { ok: false, error: 'not_allowed' };
  var p = PEOPLE.filter(function (x) { return x.uid === r.uid; })[0];
  if (!p) return { ok: false, error: 'not_found' };
  var code = randomId(32);
  props().setProperty('inv:' + code, JSON.stringify({ uid: p.uid, name: p.name, email: p.email, role: p.role, exp: Date.now() + 14 * 864e5 }));
  return { ok: true, link: APP_URL + '?invite=' + code };
}

function props() { return PropertiesService.getScriptProperties(); }
function users() { try { return JSON.parse(props().getProperty('users') || '[]'); } catch (e) { return []; } }
function saveUsers(list) { props().setProperty('users', JSON.stringify(list)); }
function publicUser(u) { return { uid: u.uid, name: u.name, email: u.email, role: u.role }; }

function hashPw(salt, pw) {
  var s = salt + '|' + pw, bytes;
  for (var i = 0; i < 300; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
    s = Utilities.base64Encode(bytes) + '|' + salt;
  }
  return Utilities.base64Encode(bytes);
}
function randomId(n) { var s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.substring(0, n); }

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache(), key = 'fail:' + email;
  var fails = Number(cache.get(key) || 0);
  if (fails >= 8) return { ok: false, error: 'locked' };
  var u = users().filter(function (x) { return x.email === email; })[0];
  if (!u || hashPw(u.salt, String(password || '')) !== u.hash) {
    cache.put(key, String(fails + 1), 900);
    return { ok: false, error: 'wrong_login' };
  }
  cache.remove(key);
  return { ok: true, token: newSession(u.uid), me: publicUser(u) };
}

function newSession(uid) {
  var t = randomId(40);
  props().setProperty('sess:' + t, JSON.stringify({ uid: uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return t;
}

function sessionUser(token) {
  if (!token) return null;
  var raw = props().getProperty('sess:' + token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (s.exp < Date.now()) { props().deleteProperty('sess:' + token); return null; }
  return users().filter(function (x) { return x.uid === s.uid; })[0] || null;
}

function inviteInfo(code) {
  var raw = props().getProperty('inv:' + String(code || ''));
  if (!raw) return { ok: false, error: 'invite_not_found' };
  var inv = JSON.parse(raw);
  if (inv.exp < Date.now()) return { ok: false, error: 'invite_expired' };
  return { ok: true, name: inv.name, email: inv.email };
}

function acceptInvite(code, password) {
  password = String(password || '');
  if (password.length < 10) return { ok: false, error: 'password_too_short' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var raw = props().getProperty('inv:' + String(code || ''));
    if (!raw) return { ok: false, error: 'invite_not_found' };
    var inv = JSON.parse(raw);
    if (inv.exp < Date.now()) return { ok: false, error: 'invite_expired' };
    var list = users().filter(function (x) { return x.uid !== inv.uid && x.email !== inv.email; });
    var salt = randomId(24);
    var u = { uid: inv.uid, email: inv.email, name: inv.name, role: inv.role, salt: salt, hash: hashPw(salt, password) };
    list.push(u); saveUsers(list);
    props().deleteProperty('inv:' + code);
    return { ok: true, token: newSession(u.uid), me: publicUser(u) };
  } finally { lock.releaseLock(); }
}

/* ==================================== small ==================================== */

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtPhone(p) { var d = String(p).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : p; }
