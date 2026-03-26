// GetMyPetMatch - Multi-Source Dog Scraper Worker
// Sources: Humane Colorado, Foothills Animal Shelter, Denver Animal Shelter
// Deploy as: gmpm-dog-scraper

const SOURCES = {
  humaneColorado: {
    name: 'Humane Colorado',
    url: 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39',
    adoptUrl: 'https://humanecolorado.org/adoption/adopt-a-dog/',
    location: 'Denver, CO'
  },
  foothills: {
    name: 'Foothills Animal Shelter',
    url: 'https://foothillsanimalshelter.org/dogs-adoption/',
    adoptUrl: 'https://foothillsanimalshelter.org/dogs-adoption/',
    location: 'Jefferson County, CO'
  },
  denver: {
    name: 'Denver Animal Shelter',
    url: 'https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Animal-Shelter/Adopt-a-Pet/Adoptable-Pets-Online',
    adoptUrl: 'https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Animal-Shelter/Adopt-a-Pet/Adoptable-Pets-Online',
    location: 'Denver, CO'
  }
};

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

      // Fetch all three sources in parallel
      const [humaneResult, foothillsResult, denverResult] = await Promise.allSettled([
        fetchHumaneColorado(),
        fetchFoothills(),
        fetchDenver()
      ]);

      // Combine all dogs
      let allDogs = [];

      if (humaneResult.status === 'fulfilled') {
        allDogs = allDogs.concat(humaneResult.value);
      }
      if (foothillsResult.status === 'fulfilled') {
        allDogs = allDogs.concat(foothillsResult.value);
      }
      if (denverResult.status === 'fulfilled') {
        allDogs = allDogs.concat(denverResult.value);
      }

      // Score and sort
      const scored = scoreDogs(allDogs, params);
      const limit = params.tier === 'paid' ? 5 : 1;
      const matches = scored.slice(0, limit);

      // Source summary
      const sourceSummary = {
        'Humane Colorado': humaneResult.status === 'fulfilled' ? humaneResult.value.length : 0,
        'Foothills Animal Shelter': foothillsResult.status === 'fulfilled' ? foothillsResult.value.length : 0,
        'Denver Animal Shelter': denverResult.status === 'fulfilled' ? denverResult.value.length : 0,
      };

      return new Response(JSON.stringify({
        success: true,
        total_available: allDogs.length,
        sources: sourceSummary,
        matches,
      }), { headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message,
        matches: []
      }), { status: 500, headers: CORS_HEADERS });
    }
  }
};

// ─── HUMANE COLORADO ───────────────────────────────────────────────
async function fetchHumaneColorado() {
  const res = await fetch(SOURCES.humaneColorado.url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  return parseHumaneColorado(html);
}

function parseHumaneColorado(html) {
  const dogs = [];
  const imgRegex = /<img[^>]+src="([^"]+\/pet_images\/[^"]+)"[^>]*alt="([^"]+)"/gi;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1].startsWith('http') ? match[1] : 'https://humanecolorado.org' + match[1];
    const alt = match[2];
    const parts = alt.split(' - ');
    if (parts.length < 2) continue;

    // Find surrounding context for age
    const idx = match.index;
    const context = html.substring(idx, idx + 800);
    const ageMatch = context.match(/(\d+)\s*(Year|Month|Week)/i);
    const locMatch = context.match(/is located at ([^<\n]+)/i);
    const linkMatch = context.match(/href="(https:\/\/humanecolorado\.org\/animals\/[^"]+)"/i);

    const age_text = ageMatch ? `${ageMatch[1]} ${ageMatch[2]}${ageMatch[1] !== '1' ? 's' : ''}` : 'Unknown';
    const age_category = getAgeCategory(ageMatch);

    dogs.push({
      name: parts[0].trim(),
      sex: parts[1]?.trim() || 'Unknown',
      breed: parts[2]?.trim() || 'Mixed Breed',
      image: src,
      age_text,
      age_category,
      size: estimateSize(parts[2]),
      location: locMatch ? locMatch[1].trim() : SOURCES.humaneColorado.location,
      shelter: SOURCES.humaneColorado.name,
      link: linkMatch ? linkMatch[1] : SOURCES.humaneColorado.adoptUrl,
      weight: null,
      adoption_fee: null,
    });
  }

  return dogs;
}

// ─── FOOTHILLS ANIMAL SHELTER ──────────────────────────────────────
async function fetchFoothills() {
  const res = await fetch(SOURCES.foothills.url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  return parseFoothills(html);
}

function parseFoothills(html) {
  const dogs = [];

  // Foothills uses Divi/WordPress with structured dog cards
  // Pattern: dog name in h2/h3, then Age/Breed/Weight/Sex/Adoption Fee fields
  // Images are WordPress uploads

  // Split by dog card sections - look for the pattern of name + details
  const cardRegex = /<h[23][^>]*>\s*([A-Z][^<]{1,40})\s*<\/h[23]>[\s\S]{0,1500}?Age:\s*([^<\n]+)[\s\S]{0,200}?(?:Weight|Breed):/gi;
  let m;

  // Alternative: find all img tags near Age: patterns
  const sections = html.split(/(?=<h[23])/);

  for (const section of sections) {
    // Check if this section has dog data
    if (!section.includes('Age:') || !section.includes('Breed:')) continue;

    const nameMatch = section.match(/<h[23][^>]*>\s*([A-Z][a-zA-Z\s\-']{1,30})\s*<\/h[23]>/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    if (name.length < 2) continue;

    const ageMatch = section.match(/Age:\s*<\/strong>\s*([^<\n]+)/i) ||
                     section.match(/Age:\s*([^\n<]{2,30})/i);
    const breedMatch = section.match(/Breed:\s*<\/strong>\s*([^<\n]+)/i) ||
                       section.match(/Breed:\s*([^\n<]{2,50})/i);
    const sexMatch = section.match(/Sex:\s*<\/strong>\s*([^<\n]+)/i) ||
                     section.match(/Sex:\s*([^\n<]{2,20})/i);
    const weightMatch = section.match(/Weight:\s*<\/strong>\s*([^<\n]+)/i) ||
                        section.match(/Weight:\s*([^\n<]{2,20})/i);
    const feeMatch = section.match(/Adoption Fee:\s*<\/strong>\s*([^<\n]+)/i) ||
                     section.match(/Adoption Fee:\s*([^\n<]{2,20})/i);

    const imgMatch = section.match(/<img[^>]+src="([^"]+(?:foothills|wp-content)[^"]+)"[^>]*(?:alt="([^"]*)")?/i);
    const linkMatch = section.match(/href="(https?:\/\/foothillsanimalshelter[^"]+)"/i);

    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';
    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';

    dogs.push({
      name,
      sex: sexMatch ? sexMatch[1].trim() : 'Unknown',
      breed,
      image: imgMatch ? imgMatch[1] : '',
      age_text,
      age_category: getAgeCategoryFromText(age_text),
      size: estimateSizeFromWeight(weightMatch ? weightMatch[1].trim() : null) || estimateSize(breed),
      location: SOURCES.foothills.location,
      shelter: SOURCES.foothills.name,
      link: linkMatch ? linkMatch[1] : SOURCES.foothills.adoptUrl,
      weight: weightMatch ? weightMatch[1].trim() : null,
      adoption_fee: feeMatch ? feeMatch[1].trim() : null,
    });
  }

  return dogs.filter(d => d.name && d.name.length > 1);
}

// ─── DENVER ANIMAL SHELTER ─────────────────────────────────────────
async function fetchDenver() {
  const res = await fetch(SOURCES.denver.url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const html = await res.text();
  return parseDenver(html);
}

function parseDenver(html) {
  const dogs = [];

  // Denver uses a structured format:
  // Name: KONA (A428750)
  // Gender: Female
  // Breed: Australian Cattle Dog
  // Animal type: Dog
  // Age: 10 years old

  // Split into individual animal blocks
  const blocks = html.split(/Name:\s+[A-Z]/);

  for (let i = 1; i < blocks.length; i++) {
    const block = 'Name: ' + 'A' + blocks[i]; // re-add the split char

    const nameMatch = block.match(/Name:\s+([A-Z][A-Z\s\-']+?)\s*(?:\([^)]+\))?(?:\n|<)/i);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();

    const genderMatch = block.match(/Gender:\s*([^\n<]+)/i);
    const breedMatch = block.match(/Breed:\s*([^\n<]+)/i);
    const ageMatch = block.match(/Age:\s*([^\n<]+)/i);
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
    const linkMatch = block.match(/href="([^"]+animal[^"]+)"/i);

    const breed = breedMatch ? breedMatch[1].trim() : 'Mixed Breed';
    const age_text = ageMatch ? ageMatch[1].trim() : 'Unknown';

    dogs.push({
      name,
      sex: genderMatch ? genderMatch[1].trim() : 'Unknown',
      breed,
      image: imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://www.denvergov.org' + imgMatch[1]) : '',
      age_text,
      age_category: getAgeCategoryFromText(age_text),
      size: estimateSize(breed),
      location: SOURCES.denver.location,
      shelter: SOURCES.denver.name,
      link: linkMatch ? linkMatch[1] : SOURCES.denver.adoptUrl,
      weight: null,
      adoption_fee: null,
    });
  }

  return dogs.filter(d => d.name && d.name.length > 1 && d.breed !== 'Cat');
}

// ─── HELPERS ───────────────────────────────────────────────────────

function getAgeCategory(ageMatch) {
  if (!ageMatch) return 'adult';
  const num = parseInt(ageMatch[1]);
  const unit = ageMatch[2].toLowerCase();
  if (unit === 'week' || (unit === 'month' && num < 12)) return 'puppy';
  if (unit === 'year' && num <= 3) return 'young-adult';
  if (unit === 'year' && num <= 8) return 'adult';
  return 'senior';
}

function getAgeCategoryFromText(text) {
  if (!text) return 'adult';
  const t = text.toLowerCase();
  if (t.includes('week') || (t.includes('month') && !t.includes('year'))) {
    const num = parseInt(t);
    if (!isNaN(num) && num < 12) return 'puppy';
  }
  if (t.includes('year')) {
    const num = parseInt(t);
    if (!isNaN(num)) {
      if (num <= 1) return 'puppy';
      if (num <= 3) return 'young-adult';
      if (num <= 8) return 'adult';
      return 'senior';
    }
  }
  if (t.includes('puppy') || t.includes('young')) return 'puppy';
  if (t.includes('senior') || t.includes('old')) return 'senior';
  return 'adult';
}

function estimateSize(breed) {
  if (!breed) return 'medium';
  const b = breed.toLowerCase();
  const small = ['chihuahua', 'dachshund', 'pomeranian', 'yorkie', 'maltese', 'shih tzu', 'toy', 'miniature', 'terrier', 'pug', 'beagle', 'corgi', 'havanese', 'bichon'];
  const large = ['german shepherd', 'labrador', 'golden retriever', 'husky', 'rottweiler', 'great dane', 'malamute', 'saint bernard', 'mastiff', 'doberman', 'weimaraner', 'boxer', 'pit bull', 'shepherd', 'retriever', 'cattle dog', 'catahoula', 'hound'];
  if (small.some(s => b.includes(s))) return 'small';
  if (large.some(l => b.includes(l))) return 'large';
  return 'medium';
}

function estimateSizeFromWeight(weightText) {
  if (!weightText) return null;
  const lbs = parseFloat(weightText);
  if (isNaN(lbs)) return null;
  if (lbs < 25) return 'small';
  if (lbs < 60) return 'medium';
  return 'large';
}

function scoreDogs(dogs, params) {
  return dogs.map(dog => {
    let score = 0;
    const reasons = [];

    // Has a real image
    if (dog.image && dog.image.length > 10) score += 15;

    // Age match (quiz Q5)
    const ageParam = params['5'] || params['3'] || '';
    if (ageParam && dog.age_category) {
      if (ageParam === dog.age_category) {
        score += 30;
        reasons.push(`Matches your ${dog.age_category} preference`);
      } else {
        score += 8;
      }
    } else {
      score += 15;
    }

    // Size match (quiz Q4)
    if (params['4']) {
      const sizes = Array.isArray(params['4']) ? params['4'] : params['4'].split(',');
      if (sizes.includes(dog.size)) {
        score += 25;
        reasons.push(`${dog.size.charAt(0).toUpperCase() + dog.size.slice(1)}-sized dog`);
      } else {
        score += 5;
      }
    } else {
      score += 15;
    }

    // Activity level vs breed energy (quiz Q2)
    if (params['2'] && dog.breed) {
      const breed = dog.breed.toLowerCase();
      const highEnergy = ['border collie', 'husky', 'shepherd', 'retriever', 'pointer', 'weimaraner', 'dalmatian', 'jack russell', 'australian', 'cattle'];
      const lowEnergy = ['basset', 'bulldog', 'pug', 'shih tzu', 'maltese', 'havanese', 'bichon', 'bloodhound'];
      const isHigh = highEnergy.some(b => breed.includes(b));
      const isLow = lowEnergy.some(b => breed.includes(b));

      if (params['2'] === 'active' && isHigh) { score += 20; reasons.push('Energetic breed for your active lifestyle'); }
      else if (params['2'] === 'chill' && isLow) { score += 20; reasons.push('Calm breed that matches your pace'); }
      else if (params['2'] === 'moderate' && !isHigh && !isLow) { score += 20; reasons.push('Well-balanced energy for your lifestyle'); }
      else score += 8;
    } else {
      score += 12;
    }

    // Shelter diversity bonus - spread across sources
    score += Math.floor(Math.random() * 5);

    const matchPct = Math.min(99, Math.round((score / 90) * 100));

    if (reasons.length === 0) {
      reasons.push(`Available at ${dog.shelter}`);
      reasons.push('Matched to your profile');
    }

    return { ...dog, match_score: matchPct, match_reasons: reasons };
  })
  .filter(d => d.image && d.image.length > 10) // only dogs with real photos
  .sort((a, b) => b.match_score - a.match_score);
}
