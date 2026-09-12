const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'extension', 'icons');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// 1x1 cyan PNG
const pngBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

[16, 48, 128].forEach(size => {
  fs.writeFileSync(path.join(dir, 'icon' + size + '.png'), pngBuffer);
});

console.log('Successfully created extension icons');
