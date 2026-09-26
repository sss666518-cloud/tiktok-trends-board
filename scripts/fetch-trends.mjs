// Daily job: pull TikTok trending hashtags via Apify, stay inside the free plan, write data/trends.json.
// Env: APIFY_TOKEN (required), COUNTRY (default US), LIMIT (default 20), MAX_SPEND_RATIO (default 0.8),
//      APIFY_BASE (default https://api.apify.com, overridable for tests)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'trends.json');
const HIST = path.join(DATA, 'history');
const BASE = process.env.APIFY_BASE || 'https://api.apify.com';
const TOKEN = process.env.APIFY_TOKEN || '';
const COUNTRY = (process.env.COUNTRY || 'US').toUpperCase();
const LIMIT = Math.min(Math.max(parseInt(process.env.LIMIT || '20', 10) || 20, 1), 50);
const MAX_SPEND_RATIO = Number(process.env.MAX_SPEND_RATIO || '0.8');
const ACTOR = 'clockworks~tiktok-trends-scraper';
const PRICE_PER_RESULT = 0.0017;

const FIT_WORDS = ['app', 'dev', 'code', 'coding', 'program', 'startup', 'founder', 'build', 'saas', 'ai', 'tech', 'product', 'design', 'productiv', 'business', 'entrepreneur', 'indie', 'software', 'career', 'study', 'learn', 'tips', 'hack', 'workflow', 'side', 'money', 'work'];
const REUSE_WORDS = ['pov', 'tips', 'hack', 'howto', 'tutorial', 'dayinthelife', 'behindthescenes', 'fyp', 'storytime', 'learn', 'before', 'after', 'challenge'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const today = () => new Date().toISOString().slice(0, 10);

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
  const next = LIMIT * PRICE_PER_RESULT * 1.5;
  if (used + next > cap * MAX_SPEND_RATIO) throw new Error(`本月 Apify 额度已用 $${used.toFixed(2)} / $${cap.toFixed(2)}，为避免超出免费额度，今天跳过抓取`);
  return { used, cap };
}

const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, x) => (a == null ? a : a[x]), o); if (v != null && v !== '') return v; } return undefined; };

function mapItem(raw, i, prevRanks) {
  const name = String(pick(raw, ['name', 'hashtagName', 'hashtag_name', 'hashtag', 'title']) || '').replace(/^#/, '').trim();
  if (!name) return null;
  const rank = Number(pick(raw, ['rank', 'position'])) || i + 1;
  const views = Number(pick(raw, ['videoViews', 'video_views', 'views', 'viewCount'])) || 0;
  const posts = Number(pick(raw, ['publishCount', 'publishCnt', 'publish_cnt', 'videoCount', 'posts'])) || 0;
  const curve = pick(raw, ['trend', 'trendingHistogram', 'trendCurve']);
  const lower = name.toLowerCase();

  let growth = 0;
  if (Array.isArray(curve) && curve.length >= 2) {
    const val = p => Number(typeof p === 'object' ? (p.value ?? p.y) : p) || 0;
    const a = val(curve[0]), b = val(curve[curve.length - 1]);
    growth = a > 0 ? Math.round(((b - a) / a) * 100) : (b > 0 ? 100 : 0);
  }
  const prev = prevRanks.get(lower);
  const moved = prev ? prev - rank : 0;
  const status = !prev ? (prevRanks.size && rank <= 5 ? 'Breakout' : 'New') : moved >= 3 ? 'Rising' : moved <= -3 ? 'Cooling' : 'Stable';

  const fitHits = FIT_WORDS.filter(w => lower.includes(w)).length;
  const viral = Math.max(40, Math.min(99, 100 - Math.round((rank - 1) * (55 / LIMIT)) + (status === 'Rising' || status === 'Breakout' ? 5 : 0)));
  const fit = Math.min(95, 30 + fitHits * 25);
  const reuse = Math.min(95, 50 + REUSE_WORDS.filter(w => lower.includes(w)).length * 15 + fitHits * 10);
  const category = fit >= 55 && viral >= 70 ? 'Bridge' : fit >= 55 ? 'Brand' : 'Traffic';

  return {
    id: `tt-${COUNTRY}-${lower}`,
    title: `#${name}`,
    type: 'Hashtag',
    category,
    region: COUNTRY,
    language: 'EN',
    status,
    growth,
    volume: views || posts,
    viral, fit, reuse,
    source: 'TikTok Creative Center (Apify)',
    url: pick(raw, ['url', 'link']) || `https://www.tiktok.com/tag/${encodeURIComponent(name)}`,
    captured: new Date().toISOString(),
    angle: `美国近 7 天热门话题第 ${rank} 名${posts ? `，${posts.toLocaleString('en-US')} 条帖子` : ''}${prev ? `，昨日第 ${prev} 名` : ''}。`,
    shots: []
  };
}

async function main() {
  fs.mkdirSync(HIST, { recursive: true });
  const prevFile = readJson(OUT, null);
  const prevRanks = new Map();
  (prevFile?.items || []).forEach((it, i) => prevRanks.set(String(it.title).replace(/^#/, '').toLowerCase(), i + 1));

  const base = { region: COUNTRY, source: 'TikTok Creative Center via Apify', note: '评分为内部规则计算，不是 TikTok 官方数据' };
  try {
    if (!TOKEN) throw new Error('缺少 APIFY_TOKEN');
    const budget = await checkBudget();
    const input = {
      adsScrapeHashtags: true, adsScrapeSounds: false, adsScrapeCreators: false, adsScrapeVideos: false,
      adsCountryCode: COUNTRY, adsTimeRange: '7', resultsPerPage: LIMIT
    };
    const { data: run } = await api(`/v2/acts/${ACTOR}/runs?waitForFinish=240&maxItems=${LIMIT}`, { method: 'POST', body: JSON.stringify(input) });
    const rows = run?.defaultDatasetId ? await api(`/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=${LIMIT}`) : [];
    if (!Array.isArray(rows) || !rows.length) {
      let tail = '';
      try { const r = await fetch(`${BASE}/v2/logs/${run.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } }); tail = (await r.text()).trim().split('\n').slice(-15).join('\n'); } catch {}
      console.log(`Apify run ${run?.id} status=${run?.status} message=${run?.statusMessage || ''}\n--- actor log tail ---\n${tail}`);
      throw new Error(`Apify 返回 0 条数据（运行状态：${run?.status || '未知'}${run?.statusMessage ? '，' + String(run.statusMessage).slice(0, 160) : ''}）`);
    }
    fs.writeFileSync(path.join(DATA, 'raw-latest.json'), JSON.stringify(rows.slice(0, 3), null, 2));
    const items = rows.slice(0, LIMIT).map((r, i) => mapItem(r, i, prevRanks)).filter(Boolean);
    if (!items.length) throw new Error('数据字段无法识别，请查看 data/raw-latest.json');
    const out = { ...base, status: 'ok', generatedAt: new Date().toISOString(), error: null, budget: { usedUsd: budget.used, capUsd: budget.cap }, items };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(HIST, `${today()}.json`), JSON.stringify(out, null, 2));
    console.log(`OK: ${items.length} hashtags for ${COUNTRY}; month usage $${budget.used.toFixed(2)}/$${budget.cap.toFixed(2)}`);
  } catch (e) {
    const kept = prevFile?.items || [];
    const out = { ...base, status: 'error', generatedAt: prevFile?.generatedAt || null, error: { message: e.message, at: new Date().toISOString() }, items: kept };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`ERROR (kept ${kept.length} previous items): ${e.message}`);
  }
}
main();
