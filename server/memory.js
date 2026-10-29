// Browser Operator - Autonomous Memory & Self-Learning Engine
const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.resolve(__dirname, '..', 'memory');
const RECIPES_DIR = path.join(MEMORY_DIR, 'recipes');
const QUIRKS_FILE = path.join(MEMORY_DIR, 'site_quirks.json');
const HISTORY_FILE = path.join(MEMORY_DIR, 'session_history.json');

// Ensure memory directories and files exist
function ensureStorage() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
  if (!fs.existsSync(RECIPES_DIR)) {
    fs.mkdirSync(RECIPES_DIR, { recursive: true });
  }
  if (!fs.existsSync(QUIRKS_FILE)) {
    fs.writeFileSync(QUIRKS_FILE, JSON.stringify({
      _meta: { description: 'Site quirks and learned tips database for autonomous browser navigation' },
      sites: {}
    }, null, 2));
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
  }
}

// Normalize domain (e.g., https://www.facebook.com/reels -> facebook.com)
function normalizeDomain(input) {
  if (!input) return '';
  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const parsed = new URL(input);
      return parsed.hostname.replace(/^www\./, '').toLowerCase();
    }
  } catch (e) {}
  return input.replace(/^www\./, '').split('/')[0].toLowerCase().trim();
}

// 1. RECIPE MANAGEMENT (Muscle Memory)
function saveRecipe({ name, domain, description, actions, notes = '' }) {
  ensureStorage();
  if (!name) throw new Error('Recipe name is required');
  const cleanDomain = normalizeDomain(domain);
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const fileName = cleanDomain ? `${cleanDomain}__${safeName}.json` : `${safeName}.json`;
  const filePath = path.join(RECIPES_DIR, fileName);

  let existing = null;
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {}
  }

  const recipe = {
    name: safeName,
    title: name,
    domain: cleanDomain,
    description: description || existing?.description || '',
    actions: Array.isArray(actions) ? actions : (existing?.actions || []),
    notes: notes || existing?.notes || '',
    timesUsed: (existing?.timesUsed || 0) + 1,
    successCount: existing?.successCount || 1,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2));
  return { success: true, fileName, recipe };
}

function listRecipes(domain = null) {
  ensureStorage();
  const cleanDomain = domain ? normalizeDomain(domain) : null;
  const files = fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json'));
  const recipes = [];

  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8'));
      if (!cleanDomain || content.domain === cleanDomain || !content.domain) {
        recipes.push({
          fileName: file,
          name: content.name,
          title: content.title || content.name,
          domain: content.domain,
          description: content.description,
          actionCount: content.actions?.length || 0,
          timesUsed: content.timesUsed || 1,
          updatedAt: content.updatedAt
        });
      }
    } catch (e) {}
  }

  return recipes;
}

function findRecipe(query, domain = null) {
  ensureStorage();
  const cleanDomain = domain ? normalizeDomain(domain) : null;
  const cleanQuery = (query || '').toLowerCase().trim();
  const all = listRecipes(cleanDomain);

  if (!cleanQuery) return all.slice(0, 10);

  // Score recipes by keyword matching
  const scored = all.map(r => {
    let score = 0;
    const nameMatch = r.name.toLowerCase().includes(cleanQuery);
    const descMatch = (r.description || '').toLowerCase().includes(cleanQuery);
    if (nameMatch) score += 10;
    if (descMatch) score += 5;
    if (cleanDomain && r.domain === cleanDomain) score += 8;
    return { ...r, score };
  }).filter(r => r.score > 0);

  scored.sort((a, b) => b.score - a.score);

  // Return full recipe data for top matches
  return scored.slice(0, 5).map(m => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, m.fileName), 'utf8'));
    } catch (e) {
      return m;
    }
  });
}

function getRecipe(fileNameOrName) {
  ensureStorage();
  let filePath = path.join(RECIPES_DIR, fileNameOrName.endsWith('.json') ? fileNameOrName : `${fileNameOrName}.json`);
  if (!fs.existsSync(filePath)) {
    // Search by name
    const files = fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json'));
    const match = files.find(f => f.includes(`__${fileNameOrName}.json`) || f === `${fileNameOrName}.json`);
    if (match) filePath = path.join(RECIPES_DIR, match);
  }
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 2. SITE QUIRKS & PITFALLS (The Library)
function getSiteQuirks(domain) {
  ensureStorage();
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return [];

  try {
    const data = JSON.parse(fs.readFileSync(QUIRKS_FILE, 'utf8'));
    const siteData = data.sites?.[cleanDomain];
    if (!siteData) return [];
    return siteData.quirks || [];
  } catch (e) {
    return [];
  }
}

function recordSiteQuirk({ domain, quirk, category = 'general', advice = '', selector = '' }) {
  ensureStorage();
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) throw new Error('Domain is required');
  if (!quirk) throw new Error('Quirk description is required');

  const data = JSON.parse(fs.readFileSync(QUIRKS_FILE, 'utf8'));
  if (!data.sites) data.sites = {};
  if (!data.sites[cleanDomain]) {
    data.sites[cleanDomain] = {
      domain: cleanDomain,
      firstRecorded: new Date().toISOString(),
      quirks: []
    };
  }

  const existingQuirk = data.sites[cleanDomain].quirks.find(q => q.quirk.toLowerCase() === quirk.toLowerCase());
  if (existingQuirk) {
    existingQuirk.timesObserved = (existingQuirk.timesObserved || 1) + 1;
    existingQuirk.lastObserved = new Date().toISOString();
    if (advice) existingQuirk.advice = advice;
    if (selector) existingQuirk.selector = selector;
  } else {
    data.sites[cleanDomain].quirks.push({
      quirk,
      category,
      advice,
      selector: selector || undefined,
      timesObserved: 1,
      recordedAt: new Date().toISOString(),
      lastObserved: new Date().toISOString()
    });
  }

  data.sites[cleanDomain].lastUpdated = new Date().toISOString();
  fs.writeFileSync(QUIRKS_FILE, JSON.stringify(data, null, 2));

  return { success: true, domain: cleanDomain, quirkCount: data.sites[cleanDomain].quirks.length };
}

// 3. EPISODIC SESSION REFLECTION
function recordSessionOutcome({ task, domain, success, error = null, stepsCount = 0, durationMs = 0, reflection = '' }) {
  ensureStorage();
  const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));

  const entry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    task,
    domain: normalizeDomain(domain),
    success: Boolean(success),
    error: error || undefined,
    stepsCount,
    durationMs,
    reflection: reflection || undefined
  };

  history.push(entry);
  // Keep last 100 entries
  if (history.length > 100) {
    history.splice(0, history.length - 100);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  return { success: true, loggedId: entry.id };
}

// Get comprehensive site intelligence (recipes + quirks + hints)
function getSiteIntelligence(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return null;

  const quirks = getSiteQuirks(cleanDomain);
  const recipes = listRecipes(cleanDomain);

  return {
    domain: cleanDomain,
    knownQuirks: quirks.map(q => `[${q.category.toUpperCase()}] ${q.quirk}${q.advice ? ' -> Advice: ' + q.advice : ''}`),
    savedRecipes: recipes.map(r => ({ name: r.name, title: r.title, description: r.description, steps: r.actionCount }))
  };
}

module.exports = {
  normalizeDomain,
  saveRecipe,
  listRecipes,
  findRecipe,
  getRecipe,
  getSiteQuirks,
  recordSiteQuirk,
  recordSessionOutcome,
  getSiteIntelligence
};
