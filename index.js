// GetMyPetMatch - Multi-Source Dog Scraper Worker
// Sources: Humane Colorado, Foothills Animal Shelter, RescueGroups v5
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

// Fetch with timeout — slow sources fail fast without blocking others
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

    const reqUrl = new URL(request.url);

    // HTML debug — inspect raw response from a specific source
    const htmlDebug = reqUrl.searchParams.get('html');
    if (htmlDebug) {
      const urls = {
        foothills: 'https://foothillsanimalshelter.org/dogs-adoption/',
        humane: 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39',
        rescuegroups: '__v5_test__',
      };
      const targetUrl = urls[htmlDebug];
      if (!targetUrl) return new Response('Unknown source', { status: 400 });
      try {
        if (htmlDebug === 'rescuegroups') {
          const v5Url = 'https://api.rescuegroups.org/v5/public/animals/search/available/dogs/?limit=5&postalcode=80201&distance=150';
          const v5Res = await fetchWithTimeout(v5Url, {
            headers: {
              'Authorization': env.RESCUEGROUPS_API_KEY,
              'Content-Type': 'application/json'
            }
          }, 8000);
          const v5Text = await v5Res.text();
          let v5Json;
          try { v5Json = JSON.parse(v5Text); } catch(e) { v5Json = { parse_error: e.message, raw: v5Text.substring(0, 300) }; }
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
        const res = await fetchWithTimeout(targetUrl, { headers: FETCH_HEADERS }, 8000);
        const text = await res.text();
        const patterns = ['adoptable-pets__content-link', 'pet_images', 'Breed:', 'animalCard', 'pet-card'];
        let bestIdx = -1, bestPattern = '';
        for (const p of patterns) {
          const idx = text.indexOf(p);
          if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestPattern = p; }
        }
        const start = Math.max(0, bestIdx - 100);
        return new Response(JSON.stringify({
          status: res.status, url: res.url, length: text.length,
          pattern_found: bestPattern, pattern_at: bestIdx,
          sample: bestIdx > 0 ? text.substring(start, start + 3000) : text.substring(0, 3000),
        }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { headers: CORS_HEADERS });
      }
    }

    // Dump — return full cached dog list for analysis
    if (reqUrl.searchParams.get('dump') === '1') {
      const allDogs = await getOrRefreshCache(env);
      return new Response(JSON.stringify(allDogs.dogs, null, 2), { headers: CORS_HEADERS });
    }

    // Debug — show per-source counts and timing
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
          results[s.name] = { count: dogs.length, ms: Date.now() - start, sample: dogs[0] || null };
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

      const allDogs = await getOrRefreshCache(env);
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
      return new Response(JSON.stringify({ success: false, error: err.message, matches: [] }), {
        status: 500, headers: CORS_HEADERS
      });
    }
  },

  // ─── CRON TRIGGER ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log('Cron triggered — refreshing dog listings cache');
    await refreshCache(env);
    console.log('Cache refresh complete');
  }
};

// ─── CACHE LOGIC ──────────────────────────────────────────────────

async function getOrRefreshCache(env) {
  try {
    const cached = await env.DOG_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      return cached;
    }
  } catch (e) {
    console.log('Cache read error:', e.message);
  }
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
      'Humane Colorado': humaneResult.status === 'fulfilled' ? humaneResult.value.length : `error: ${humaneResult.reason}`,
      'Foothills Animal Shelter': foothillsResult.status === 'fulfilled' ? foothillsResult.value.length : `error: ${foothillsResult.reason}`,
      'RescueGroups (Colorado)': rescueGroupsResult.status === 'fulfilled' ? rescueGroupsResult.value.length : `error: ${rescueGroupsResult.reason}`,
    }
  };

  try {
    await env.DOG_CACHE.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: 7200 });
  } catch (e) {
    console.log('Cache write error:', e.message);
  }

  return data;
}

// ─── SCRAPERS ─────────────────────────────────────────────────────

// FIX: Humane Colorado wraps each card in <a class="adoptable-pets__content-link">
// The link IS the card — it appears BEFORE the img in raw HTML.
// Old approach searched forward from <img> and never found the href.
// New approach: split on card boundaries, grab href at top of each block.
async function fetchHumaneColorado() {
  const url = 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39';
  const res = await fetchWithTimeout(url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];

  // Split on the card anchor — each segment after index 0 is one dog card
  const blocks = html.split('<a class="adoptable-pets__content-link"');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    // href is the first attribute — right at the start of the block
    const linkMatch = block.match(/^[^>]*href="([^"]+)"/);
    if (!linkMatch) continue;
    const rawHref = linkMatch[1];
    const link = rawHref.startsWith('http') ? rawHref : 'https://humanecolorado.org' + rawHref;

    // Image — always in /pet_images/ path
    const imgMatch = block.match(/src="([^"]+\/pet_images\/[^"]+)"/i);
    if (!imgMatch) continue;
    const image = imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://humanecolorado.org' + imgMatch[1];

    // alt="Name - Sex - Breed"
    const altMatch = block.match(/alt="([^"]+)"/i);
    const altParts = altMatch ? altMatch[1].split(' - ') : [];
    const name = altParts[0]?.trim() || 'Unknown';
    const sex = altParts[1]?.trim() || 'Unknown';
    const breed = altParts[2]?.trim() || 'Mixed Breed';

    // Age: find a <p> containing year/month/week
    const pMatches = [...block.matchAll(/<p[^>]*>([^<]+)<\/p>/gi)];
    let age_text = 'Unknown';
    for (const pm of pMatches) {
      const txt = pm[1].trim();
      if (/year|month|week/i.test(txt)) {
        // Detail rows look like: "Male | Breed | 4 Years | Color"
        const parts = txt.split('|').map(s => s.trim());
        const agePart = parts.find(p => /year|month|week/i.test(p));
        if (agePart) { age_text = agePart; break; }
        // Fallback: the whole string is the age
        age_text = txt;
        break;
      }
    }

    // Location from <h4> (shelter branch name)
    const locMatch = block.match(/<h4[^>]*>([^<]+)<\/h4>/i);
    const location = locMatch ? locMatch[1].trim() : 'Denver, CO';

    if (!name || name === 'Unknown') continue;

    dogs.push({
      name,
      sex,
      breed,
      image,
      age_text,
      age_category: getAgeCategoryFromText(age_text),
      size: estimateSize(breed),
      location,
      shelter: 'Humane Colorado',
      link,
      weight: null,
      adoption_fee: null,
    });
  }

  return dogs;
}

async function fetchFoothills() {
  const res = await fetchWithTimeout('https://foothillsanimalshelter.org/dogs-adoption/', { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];

  const blocks = html.split('<div class="pet');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    const imgMatch = block.match(/background-image:\s*url\(([^)]+)\)/i);
    const image = imgMatch ? imgMatch[1].replace(/['"]/g, '').trim() : '';
    if (!image) continue;

    const nameMatch = block.match(/<h4>([^<]+)<\/h4>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

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
      link: linkMatch ? linkMatch[1] : 'https://foothillsanimalshelter.org/dogs-adoption/',
      weight,
      adoption_fee: feeMatch ? feeMatch[1].trim() : null,
    });
  }

  return dogs;
}

// ─── RESCUEGROUPS v5 ──────────────────────────────────────────────

async function fetchRescueGroups(env) {
  if (!env.RESCUEGROUPS_API_KEY) return [];

  const url = 'https://api.rescuegroups.org/v5/public/animals/search/available/dogs/?limit=100&postalcode=80201&distance=150&include=orgs&fields[animals]=name,sex,breedString,ageString,sizeGroup,pictureThumbnailUrl,orgName&fields[orgs]=name,city,state,websiteUrl';

  const res = await fetchWithTimeout(url, {
    headers: {
      'Authorization': env.RESCUEGROUPS_API_KEY,
      'Content-Type': 'application/json'
    }
  }, 8000);

  if (!res.ok) return [];
  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) return [];

  const orgMap = {};
  if (json.included) {
    for (const inc of json.included) {
      if (inc.type === 'orgs' && inc.attributes) {
        const city = inc.attributes.city || '';
        const state = inc.attributes.state || '';
        orgMap[inc.id] = {
          location: city && state ? `${city}, ${state}` : (city || state || 'Colorado'),
          websiteUrl: inc.attributes.websiteUrl || null,
        };
      }
    }
  }

  return json.data.map(animal => {
    const a = animal.attributes;
    const image = a.pictureThumbnailUrl ? a.pictureThumbnailUrl.replace(/\?width=\d+$/, '') : '';
    if (!image) return null;

    let location = 'Colorado';
    let orgWebsite = null;
    if (animal.relationships?.orgs?.data?.length > 0) {
      const orgId = animal.relationships.orgs.data[0].id;
      if (orgMap[orgId]) {
        location = orgMap[orgId].location;
        orgWebsite = orgMap[orgId].websiteUrl;
      }
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
      link: orgWebsite || `https://www.rescuegroups.org/animals/search/#nosearch/type=animals&animalID=${animal.id}`,
      weight: null,
      adoption_fee: null,
    };
  }).filter(d => d && d.name && d.image);
}

// ─── HELPERS ──────────────────────────────────────────────────────

function normalizeSizeRG(sizeString) {
  if (!sizeString) return null;
  const s = sizeString.toLowerCase();
  if (s.includes('small') || s.includes('tiny') || s.includes('x-small')) return 'small';
  if (s.includes('large') || s.includes('x-large') || s.includes('extra')) return 'large';
  return 'medium';
}

function getAgeCategoryFromText(text) {
  if (!text) return 'adult';
  const t = text.toLowerCase();
  // Check year FIRST — "6 years 2 weeks" should be adult, not puppy
  if (t.includes('year')) {
    const n = parseInt(t);
    if (!isNaN(n)) {
      if (n <= 1) return 'puppy';
      if (n <= 3) return 'young-adult';
      if (n <= 8) return 'adult';
      return 'senior';
    }
  }
  // Only treat week/month as puppy if no year present
  if (t.includes('week') || t.includes('month')) {
    const n = parseInt(t);
    return (!isNaN(n) && n < 12) ? 'puppy' : 'adult';
  }
  if (t.includes('puppy')) return 'puppy';
  if (t.includes('senior')) return 'senior';
  return 'adult';
}

function estimateSize(breed) {
  if (!breed) return 'medium';
  const b = breed.toLowerCase();
  const small = ['chihuahua', 'dachshund', 'pomeranian', 'yorkie', 'maltese', 'shih tzu', 'toy', 'miniature', 'pug', 'beagle', 'corgi', 'havanese', 'bichon'];
  const large = ['german shepherd', 'labrador', 'golden retriever', 'husky', 'rottweiler', 'great dane', 'malamute', 'mastiff', 'doberman', 'weimaraner', 'boxer', 'pit bull', 'shepherd', 'retriever', 'cattle dog', 'catahoula', 'hound', 'great pyrenees', 'whippet', 'dutch shepherd', 'border collie'];
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
  const hi = ['border collie', 'husky', 'shepherd', 'retriever', 'pointer', 'weimaraner', 'dalmatian', 'jack russell', 'australian', 'cattle', 'whippet'];
  const lo = ['basset', 'bulldog', 'pug', 'shih tzu', 'maltese', 'havanese', 'bichon', 'bloodhound'];

  const ageParam = params['5'] || params['3'] || '';
  const sizeParam = params['4'] ? (Array.isArray(params['4']) ? params['4'] : params['4'].split(',')) : null;
  const activityParam = params['2'] || '';

  // Helper to get activity bucket for a dog
  function getDogActivity(dog) {
    const b = (dog.breed || '').toLowerCase();
    if (hi.some(x => b.includes(x))) return 'active';
    if (lo.some(x => b.includes(x))) return 'chill';
    return 'moderate';
  }

  // Hard filter — only dogs with photos + matching quiz answers
  // If a filter has no matches in the pool, we skip that filter (graceful fallback)
  let pool = dogs.filter(d => d.image && d.image.length > 10);

  // Try applying each filter; only apply if it leaves at least 1 dog
  if (ageParam) {
    const filtered = pool.filter(d => d.age_category === ageParam);
    if (filtered.length > 0) pool = filtered;
  }

  if (sizeParam) {
    const filtered = pool.filter(d => sizeParam.includes(d.size));
    if (filtered.length > 0) pool = filtered;
  }

  if (activityParam) {
    const filtered = pool.filter(d => getDogActivity(d) === activityParam);
    if (filtered.length > 0) pool = filtered;
  }

  // Score remaining dogs for variety/ranking
  return pool
    .map(dog => {
      let score = 0;
      const reasons = [];
      const dogActivity = getDogActivity(dog);

      score += 20; // has photo (already filtered)

      if (ageParam && dog.age_category === ageParam) {
        score += 30;
        reasons.push(`Matches your ${dog.age_category} preference`);
      } else {
        score += 15;
      }

      if (sizeParam && sizeParam.includes(dog.size)) {
        score += 25;
        reasons.push(`${dog.size.charAt(0).toUpperCase() + dog.size.slice(1)}-sized dog`);
      } else {
        score += 15;
      }

      if (activityParam && dogActivity === activityParam) {
        const labels = { active: 'Energetic breed for your active lifestyle', chill: 'Calm breed that matches your pace', moderate: 'Well-balanced energy for your lifestyle' };
        score += 20;
        reasons.push(labels[activityParam] || 'Matched to your activity level');
      } else {
        score += 8;
      }

      score += Math.floor(Math.random() * 5);

      const matchPct = Math.min(99, Math.round((score / 95) * 100));
      if (reasons.length === 0) {
        reasons.push(`Available at ${dog.shelter}`);
        reasons.push('Matched to your profile');
      }

      return { ...dog, match_score: matchPct, match_reasons: reasons };
    })
    .sort((a, b) => b.match_score - a.match_score);
}
