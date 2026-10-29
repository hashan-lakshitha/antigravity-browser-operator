const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
];

function getChromeExe() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return 'chrome.exe';
}

function getUserDataBasePath() {
  return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
}

function getLocalStatePath() {
  return path.join(getUserDataBasePath(), 'Local State');
}

function checkProfileHasExtension(folder) {
  try {
    const basePath = getUserDataBasePath();
    const securePrefs = path.join(basePath, folder, 'Secure Preferences');
    const prefs = path.join(basePath, folder, 'Preferences');

    for (const p of [securePrefs, prefs]) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8');
        if (content.includes('browser-operator') || content.includes('Browser Operator')) {
          return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

function listProfiles() {
  try {
    const localStateFile = getLocalStatePath();
    if (!fs.existsSync(localStateFile)) return [];
    const data = JSON.parse(fs.readFileSync(localStateFile, 'utf8'));
    const infoCache = data.profile?.info_cache || {};

    return Object.entries(infoCache).map(([folder, info]) => ({
      folder,
      name: info.name || folder,
      email: info.user_name || '',
      gaiaName: info.gaia_name || '',
      hasExtension: checkProfileHasExtension(folder)
    })).sort((a, b) => {
      // Put profiles with extension first, then alphabetical
      if (a.hasExtension && !b.hasExtension) return -1;
      if (!a.hasExtension && b.hasExtension) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    console.error('[Profiles] Failed to read Chrome profiles:', err.message);
    return [];
  }
}

function launchProfile(profileNameOrFolder, url) {
  const profiles = listProfiles();
  const lower = (profileNameOrFolder || '').toLowerCase().trim();

  // 1. Exact folder match (e.g. "Profile 13" or "Default")
  let target = profiles.find(p => p.folder.toLowerCase() === lower);
  // 2. Exact name match (e.g. "Clean", "Hashan", "pmd")
  if (!target) target = profiles.find(p => p.name.toLowerCase() === lower);
  // 3. Email match (e.g. "cleanslproject@gmail.com")
  if (!target) target = profiles.find(p => p.email.toLowerCase() === lower);
  // 4. Substring name match
  if (!target) target = profiles.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));

  if (!target) {
    throw new Error(`Profile "${profileNameOrFolder}" not found. Available profiles: ${profiles.map(p => `"${p.name}" (${p.folder})`).join(', ')}`);
  }

  const chromeExe = getChromeExe();
  const args = [`--profile-directory=${target.folder}`];
  if (url) args.push(url);

  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  return {
    success: true,
    launchedProfile: {
      folder: target.folder,
      name: target.name,
      email: target.email,
      hasExtension: target.hasExtension
    },
    url: url || undefined,
    message: `Launched Chrome profile "${target.name}" (${target.folder})${url ? ` with URL: ${url}` : ''}.${!target.hasExtension ? ' Note: The Browser Operator extension is not yet loaded in this profile. To automate tabs here, load the extension once via chrome://extensions.' : ''}`
  };
}

module.exports = {
  listProfiles,
  launchProfile,
  getChromeExe
};
