const fs = require('fs');
const path = require('path');
const casesDir = path.join(__dirname, '..', 'content', 'cases');
const outputFile = path.join(__dirname, '..', 'public', 'cases-index.json');

if (!fs.existsSync(casesDir)) {
  console.log('No cases directory found, creating empty index.');
  fs.writeFileSync(outputFile, JSON.stringify([], null, 2));
  process.exit(0);
}

const files = fs.readdirSync(casesDir).filter(f => f.endsWith('.json'));
const cases = [];

for (const file of files) {
  try {
    const content = fs.readFileSync(path.join(casesDir, file), 'utf8');
    const data = JSON.parse(content);
    if (data.published === false) continue;
    cases.push(data);
  } catch(e) {
    console.log('Skipping invalid file:', file);
  }
}

cases.sort((a, b) => {
  if (a.featured && !b.featured) return -1;
  if (!a.featured && b.featured) return 1;
  return 0;
});

fs.writeFileSync(outputFile, JSON.stringify(cases, null, 2));
console.log(`✓ Built cases-index.json with ${cases.length} case(s)`);
  
