// Writes Kia's listings into index.html so search engines and AI crawlers can read them without running JavaScript.
// Runs daily from .github/workflows/listings.yml. The page's own script still refreshes them live for visitors.
import { readFileSync, writeFileSync } from 'node:fs';

const cfg = readFileSync('config.js', 'utf8');
const api = (cfg.match(/apiUrl:\s*'([^']+)'/) || [])[1];
if (!api) { console.log('No apiUrl in config.js'); process.exit(0); }

const res = await fetch(api, { method: 'POST', body: JSON.stringify({ action: 'listings' }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
const data = await res.json();
if (!data.ok) { console.log('Listings call failed', data); process.exit(0); }

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n ? '$' + Number(n).toLocaleString('en-US') : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYr = (d) => { const m = /^(\d{4})-(\d{2})/.exec(d || ''); return m ? MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };
const facts = (L) => [L.beds && `<span><b>${L.beds}</b> bd</span>`, L.baths && `<span><b>${L.baths}</b> ba</span>`, L.sqft && `<span><b>${Number(L.sqft).toLocaleString('en-US')}</b> sq ft</span>`].filter(Boolean).join('');

const active = data.active || [];
const sold = (data.sold || []).filter((x) => x.photo);

const activeHtml = active.map((L, i) =>
  `<button class="lcard" type="button" data-i="${i}"><div class="ph">${L.photos[0] ? `<img src="${esc(L.photos[0])}" alt="${esc(L.street)}, ${esc(L.city)}" loading="lazy">` : ''}` +
  `<span class="badge">${esc(/active/i.test(L.status) ? 'For sale' : L.status)}</span></div><div class="bd">` +
  `<div class="pr">${money(L.price)}</div><div class="ad">${esc(L.street)}, ${esc(L.city)}</div><div class="nb">${esc(L.neighborhood)}</div>` +
  `<div class="facts">${facts(L)}</div><span class="courtesy">Listing courtesy of ${esc(L.brokerage)}</span></div></button>`).join('');

const soldHtml = sold.slice(0, 8).map((L) =>
  `<div class="scard"><div class="ph"><img src="${esc(L.photo)}" alt="Home sold in ${esc(L.neighborhood || L.city)}" loading="lazy"><span class="badge sold">Sold</span></div>` +
  `<div class="bd"><div class="nb">${esc(L.neighborhood || L.city)}</div><div class="dt">${esc([L.neighborhood ? L.city : '', 'Sold ' + monthYr(L.sold)].filter(Boolean).join(' · '))}</div></div></div>`).join('');

const ld = active.length ? `<script type="application/ld+json" id="listing-ld">${JSON.stringify({
  '@context': 'https://schema.org', '@graph': active.map((L) => ({
    '@type': 'RealEstateListing', name: `${L.street}, ${L.city}, ${L.state} ${L.zip}`, url: 'https://kiasellskc.com/#listings',
    image: L.photos.slice(0, 3), datePosted: L.listed || undefined, description: (L.description || '').slice(0, 500),
    offers: { '@type': 'Offer', price: L.price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    about: { '@type': 'SingleFamilyResidence', numberOfRooms: L.beds || undefined, floorSize: L.sqft ? { '@type': 'QuantitativeValue', value: L.sqft, unitCode: 'FTK' } : undefined,
      address: { '@type': 'PostalAddress', streetAddress: L.street, addressLocality: L.city, addressRegion: L.state, postalCode: L.zip } },
    provider: { '@id': 'https://kiasellskc.com/#kia' }
  }))
}).replace(/</g, '\\u003c')}</script>` : '';

let html = readFileSync('index.html', 'utf8');
const before = html;
html = html.replace(/<!--ACTIVE:START-->[\s\S]*?<!--ACTIVE:END-->/, `<!--ACTIVE:START-->${activeHtml}<!--ACTIVE:END-->`);
html = html.replace(/<!--SOLD:START-->[\s\S]*?<!--SOLD:END-->/, `<!--SOLD:START-->${soldHtml}<!--SOLD:END-->`);
html = html.replace(/<!--LISTINGLD:START-->[\s\S]*?<!--LISTINGLD:END-->/, `<!--LISTINGLD:START-->${ld}<!--LISTINGLD:END-->`);
const show = (tag, on) => { html = html.replace(new RegExp(`(<[^>]*${tag}[^>]*?)( hidden)?>`), (m, a) => a + (on ? '' : ' hidden') + '>'); };
show('class="listings" id="listings"', active.length || sold.length);
show('id="activeWrap"', active.length);
show('id="soldWrap"', sold.length);
if (html !== before) { writeFileSync('index.html', html); console.log(`Updated: ${active.length} active, ${sold.length} sold`); }
else console.log('No changes');
