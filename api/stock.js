/**
 * StockSage Pro — Vercel Serverless API
 * Multi-source fundamentals, derived ratios, full 1Y history
 * CommonJS — zero config Vercel deployment
 */
'use strict';

const cache = new Map();
const CACHE_TTL = 60000;

// Safe numeric extractor — handles Yahoo's {raw,fmt} objects and plain values
function n(obj, key, fb = null) {
  if (!obj || obj[key] == null) return fb;
  const v   = obj[key];
  const raw = (typeof v === 'object' && v !== null) ? v.raw : v;
  if (raw == null) return fb;
  const num = Number(raw);
  return (isNaN(num) || !isFinite(num)) ? fb : parseFloat(num.toFixed(8));
}

// Return first non-null finite value
function pick(...vals) {
  for (const v of vals) {
    if (v != null && !isNaN(v) && isFinite(v) && v !== 0) return v;
  }
  return null;
}

function fmtLarge(v, currency) {
  if (!v || isNaN(v)) return null;
  if (currency === 'INR') {
    const cr = v / 1e7;
    if (cr >= 1e5) return (cr / 1e5).toFixed(2) + 'L Cr';
    if (cr >= 1e3) return (cr / 1e3).toFixed(2) + 'K Cr';
    return cr.toFixed(2) + ' Cr';
  }
  if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9)  return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return (v / 1e6).toFixed(2) + 'M';
  return v.toLocaleString();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.json(cached.data);
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const validRanges = ['1d','5d','1mo','3mo','6mo','1y','2y','5y'];
  const validIntvls = ['1m','5m','15m','1h','1d','1wk','1mo'];
  const safeRange   = validRanges.includes(range)    ? range    : '1y';
  const safeIntvl   = validIntvls.includes(interval) ? interval : '1d';

  const MODULES = [
    'defaultKeyStatistics', 'financialData', 'summaryProfile',
    'summaryDetail', 'price',
    'incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory',
  ].join(',');

  try {
    const [chartRes, summaryRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?interval=${safeIntvl}&range=${safeRange}&includePrePost=false`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfSym}?modules=${MODULES}`, { headers }),
    ]);

    if (!chartRes.ok) throw new Error(`Yahoo Finance HTTP ${chartRes.status} for ${sym}`);
    const chartJson   = await chartRes.json();
    const summaryJson = summaryRes.ok ? await summaryRes.json() : {};

    if (chartJson.chart?.error) throw new Error(chartJson.chart.error.description || 'Yahoo chart error');
    if (!chartJson.chart?.result?.[0]) throw new Error(`No data found for ${sym}`);

    const meta   = chartJson.chart.result[0].meta || {};
    const q      = chartJson.chart.result[0].indicators?.quote?.[0] || {};
    const stamps = chartJson.chart.result[0].timestamp || [];

    const mapArr = (arr, fn) => (arr || []).map(v => v != null ? fn(v) : null);
    const closes  = mapArr(q.close,  v => +parseFloat(v).toFixed(4));
    const opens   = mapArr(q.open,   v => +parseFloat(v).toFixed(4));
    const highs   = mapArr(q.high,   v => +parseFloat(v).toFixed(4));
    const lows    = mapArr(q.low,    v => +parseFloat(v).toFixed(4));
    const volumes = mapArr(q.volume, v => Math.round(v));

    const trimArr = arr => {
      const last = arr.reduceRight((a, v, i) => a === -1 && v != null ? i : a, -1);
      return last === -1 ? [] : arr.slice(0, last + 1);
    };

    const cc = trimArr(closes);
    const ch = trimArr(highs);
    const cl = trimArr(lows);
    const cv = trimArr(volumes);

    // Previous close = second-to-last candle (accurate)
    const prevClose = cc.length >= 2
      ? +cc[cc.length - 2].toFixed(2)
      : (n(meta, 'chartPreviousClose') || n(meta, 'previousClose'));

    const ohlcv = stamps
      .map((ts, i) => ({ t: ts * 1000, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] }))
      .filter(b => b.c != null);

    const qr  = summaryJson.quoteSummary?.result?.[0] || {};
    const fin = qr.financialData        || {};
    const sta = qr.defaultKeyStatistics || {};
    const pro = qr.summaryProfile       || {};
    const det = qr.summaryDetail        || {};
    const pr  = qr.price                || {};
    const inc = qr.incomeStatementHistory?.incomeStatementHistory?.[0] || {};
    const bal = qr.balanceSheetHistory?.balanceSheetStatements?.[0]   || {};
    const cf  = qr.cashflowStatementHistory?.cashflowStatements?.[0]  || {};

    const currency       = meta.currency || pr.currency || 'INR';
    const currencySymbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency;
    const priceNow       = n(meta, 'regularMarketPrice');

    // Derived fundamentals
    const netIncome   = n(fin, 'netIncomeToCommon') || n(inc, 'netIncome');
    const totalRev    = n(fin, 'totalRevenue');
    const totalEq     = n(bal, 'totalStockholderEquity') || n(bal, 'stockholdersEquity');
    const totalAssets = n(bal, 'totalAssets');
    const grossProfit = n(inc, 'grossProfit');
    const opIncome    = n(inc, 'operatingIncome') || n(inc, 'ebit');
    const shares      = n(sta, 'sharesOutstanding') || n(pr, 'sharesOutstanding');
    const bookVal     = n(sta, 'bookValue');
    const mcapRaw     = pick(n(pr, 'marketCap'), n(det, 'marketCap'), n(sta, 'marketCap'));

    // Smart multi-source fundamentals
    const eps = pick(n(sta, 'trailingEps'), shares && netIncome ? netIncome / shares : null);
    const pe  = pick(n(det, 'trailingPE'), n(sta, 'trailingPE'), n(pr, 'trailingPE'), eps && priceNow ? priceNow / eps : null);
    const pb  = pick(n(sta, 'priceToBook'), bookVal && priceNow ? priceNow / bookVal : null);
    const ps  = pick(n(sta, 'priceToSalesTrailing12Months'), mcapRaw && totalRev ? mcapRaw / totalRev : null);
    const roe = pick(n(fin, 'returnOnEquity'), totalEq && netIncome ? netIncome / totalEq : null);
    const roa = pick(n(fin, 'returnOnAssets'), totalAssets && netIncome ? netIncome / totalAssets : null);
    const grossMargins    = pick(n(fin, 'grossMargins'),    totalRev && grossProfit ? grossProfit / totalRev : null);
    const operatingMargins= pick(n(fin, 'operatingMargins'),totalRev && opIncome   ? opIncome    / totalRev : null);
    const profitMargins   = pick(n(fin, 'profitMargins'),   n(sta, 'profitMargins'), totalRev && netIncome ? netIncome / totalRev : null);
    const debtToEq = pick(n(fin, 'debtToEquity'),
      n(bal,'longTermDebt') && totalEq ? n(bal,'longTermDebt') / totalEq : null);
    const currRatio = pick(n(fin, 'currentRatio'),
      n(bal,'totalCurrentAssets') && n(bal,'totalCurrentLiabilities') && n(bal,'totalCurrentLiabilities') !== 0
        ? n(bal,'totalCurrentAssets') / n(bal,'totalCurrentLiabilities') : null);
    const fcf = pick(n(fin, 'freeCashflow'),
      n(cf,'totalCashFromOperatingActivities') != null && n(cf,'capitalExpenditures') != null
        ? n(cf,'totalCashFromOperatingActivities') + n(cf,'capitalExpenditures')
        : null);

    const priceTime = new Date((meta.regularMarketTime || Date.now() / 1000) * 1000);

    const data = {
      ticker:      sym,
      companyName: meta.longName || meta.shortName || pr.longName || pr.shortName || sym,
      exchange:    meta.exchangeName || exchange || 'NSE',
      currency,    currencySymbol,
      sector:      pro.sector   || null,
      industry:    pro.industry || null,
      website:     pro.website  || null,
      employees:   pro.fullTimeEmployees || null,
      description: pro.longBusinessSummary ? pro.longBusinessSummary.slice(0, 500) : null,
      country:     pro.country  || null,

      price:        priceNow,
      previousClose: prevClose,
      open:         n(meta, 'regularMarketOpen'),
      dayHigh:      n(meta, 'regularMarketDayHigh'),
      dayLow:       n(meta, 'regularMarketDayLow'),
      weekHigh52:   n(meta, 'fiftyTwoWeekHigh'),
      weekLow52:    n(meta, 'fiftyTwoWeekLow'),
      volume:       meta.regularMarketVolume || 0,
      avgVolume:    meta.averageDailyVolume3Month || meta.averageDailyVolume10Day || 0,
      priceDate:    priceTime.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      priceTime:    priceTime.toISOString(),

      marketCap:        mcapRaw,
      marketCapFmt:     fmtLarge(mcapRaw, currency),
      pe,               forwardPE:    n(sta, 'forwardPE'),
      eps,              pb,           ps,
      peg:              n(sta, 'pegRatio'),
      bookValue:        bookVal,
      dividendYield:    pick(n(det, 'dividendYield'), n(sta, 'dividendYield')),
      dividendRate:     n(det, 'dividendRate'),
      beta:             pick(n(sta, 'beta'), n(det, 'beta')),
      roe,              roa,
      grossMargins,     operatingMargins,     profitMargins,
      debtToEquity:     debtToEq,
      currentRatio:     currRatio,
      quickRatio:       n(fin, 'quickRatio'),
      revenueGrowth:    n(fin, 'revenueGrowth'),
      earningsGrowth:   n(fin, 'earningsGrowth'),
      totalRevenue:     totalRev,
      totalRevenueFmt:  fmtLarge(totalRev, currency),
      netIncome,
      netIncomeFmt:     fmtLarge(netIncome, currency),
      freeCashflow:     fcf,
      freeCashflowFmt:  fmtLarge(fcf, currency),
      totalDebt:        pick(n(fin, 'totalDebt'), n(bal, 'longTermDebt')),
      totalCash:        n(fin, 'totalCash'),
      sharesOutstanding: shares,
      enterpriseValue:  n(sta, 'enterpriseValue'),
      evToRevenue:      n(sta, 'enterpriseToRevenue'),
      evToEbitda:       n(sta, 'enterpriseToEbitda'),

      ohlcv, closes: cc, highs: ch, lows: cl, volumes: cv,
      dataSource: 'Yahoo Finance', range: safeRange, interval: safeIntvl,
      fetchedAt:  new Date().toISOString(),
    };

    cache.set(cacheKey, { ts: Date.now(), data });
    if (cache.size > 200) {
      [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 50).forEach(([k]) => cache.delete(k));
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.json(data);

  } catch (err) {
    console.error(`[StockSage API] ${sym}:`, err.message);
    return res.status(500).json({ error: err.message, symbol: sym });
  }
};
