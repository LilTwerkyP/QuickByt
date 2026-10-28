const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
for (let index = 0; index < scripts.length; index++) {
  // Compile, do not execute: this validates inline JavaScript syntax without a browser.
  new Function(scripts[index][1]);
}
console.log(`OK: ${scripts.length} inline script blocks parsed successfully.`);
