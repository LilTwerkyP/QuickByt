const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'menu_seed.json'), 'utf8'));
const startMarker = 'const INITIAL_MENU_ITEMS = ';
const start = html.indexOf(startMarker);
if (start < 0) throw new Error('Could not find INITIAL_MENU_ITEMS in frontend/index.html');
const arrayStart = start + startMarker.length;
let i = arrayStart, depth = 0, quote = null, escaped = false;
for (; i < html.length; i++) {
  const ch = html[i];
  if (quote) {
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === quote) quote = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
  if (ch === '[') depth++;
  if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
}
const frontendMenu = Function(`return (${html.slice(arrayStart, i)})`)();
const byId = new Map(seed.map(item => [item.id, item]));
if (seed.length !== frontendMenu.length) throw new Error(`Menu count mismatch: frontend=${frontendMenu.length}, backend=${seed.length}`);
for (const item of frontendMenu) {
  const other = byId.get(item.id);
  if (!other) throw new Error(`Backend seed is missing ${item.id} (${item.name})`);
  for (const field of ['name', 'category', 'price', 'isVeg', 'hasOption']) {
    const frontValue = field === 'hasOption' ? Boolean(item[field]) : item[field];
    if (frontValue !== other[field]) {
      throw new Error(`${item.id}.${field} mismatch: frontend=${frontValue}, backend=${other[field]}`);
    }
  }
  const a = JSON.stringify(item.options || []), b = JSON.stringify(other.options || []);
  if (a !== b) throw new Error(`${item.id}.options mismatch`);
}
console.log(`OK: ${frontendMenu.length} frontend menu items match backend seed IDs, names, categories, prices, diet flags and options.`);
