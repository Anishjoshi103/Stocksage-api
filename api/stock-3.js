/**
 * StockSage Pro — Vercel Serverless API v2
 * Full structured response with price, fundamentals, history
 */
'use strict';

const cache = new Map();
const CACHE_TTL = 60000;

function n(obj, key, fb = null) {
  if (!obj) return fb;
  const v = obj[key];
  if (v == null) return fb;
  const raw = typeof v === 'object' ? v.raw : v;
  if (raw == null || isNaN(Number(raw))) return fb;
  return parseFloat(Number(raw).toFixed(6));
}

function fmtCap(v, currency) {
  if (!v || isNaN(v)) return null;
  if (currency === 'INR') {
    const cr = v / 1e7;
    if (cr >= 1e5) return (cr/1e5).toFixed(2) + 'L Cr';
    if (cr >= 1e3) return (cr/1e3).toFixed(2) + 'K Cr';
    return cr.toFixed(2) + ' Cr';
  }
  if (v >= 1e12) return (v/1e12).toFixed(2) + 'T';
  if (v >= 1e9)  return (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return (v/1e6).toFixed(2) + 'M';
  return v.toString();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, exchange, range = '1y', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  const sym      = symbol.toUpperCase().trim();
  const suffix   = exchange === 'BSE' ? '.BO' : exchange === 'NSE' ? '.NS' : '';
  const yfSym    = encodeURIComponent(sym + suffix);
  const cacheKey = `${yfSym}:${range}:${interval}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached.data);
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const validRanges    = ['1d','5d','1mo','3mo','6mo','1y','2y','5y'];
  const validIntervals = ['1m','5m','15m','1h','1d','1wk','1mo'];
  const safeRange    = validRanges.includes(range)    ? range    : '1y';
  const safeInterval = validIntervals.includes(interval) ? interval : '1d';

  try {
    const [chartRes, summaryRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?interval=${safeInterval}&range=${safeRange}&includePrePost=false`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfSym}?modules=defaultKeyStatistics,financialData,summaryProfile,summaryDetail,price`, { headers })
    ]);

    if (!chartRes.ok) throw new Error(`Chart HTTP ${chartRes.status}`);
    const chartJson   = await chartRes.json();
    const summaryJson = summaryRes.ok ? await summaryRes.json() : {};

    if (chartJson.chart?.error) throw new Error(chartJson.chart.error.description);
    if (!chartJson.chart?.result?.[0]) throw new Error('No data returned');

    const meta   = chartJson.chart.result[0].meta;
    const q      = chartJson.chart.result[0].indicators.quote[0] || {};
    const stamps = chartJson.chart.result[0].timestamp || [];

    const closes  = (q.close  || []).map(v => v != null ? +v.toFixed(4) : null);
    const opens   = (q.open   || []).map(v => v != null ? +v.toFixed(4) : null);
    const highs   = (q.high   || []).map(v => v != null ? +v.toFixed(4) : null);
    const lows    = (q.low    || []).map(v => v != null ? +v.toFixed(4) : null);
    const volumes = (q.volume || []).map(v => v != null ? +v : null);

    const clean = arr => {
      const last = arr.reduceRight((acc,v,i) => acc===-1 && v!=null ? i : acc, -1);
      return last === -1 ? [] : arr.slice(0, last+1);
    };
    const cc = clean(closes);
    const ch = clean(highs);
    const cl = clean(lows);
    const cv = clean(volumes);

    // Previous close from history (more accurate)
    const prevClose = cc.length >= 2 ? cc[cc.length-2] :
      (n(meta,'chartPreviousClose') || n(meta,'previousClose'));

    const ohlcv = stamps.map((ts,i) => ({
      t: ts*1000, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i]
    })).filter(b => b.c != null);

    const qr   = summaryJson.quoteSummary?.result?.[0] || {};
    const fin  = qr.financialData        || {};
    const stat = qr.defaultKeyStatistics || {};
    const prof = qr.summaryProfile       || {};
    const det  = qr.summaryDetail        || {};
    const pr   = qr.price                || {};

    const currency = meta.currency || pr.currency || 'INR';
    const sym2     = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency;
    const mcap     = n(pr,'marketCap') || n(det,'marketCap') || n(stat,'marketCap');
    const priceTime = new Date((meta.regularMarketTime || Date.now()/1000)*1000);

    const data = {
      ticker: sym,
      companyName: meta.longName || meta.shortName || pr.longName || sym,
      exchange: meta.exchangeName || exchange || 'NSE',
      currency, currencySymbol: sym2,
      sector: prof.sector || null,
      industry: prof.industry || null,
      website: prof.website || null,
      employees: prof.fullTimeEmployees || null,
      description: prof.longBusinessSummary ? prof.longBusinessSummary.slice(0,400) : null,
      country: prof.country || null,

      // Price
      price:        n(meta,'regularMarketPrice'),
      previousClose: prevClose ? +prevClose.toFixed(2) : null,
      open:         n(meta,'regularMarketOpen'),
      dayHigh:      n(meta,'regularMarketDayHigh'),
      dayLow:       n(meta,'regularMarketDayLow'),
      weekHigh52:   n(meta,'fiftyTwoWeekHigh'),
      weekLow52:    n(meta,'fiftyTwoWeekLow'),
      volume:       meta.regularMarketVolume || 0,
      avgVolume:    meta.averageDailyVolume3Month || meta.averageDailyVolume10Day || 0,
      priceDate:    priceTime.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),
      priceTime:    priceTime.toISOString(),

      // Fundamentals
      marketCap: mcap, marketCapFmt: fmtCap(mcap, currency),
      pe:        n(det,'trailingPE') || n(stat,'trailingPE') || n(pr,'trailingPE'),
      forwardPE: n(stat,'forwardPE'),
      eps:       n(stat,'trailingEps'),
      pb:        n(stat,'priceToBook'),
      ps:        n(stat,'priceToSalesTrailing12Months'),
      peg:       n(stat,'pegRatio'),
      dividendYield: n(det,'dividendYield') || n(stat,'dividendYield'),
      dividendRate:  n(det,'dividendRate'),
      beta:          n(stat,'beta') || n(det,'beta'),
      roe:           n(fin,'returnOnEquity'),
      roa:           n(fin,'returnOnAssets'),
      debtToEquity:  n(fin,'debtToEquity'),
      currentRatio:  n(fin,'currentRatio'),
      quickRatio:    n(fin,'quickRatio'),
      revenueGrowth: n(fin,'revenueGrowth'),
      earningsGrowth:n(fin,'earningsGrowth'),
      grossMargins:  n(fin,'grossMargins'),
      operatingMargins: n(fin,'operatingMargins'),
      profitMargins: n(fin,'profitMargins') || n(stat,'profitMargins'),
      totalRevenue:  n(fin,'totalRevenue'),
      freeCashflow:  n(fin,'freeCashflow'),
      totalDebt:     n(fin,'totalDebt'),
      sharesOutstanding: n(stat,'sharesOutstanding'),

      // History
      ohlcv, closes: cc, highs: ch, lows: cl, volumes: cv,

      // Meta
      dataSource: 'Yahoo Finance', range: safeRange, interval: safeInterval,
      fetchedAt: new Date().toISOString()
    };

    cache.set(cacheKey, { ts: Date.now(), data });
    if (cache.size > 200) {
      [...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts).slice(0,50).forEach(([k])=>cache.delete(k));
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.json(data);

  } catch(err) {
    return res.status(500).json({ error: err.message, symbol: sym });
  }
};
