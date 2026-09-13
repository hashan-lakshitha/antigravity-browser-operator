const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = path.join(__dirname, 'extension', 'icons');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Official Google Antigravity full-color logo
const OFFICIAL_URL = 'https://www.gstatic.com/antigravity/logos/antigravity-icon__full-color.png';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('Fetching official Google Antigravity logo from gstatic...');
  const icon128Path = path.join(dir, 'icon128.png');
  await download(OFFICIAL_URL, icon128Path);
  console.log('Downloaded official icon128.png');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { download };
