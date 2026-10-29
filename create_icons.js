const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'extension', 'icons');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log('Browser Operator icons directory ready at:', dir);
