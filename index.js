// GetMyPetMatch - Dog Scraper Worker
// Scrapes Humane Colorado (humanecolorado.org) and returns matched dogs
// Deploy to Cloudflare Workers as: gmpm-dog-scraper

const HUMANE_CO_URL = 'https://humanecolorado.org/animals/?_pet_animal_type=dog%2Cpuppy&_pet_record_type=available%2C7a6e4f7c956981bab7196df203d380a1%2Cd80ef6dd787418b1aa71412dab712e39';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // Parse quiz params from request
      let params = {};
      if (request.method === 'POST') {
        params = await request.json();
      } else {
        const url = new URL(request.url);
        params = Object.fromEntries(url.searchParams);
      }

      // Fetch Humane Colorado dog listings
      const response = await fetch(HUMANE_CO_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://humanecolorado.org/'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch listings: ${response.status}`);
      }

      const html = await response.text();

      // Parse dog cards from HTML
      const dogs = parseDogs(html);

      // Score and filter dogs based on quiz answers
      const scored = scoreDogs(dogs, params);

      // Return top match (free tier = 1, paid = more)
      const limit = params.tier === 'paid' ? 5 : 1;
      const matches = scored.slice(0, limit);

      return new Response(JSON.stringify({
        success: true,
        total_available: dogs.length,
        matches: matches,
        source: 'Humane Colorado',
        source_url: 'https://humanecolorado.org/adoption/adopt-a-dog/'
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

// Parse dog listings from HTML
function parseDogs(html) {
  const dogs = [];

  // Match each article card
  const cardRegex = /<article[^>]*class="[^"]*animal-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let cardMatch;

  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1];
    const dog = {};

    // Name
    const nameMatch = card.match(/<h[23][^>]*>\s*([^<]+)\s*<\/h[23]>/i);
    dog.name = nameMatch ? nameMatch[1].trim() : null;

    // Image
    const imgMatch = card.match(/<img[^>]+src="([^"]+pet_images[^"]+)"[^>]*alt="([^"]+)"/i);
    if (imgMatch) {
      dog.image = imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://humanecolorado.org' + imgMatch[1];
      // Parse alt text: "Name - Sex - Breed"
      const altParts = imgMatch[2].split(' - ');
      if (altParts.length >= 3) {
        dog.sex = altParts[1]?.trim();
        dog.breed = altParts[2]?.trim();
      }
    }

    // Link
    const linkMatch = card.match(/href="(https:\/\/humanecolorado\.org\/animals\/[^"]+)"/i);
    dog.link = linkMatch ? linkMatch[1] : 'https://humanecolorado.org/adoption/adopt-a-dog/';

    // Location (figcaption)
    const locMatch = card.match(/is located at ([^<\n]+)/i);
    dog.location = locMatch ? locMatch[1].trim() : 'Humane Colorado';

    // Age - look for "X Years" or "X Months"
    const ageMatch = card.match(/(\d+)\s*(Year|Month|Week)/i);
    if (ageMatch) {
      const num = parseInt(ageMatch[1]);
      const unit = ageMatch[2].toLowerCase();
      dog.age_text = `${num} ${ageMatch[2]}${num !== 1 ? 's' : ''}`;
      // Normalize age category
      if (unit === 'week' || (unit === 'month' && num < 12)) {
        dog.age_category = 'puppy';
      } else if (unit === 'year' && num <= 3) {
        dog.age_category = 'young-adult';
      } else if (unit === 'year' && num <= 8) {
        dog.age_category = 'adult';
      } else {
        dog.age_category = 'senior';
      }
    } else {
      dog.age_text = 'Unknown';
      dog.age_category = 'adult';
    }

    // Color
    const colorMatch = card.match(/(\d+)\s*Years?\s*\n\s*([^\n<]+)/i);
    dog.color = colorMatch ? colorMatch[2].trim() : null;

    // Size estimation from breed name
    dog.size = estimateSize(dog.breed);

    if (dog.name && dog.image) {
      dogs.push(dog);
    }
  }

  // Fallback: try simpler parsing if no cards found
  if (dogs.length === 0) {
    return parseDogsFallback(html);
  }

  return dogs;
}

// Fallback parser using regex on raw text blocks
function parseDogsFallback(html) {
  const dogs = [];
  const imgRegex = /<img[^>]+src="([^"]+\/pet_images\/[^"]+)"[^>]*alt="([^"]+)"/gi;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1].startsWith('http') ? match[1] : 'https://humanecolorado.org' + match[1];
    const alt = match[2]; // "Name - Sex - Breed"
    const parts = alt.split(' - ');

    if (parts.length >= 2) {
      dogs.push({
        name: parts[0].trim(),
        sex: parts[1]?.trim() || 'Unknown',
        breed: parts[2]?.trim() || 'Mixed Breed',
        image: src,
        age_text: 'Unknown',
        age_category: 'adult',
        size: estimateSize(parts[2]),
        location: 'Humane Colorado',
        link: 'https://humanecolorado.org/adoption/adopt-a-dog/',
        color: null
      });
    }
  }

  return dogs;
}

// Estimate size from breed name
function estimateSize(breed) {
  if (!breed) return 'medium';
  const b = breed.toLowerCase();
  const small = ['chihuahua', 'dachshund', 'pomeranian', 'yorkie', 'maltese', 'shih tzu', 'poodle toy', 'miniature', 'terrier', 'pug', 'beagle'];
  const large = ['german shepherd', 'labrador', 'golden retriever', 'husky', 'rottweiler', 'great dane', 'malamute', 'saint bernard', 'mastiff', 'doberman', 'weimaraner', 'boxer', 'pit bull', 'shepherd', 'retriever'];
  if (small.some(s => b.includes(s))) return 'small';
  if (large.some(l => b.includes(l))) return 'large';
  return 'medium';
}

// Score dogs against quiz answers
function scoreDogs(dogs, params) {
  return dogs.map(dog => {
    let score = 0;
    const reasons = [];

    // Age match
    if (params['3'] && dog.age_category) {
      const ageMap = {
        'puppy': 'puppy',
        'young-adult': 'young-adult',
        'adult': 'adult',
        'senior': 'senior'
      };
      if (ageMap[params['3']] === dog.age_category) {
        score += 30;
        reasons.push(`Matches your ${dog.age_category} preference`);
      } else {
        score += 10; // partial credit
      }
    } else {
      score += 20; // no preference = neutral
    }

    // Size match
    if (params['4']) {
      const sizes = Array.isArray(params['4']) ? params['4'] : [params['4']];
      if (sizes.includes(dog.size)) {
        score += 25;
        reasons.push(`${dog.size.charAt(0).toUpperCase() + dog.size.slice(1)}-sized dog`);
      } else {
        score += 5;
      }
    } else {
      score += 15;
    }

    // Activity level vs breed energy
    if (params['2'] && dog.breed) {
      const breed = dog.breed.toLowerCase();
      const highEnergy = ['border collie', 'husky', 'shepherd', 'retriever', 'pointer', 'weimaraner', 'dalmatian', 'jack russell', 'australian'];
      const lowEnergy = ['basset', 'bulldog', 'pug', 'shih tzu', 'maltese', 'havanese', 'bichon'];
      const isHighEnergy = highEnergy.some(b => breed.includes(b));
      const isLowEnergy = lowEnergy.some(b => breed.includes(b));

      if (params['2'] === 'active' && isHighEnergy) { score += 20; reasons.push('Energetic breed for your active lifestyle'); }
      else if (params['2'] === 'chill' && isLowEnergy) { score += 20; reasons.push('Calm breed that matches your pace'); }
      else if (params['2'] === 'moderate' && !isHighEnergy && !isLowEnergy) { score += 20; reasons.push('Good energy match for your lifestyle'); }
      else { score += 8; }
    } else {
      score += 15;
    }

    // Add base score for being available
    score += 10;

    // Normalize to percentage
    const matchPct = Math.min(99, Math.round((score / 85) * 100));

    return {
      ...dog,
      match_score: matchPct,
      match_reasons: reasons.length > 0 ? reasons : ['Available in Colorado', 'Matches your profile']
    };
  })
  .sort((a, b) => b.match_score - a.match_score);
}
