// Creatify AI backend — Node 22.13+, zero dependencies (node:http + node:sqlite).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const PORT = +env.PORT || 8787, DAILY_LIMIT = +env.DAILY_JOB_LIMIT || 10;
const ORIGINS = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const DATA = env.DATA_DIR || join(ROOT, 'data'); mkdirSync(DATA, { recursive: true });
const SECRET = env.AUTH_SECRET || (() => { const f = join(DATA, '.secret'); if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex')); return readFileSync(f, 'utf8'); })();

// ---------- database ----------
export const db = new DatabaseSync(env.DB_FILE || join(DATA, 'creatify.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,pw TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS creators(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS briefs(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,message TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(brief_id,creator_id));
CREATE TABLE IF NOT EXISTS hires(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,brief_id TEXT,message TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,creator_id TEXT NOT NULL,PRIMARY KEY(user_id,creator_id));
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,params TEXT NOT NULL,provider_id TEXT,status TEXT NOT NULL,error TEXT,output_url TEXT,created_at INTEGER NOT NULL);`);
const seedFile = join(ROOT, 'data', 'seed.json');
if (!db.prepare('SELECT 1 FROM creators LIMIT 1').get() && existsSync(seedFile))
  for (const c of JSON.parse(readFileSync(seedFile, 'utf8'))) db.prepare('INSERT INTO creators(id,user_id,data) VALUES(?,NULL,?)').run(c.id, JSON.stringify(c));
const one = (sql, ...a) => db.prepare(sql).get(...a), all = (sql, ...a) => db.prepare(sql).all(...a), run = (sql, ...a) => db.prepare(sql).run(...a);
const now = () => new Date().toISOString();

// ---------- helpers ----------
class HttpError extends Error { constructor(s, m, d) { super(m); this.status = s; this.details = d; } }
const bad = (m, d) => new HttpError(400, m, d), need = (c, s, m) => { if (!c) throw new HttpError(s, m); };
const str = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
const safeUrl = u => { try { return /^https?:$/.test(new URL(u).protocol) ? u : ''; } catch { return ''; } };
const b64 = b => Buffer.from(b).toString('base64url');
const sign = p => { const body = b64(JSON.stringify(p)); return body + '.' + createHmac('sha256', SECRET).update(body).digest('base64url'); };
const verify = t => { const [body, sig] = String(t).split('.'); if (!body || !sig) return null;
  const ok = createHmac('sha256', SECRET).update(body).digest('base64url'); if (sig.length !== ok.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; };
const hash = pw => { const s = randomBytes(16).toString('hex'); return s + ':' + scryptSync(pw, s, 64).toString('hex'); };
const check = (pw, h) => { const [s, k] = h.split(':'); return timingSafeEqual(Buffer.from(k, 'hex'), scryptSync(pw, s, 64)); };
const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const hits = new Map();
function limit(key, max, ms = 60000) { const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < ms); a.push(t); hits.set(key, a); if (a.length > max) throw new HttpError(429, 'Too many requests. Wait a minute and try again.'); }

// ---------- domain logic ----------
const MODELS = { // mirrors the model rules enforced in the prototype's AI Studio
  'Diffusion-style image model': { kind: 'image', ratios: ['16:9', '9:16', '1:1', '4:5'], max: 4 },
  'Chat-style image model': { kind: 'image', ratios: ['1:1', '16:9', '9:16'], max: 2 },
  'Video model A': { kind: 'video', ratios: ['16:9', '9:16'], durations: [5, 10], img2vid: 1 },
  'Video model B': { kind: 'video', ratios: ['16:9', '1:1', '9:16'], durations: [4, 8], img2vid: 0 } };
function validateJob(b) {
  const m = MODELS[b.model], p = b.params || {}, er = [];
  if (!m || m.kind !== b.kind) throw bad('Unknown model or kind.', { allowed: Object.keys(MODELS) });
  if (!str(p.prompt)) er.push('Enter a prompt.');
  if (!m.ratios.includes(p.ratio)) er.push(`${b.model} does not support ${p.ratio}.`);
  if (b.kind === 'video' && !m.durations.includes(+p.duration)) er.push(`${b.model} supports durations ${m.durations.join(', ')} s.`);
  if (b.kind === 'image' && !(+p.count >= 1 && +p.count <= m.max)) er.push(`${b.model} allows 1-${m.max} images.`);
  if (p.ref && !safeUrl(p.ref)) er.push('Reference must be an http(s) URL.');
  if (p.ref && b.kind === 'video' && !m.img2vid) er.push(`${b.model} has no image-to-video.`);
  if (er.length) throw bad(er.join(' '), er);
  return { prompt: str(p.prompt, 4000), ref: str(p.ref, 500), ratio: p.ratio, count: +p.count || 1, duration: +p.duration || 0 };
}
const DIMS = { '1:1': [1024, 1024], '16:9': [1280, 720], '9:16': [720, 1280], '4:5': [816, 1024], '4:3': [1024, 768], '3:4': [768, 1024] };
function imageUrls(j) { // keyless free Pollinations text-to-image, one URL per requested image, seeded per job
  let p = {}; try { p = JSON.parse(j.params); } catch {}
  const [w, h] = DIMS[p.ratio] || [1024, 768], n = Math.min(Math.max(+p.count || 1, 1), 4);
  const seed = parseInt(String(j.id).replace(/\D/g, '').slice(0, 8) || '1', 10);
  return Array.from({ length: n }, (_, i) => `https://image.pollinations.ai/prompt/${encodeURIComponent(String(p.prompt || 'image').slice(0, 400))}?width=${w}&height=${h}&seed=${seed + i}&nologo=true`);
}
const MEDIA = join(DATA, 'media'); mkdirSync(MEDIA, { recursive: true });
// ---------- Magic Hour provider (set MAGICHOUR_KEY; handles all video generation) ----------
const MH = { key: env.MAGICHOUR_KEY || '', base: (env.MAGICHOUR_BASE || 'https://api.magichour.ai').replace(/\/$/, ''),
  modelA: env.MAGICHOUR_MODEL_A || 'default', modelB: env.MAGICHOUR_MODEL_B || 'minimax-h3', resolution: env.MAGICHOUR_RESOLUTION || '' };
if (MH.key) MODELS['Video model A'].img2vid = 0; // reference-image video is not connected for Magic Hour yet
async function mhFetch(path, opts = {}) {
  const r = await fetch(MH.base + path, { ...opts, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + MH.key }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) { let m = ''; try { const d = await r.json(); m = d.message || d.code || ''; } catch {} throw new Error('Magic Hour returned ' + r.status + (m ? ': ' + String(m).slice(0, 200) : '') + (r.status === 402 ? ' Fix: add credits on magichour.ai, set MAGICHOUR_RESOLUTION=480p in .env, or try Video model B with a shorter clip.' : '')); }
  return r.json();
}
async function mhSubmit(model, p) { // -> provider id stored on the job
  const body = { name: 'Creatify ' + Date.now(), end_seconds: p.duration, aspect_ratio: p.ratio, style: { prompt: p.prompt.slice(0, 20000) } };
  const m = model === 'Video model B' ? MH.modelB : MH.modelA; if (m && m !== 'default') body.model = m;
  if (MH.resolution) body.resolution = MH.resolution;
  const d = await mhFetch('/v1/text-to-video', { method: 'POST', body: JSON.stringify(body) });
  if (!d.id) throw new Error('Magic Hour returned no job id.'); return 'mh:' + d.id;
}
const mhBusy = new Set();
async function mhPoll(j, base) { // -> job view; saves the finished video locally because Magic Hour download links expire
  const id = j.provider_id.slice(3);
  if (Date.now() - j.created_at > 20 * 60000) { run("UPDATE jobs SET status='failed',error='Generation timed out. Try again.' WHERE id=?", j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); }
  if (mhBusy.has(j.id)) return { id: j.id, status: 'processing', progress: .95 };
  let d; try { d = await mhFetch('/v1/video-projects/' + encodeURIComponent(id)); }
  catch (e) { if (/returned (4\d\d)/.test(e.message) && !/returned 429/.test(e.message)) { run("UPDATE jobs SET status='failed',error=? WHERE id=?", e.message.slice(0, 300), j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); } return { id: j.id, status: 'processing', progress: 0 }; }
  if (d.status === 'queued' || d.status === 'draft') return { id: j.id, status: 'processing', progress: .1 };
  if (d.status === 'rendering') return { id: j.id, status: 'processing', progress: .5 };
  if (d.status === 'error' || d.status === 'canceled') { run("UPDATE jobs SET status='failed',error=? WHERE id=?", String(d.error?.message || (d.status === 'canceled' ? 'The job was canceled.' : 'Magic Hour reported a failure.')).slice(0, 300), j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); }
  if (d.status !== 'complete') return { id: j.id, status: 'processing', progress: .5 };
  const remote = safeUrl(d.downloads?.[0]?.url);
  if (!remote) { run("UPDATE jobs SET status='failed',error='Magic Hour finished but returned no video link.' WHERE id=?", j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); }
  mhBusy.add(j.id); let out = remote;
  try { const f = await fetch(remote, { signal: AbortSignal.timeout(120000) }); if (f.ok) { const name = j.id + '-0.mp4'; writeFileSync(join(MEDIA, name), Buffer.from(await f.arrayBuffer())); out = base + '/media/' + name; } } catch {} // fall back to the (expiring) remote link
  finally { mhBusy.delete(j.id); }
  run("UPDATE jobs SET status='completed',output_url=? WHERE id=?", out, j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id));
}
// ---------- Hugging Face provider (set HF_TOKEN; free monthly credits) ----------
const HF = { token: env.HF_TOKEN || '', base: (env.HF_BASE || 'https://router.huggingface.co').replace(/\/$/, ''),
  image: env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell', videoUrl: env.HF_VIDEO_URL || '' };
async function hfCall(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + HF.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  if (!r.ok) { let m = ''; try { m = (await r.text()).slice(0, 200); } catch {} throw new Error('Hugging Face returned ' + r.status + (m ? ': ' + m : '')); }
  return r;
}
async function hfBytes(r, prefix) { // binary response, or JSON pointing at a hosted file
  const ct = r.headers.get('content-type') || '';
  if (ct.startsWith(prefix + '/')) return { buf: Buffer.from(await r.arrayBuffer()), ct };
  const d = await r.json().catch(() => ({})), u = safeUrl(d?.video?.url || d?.images?.[0]?.url || d?.url || d?.output?.url || '');
  if (!u) throw new Error('Hugging Face returned no ' + prefix + ' output.');
  const f = await fetch(u, { signal: AbortSignal.timeout(120000) }); if (!f.ok) throw new Error('Could not download result (' + f.status + ').');
  return { buf: Buffer.from(await f.arrayBuffer()), ct: f.headers.get('content-type') || prefix + '/' };
}
async function hfGenerate(j, p, base) { // runs in background; writes the job row when done
  try {
    const urls = [];
    for (let i = 0; i < (j.kind === 'video' ? 1 : p.count); i++) {
      let out;
      if (j.kind === 'video') {
        if (!HF.videoUrl) throw new Error('Video needs HF_VIDEO_URL in the backend .env (a Hugging Face video endpoint, see README).');
        out = await hfBytes(await hfCall(HF.videoUrl, { inputs: p.prompt, parameters: { aspect_ratio: p.ratio, duration: p.duration, ...(p.ref && { image_url: p.ref }) } }), 'video');
      } else {
        const [w, h] = DIMS[p.ratio] || [1024, 768];
        out = await hfBytes(await hfCall(`${HF.base}/hf-inference/models/${HF.image}`, { inputs: p.prompt, parameters: { width: w, height: h, seed: i + 1 } }), 'image');
      }
      const ext = j.kind === 'video' ? 'mp4' : /jpe?g/.test(out.ct) ? 'jpg' : /webp/.test(out.ct) ? 'webp' : 'png', name = `${j.id}-${i}.${ext}`;
      writeFileSync(join(MEDIA, name), out.buf); urls.push(base + '/media/' + name);
    }
    run("UPDATE jobs SET status='completed',output_url=? WHERE id=?", urls.join('\n'), j.id);
  } catch (e) {
    if (j.kind === 'image') { run("UPDATE jobs SET status='completed',output_url=? WHERE id=?", imageUrls({ id: j.id, params: JSON.stringify(p) }).join('\n'), j.id); return; } // free fallback
    run("UPDATE jobs SET status='failed',error=? WHERE id=?", String(e.message).slice(0, 300), j.id);
  }
}
const outView = j => { const u = String(j.output_url || '').split('\n').filter(Boolean); return { outputUrl: u[0] || '', outputUrls: u }; };
// ---------- fal.ai provider (set FAL_KEY to enable real image + video generation) ----------
const FAL_BASE = env.FAL_BASE || 'https://queue.fal.run';
const FAL = { key: env.FAL_KEY || '', video: env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v1.6/standard/text-to-video',
  i2v: env.FAL_I2V_MODEL || 'fal-ai/kling-video/v1.6/standard/image-to-video', image: env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell' };
async function falFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + FAL.key } });
  if (!r.ok) { let m = ''; try { m = (await r.text()).slice(0, 200); } catch {} throw new Error('fal.ai returned ' + r.status + (m ? ': ' + m : '')); }
  return r.json();
}
async function falSubmit(kind, p) {
  const IMG = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:5': 'portrait_4_3' };
  let model, input;
  if (kind === 'video') { model = p.ref ? FAL.i2v : FAL.video; input = { prompt: p.prompt, duration: p.duration <= 5 ? '5' : '10', aspect_ratio: p.ratio }; if (p.ref) input.image_url = p.ref; }
  else { model = FAL.image; input = { prompt: p.prompt, image_size: IMG[p.ratio] || 'landscape_4_3', num_images: 1 }; }
  const d = await falFetch(FAL_BASE.replace(/\/$/, '') + '/' + model, { method: 'POST', body: JSON.stringify(input) });
  return JSON.stringify({ fal: 1, model, id: d.request_id, status_url: d.status_url, response_url: d.response_url });
}
async function falPoll(ref) { // -> {status:'processing'|'completed', url?}
  const st = await falFetch(ref.status_url);
  if (st.status !== 'COMPLETED') return { status: 'processing', progress: st.status === 'IN_PROGRESS' ? .5 : .1 };
  const out = await falFetch(ref.response_url);
  const url = out?.video?.url || out?.images?.[0]?.url || out?.image?.url || out?.output?.url || '';
  return { status: 'completed', url };
}
function jobView(j) { // stateless progress so jobs survive restarts; swap in a real provider via PROVIDER_URL
  if (j.kind === 'video' && !j.provider_id && j.status === 'processing') { const m = 'No video provider configured on the server, so nothing was generated. Set MAGICHOUR_KEY (magichour.ai) in the backend .env.'; run("UPDATE jobs SET status='failed',error=? WHERE id=?", m, j.id); return { id: j.id, status: 'failed', error: m }; }
  const dur = j.kind === 'video' ? 15000 : 6000, t = Date.now() - j.created_at;
  if (j.status === 'failed') return { id: j.id, status: 'failed', error: j.error };
  if (j.status === 'completed') return { id: j.id, status: 'completed', progress: 1, ...outView(j) };
  if (t < dur) return { id: j.id, status: 'processing', progress: Math.min(.99, t / dur) };
  run("UPDATE jobs SET status='completed',output_url=? WHERE id=?", imageUrls(j).join('\n'), j.id);
  return jobView(one('SELECT * FROM jobs WHERE id=?', j.id));
}
async function providerCall(path, opts) {
  const r = await fetch(env.PROVIDER_URL.replace(/\/$/, '') + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (env.PROVIDER_KEY || '') } });
  if (!r.ok) throw new Error('provider returned ' + r.status); return r.json();
}
const has = (arr, s) => arr.some(x => x.toLowerCase().includes(s.toLowerCase()));
function matchBrief(b, creators) { // port of the prototype's brief→creator matching
  const out = creators.map(c => { const fails = [], why = []; let sc = 0;
    if (b.commercial && !c.commercial) fails.push('Commercial use required, but creator has not stated it');
    if (b.ratio && !c.formats.includes(b.ratio)) fails.push(`Does not list ${b.ratio} output`);
    const sk = c.skills.concat(c.portfolioProjects.flatMap(p => p.skills || [])), rs = list(b.skills).filter(s => has(sk, s)), rt = list(b.tools).filter(s => has(c.tools, s));
    if (rs.length) { sc += 3 * rs.length; why.push('Skills match: ' + rs.join(', ')); }
    if (rt.length) { sc += 2 * rt.length; why.push('Tools match: ' + rt.join(', ')); }
    if (b.type && c.contentTypes.includes(b.type)) { sc += 2; why.push('Works in ' + b.type); }
    return { creatorId: c.id, name: c.name, score: sc, why, fails, eligible: !fails.length }; });
  return out.sort((a, z) => (z.eligible - a.eligible) || z.score - a.score);
}
const creatorRow = r => ({ ...JSON.parse(r.data), ownerId: r.user_id });
const getCreator = id => { const r = one('SELECT * FROM creators WHERE id=?', id); need(r, 404, 'Creator not found.'); return r; };
const briefRow = r => ({ ...JSON.parse(r.data), id: r.id, ownerId: r.owner, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const getBrief = id => { const r = one('SELECT * FROM briefs WHERE id=?', id); need(r, 404, 'Brief not found.'); return r; };
function cleanBrief(b) {
  const er = {}, o = {}; for (const k of ['title', 'brand', 'objective', 'deliverables']) { o[k] = str(b[k]); if (!o[k]) er[k] = `${k} is required.`; }
  for (const k of ['audience', 'industry', 'type', 'style', 'theme', 'refs', 'tools', 'skills', 'ratio', 'resolution', 'duration', 'fileFormat', 'platform', 'budget', 'channels', 'licensing', 'revisions']) o[k] = str(b[k]);
  o.commercial = !!b.commercial; o.qty = b.qty ? +b.qty : '';
  if (o.qty !== '' && !(o.qty > 0)) er.qty = 'Quantity must be a positive number.';
  o.deadline = str(b.deadline, 40); if (o.deadline && isNaN(Date.parse(o.deadline))) er.deadline = 'Enter a valid date.';
  if (Object.keys(er).length) throw bad('Please fix the highlighted fields.', er); return o;
}

// ---------- routes ----------
const routes = [];
const route = (m, p, h, o = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), h, ...o });
const auth = u => need(u, 401, 'Log in first.');

route('GET', '/api/health', () => ({ ok: true, time: now() }));
route('POST', '/api/auth/register', ({ body, ip }) => {
  limit('auth' + ip, 10); const email = str(body.email, 200).toLowerCase(), name = str(body.name, 80), pw = String(body.password || '');
  const role = ['creator', 'brand'].includes(body.role) ? body.role : 'brand';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email.'); if (!name) throw bad('Enter your name.'); if (pw.length < 8) throw bad('Password must be at least 8 characters.');
  need(!one('SELECT 1 FROM users WHERE email=?', email), 409, 'An account with this email already exists.');
  const id = 'u' + randomUUID().slice(0, 8); run('INSERT INTO users VALUES(?,?,?,?,?,?)', id, email, name, role, hash(pw), now());
  if (role === 'creator') { const c = { id: 'c' + id, name, specialization: '', bio: '', skills: [], tools: [], contentTypes: [], formats: [], commercial: false, verification: ['n', 'n', 'n'], workflow: '', portfolioProjects: [] }; run('INSERT INTO creators VALUES(?,?,?)', c.id, id, JSON.stringify(c)); }
  const u = one('SELECT * FROM users WHERE id=?', id); return [201, { token: sign({ uid: id, exp: Date.now() + 7 * 864e5 }), user: pub(u) }];
});
route('POST', '/api/auth/login', ({ body, ip }) => {
  limit('auth' + ip, 10); const u = one('SELECT * FROM users WHERE email=?', str(body.email, 200).toLowerCase());
  need(u && check(String(body.password || ''), u.pw), 401, 'Email or password is incorrect.');
  return { token: sign({ uid: u.id, exp: Date.now() + 7 * 864e5 }), user: pub(u) };
});
route('GET', '/api/me', ({ user }) => { auth(user); const c = one('SELECT id FROM creators WHERE user_id=?', user.id); return { ...pub(user), creatorId: c?.id || null }; });

route('GET', '/api/creators', ({ query: q }) => {
  let r = all('SELECT * FROM creators').map(creatorRow); const t = str(q.q).toLowerCase().split(/\s+/).filter(Boolean);
  r = r.filter(c => { const hay = [c.name, c.bio, c.specialization, ...c.skills, ...c.tools, ...c.portfolioProjects.flatMap(p => [p.title, p.description])].join(' ').toLowerCase();
    return t.every(w => hay.includes(w)) && (!q.spec || c.specialization === q.spec) && (!q.tool || c.tools.includes(q.tool)) && (!q.type || c.contentTypes.includes(q.type)) && (!q.format || c.formats.includes(q.format)) && (q.comm !== '1' || c.commercial) && (q.ver !== '1' || c.verification.includes('v')); });
  return { total: r.length, creators: r };
});
route('GET', '/api/creators/:id', ({ params }) => creatorRow(getCreator(params.id)));
route('PUT', '/api/creators/:id', ({ params, body, user }) => {
  auth(user); const r = getCreator(params.id); need(r.user_id === user.id, 403, 'You can only edit your own profile.'); const c = JSON.parse(r.data);
  const bio = str(body.bio, 3000), skills = list(body.skills), tools = list(body.tools), er = [];
  if (!bio) er.push('Biography is required.'); if (!skills.length) er.push('Add at least one skill.'); if (!tools.length) er.push('Add at least one AI tool.'); if (er.length) throw bad(er.join(' '), er);
  Object.assign(c, { bio, skills, tools, specialization: str(body.specialization, 80), workflow: str(body.workflow, 3000), commercial: !!body.commercial, contentTypes: list(body.contentTypes), formats: list(body.formats) });
  run('UPDATE creators SET data=? WHERE id=?', JSON.stringify(c), c.id); return c;
});
route('POST', '/api/creators/:id/projects', ({ params, body, user }) => {
  auth(user); const r = getCreator(params.id); need(r.user_id === user.id, 403, 'You can only edit your own portfolio.'); const c = JSON.parse(r.data);
  const title = str(body.title, 120), description = str(body.description, 2000); if (!title || !description) throw bad('Project title and description are required.');
  if (body.previewMedia && !safeUrl(body.previewMedia)) throw bad('Image URL must start with http:// or https://.');
  const p = { id: c.id + 'p' + Date.now(), title, description, mediaType: str(body.mediaType, 30) || 'Image', objective: str(body.objective), role: 'Creator', toolsUsed: list(body.toolsUsed), aspectRatio: str(body.aspectRatio, 10), deliverables: str(body.deliverables), workflow: str(body.workflow), intendedUse: str(body.intendedUse), licensingInformation: str(body.licensingInformation), skills: list(body.skills), previewMedia: safeUrl(body.previewMedia) };
  c.portfolioProjects.push(p); run('UPDATE creators SET data=? WHERE id=?', JSON.stringify(c), c.id); return [201, p];
});
route('DELETE', '/api/creators/:id/projects/:pid', ({ params, user }) => {
  auth(user); const r = getCreator(params.id); need(r.user_id === user.id, 403, 'Not your portfolio.'); const c = JSON.parse(r.data);
  need(c.portfolioProjects.length > 1, 409, 'Keep at least one project in your portfolio.'); c.portfolioProjects = c.portfolioProjects.filter(p => p.id !== params.pid);
  run('UPDATE creators SET data=? WHERE id=?', JSON.stringify(c), c.id); return { ok: true };
});

route('GET', '/api/saved', ({ user }) => { auth(user); return { saved: all('SELECT creator_id FROM saved WHERE user_id=?', user.id).map(r => r.creator_id) }; });
route('PUT', '/api/saved/:id', ({ params, user }) => { auth(user); getCreator(params.id); run('INSERT OR IGNORE INTO saved VALUES(?,?)', user.id, params.id); return { ok: true }; });
route('DELETE', '/api/saved/:id', ({ params, user }) => { auth(user); run('DELETE FROM saved WHERE user_id=? AND creator_id=?', user.id, params.id); return { ok: true }; });

route('GET', '/api/briefs', ({ user, query: q }) => { // brands see their own; creators see published briefs
  auth(user); const rows = user.role === 'brand' ? all('SELECT * FROM briefs WHERE owner=? ORDER BY created_at DESC', user.id) : all("SELECT * FROM briefs WHERE status LIKE 'Published%' ORDER BY created_at DESC");
  return { briefs: rows.map(briefRow).filter(b => !q.status || b.status === q.status) };
});
route('POST', '/api/briefs', ({ user, body }) => { auth(user); need(user.role === 'brand', 403, 'Only brand accounts can create briefs.');
  const id = 'b' + Date.now(), t = now(); run('INSERT INTO briefs VALUES(?,?,?,?,?,?)', id, user.id, 'Draft', JSON.stringify(cleanBrief(body)), t, t); return [201, briefRow(getBrief(id))]; });
route('GET', '/api/briefs/:id', ({ params, user }) => { auth(user); const r = getBrief(params.id); need(r.owner === user.id || r.status.startsWith('Published'), 403, 'This brief is private.'); return briefRow(r); });
route('PUT', '/api/briefs/:id', ({ params, user, body }) => { auth(user); const r = getBrief(params.id); need(r.owner === user.id, 403, 'Not your brief.');
  run('UPDATE briefs SET data=?,updated_at=? WHERE id=?', JSON.stringify(cleanBrief(body)), now(), r.id); return briefRow(getBrief(r.id)); });
route('POST', '/api/briefs/:id/publish', ({ params, user }) => { auth(user); const r = getBrief(params.id); need(r.owner === user.id, 403, 'Not your brief.');
  run('UPDATE briefs SET status=?,updated_at=? WHERE id=?', 'Published', now(), r.id); return briefRow(getBrief(r.id)); });
route('DELETE', '/api/briefs/:id', ({ params, user }) => { auth(user); const r = getBrief(params.id); need(r.owner === user.id, 403, 'Not your brief.'); run('DELETE FROM briefs WHERE id=?', r.id); return { ok: true }; });
route('GET', '/api/briefs/:id/matches', ({ params, user }) => { auth(user); const r = getBrief(params.id); need(r.owner === user.id, 403, 'Not your brief.'); return { matches: matchBrief(briefRow(r), all('SELECT * FROM creators').map(creatorRow)) }; });
route('POST', '/api/briefs/:id/applications', ({ params, user, body }) => {
  auth(user); const b = getBrief(params.id), c = one('SELECT * FROM creators WHERE user_id=?', user.id); need(c, 403, 'Only creators can apply.'); need(b.status.startsWith('Published'), 409, 'This brief is not open.');
  const message = str(body.message, 3000); if (message.length < 20) throw bad('Tell the brand why you fit (at least 20 characters).');
  need(!one('SELECT 1 FROM applications WHERE brief_id=? AND creator_id=?', b.id, c.id), 409, 'You already applied to this brief.');
  const id = 'a' + randomUUID().slice(0, 8); run('INSERT INTO applications VALUES(?,?,?,?,?,?)', id, b.id, c.id, message, 'Submitted', now()); return [201, one('SELECT * FROM applications WHERE id=?', id)];
});
route('GET', '/api/briefs/:id/applications', ({ params, user }) => { auth(user); const b = getBrief(params.id); need(b.owner === user.id, 403, 'Not your brief.'); return { applications: all('SELECT * FROM applications WHERE brief_id=? ORDER BY created_at DESC', b.id) }; });
route('GET', '/api/applications', ({ user }) => { auth(user); const c = one('SELECT id FROM creators WHERE user_id=?', user.id); return { applications: c ? all('SELECT * FROM applications WHERE creator_id=? ORDER BY created_at DESC', c.id) : [] }; });
route('PATCH', '/api/applications/:id', ({ params, user, body }) => {
  auth(user); const a = one('SELECT * FROM applications WHERE id=?', params.id); need(a, 404, 'Application not found.'); const b = getBrief(a.brief_id);
  if (body.status === 'Withdrawn') { const c = one('SELECT user_id FROM creators WHERE id=?', a.creator_id); need(c.user_id === user.id, 403, 'Not your application.'); }
  else { need(b.owner === user.id, 403, 'Only the brief owner can review applications.'); need(['Shortlisted', 'Accepted', 'Rejected'].includes(body.status), 400, 'Status must be Shortlisted, Accepted or Rejected.'); }
  run('UPDATE applications SET status=? WHERE id=?', body.status, a.id); return one('SELECT * FROM applications WHERE id=?', a.id);
});

// ---------- hire requests (brand -> creator) ----------
const hireView = r => { const c = one('SELECT data FROM creators WHERE id=?', r.creator_id), u = one('SELECT name FROM users WHERE id=?', r.brand_id), b = r.brief_id ? one('SELECT data FROM briefs WHERE id=?', r.brief_id) : null;
  return { id: r.id, creatorId: r.creator_id, creatorName: c ? JSON.parse(c.data).name : '', brandId: r.brand_id, brandName: u?.name || '', briefId: r.brief_id, briefTitle: b ? JSON.parse(b.data).title : '', message: r.message, status: r.status, createdAt: r.created_at }; };
route('POST', '/api/creators/:id/hire', ({ params, user, body }) => {
  auth(user); need(user.role === 'brand', 403, 'Only brand accounts can hire creators.'); const c = getCreator(params.id); limit('hire' + user.id, 20);
  const message = str(body.message, 3000); if (message.length < 10) throw bad('Tell the creator what you need (at least 10 characters).');
  let briefId = null; if (body.briefId) { const b = one('SELECT owner FROM briefs WHERE id=?', String(body.briefId)); need(b && b.owner === user.id, 400, 'Choose one of your own briefs.'); briefId = String(body.briefId); }
  need(!one("SELECT 1 FROM hires WHERE brand_id=? AND creator_id=? AND status='Sent'", user.id, c.id), 409, 'You already have a pending hire request with this creator.');
  const id = 'h' + randomUUID().slice(0, 8); run('INSERT INTO hires VALUES(?,?,?,?,?,?,?)', id, user.id, c.id, briefId, message, 'Sent', now()); return [201, hireView(one('SELECT * FROM hires WHERE id=?', id))]; });
route('GET', '/api/hires', ({ user }) => { auth(user);
  let rows; if (user.role === 'brand') rows = all('SELECT * FROM hires WHERE brand_id=? ORDER BY created_at DESC', user.id);
  else { const c = one('SELECT id FROM creators WHERE user_id=?', user.id); rows = c ? all('SELECT * FROM hires WHERE creator_id=? ORDER BY created_at DESC', c.id) : []; }
  return { hires: rows.map(hireView) }; });
route('PATCH', '/api/hires/:id', ({ params, user, body }) => { auth(user); const h = one('SELECT * FROM hires WHERE id=?', params.id); need(h, 404, 'Hire request not found.'); need(h.status === 'Sent', 409, 'This request has already been ' + h.status.toLowerCase() + '.');
  if (body.status === 'Cancelled') need(h.brand_id === user.id, 403, 'Only the brand that sent this can cancel it.');
  else { need(['Accepted', 'Declined'].includes(body.status), 400, 'Status must be Accepted, Declined or Cancelled.'); const c = one('SELECT user_id FROM creators WHERE id=?', h.creator_id); need(c && c.user_id === user.id, 403, 'Only the creator can answer this request.'); }
  run('UPDATE hires SET status=? WHERE id=?', body.status, h.id); return hireView(one('SELECT * FROM hires WHERE id=?', h.id)); });

route('GET', '/api/assets', ({ user }) => { auth(user); return { assets: all('SELECT * FROM assets WHERE owner=? ORDER BY created_at DESC', user.id).map(a => ({ ...a, data: JSON.parse(a.data) })) }; });
route('POST', '/api/assets', ({ user, body }) => { auth(user); const id = 'as' + randomUUID().slice(0, 8), kind = str(body.kind, 30), title = str(body.title, 200); if (!kind || !title) throw bad('Asset kind and title are required.');
  run('INSERT INTO assets VALUES(?,?,?,?,?,?)', id, user.id, kind, title, JSON.stringify(body.data || {}).slice(0, 100000), now()); return [201, { id, kind, title }]; });
route('DELETE', '/api/assets/:id', ({ params, user }) => { auth(user); run('DELETE FROM assets WHERE id=? AND owner=?', params.id, user.id); return { ok: true }; });

// AI Studio job API — matches the contract already used by the prototype (POST /jobs, GET /jobs/:id).
const jobCreate = async ({ body, user, ip, host }) => {
  const owner = user?.id || 'ip:' + ip, p = validateJob(body), day = Date.now() - 864e5;
  need(one('SELECT COUNT(*) n FROM jobs WHERE owner=? AND created_at>?', owner, day).n < DAILY_LIMIT, 429, `Daily limit of ${DAILY_LIMIT} generations reached.`);
  const id = 'j' + randomUUID().slice(0, 10); let pid = null, status = 'processing', error = null;
  const ext = !env.PROVIDER_URL, useMH = MH.key && ext && body.kind === 'video', useFal = FAL.key && ext && !useMH, useHF = HF.token && ext && !useMH && !FAL.key; if (useHF) pid = 'hf';
  if (useMH) { try { pid = await mhSubmit(body.model, p); } catch (e) { status = 'failed'; error = 'Provider error: ' + e.message; } }
  else if (useFal) { try { pid = await falSubmit(body.kind, p); } catch (e) { status = 'failed'; error = 'Provider error: ' + e.message; } }
  else if (env.PROVIDER_URL) { try { pid = (await providerCall('/jobs', { method: 'POST', body: JSON.stringify({ kind: body.kind, model: body.model, params: p }) })).id; } catch (e) { status = 'failed'; error = 'Provider error: ' + e.message; } }
  run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)', id, owner, body.kind, body.model, JSON.stringify(p), pid, status, error, null, Date.now());
  if (useHF) hfGenerate({ id, kind: body.kind }, p, (env.PUBLIC_URL || 'http://' + host).replace(/\/$/, ''));
  return [201, { id, status }];
};
const jobGet = async ({ params, user, ip, host }) => {
  const j = one('SELECT * FROM jobs WHERE id=?', params.id); need(j && j.owner === (user?.id || 'ip:' + ip), 404, 'Job not found.');
  if (j.provider_id?.startsWith('mh:') && j.status === 'processing') return mhPoll(j, (env.PUBLIC_URL || 'http://' + host).replace(/\/$/, ''));
  if (j.provider_id === 'hf' && j.status === 'processing') { const t = Date.now() - j.created_at; // survives restarts: stale jobs fail instead of hanging
    if (t > 11 * 60000) { run("UPDATE jobs SET status='failed',error='Generation timed out. Try again.' WHERE id=?", j.id); return { id: j.id, status: 'failed', error: 'Generation timed out. Try again.' }; }
    return { id: j.id, status: 'processing', progress: Math.min(.95, t / (j.kind === 'video' ? 240000 : 30000)) }; }
  if (j.provider_id === 'hf') return jobView(j);
  if (j.provider_id && j.provider_id.startsWith('{') && j.status === 'processing') { try { const d = await falPoll(JSON.parse(j.provider_id));
    if (d.status === 'processing') return { id: j.id, status: 'processing', progress: d.progress };
    const u = safeUrl(d.url); run('UPDATE jobs SET status=?,output_url=?,error=? WHERE id=?', u ? 'completed' : 'failed', u, u ? null : 'fal.ai finished but returned no usable output URL.', j.id);
    return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); }
    catch (e) { if (/returned 4\d\d/.test(e.message) && !/returned 4(08|29)/.test(e.message)) { run("UPDATE jobs SET status='failed',error=? WHERE id=?", e.message.slice(0, 300), j.id); return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); } return { id: j.id, status: 'processing', progress: 0 }; } }
  if (j.provider_id && j.status === 'processing') { try { const d = await providerCall('/jobs/' + encodeURIComponent(j.provider_id));
    if (d.status === 'completed') { const u = safeUrl(d.outputUrl); run('UPDATE jobs SET status=?,output_url=?,error=? WHERE id=?', u ? 'completed' : 'failed', u, u ? null : 'Provider returned an invalid output URL.', j.id); }
    else if (d.status === 'failed') run("UPDATE jobs SET status='failed',error=? WHERE id=?", String(d.error || 'Provider reported a failure.').slice(0, 300), j.id);
    else return { id: j.id, status: 'processing', progress: d.progress ?? 0 }; } catch (e) { return { id: j.id, status: 'processing', progress: 0 }; }
    return jobView(one('SELECT * FROM jobs WHERE id=?', j.id)); }
  return jobView(j);
};
for (const base of ['/jobs', '/api/jobs']) { route('POST', base, jobCreate, { anon: true }); route('GET', base + '/:id', jobGet, { anon: true }); }
route('GET', '/api/jobs', ({ user }) => { auth(user); return { jobs: all('SELECT id,kind,model,status,created_at FROM jobs WHERE owner=? ORDER BY created_at DESC LIMIT 100', user.id) }; });
route('GET', '/api/models', () => ({ models: MODELS, dailyLimit: DAILY_LIMIT }));

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
async function readBody(req) { let n = 0, ch = []; for await (const c of req) { n += c.length; if (n > 1e6) throw new HttpError(413, 'Request body too large.'); ch.push(c); }
  if (!n) return {}; try { return JSON.parse(Buffer.concat(ch).toString()); } catch { throw bad('Request body must be valid JSON.'); } }
export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin, allow = ORIGINS.includes('*') ? '*' : ORIGINS.includes(origin) ? origin : '';
  const send = (s, d, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...SEC, ...(allow && { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', Vary: 'Origin' }), ...h }); res.end(JSON.stringify(d)); };
  try {
    const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress || 'ip';
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...(allow && { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }) }); return res.end(); }
    limit('g' + ip, 240);
    for (const r of routes) { const m = r.m === req.method && r.re.exec(url.pathname); if (!m) continue;
      const tok = (req.headers.authorization || '').replace(/^Bearer /, ''), p = tok && verify(tok), user = p ? one('SELECT * FROM users WHERE id=?', p.uid) : null;
      const out = await r.h({ params: m.groups || {}, query: Object.fromEntries(url.searchParams), body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {}, user, ip, host: req.headers.host || 'localhost:' + PORT });
      return Array.isArray(out) ? send(out[0], out[1]) : send(200, out); }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) { const n = url.pathname.slice(7);
      if (/^[\w-]+\.(png|jpg|webp|mp4)$/.test(n) && existsSync(join(MEDIA, n))) { res.writeHead(200, { 'Content-Type': { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4' }[extname(n).slice(1)], 'Cache-Control': 'public, max-age=86400', ...SEC }); return res.end(readFileSync(join(MEDIA, n))); }
      throw new HttpError(404, 'Not found.'); }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/jobs')) throw new HttpError(404, 'Route not found.');
    if (req.method === 'GET') { const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, ''), f = join(ROOT, 'public', rel);
      if (f.startsWith(join(ROOT, 'public')) && existsSync(f) && extname(f)) { res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', ...SEC }); return res.end(readFileSync(f)); } }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, details: e.details });
    console.error(e); send(500, { error: 'Something went wrong on our side. Try again.' });
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(PORT, () => console.log(`Creatify backend on http://localhost:${PORT}  (db: ${env.DB_FILE || 'data/creatify.db'})`));
