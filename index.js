// GetMyPetMatch - Multi-Source Dog Scraper Worker
// Sources: Humane Colorado, Foothills, Denver Animal Shelter, HSPPR (24PetConnect), Longmont Humane Society
// Deploy as: gmpm-dog-scraper

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      let params = {};
      if (request.method === 'POST') {
        params = await request.json();
      } else {
        const url = new URL(request.url);
        params = Object.fromEntries(url.searchParams);
      }

      const [humaneResult, foothillsResult, denverResult, hspprResult, longmontResult] = await Promise.allSettled([
        fetchHumaneColorado(),
        fetchFoothills(),
        fetchDenver(),
        fetchHSPPR(),
        fetchLongmont(),
      ]);

      let allDogs = [];
      if (humaneResult.status === 'fulfilled') allDogs = allDogs.concat(humaneResult.value);
      if (foothillsResult.status === 'fulfilled') allDogs = allDogs.concat(foothillsResult.value);
      if (denverResult.status === 'fulfilled') allDogs = allDogs.concat(denverResult.value);
      if (hspprResult.status === 'fulfilled') allDogs = allDogs.concat(hspprResult.value);
      if (longmontResult.status === 'fulfilled') allDogs = allDogs.concat(longmontResult.value);

      const scored = scoreDogs(allDogs, params);
      const limit = params.tier === 'paid' ? 5 : 1;
      const matches = scored.slice(0, limit);

      return new Response(JSON.stringify({
        success: true,
        total_available: allDogs.length,
        sources: {
          'Humane Colorado': humaneResult.status === 'fulfilled' ? humaneResult.value.length : 0,
          'Foothills Animal Shelter': foothillsResult.status === 'fulfilled' ? foothillsResult.value.length : 0,
          'Denver Animal Shelter': denverResult.status === 'fulfilled' ? denverResult.value.length : 0,
          'HSPPR Colorado Springs': hspprResult.status === 'fulfilled' ? hspprResult.value.length : 0,
          'Longmont Humane Society': longmontResult.status === 'fulfilled' ? longmontResult.value.length : 0,
        },
        matches,
      }), { headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message, matches: [] }), { status: 500, headers: CORS_HEADERS });
    }
  }
};

async function fetchHumaneColorado() {
  const url = 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39';
  const res = await fetch(url, { headers: FETCH_HEADERS });
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
      link: linkMatch ? linkMatch[1] : 'https://humanecolorado.org/adoption/adopt-a-dog/',
      weight: null, adoption_fee: null,
    });
  }
  return dogs;
}

async function fetchFoothills() {
  const res = await fetch('https://foothillsanimalshelter.org/dogs-adoption/', { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];
  const sections = html.split(/(?=<h[23])/);
  for (const section of sections) {
    if (!section.includes('Age:') || !section.includes('Breed:')) continue;
    const nameMatch = section.match(/<h[23][^>]*>\s*([A-Z][a-zA-Z\s\-']{1,30})\s*<\/h[23]>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (name.length < 2) continue;
    const ageMatch = section.match(/Age:\s*(?:<\/strong>)?\s*([^<\n]+)/i);
    const breedMatch = section.match(/Breed:\s*(?:<\/strong>)?\s*([^<\n]+)/i);
    const sexMatch = section.match(/Sex:\s*(?:<\/strong>)?\s*([^<\n]+)/i);
    const weightMatch = section.match(/Weight:\s*(?:<\/strong>)?\s*([^<\n]+)/i);
    const feeMatch = section.match(/Adoption Fee:\s*(?:<\/strong>)?\s*([^<\n]+)/i);
    const imgMatch = section.match(/<img[^>]+src="([^"]+(?:foothills|wp-content)[^"]+)"[^>]*/i);
    const linkMatch = section.match(/href="(https?:\/\/foothillsanimalshelter[^"]+)"/i);
    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';
    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';
    dogs.push({
      name, sex: sexMatch ? sexMatch[1].trim() : 'Unknown', breed,
      image: imgMatch ? imgMatch[1] : '',
      age_text, age_category: getAgeCategoryFromText(age_text),
      size: estimateSizeFromWeight(weightMatch ? weightMatch[1].trim() : null) || estimateSize(breed),
      location: 'Jefferson County, CO', shelter: 'Foothills Animal Shelter',
      link: linkMatch ? linkMatch[1] : 'https://foothillsanimalshelter.org/dogs-adoption/',
      weight: weightMatch ? weightMatch[1].trim() : null,
      adoption_fee: feeMatch ? feeMatch[1].trim() : null,
    });
  }
  return dogs.filter(d => d.name && d.name.length > 1);
}

async function fetchDenver() {
  const url = 'https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Animal-Shelter/Adopt-a-Pet/Adoptable-Pets-Online';
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];
  const blocks = html.split(/Name:\s+[A-Z]/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const typeMatch = block.match(/Animal type:\s*([^\n<]+)/i);
    if (!typeMatch || !typeMatch[1].toLowerCase().includes('dog')) continue;
    const nameRaw = block.match(/^([A-Z][A-Z\s\-']+?)(?:\s*\([^)]+\))?(?:\n|<)/);
    if (!nameRaw) continue;
    const name = nameRaw[1].trim();
    const genderMatch = block.match(/Gender:\s*([^\n<]+)/i);
    const breedMatch = block.match(/Breed:\s*([^\n<]+)/i);
    const ageMatch = block.match(/Age:\s*([^\n<]+)/i);
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';
    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';
    dogs.push({
      name, sex: genderMatch ? genderMatch[1].trim() : 'Unknown', breed,
      image: imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://www.denvergov.org' + imgMatch[1]) : '',
      age_text, age_category: getAgeCategoryFromText(age_text),
      size: estimateSize(breed), location: 'Denver, CO',
      shelter: 'Denver Animal Shelter', link: url,
      weight: null, adoption_fee: null,
    });
  }
  return dogs.filter(d => d.name && d.name.length > 1);
}

async function fetchHSPPR() {
  const res = await fetch('https://24petconnect.com/PKPK', { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  const dogs = [];
  const blocks = html.split(/Name:\s*/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const typeMatch = block.match(/Animal type:\s*([^\n<\r]+)/i);
    if (!typeMatch || !typeMatch[1].toLowerCase().includes('dog')) continue;
    const nameMatch = block.match(/^([^\n\r<(]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].replace(/\([^)]+\)/, '').trim();
    if (!name || name.length < 2) continue;
    const animalIdMatch = block.match(/\(([A-Z]\d+)\)/);
    const animalId = animalIdMatch ? animalIdMatch[1] : null;
    const genderMatch = block.match(/Gender:\s*([^\n<\r]+)/i);
    const breedMatch = block.match(/Breed:\s*([^\n<\r]+)/i);
    const ageMatch = block.match(/Age:\s*([^\n<\r]+)/i);
    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';
    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';
    dogs.push({
      name: name.trim(), sex: genderMatch ? genderMatch[1].trim() : 'Unknown', breed,
      image: animalId ? `https://24petconnect.com/image/${animalId}/PKPK/1` : '',
      age_text, age_category: getAgeCategoryFromText(age_text),
      size: estimateSize(breed), location: 'Colorado Springs, CO',
      shelter: 'Humane Society of the Pikes Peak Region',
      link: 'https://www.hsppr.org/pets/',
      weight: null, adoption_fee: null,
    });
  }
  return dogs.filter(d => d.name && d.name.length > 1);
}

async function fetchLongmont() {
  const res = await fetch('https://www.longmonthumane.org/animals/', { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const text = await res.text();
  const dogs = [];
  const animalRegex = /([A-Z][a-zA-Z\s]{1,25})\s+(Male|Female)\s+Dog,\s+([^<\n]+?)\s+(<1yo|\d+yo|\d+\s+years?|\d+\s+months?)/gi;
  let match;
  while ((match = animalRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const sex = match[2].trim();
    const breedRaw = match[3].trim();
    const ageRaw = match[4].trim();
    let size = 'medium';
    if (breedRaw.toLowerCase().includes('over 44')) size = 'large';
    else if (breedRaw.toLowerCase().includes('up to 44')) size = 'medium';
    else size = estimateSize(breedRaw);
    const breed = breedRaw.replace(/,?\s*(Large|Medium|Small)[^,]*/i, '').trim() || 'Mixed Breed';
    const age_text = ageRaw.replace('<1yo', 'Under 1 year').replace(/(\d+)yo/, '$1 years');
    dogs.push({
      name, sex, breed,
      image: '', // Longmont text page has no images — skip for now, filtered later
      age_text, age_category: getAgeCategoryFromText(age_text),
      size, location: 'Longmont, CO',
      shelter: 'Longmont Humane Society',
      link: 'https://www.longmonthumane.org/animals/',
      weight: null, adoption_fee: null,
    });
  }
  return dogs;
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
  const large = ['german shepherd', 'labrador', 'golden retriever', 'husky', 'rottweiler', 'great dane', 'malamute', 'mastiff', 'doberman', 'weimaraner', 'boxer', 'pit bull', 'shepherd', 'retriever', 'cattle dog', 'catahoula', 'hound', 'great pyrenees', 'whippet', 'dutch shepherd', 'over 44'];
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
