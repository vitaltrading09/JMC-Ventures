/**
 * final_cleanup.js - Fixes the trailing quotes and accidental spaces in URLs
 */
const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory() && !['node_modules', '.git', '.next'].includes(f)) {
            results = results.concat(walk(full));
        } else if (f.endsWith('.tsx') || f.endsWith('.ts')) {
            results.push(full);
        }
    }
    return results;
}

const files = walk('apps/web');
let count = 0;

for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    let content = original;

    // 1. Fix the trailing single quotes on template literals
    content = content.replace(/(\/ingestion\/[a-zA-Z0-9\-\/]*?)',/g, "$1`,");
    content = content.replace(/(\/auth\/[a-zA-Z0-9\-\/]*?)',/g, "$1`,");

    // 2. Fix the specific cases in data/page.tsx that end with ')
    content = content.replace(/(\/ingestion\/[a-zA-Z0-9\-\/]*?)'\)/g, "$1`)");

    // 3. Fix the accidental spaces in sites/page.tsx
    content = content.replace(/\} \/ ingestion \/ sites/g, "}/ingestion/sites");
    content = content.replace(/\} \/ ingestion \/ meters \/ \$\{meterId\}/g, "}/ingestion/meters/${meterId}");
    content = content.replace(/\} \/ ingestion \/ meters/g, "}/ingestion/meters");

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        const rel = path.relative('.', file);
        console.log(`Fixed: ${rel}`);
        count++;
    }
}

console.log(`\nDone. Fixed ${count} file(s).`);
