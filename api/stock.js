// Vercel Serverless Function — fetches Yahoo Finance server-side (no CORS)
// Deploy free at vercel.com — handles all NSE (.NS), BSE (.BO), US stocks

export default async function handler(req, res) {
  // Allow your GitHub Pages domain to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  const { symbol, exchange } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Build Yahoo Finance symbol
  const sym = symbol.toUpperCase();
  const suffix = exchange === 'BSE' ? '.BO' : exchange === 'NSE' ? '.NS' : '';
  const yfSymbol = encodeURIComponent(sym + suffix);

  try {
    // Fetch quote + chart data in parallel
    const [quoteRes, chartRes] = await Promise.all([
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1d&range=1mo`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      ),
      fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfSymbol}?modules=defaultKeyStatistics,financialData,summaryProfile,summaryDetail`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      )
    ]);

    const chartJson = await quoteRes.json();
    const summaryJson = await chartRes.json();

    if (chartJson.chart?.error) throw new Error(chartJson.chart.error.description);

    const meta   = chartJson.chart.result[0].meta;
    const quote  = chartJson.chart.result[0].indicators.quote[0];
    const closes = (quote.close || []).filter(v => v != null);
    const time   = new Date(meta.regularMarketTime * 1000);

    // Extract fundamentals from quoteSummary
    const fin  = summaryJson.quoteSummary?.result?.[0]?.financialData || {};
    const stat  = summaryJson.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
    const prof  = summaryJson.quoteSummary?.result?.[0]?.summaryProfile || {};
    const det   = summaryJson.quoteSummary?.result?.[0]?.summaryDetail || {};

    const pf = (obj, key) => {
      const v = obj?.[key]?.raw ?? obj?.[key];
      return v != null ? parseFloat(parseFloat(v).toFixed(2)) : null;
    };

    res.json({
      ticker:        sym,
      companyName:   meta.longName || meta.shortName || sym,
      exchange:      meta.exchangeName || exchange || 'NSE',
      currency:      meta.currency || 'INR',
      currencySymbol:meta.currency === 'INR' ? '₹' : meta.currency === 'USD' ? '$' : meta.currency,
      price:         pf(meta, 'regularMarketPrice'),
      previousClose: pf(meta, 'chartPreviousClose') || pf(meta, 'previousClose'),
      open:          pf(meta, 'regularMarketOpen'),
      dayHigh:       pf(meta, 'regularMarketDayHigh'),
      dayLow:        pf(meta, 'regularMarketDayLow'),
      weekHigh52:    pf(meta, 'fiftyTwoWeekHigh'),
      weekLow52:     pf(meta, 'fiftyTwoWeekLow'),
      volume:        meta.regularMarketVolume || 0,
      avgVolume:     meta.averageDailyVolume3Month || meta.averageDailyVolume10Day || 0,
      marketCap:     pf(det, 'marketCap'),
      pe:            pf(det, 'trailingPE') || pf(stat, 'trailingPE'),
      eps:           pf(stat, 'trailingEps'),
      pb:            pf(stat, 'priceToBook'),
      beta:          pf(stat, 'beta'),
      dividendYield: pf(det, 'dividendYield'),
      roe:           pf(fin, 'returnOnEquity'),
      debtToEquity:  pf(fin, 'debtToEquity'),
      currentRatio:  pf(fin, 'currentRatio'),
      revenueGrowth: pf(fin, 'revenueGrowth'),
      earningsGrowth:pf(fin, 'earningsGrowth'),
      grossMargins:  pf(fin, 'grossMargins'),
      operatingMargins: pf(fin, 'operatingMargins'),
      sector:        prof.sector || null,
      industry:      prof.industry || null,
      website:       prof.website || null,
      employees:     prof.fullTimeEmployees || null,
      description:   prof.longBusinessSummary || null,
      priceHistory:  closes.slice(-30),
      priceDate:     time.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }),
      dataSource:    'Yahoo Finance',
      fetchedAt:     new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
