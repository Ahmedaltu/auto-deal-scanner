/**
 * Auto Deal Scanner — content.js
 * Runs on all nettiauto.com pages.
 * - On listing pages: injects full deal analysis panel
 * - On search results pages: injects mini cost badges on each card
 */

(function () {
  'use strict';

  // ── Utilities ──────────────────────────────────────────────────────────────

  function extractNumber(text) {
    if (!text) return null;
    const cleaned = text
      .replace(/\s/g, '')
      .replace(/\u00a0/g, '')
      .replace(',', '.')
      .replace(/[^\d.]/g, '');
    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
  }

  function formatEur(val, decimals = 0) {
    if (val == null) return '—';
    return '€' + val.toLocaleString('fi-FI', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function formatPct(val) {
    if (val == null) return '—';
    return val.toFixed(2) + '%';
  }

  // ── Finance Math ───────────────────────────────────────────────────────────

  function computeDeal({ price, downPayment, termMonths, nominalRatePct, monthlyFee, openingFee, balloon, monthlyPaymentGiven }) {
    const principal = price - downPayment;
    const monthlyRate = nominalRatePct / 100 / 12;

    let monthlyPayment;
    if (monthlyPaymentGiven && monthlyPaymentGiven > 0) {
      monthlyPayment = monthlyPaymentGiven;
    } else {
      if (termMonths <= 0) return null;
      if (monthlyRate === 0) {
        monthlyPayment = balloon > 0
          ? (principal - balloon) / termMonths
          : principal / termMonths;
      } else {
        const pvBalloon = balloon > 0 ? balloon / Math.pow(1 + monthlyRate, termMonths) : 0;
        const adj = principal - pvBalloon;
        monthlyPayment = adj * (monthlyRate * Math.pow(1 + monthlyRate, termMonths))
          / (Math.pow(1 + monthlyRate, termMonths) - 1);
      }
    }

    const totalMonthly = monthlyPayment + monthlyFee;
    const totalPaid = downPayment + openingFee + totalMonthly * termMonths + balloon;
    const totalInterest = totalPaid - price;
    const apr = solveAPR(principal, monthlyPayment, monthlyFee, termMonths, balloon, openingFee);

    return {
      monthlyPayment: Math.round(monthlyPayment * 100) / 100,
      totalMonthlyWithFee: Math.round(totalMonthly * 100) / 100,
      totalPaid: Math.round(totalPaid),
      totalInterest: Math.round(totalInterest),
      apr: apr != null ? Math.round(apr * 10000) / 100 : null
    };
  }

  function solveAPR(principal, monthlyPayment, monthlyFee, termMonths, balloon, openingFee) {
    const pv = principal - openingFee;
    const payment = monthlyPayment + monthlyFee;

    function f(r) {
      if (Math.abs(r) < 1e-10) return pv - payment * termMonths - balloon;
      let sum = 0;
      for (let t = 1; t <= termMonths; t++) sum += payment / Math.pow(1 + r, t);
      return sum + balloon / Math.pow(1 + r, termMonths) - pv;
    }

    function df(r) {
      if (Math.abs(r) < 1e-10) {
        let s = 0;
        for (let t = 1; t <= termMonths; t++) s -= t * payment;
        return s - termMonths * balloon;
      }
      let s = 0;
      for (let t = 1; t <= termMonths; t++) s -= t * payment / Math.pow(1 + r, t + 1);
      return s - termMonths * balloon / Math.pow(1 + r, termMonths + 1);
    }

    let r = 0.005;
    for (let i = 0; i < 100; i++) {
      const fr = f(r), dfr = df(r);
      if (Math.abs(dfr) < 1e-12) break;
      const rNew = r - fr / dfr;
      if (Math.abs(rNew - r) < 1e-10) { r = rNew; break; }
      r = rNew;
      if (r < -0.999) r = 0.001;
    }
    return r * 12;
  }

  function getVerdict(totalInterest, price) {
    const ratio = price > 0 ? totalInterest / price : 0;
    if (ratio < 0.08) return { label: 'Erinomainen', labelEn: 'Excellent', color: '#22c55e', bg: '#052e16' };
    if (ratio < 0.15) return { label: 'Hyvä', labelEn: 'Good', color: '#60a5fa', bg: '#0c1a2e' };
    if (ratio < 0.25) return { label: 'Kohtalainen', labelEn: 'Average', color: '#f59e0b', bg: '#1c1000' };
    return { label: 'Kallis', labelEn: 'Expensive', color: '#ef4444', bg: '#1c0000' };
  }

  // ── DOM Parser ─────────────────────────────────────────────────────────────

  function parseListingPage() {
    // IMPORTANT: exclude our own injected panel from parsing to avoid reading our own output
    const panel = document.getElementById('ads-panel');
    const clone = document.body.cloneNode(true);
    const panelClone = clone.querySelector('#ads-panel');
    if (panelClone) panelClone.remove();

    // Normalize non-breaking spaces to regular spaces
    const text = clone.innerText.replace(/\u00a0/g, ' ');

    function findFirst(patterns) {
      for (const pat of patterns) {
        const match = text.match(pat);
        if (match) {
          const num = extractNumber(match[1] || match[0]);
          if (num && num > 0) return num;
        }
      }
      return null;
    }

    // Price — use direct DOM selector (reliable)
    let price = null;
    const priceEl = document.querySelector('[class*="price"]:not([class*="Price"])');
    if (priceEl) {
      price = extractNumber(priceEl.innerText);
    }
    // Fallback: meta tag
    if (!price) {
      const metaPrice = document.querySelector('meta[property="product:price:amount"]');
      if (metaPrice) price = parseFloat(metaPrice.content);
    }
    // Last resort: find €-amounts in text, filter to realistic car price range 2000-150000
    if (!price) {
      const allAmounts = [...text.matchAll(/([\d][\d\s]{2,6})\s*€/g)]
        .map(m => extractNumber(m[1]))
        .filter(v => v && v >= 2000 && v < 150000);
      if (allAmounts.length) price = Math.min(...allAmounts);
    }

    // Monthly payment — use direct DOM selector (class*="Price" has "alk. 255,86 €/kk")
    let monthly = null;
    const monthlyEl = document.querySelector('[class*="Price"]');
    if (monthlyEl) {
      const monthlyText = monthlyEl.innerText;
      const m = monthlyText.match(/([\d\s,]+)\s*€/);
      if (m) {
        const val = extractNumber(m[1]);
        if (val && val >= 50 && val <= 5000) monthly = val;
      }
    }
    // Fallback: regex on page text
    if (!monthly) {
      const monthlyPatterns = [
        /[Kk]uukausier[äa][:\s]*([\d\s,]+)\s*€/g,
        /[Kk]uukausimaksu[:\s]*([\d\s,]+)\s*€/g,
        /([\d\s,]+)\s*€\s*\/\s*kk/g,
      ];
      for (const pat of monthlyPatterns) {
        for (const match of text.matchAll(pat)) {
          const val = extractNumber(match[1]);
          if (val && val >= 50 && val <= 5000) { monthly = val; break; }
        }
        if (monthly) break;
      }
    }

    // Term — financing terms are 24-84 months, pick most frequent in that range
    const termMatches = [...text.matchAll(/(\d+)\s*kk/gi)].map(m => parseInt(m[1]));
    const validTerms = termMatches.filter(t => t >= 24 && t <= 84);
    const term = validTerms.length
      ? validTerms.sort((a, b) =>
          validTerms.filter(v => v === b).length - validTerms.filter(v => v === a).length
        )[0]
      : 60;

    // Interest rate — Nettiauto writes "2,99%" or "Korko 2,99 %"
    // Must NOT match our own injected APR — exclude patterns near "vuosikorko" label
    const rateMatch =
      text.match(/[Kk]orko\s*([\d,\.]+)\s*%/) ||
      text.match(/([\d,\.]+)\s*%[*\s]*korko/i) ||
      text.match(/rahoitus(?:korko)?[:\s]*([\d,\.]+)\s*%/i);
    const rate = rateMatch ? parseFloat(rateMatch[1].replace(',', '.')) : null;

    // Monthly fee
    const feeMatch = text.match(/(?:hoitomaksu|k[äa]sittelymaksu|tilinhoitomaksu)[:\s]*([\d,\.]+)\s*€/i);
    const monthlyFee = feeMatch ? extractNumber(feeMatch[1]) : 0;

    // Opening fee
    const openMatch = text.match(/(?:avausmaksu|aloitusmaksu|j[äa]rjestelymaksu)[:\s]*([\d,\.]+)\s*€/i);
    const openingFee = openMatch ? extractNumber(openMatch[1]) : 0;

    // Balloon
    const balloonMatch = text.match(/(?:j[äa][äa]nn[oö]sarvo|loppuer[äa])[:\s]*([\d\s,]+)\s*€/i);
    const balloon = balloonMatch ? extractNumber(balloonMatch[1]) : 0;

    // Down payment
    const downMatch = text.match(/k[äa]siraha[:\s]*([\d\s,]+)\s*€/i);
    const downPayment = downMatch ? extractNumber(downMatch[1]) : 0;

    // Car name — from h1, not from clone (h1 is safe)
    const h1 = document.querySelector('h1');
    const name = h1 ? h1.innerText.trim() : document.title;

    return {
      name,
      price,
      downPayment: downPayment || 0,
      termMonths: term,
      nominalRatePct: rate,
      monthlyFee: monthlyFee || 0,
      openingFee: openingFee || 0,
      balloon: balloon || 0,
      monthlyPaymentGiven: monthly
    };
  }

  // ── Panel injection (listing page) ─────────────────────────────────────────

  function isListingPage() {
    return /nettiauto\.com\/[^/]+\/[^/]+\/\d+/.test(location.href)
      || /nettiauto\.com\/auto\//.test(location.href);
  }

  function isSearchPage() {
    return /nettiauto\.com\/?(\?|$|[a-z-]+\/?\?)/.test(location.href)
      && !isListingPage();
  }

  function injectPanel(data, deal) {
    if (document.getElementById('ads-panel')) return;

    const verdict = getVerdict(deal.totalInterest, data.price);
    const usedRate = data.nominalRatePct || 4.0;
    const rateNote = data.nominalRatePct ? '' : ' <span class="ads-note">(oletus 4%)</span>';

    const panel = document.createElement('div');
    panel.id = 'ads-panel';
    panel.innerHTML = `
      <div class="ads-header">
        <div class="ads-logo">
          <span class="ads-logo-icon">🔍</span>
          <span class="ads-logo-text">Auto Deal Scanner</span>
        </div>
        <div class="ads-verdict" style="background:${verdict.bg}; color:${verdict.color};">
          ${verdict.label}
        </div>
        <button class="ads-toggle" id="ads-toggle-btn" title="Pienennä/suurenna">▲</button>
      </div>

      <div class="ads-body" id="ads-body">
        <div class="ads-grid">
          <div class="ads-stat">
            <div class="ads-stat-label">Listahinta</div>
            <div class="ads-stat-value">${formatEur(data.price)}</div>
          </div>
          <div class="ads-stat ads-stat-highlight">
            <div class="ads-stat-label">Maksat yhteensä</div>
            <div class="ads-stat-value" style="color:#ef4444">${formatEur(deal.totalPaid)}</div>
          </div>
          <div class="ads-stat">
            <div class="ads-stat-label">Korko + kulut</div>
            <div class="ads-stat-value" style="color:#f59e0b">${formatEur(deal.totalInterest)}</div>
          </div>
          <div class="ads-stat">
            <div class="ads-stat-label">Kuukausierä</div>
            <div class="ads-stat-value" style="color:#60a5fa">${formatEur(deal.totalMonthlyWithFee, 0)}</div>
          </div>
          <div class="ads-stat">
            <div class="ads-stat-label">Tod. vuosikorko</div>
            <div class="ads-stat-value" style="color:#a78bfa">${formatPct(deal.apr)}</div>
          </div>
          <div class="ads-stat">
            <div class="ads-stat-label">Laina-aika</div>
            <div class="ads-stat-value">${data.termMonths} kk</div>
          </div>
        </div>

        <div class="ads-divider"></div>

        <div class="ads-details">
          <div class="ads-detail-row">
            <span class="ads-detail-label">Nimelliskorko${rateNote}</span>
            <span class="ads-detail-value">${usedRate}%</span>
          </div>
          <div class="ads-detail-row">
            <span class="ads-detail-label">Käsiraha</span>
            <span class="ads-detail-value">${formatEur(data.downPayment)}</span>
          </div>
          <div class="ads-detail-row">
            <span class="ads-detail-label">Kuukausimaksu (pohja)</span>
            <span class="ads-detail-value">${formatEur(deal.monthlyPayment, 2)}</span>
          </div>
          <div class="ads-detail-row">
            <span class="ads-detail-label">+ Hoitomaksu/kk</span>
            <span class="ads-detail-value">${formatEur(data.monthlyFee, 2)}</span>
          </div>
          <div class="ads-detail-row">
            <span class="ads-detail-label">Avausmaksu</span>
            <span class="ads-detail-value">${formatEur(data.openingFee)}</span>
          </div>
          <div class="ads-detail-row">
            <span class="ads-detail-label">Jäännösarvo</span>
            <span class="ads-detail-value">${formatEur(data.balloon)}</span>
          </div>
          <div class="ads-detail-row ads-detail-total">
            <span class="ads-detail-label">Ylimaksu vs. listahinta</span>
            <span class="ads-detail-value" style="color:${verdict.color}">
              ${formatEur(deal.totalInterest)} (${data.price > 0 ? ((deal.totalInterest / data.price) * 100).toFixed(1) : 0}%)
            </span>
          </div>
        </div>

        ${!data.nominalRatePct ? `
        <div class="ads-warning">
          ⚠️ Korko ei näkynyt sivulla — laskelma käyttää oletusta 4%. Tarkista rahoitustarjous.
        </div>` : ''}

        <div class="ads-footer">
          Auto Deal Scanner · ilmainen · <a href="https://github.com/Ahmedaltu/auto-deal-scanner" target="_blank">GitHub</a>
        </div>
      </div>
    `;

    // Toggle collapse
    panel.querySelector('#ads-toggle-btn').addEventListener('click', () => {
      const body = document.getElementById('ads-body');
      const btn = document.getElementById('ads-toggle-btn');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      btn.textContent = collapsed ? '▲' : '▼';
    });

    // Insert after first h1 or at top of main content
    const target = document.querySelector('h1')?.parentElement
      || document.querySelector('main, article, #content, .content')
      || document.body;

    const h1 = document.querySelector('h1');
    if (h1 && h1.parentElement) {
      h1.parentElement.insertBefore(panel, h1.nextSibling);
    } else {
      target.prepend(panel);
    }
  }

  // ── Search results badges ──────────────────────────────────────────────────

  function injectSearchBadges() {
    // Wait for cards to appear
    const observer = new MutationObserver(() => {
      procesSearchCards();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(procesSearchCards, 1500);
  }

  function procesSearchCards() {
    // Nettiauto search result cards — try common selectors
    const cards = document.querySelectorAll([
      '.car-list-item',
      '.listing-item',
      '.result-item',
      '[class*="car-item"]',
      '[class*="listing-card"]',
      '[class*="result-card"]',
      'article',
    ].join(','));

    cards.forEach(card => {
      if (card.dataset.adsProcessed) return;
      card.dataset.adsProcessed = '1';

      const text = card.innerText;

      // Extract price from card
      const priceMatch = text.match(/(\d[\d\s]{2,6})\s*€/);
      const price = priceMatch ? extractNumber(priceMatch[1]) : null;
      if (!price || price < 500) return;

      // Extract monthly if shown
      const monthlyMatch = text.match(/(\d[\d\s,]+)\s*€\s*\/\s*kk/i)
        || text.match(/[Kk]uukausier[äa]\s*(\d[\d\s,]+)\s*€/i);
      const monthly = monthlyMatch ? extractNumber(monthlyMatch[1]) : null;

      // Quick estimate: assume 4%, 60 months, no fees
      const deal = computeDeal({
        price,
        downPayment: 0,
        termMonths: 60,
        nominalRatePct: 4.0,
        monthlyFee: 0,
        openingFee: 0,
        balloon: 0,
        monthlyPaymentGiven: monthly
      });
      if (!deal) return;

      const verdict = getVerdict(deal.totalInterest, price);

      const badge = document.createElement('div');
      badge.className = 'ads-badge';
      badge.innerHTML = `
        <span class="ads-badge-label" style="color:${verdict.color}; border-color:${verdict.color}20; background:${verdict.bg}">
          ~${formatEur(deal.totalPaid)} yhteensä · ${verdict.label}
        </span>
      `;
      card.style.position = 'relative';
      card.appendChild(badge);
    });
  }

  // ── MutationObserver for async financing fields ────────────────────────────

  function waitForFinancingData(callback, timeout = 5000) {
    const start = Date.now();
    const observer = new MutationObserver(() => {
      const text = document.body.innerText;
      // Check if financing section has loaded
      if (/kk|kuukausier|korko/i.test(text)) {
        observer.disconnect();
        callback();
      } else if (Date.now() - start > timeout) {
        observer.disconnect();
        callback(); // run anyway with what we have
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Also run after short delay
    setTimeout(() => { observer.disconnect(); callback(); }, timeout);
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  function run() {
    if (isListingPage()) {
      waitForFinancingData(() => {
        const data = parseListingPage();
        if (!data.price) return; // can't do anything without a price

        const deal = computeDeal({
          price: data.price,
          downPayment: data.downPayment,
          termMonths: data.termMonths,
          nominalRatePct: data.nominalRatePct || 4.0,
          monthlyFee: data.monthlyFee,
          openingFee: data.openingFee,
          balloon: data.balloon,
          monthlyPaymentGiven: data.monthlyPaymentGiven
        });

        if (deal) injectPanel(data, deal);
      });
    } else {
      injectSearchBadges();
    }
  }

  // Run on page load and handle SPA navigation
  run();

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(run, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
