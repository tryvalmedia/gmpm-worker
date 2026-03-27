// GetMyPetMatch - Multi-Source Dog Scraper Worker
// Sources: Humane Colorado, Foothills, Denver Animal Shelter, HSPPR, Longmont Humane Society
// Features: KV caching (1hr TTL) + hourly cron refresh

const CACHE_KEY = 'dog_listings';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Fetch with a 5 second timeout — slow sources fail fast without blocking others
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
export default {

  // ─── HTTP REQUEST HANDLER ──────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // HTML debug — see raw response from a specific source
    const reqUrl = new URL(request.url);
    const htmlDebug = reqUrl.searchParams.get('html');
    if (htmlDebug) {
      const urls = {
        foothills: 'https://foothillsanimalshelter.org/dogs-adoption/',
        denver: 'https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Animal-Shelter/Adopt-a-Pet/Adoptable-Pets-Online',
        hsppr: 'https://24petconnect.com/PKPK',
        longmont: 'https://www.longmonthumane.org/animals/',
        rescuegroups: '__v5_test__',
      };
      const targetUrl = urls[htmlDebug];
      if (!targetUrl) return new Response('Unknown source', { status: 400 });
      try {
        // RescueGroups v2 requires POST
        if (htmlDebug === 'rescuegroups') {
          const v5Url = 'https://api.rescuegroups.org/v5/public/animals/search/available/dogs/?limit=5&postalcode=80201&distance=150';
          const v5Res = await fetchWithTimeout(v5Url, {
            headers: { 'Authorization': env.RESCUEGROUPS_API_KEY, 'Content-Type': 'application/json' }
          }, 8000);
          const v5Text = await v5Res.text();
          let v5Json; try { v5Json = JSON.parse(v5Text); } catch(e) { v5Json = { parse_error: e.message, raw: v5Text.substring(0, 300) }; }
          return new Response(JSON.stringify({
            v5_status: v5Res.status,
            v5_data_count: v5Json.data ? v5Json.data.length : 0,
            v5_meta: v5Json.meta,
            v5_errors: v5Json.errors,
            v5_first_animal: v5Json.data && v5Json.data[0] ? { id: v5Json.data[0].id, attrs: v5Json.data[0].attributes } : null,
            key_present: !!env.RESCUEGROUPS_API_KEY,
            key_length: env.RESCUEGROUPS_API_KEY ? env.RESCUEGROUPS_API_KEY.length : 0,
          }, null, 2), { headers: CORS_HEADERS });
        }
        const fetchOpts = { headers: FETCH_HEADERS };
        const res = await fetchWithTimeout(targetUrl, fetchOpts, 8000);
        const text = await res.text();
        // For rescuegroups, parse and return structure analysis
        if (htmlDebug === 'rescuegroups') {
          try {
            const json = JSON.parse(text);
            const first = json.data && json.data[0];
            return new Response(JSON.stringify({
              status: res.status,
              meta: json.meta,
              first_animal_keys: first ? Object.keys(first) : [],
              first_animal_attr_keys: first ? Object.keys(first.attributes) : [],
              first_animal_relationships: first && first.relationships ? Object.keys(first.relationships) : [],
              first_picture_relationship: first && first.relationships && first.relationships.pictures ? first.relationships.pictures : null,
              included_count: json.included ? json.included.length : 0,
              included_types: json.included ? [...new Set(json.included.map(i => i.type))] : [],
              first_included: json.included && json.included[0] ? json.included[0] : null,
              first_included_all_attrs: json.included && json.included[0] && json.included[0].attributes ? Object.keys(json.included[0].attributes) : [],
            }, null, 2), { headers: CORS_HEADERS });
          } catch(e) {
            return new Response(JSON.stringify({ parse_error: e.message, raw: text.substring(0, 500) }), { headers: CORS_HEADERS });
          }
        }
        // Search the full HTML for animal data patterns
        const patterns = ['Gender:', 'Breed:', 'animalCard', 'pet-card', 'Animal type', 'animal-name', 'Name:</'];
        let bestIdx = -1;
        let bestPattern = '';
        for (const p of patterns) {
          const idx = text.indexOf(p);
          if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx;
            bestPattern = p;
          }
        }
        const start = Math.max(0, bestIdx - 200);
        return new Response(JSON.stringify({
          status: res.status,
          url: res.url,
          length: text.length,
          pattern_found: bestPattern,
          pattern_at: bestIdx,
          sample: bestIdx > 0 ? text.substring(start, start + 5000) : text.substring(0, 3000),
        }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { headers: CORS_HEADERS });
      }
    }
    if (reqUrl.searchParams.get('debug') === '1') {
      const results = {};
      const sources = [
        { name: 'humane_colorado', fn: fetchHumaneColorado },
        { name: 'foothills', fn: fetchFoothills },
        { name: 'rescue_groups', fn: () => fetchRescueGroups(env) },
      ];
      for (const s of sources) {
        const start = Date.now();
        try {
          const dogs = await s.fn();
          results[s.name] = { count: dogs.length, ms: Date.now() - start };
        } catch (e) {
          results[s.name] = { error: e.message, ms: Date.now() - start };
        }
      }
      return new Response(JSON.stringify(results, null, 2), { headers: CORS_HEADERS });
    }

    try {
      let params = {};
      if (request.method === 'POST') {
        params = await request.json();
      } else {
        params = Object.fromEntries(reqUrl.searchParams);
      }

      // Try cache first
      const allDogs = await getOrRefreshCache(env);

      // Score and return matches
      const scored = scoreDogs(allDogs.dogs, params);
      const limit = params.tier === 'paid' ? 5 : 1;
      const matches = scored.slice(0, limit);

      return new Response(JSON.stringify({
        success: true,
        total_available: allDogs.dogs.length,
        sources: allDogs.sources,
        cache_age_minutes: Math.round((Date.now() - allDogs.timestamp) / 60000),
        matches,
      }), { headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message,
        matches: []
      }), { status: 500, headers: CORS_HEADERS });
    }
  },

  // ─── CRON TRIGGER HANDLER ──────────────────────────────────────
  // Fires every hour — refreshes the cache in the background
  async scheduled(event, env, ctx) {
    console.log('Cron triggered — refreshing dog listings cache');
    await refreshCache(env);
    console.log('Cache refresh complete');
  }
};

// ─── CACHE LOGIC ───────────────────────────────────────────────────
async function getOrRefreshCache(env) {
  try {
    const cached = await env.DOG_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      return cached; // fresh cache hit
    }
  } catch (e) {
    console.log('Cache read error:', e.message);
  }
  // Cache miss or stale — fetch fresh
  return await refreshCache(env);
}

async function refreshCache(env) {
  const [humaneResult, foothillsResult, rescueGroupsResult] = await Promise.allSettled([
    fetchHumaneColorado(),
    fetchFoothills(),
    fetchRescueGroups(env),
  ]);

  let dogs = [];
  if (humaneResult.status === 'fulfilled') dogs = dogs.concat(humaneResult.value);
  if (foothillsResult.status === 'fulfilled') dogs = dogs.concat(foothillsResult.value);
  if (rescueGroupsResult.status === 'fulfilled') dogs = dogs.concat(rescueGroupsResult.value);

  const data = {
    timestamp: Date.now(),
    dogs,
    sources: {
      'Humane Colorado': humaneResult.status === 'fulfilled' ? humaneResult.value.length : 0,
      'Foothills Animal Shelter': foothillsResult.status === 'fulfilled' ? foothillsResult.value.length : 0,
      'RescueGroups (Colorado)': rescueGroupsResult.status === 'fulfilled' ? rescueGroupsResult.value.length : 0,
    }
  };

  // Store in KV with 2hr expiration (safety buffer)
  try {
    await env.DOG_CACHE.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: 7200 });
  } catch (e) {
    console.log('Cache write error:', e.message);
  }

  return data;
}

// ─── SCRAPERS ──────────────────────────────────────────────────────

async function fetchHumaneColorado() {
  const url = 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39';
  const res = await fetchWithTimeout(url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];
  const imgRegex = /<img[^>]+src="([^"]+\/pet_images\/[^"]+)"[^>]*alt="([^"]+)"/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1].startsWith('http') ? match[1] : 'https://humanecolorado.org' + match[1];
    const parts = match[2].split(' - ');
    if (parts.length < 2) continue;
    const ctx = html.substring(match.index, match.index + 800);
    const ageMatch = ctx.match(/(\d+)\s*(Year|Month|Week)/i);
    const locMatch = ctx.match(/is located at ([^<\n]+)/i);
    const linkMatch = ctx.match(/href="(https:\/\/humanecolorado\.org\/animals\/[^"]+)"/i);
    dogs.push({
      name: parts[0].trim(),
      sex: parts[1]?.trim() || 'Unknown',
      breed: parts[2]?.trim() || 'Mixed Breed',
      image: src,
      age_text: ageMatch ? `${ageMatch[1]} ${ageMatch[2]}${ageMatch[1] !== '1' ? 's' : ''}` : 'Unknown',
      age_category: getAgeCategoryFromMatch(ageMatch),
      size: estimateSize(parts[2]),
      location: locMatch ? locMatch[1].trim() : 'Denver, CO',
      shelter: 'Humane Colorado',
      link: linkMatch ? linkMatch[1] : `https://humanecolorado.org/animals/?search=${encodeURIComponent(parts[0].trim())}&_pet_animal_type=dog`,
      weight: null, adoption_fee: null,
    });
  }
  return dogs;
}

async function fetchFoothills() {
  const res = await fetchWithTimeout('https://foothillsanimalshelter.org/dogs-adoption/', { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];

  // Split on each dog card — Foothills uses <div class="pet ...">
  const blocks = html.split('<div class="pet');
  // First element is page header, skip it
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    // Image from background-image: url(...)
    const imgMatch = block.match(/background-image:\s*url\(([^)]+)\)/i);
    const image = imgMatch ? imgMatch[1].replace(/['"]/g, '').trim() : '';
    if (!image) continue;

    // Name from <h4>
    const nameMatch = block.match(/<h4>([^<]+)<\/h4>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Details from <strong>Field:</strong>Value pattern
    const ageMatch = block.match(/<strong>Age:<\/strong>([^<]+)/i);
    const breedMatch = block.match(/<strong>Breed:<\/strong>([^<]+)/i);
    const sexMatch = block.match(/<strong>Sex:<\/strong>([^<]+)/i);
    const weightMatch = block.match(/<strong>Weight:<\/strong>([^<]+)/i);
    const feeMatch = block.match(/<strong>Adoption Fee:<\/strong>([^<]+)/i);
    const linkMatch = block.match(/href="(https?:\/\/foothillsanimalshelter\.org\/pets\/[^"]+)"/i);

    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';
    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';
    const weight = weightMatch ? weightMatch[1].trim() : null;

    dogs.push({
      name,
      sex: sexMatch ? sexMatch[1].trim() : 'Unknown',
      breed,
      image,
      age_text,
      age_category: getAgeCategoryFromText(age_text),
      size: estimateSizeFromWeight(weight) || estimateSize(breed),
      location: 'Jefferson County, CO',
      shelter: 'Foothills Animal Shelter',
      link: linkMatch ? linkMatch[1] : `https://foothillsanimalshelter.org/dogs-adoption/?search=${encodeURIComponent(name)}`,
      weight,
      adoption_fee: feeMatch ? feeMatch[1].trim() : null,
    });
  }

  return dogs;
}

// ─── RESCUEGROUPS v5 ───────────────────────────────────────────────
// Pure v5 — pictureThumbnailUrl is on the animal object directly
// postalcode+distance gives us CO dogs, orgs include gives us city/state
async function fetchRescueGroups(env) {
  if (!env.RESCUEGROUPS_API_KEY) return [];

  const url = 'https://api.rescuegroups.org/v5/public/animals/search/available/dogs/?limit=100&postalcode=80201&distance=150&include=orgs&fields[animals]=name,sex,breedString,ageString,sizeGroup,pictureThumbnailUrl,urlDetail,orgName&fields[orgs]=name,city,state';

  const res = await fetchWithTimeout(url, {
    headers: { 'Authorization': env.RESCUEGROUPS_API_KEY, 'Content-Type': 'application/json' }
  }, 8000);

  if (!res.ok) return [];
  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) return [];

  // Build org city/state lookup from included
  const orgMap = {};
  if (json.included) {
    for (const inc of json.included) {
      if (inc.type === 'orgs' && inc.attributes) {
        const city = inc.attributes.city || '';
        const state = inc.attributes.state || '';
        orgMap[inc.id] = city && state ? `${city}, ${state}` : (city || state || 'Colorado');
      }
    }
  }

  return json.data.map(animal => {
    const a = animal.attributes;
    // pictureThumbnailUrl is on the animal — strip ?width=100 to get full size
    const image = a.pictureThumbnailUrl
      ? a.pictureThumbnailUrl.replace(/\?width=\d+$/, '')
      : '';
    if (!image) return null;

    // Get location from included orgs
    let location = 'Colorado';
    if (animal.relationships && animal.relationships.orgs && animal.relationships.orgs.data && animal.relationships.orgs.data.length > 0) {
      const orgId = animal.relationships.orgs.data[0].id;
      if (orgMap[orgId]) location = orgMap[orgId];
    }

    const breed = a.breedString || 'Mixed Breed';
    const age_text = a.ageString || 'Unknown';

    return {
      name: a.name || 'Unknown',
      sex: a.sex || 'Unknown',
      breed,
      image,
      age_text,
      age_category: getAgeCategoryFromText(age_text),
      size: normalizeSizeRG(a.sizeGroup) || estimateSize(breed),
      location,
      shelter: a.orgName || 'Colorado Rescue',
      link: a.urlDetail || 'https://rescuegroups.org',
      weight: null,
      adoption_fee: null,
    };
  }).filter(d => d && d.name && d.image);
}


function normalizeSizeRG(sizeString) {
  if (!sizeString) return null;
  const s = sizeString.toLowerCase();
  if (s.includes('small') || s.includes('tiny') || s.includes('x-small')) return 'small';
  if (s.includes('large') || s.includes('x-large') || s.includes('extra')) return 'large';
  return 'medium';
}


function getAgeCategoryFromMatch(m) {
  if (!m) return 'adult';
  const num = parseInt(m[1]), unit = m[2].toLowerCase();
  if (unit === 'week' || (unit === 'month' && num < 12)) return 'puppy';
  if (unit === 'year' && num <= 1) return 'puppy';
  if (unit === 'year' && num <= 3) return 'young-adult';
  if (unit === 'year' && num <= 8) return 'adult';
  return 'senior';
}

function getAgeCategoryFromText(text) {
  if (!text) return 'adult';
  const t = text.toLowerCase();
  if (t.includes('under 1') || t === '<1yo' || t.includes('week')) return 'puppy';
  if (t.includes('month') && !t.includes('year')) { const n = parseInt(t); return (!isNaN(n) && n < 12) ? 'puppy' : 'adult'; }
  if (t.includes('year')) {
    const n = parseInt(t);
    if (!isNaN(n)) { if (n <= 1) return 'puppy'; if (n <= 3) return 'young-adult'; if (n <= 8) return 'adult'; return 'senior'; }
  }
  if (t.includes('puppy')) return 'puppy';
  if (t.includes('senior')) return 'senior';
  return 'adult';
}

function estimateSize(breed) {
  if (!breed) return 'medium';
  const b = breed.toLowerCase();
  const small = ['chihuahua', 'dachshund', 'pomeranian', 'yorkie', 'maltese', 'shih tzu', 'toy', 'miniature', 'pug', 'beagle', 'corgi', 'havanese', 'bichon'];
  const large = ['german shepherd', 'labrador', 'golden retriever', 'husky', 'rottweiler', 'great dane', 'malamute', 'mastiff', 'doberman', 'weimaraner', 'boxer', 'pit bull', 'shepherd', 'retriever', 'cattle dog', 'catahoula', 'hound', 'great pyrenees', 'whippet', 'dutch shepherd'];
  if (small.some(s => b.includes(s))) return 'small';
  if (large.some(l => b.includes(l))) return 'large';
  return 'medium';
}

function estimateSizeFromWeight(w) {
  if (!w) return null;
  const lbs = parseFloat(w);
  if (isNaN(lbs)) return null;
  if (lbs < 25) return 'small';
  if (lbs < 60) return 'medium';
  return 'large';
}

function scoreDogs(dogs, params) {
  return dogs
    .map(dog => {
      let score = 0;
      const reasons = [];
      if (dog.image && dog.image.length > 10) score += 20;
      const ageParam = params['5'] || params['3'] || '';
      if (ageParam && dog.age_category) {
        if (ageParam === dog.age_category) { score += 30; reasons.push(`Matches your ${dog.age_category} preference`); }
        else score += 8;
      } else score += 15;
      if (params['4']) {
        const sizes = Array.isArray(params['4']) ? params['4'] : params['4'].split(',');
        if (sizes.includes(dog.size)) { score += 25; reasons.push(`${dog.size.charAt(0).toUpperCase() + dog.size.slice(1)}-sized dog`); }
        else score += 5;
      } else score += 15;
      if (params['2'] && dog.breed) {
        const b = dog.breed.toLowerCase();
        const hi = ['border collie', 'husky', 'shepherd', 'retriever', 'pointer', 'weimaraner', 'dalmatian', 'jack russell', 'australian', 'cattle', 'whippet'];
        const lo = ['basset', 'bulldog', 'pug', 'shih tzu', 'maltese', 'havanese', 'bichon', 'bloodhound'];
        const isHi = hi.some(x => b.includes(x)), isLo = lo.some(x => b.includes(x));
        if (params['2'] === 'active' && isHi) { score += 20; reasons.push('Energetic breed for your active lifestyle'); }
        else if (params['2'] === 'chill' && isLo) { score += 20; reasons.push('Calm breed that matches your pace'); }
        else if (params['2'] === 'moderate' && !isHi && !isLo) { score += 20; reasons.push('Well-balanced energy for your lifestyle'); }
        else score += 8;
      } else score += 12;
      score += Math.floor(Math.random() * 5);
      const matchPct = Math.min(99, Math.round((score / 95) * 100));
      if (reasons.length === 0) { reasons.push(`Available at ${dog.shelter}`); reasons.push('Matched to your profile'); }
      return { ...dog, match_score: matchPct, match_reasons: reasons };
    })
    .filter(d => d.image && d.image.length > 10)
    .sort((a, b) => b.match_score - a.match_score);
}
