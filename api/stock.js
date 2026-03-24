// Vercel Serverless Function — fetches Yahoo Finance server-side (no CORS)
// CommonJS format — works on Vercel with zero config

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, exchange } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase();
  const suffix = exchange === 'BSE' ? '.BO' : exchange === 'NSE' ? '.NS' : '';
  const yfSymbol = encodeURIComponent(sym + suffix);
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

  try {
    const [chartRes, summaryRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1d&range=3mo`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfSymbol}?modules=defaultKeyStatistics,financialData,summaryProfile,summaryDetail,recommendationTrend,topHoldings`, { headers })
    ]);

    const chartJson   = await chartRes.json();
    const summaryJson = await summaryRes.json();

    if (chartJson.chart?.error) throw new Error(chartJson.chart.error.description);

    const meta   = chartJson.chart.result[0].meta;
    const quote  = chartJson.chart.result[0].indicators.quote[0];
    const closes = (quote.close || []).filter(v => v != null);

    const fin  = summaryJson.quoteSummary?.result?.[0]?.financialData || {};
    const stat = summaryJson.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
    const prof = summaryJson.quoteSummary?.result?.[0]?.summaryProfile || {};
    const det  = summaryJson.quoteSummary?.result?.[0]?.summaryDetail || {};

    const r = (obj, key) => {
      const v = obj?.[key]?.raw ?? obj?.[key];
      return (v != null && !isNaN(v)) ? parseFloat(parseFloat(v).toFixed(4)) : null;
    };

    const time = new Date(meta.regularMarketTime * 1000);

    res.json({
      ticker:         sym,
      companyName:    meta.longName || meta.shortName || sym,
      exchange:       meta.exchangeName || exchange || 'NSE',
      currency:       meta.currency || 'INR',
      currencySymbol: meta.currency === 'INR' ? '₹' : meta.currency === 'USD' ? '$' : meta.currency || '₹',
      price:          r(meta, 'regularMarketPrice'),
      previousClose:  r(meta, 'chartPreviousClose') || r(meta, 'previousClose'),
      open:           r(meta, 'regularMarketOpen'),
      dayHigh:        r(meta, 'regularMarketDayHigh'),
      dayLow:         r(meta, 'regularMarketDayLow'),
      weekHigh52:     r(meta, 'fiftyTwoWeekHigh'),
      weekLow52:      r(meta, 'fiftyTwoWeekLow'),
      volume:         meta.regularMarketVolume || 0,
      avgVolume:      meta.averageDailyVolume3Month || meta.averageDailyVolume10Day || 0,
      marketCap:      r(det, 'marketCap'),
      pe:             r(det, 'trailingPE') || r(stat, 'trailingPE'),
      eps:            r(stat, 'trailingEps'),
      pb:             r(stat, 'priceToBook'),
      beta:           r(stat, 'beta'),
      dividendYield:  r(det, 'dividendYield'),
      roe:            r(fin, 'returnOnEquity'),
      debtToEquity:   r(fin, 'debtToEquity'),
      currentRatio:   r(fin, 'currentRatio'),
      revenueGrowth:  r(fin, 'revenueGrowth'),
      earningsGrowth: r(fin, 'earningsGrowth'),
      grossMargins:   r(fin, 'grossMargins'),
      operatingMargins: r(fin, 'operatingMargins'),
      sector:         prof.sector || null,
      industry:       prof.industry || null,
      website:        prof.website || null,
      employees:      prof.fullTimeEmployees || null,
      description:    (prof.longBusinessSummary || '').slice(0, 300) || null,
      priceHistory:   closes.slice(-30),
      priceDate:      time.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }),
      dataSource:     'Yahoo Finance'
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
