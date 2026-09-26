// Daily job: pull the US TikTok Explore feed via Apify (mu0i~tiktok-trending), stay inside the free plan,
// derive trending videos / hashtags / sounds, and write data/trends.json.
// Env: APIFY_TOKEN (required), LIMIT (videos per run, default 30), MAX_SPEND_RATIO (default 0.8),
//      APIFY_BASE (default https://api.apify.com, overridable for tests)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'trends.json');
const HIST = path.join(DATA, 'history');
const BASE = process.env.APIFY_BASE || 'https://api.apify.com';
const TOKEN = process.env.APIFY_TOKEN || '';
const LIMIT = Math.min(Math.max(parseInt(process.env.LIMIT || '30', 10) || 30, 5), 60);
const MAX_SPEND_RATIO = Number(process.env.MAX_SPEND_RATIO || '0.8');
const ACTOR = 'mu0i~tiktok-trending';
const PRICE_PER_RESULT = 0.003;
const REGION = 'US';

const GENERIC = new Set(['fyp', 'foryou', 'foryoupage', 'fypシ', 'fypage', 'viral', 'goviral', 'viralvideo', 'trending', 'trend', 'tiktok', 'xyzbca', 'capcut', 'explore', 'explorepage', 'fy', 'f', 'parati', 'foru', 'blowthisup', 'fypviral', 'viraltiktok', 'fypp', 'foyou']);
const isGeneric = t => GENERIC.has(t) || /^(fy+p*|foryou|for+you|parati|paratí|viral|trending|explore)/.test(t) || /(.)\1{3,}/.test(t) || t.length < 2;
const FIT_WORDS = ['app', 'dev', 'code', 'coding', 'program', 'startup', 'founder', 'build', 'saas', 'ai', 'tech', 'product', 'design', 'productiv', 'business', 'entrepreneur', 'indie', 'software', 'career', 'study', 'learn', 'tips', 'hack', 'workflow', 'sidehustle', 'money', 'work', 'office', 'corporate', 'college'];
const REUSE_WORDS = ['pov', 'tips', 'hack', 'howto', 'tutorial', 'dayinthelife', 'behindthescenes', 'storytime', 'learn', 'before', 'after', 'challenge', 'routine', 'grwm', 'fyp'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (n, a, b) => Math.max(a, Math.min(b, Math.round(n)));
const tokens = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// short words must match a whole token; longer stems may prefix a token (e.g. coding → codinglife)
const hits = (s, words) => { const t = tokens(s); return words.filter(w => t.some(x => x === w || (w.length >= 5 && x.startsWith(w)))).length; };
const WINDOW_DAYS = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error('Apify returned non-JSON'); }
}

async function checkBudget() {
  const { data } = await api('/v2/users/me/limits');
  const used = Number(data?.current?.monthlyUsageUsd ?? 0);
  const cap = Number(data?.limits?.maxMonthlyUsageUsd ?? 5);
  if (used + LIMIT * PRICE_PER_RESULT * 1.5 > cap * MAX_SPEND_RATIO) throw new Error(`本月 Apify 额度已用 $${used.toFixed(2)} / $${cap.toFixed(2)}，为避免超出免费额度，今天跳过抓取`);
  return { used, cap };
}

async function runActor() {
  const { data: run } = await api(`/v2/acts/${ACTOR}/runs?waitForFinish=240&maxItems=${LIMIT}`, { method: 'POST', body: JSON.stringify({ maxVideos: LIMIT }) });
  let r = run;
  for (let i = 0; i < 30 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(r.status); i++) { await sleep(8000); r = (await api(`/v2/actor-runs/${run.id}`)).data; }
  if (r.status !== 'SUCCEEDED') throw new Error(`Apify 运行未成功（${r.status}${r.statusMessage ? '：' + String(r.statusMessage).slice(0, 160) : ''}）`);
  const rows = await api(`/v2/datasets/${r.defaultDatasetId}/items?clean=true&limit=${LIMIT}`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('Apify 返回 0 条数据');
  return rows;
}

const tagsOf = v => (Array.isArray(v.hashtags) && v.hashtags.length ? v.hashtags : String(v.description || '').match(/#[^\s#]+/g) || [])
  .map(t => String(typeof t === 'object' ? (t.name || t.title || '') : t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
const engagement = v => { const p = Number(v.playCount) || 0; return p ? ((Number(v.likeCount) || 0) + (Number(v.commentCount) || 0) + (Number(v.shareCount) || 0) + (Number(v.saveCount) || 0)) / p : 0; };
const isOriginal = t => /original sound|原声|som original|sonido original/i.test(t || '');

function scoreText(text) {
  const s = text;
  const fit = clamp(30 + hits(s, FIT_WORDS) * 25, 0, 95);
  const reuse = clamp(50 + hits(s, REUSE_WORDS) * 12 + hits(s, FIT_WORDS) * 8, 0, 95);
  return { fit, reuse };
}
const categoryOf = (fit, viral) => (fit >= 55 && viral >= 70 ? 'Bridge' : fit >= 55 ? 'Brand' : 'Traffic');

function build(rows, prev, past = []) {
  const now = new Date().toISOString();
  const prevById = new Map((prev?.items || []).map(i => [i.id, i]));
  const statusFor = (id, rank, prevRank) => {
    if (!prevById.size) return 'New';
    const p = prevById.get(id);
    if (!p) return rank <= 3 ? 'Breakout' : 'New';
    if (prevRank && prevRank - rank >= 2) return 'Rising';
    if (prevRank && rank - prevRank >= 2) return 'Cooling';
    return 'Stable';
  };
  const maxPlay = Math.max(1, ...rows.map(v => Number(v.playCount) || 0));

  const videos = rows
    .filter(v => v.url)
    .sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))
    .map((v, i) => {
      const id = `vid-${v.videoId || i}`;
      const plays = Number(v.playCount) || 0;
      const hours = Math.max(1, (Date.now() - new Date(v.createdAt).getTime()) / 36e5) || 1;
      const p = prevById.get(id);
      const growth = p && p.volume ? Math.round(((plays - p.volume) / p.volume) * 100) : 0;
      const tags = tagsOf(v).filter(t => !isGeneric(t));
      const desc = String(v.description || '').replace(/\s+/g, ' ').trim();
      const viral = clamp(40 + (plays / maxPlay) * 40 + Math.min(engagement(v), 0.25) * 80, 0, 99);
      const { fit, reuse } = scoreText(`${desc} ${tags.join(' ')}`);
      return {
        id, title: desc ? desc.slice(0, 90) : `@${v.authorUsername} 的视频`, type: v.isPhotoPost ? 'Template' : 'Topic',
        category: categoryOf(fit, viral), region: REGION, language: 'EN',
        status: statusFor(id, i + 1, p ? (prev.items.filter(x => x.id.startsWith('vid-')).findIndex(x => x.id === id) + 1) : 0),
        growth, volume: plays, viral, fit, reuse,
        source: 'TikTok Explore (Apify)', url: v.url, captured: v.collectedAt || now,
        hook: desc.slice(0, 200),
        angle: `@${v.authorUsername || '?'} · ${v.isPhotoPost ? '图文' : `${Math.round((Number(v.durationMs) || 0) / 1000)} 秒视频`} · 发布 ${Math.round(hours)} 小时 · 约 ${Math.round(plays / hours).toLocaleString('en-US')} 播放/小时 · 互动率 ${(engagement(v) * 100).toFixed(1)}%${v.musicTitle ? ` · 音乐：${v.musicTitle}` : ''}`,
        shots: []
      };
    });

  const seen = new Set(rows.map(v => String(v.videoId)));
  const pool = [...rows, ...past.filter(v => v && !seen.has(String(v.videoId)) && seen.add(String(v.videoId)))];
  const days = 1 + new Set(past.map(v => v._day)).size;
  const agg = (keyFn, labelFn) => {
    const m = new Map();
    for (const v of pool) for (const k of keyFn(v)) {
      const e = m.get(k) || { k, n: 0, plays: 0, sample: v, label: labelFn(v, k) };
      e.n++; e.plays += Number(v.playCount) || 0; m.set(k, e);
    }
    return [...m.values()].filter(e => e.n >= 2).sort((a, b) => b.n - a.n || b.plays - a.plays);
  };

  const hashtags = agg(v => [...new Set(tagsOf(v).filter(t => !isGeneric(t)))], (v, k) => `#${k}`).slice(0, 15).map((e, i) => {
    const id = `tag-${e.k}`, p = prevById.get(id);
    const viral = clamp(45 + e.n * 8 + (e.plays / maxPlay) * 20, 0, 99);
    const { fit, reuse } = scoreText(e.k);
    return {
      id, title: e.label, type: 'Hashtag', category: categoryOf(fit, viral), region: REGION, language: 'EN',
      status: statusFor(id, i + 1, 0), growth: p && p.volume ? Math.round(((e.plays - p.volume) / p.volume) * 100) : 0,
      volume: e.plays, viral, fit, reuse, source: 'TikTok Explore (Apify)',
      url: `https://www.tiktok.com/tag/${encodeURIComponent(e.k)}`, captured: now,
      angle: `最近 ${days} 天抽样的 ${pool.length} 条 Explore 热门内容中，有 ${e.n} 条使用此标签，合计 ${e.plays.toLocaleString('en-US')} 播放。`, shots: []
    };
  });

  const sounds = agg(v => (v.musicId && !isOriginal(v.musicTitle) ? [String(v.musicId)] : []), v => `${v.musicTitle || 'Unknown'}${v.musicAuthor ? ' — ' + v.musicAuthor : ''}`).slice(0, 10).map((e, i) => {
    const id = `music-${e.k}`, p = prevById.get(id);
    const viral = clamp(50 + e.n * 8 + (e.plays / maxPlay) * 20, 0, 99);
    return {
      id, title: e.label.slice(0, 120), type: 'Music', category: 'Traffic', region: REGION, language: 'EN',
      status: statusFor(id, i + 1, 0), growth: p && p.volume ? Math.round(((e.plays - p.volume) / p.volume) * 100) : 0,
      volume: e.plays, viral, fit: 40, reuse: 70, source: 'TikTok Explore (Apify)',
      url: `https://www.tiktok.com/music/x-${encodeURIComponent(e.k)}`, captured: now,
      angle: `最近 ${days} 天抽样中有 ${e.n} 条热门内容使用这段音乐，合计 ${e.plays.toLocaleString('en-US')} 播放。发布时在平台音乐库内添加。`, shots: []
    };
  });

  return [...hashtags, ...sounds, ...videos];
}

async function main() {
  fs.mkdirSync(HIST, { recursive: true });
  const prevFile = readJson(OUT, null);
  const base = { region: REGION, source: 'TikTok Explore feed via Apify (mu0i/tiktok-trending)', note: '评分为内部规则计算，不是 TikTok 官方数据；话题与音乐由当日抽样的热门视频统计得出' };
  try {
    if (!TOKEN) throw new Error('缺少 APIFY_TOKEN');
    const budget = await checkBudget();
    const rows = await runActor();
    fs.writeFileSync(path.join(DATA, 'raw-latest.json'), JSON.stringify(rows.slice(0, 3), null, 2));
    const past = [];
    for (let d = 1; d < WINDOW_DAYS; d++) {
      const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      const h = readJson(path.join(HIST, `${day}.json`), null);
      if (Array.isArray(h?.sample)) h.sample.forEach(v => past.push({ ...v, _day: day }));
    }
    const items = build(rows, prevFile?.items?.length ? prevFile : null, past);
    const sample = rows.map(v => ({ videoId: String(v.videoId), playCount: Number(v.playCount) || 0, hashtags: tagsOf(v), musicId: v.musicId || null, musicTitle: v.musicTitle || '', musicAuthor: v.musicAuthor || '' }));
    if (!items.length) throw new Error('数据字段无法识别，请查看 data/raw-latest.json');
    const out = { ...base, status: 'ok', generatedAt: new Date().toISOString(), error: null, sampleSize: rows.length, budget: { usedUsd: budget.used, capUsd: budget.cap }, items };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(HIST, `${today()}.json`), JSON.stringify({ ...out, sample }, null, 2));
    const count = t => items.filter(i => i.type === t).length;
    console.log(`OK: ${rows.length} videos → ${count('Hashtag')} hashtags, ${count('Music')} sounds, ${items.length - count('Hashtag') - count('Music')} videos; month usage $${budget.used.toFixed(2)}/$${budget.cap.toFixed(2)}`);
  } catch (e) {
    const kept = prevFile?.items || [];
    const out = { ...base, status: 'error', generatedAt: prevFile?.generatedAt || null, error: { message: e.message, at: new Date().toISOString() }, items: kept };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`ERROR (kept ${kept.length} previous items): ${e.message}`);
  }
}
main();
