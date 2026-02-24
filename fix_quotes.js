/**
 * fix_quotes.js - Single-purpose, safe URL fixer
 * 
 * Finds ONLY the pattern: localhost:8081'}/  (closing single-quote before })
 * and replaces it with:   localhost:8081`}/  (closing backtick before })
 * 
 * This is safe because this exact sequence NEVER appears in valid code -
 * it's always a mismatched closing quote on a template literal URL.
 */
const fs = require('fs');
const path = require('path');

const BROKEN = "localhost:8081'}/";
const FIXED = "localhost:8081\`}/";

// Also fix the upload/preview specific one
const BROKEN2 = "localhost:8081'}/ingestion/upload";
const FIXED2 = "localhost:8081\`}/ingestion/upload";

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

    // Replace all instances of the broken pattern
    while (content.includes(BROKEN)) {
        content = content.split(BROKEN).join(FIXED);
    }

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        const rel = path.relative('.', file);
        console.log(`Fixed: ${rel}`);
        count++;
    }
}

console.log(`\nDone. Fixed ${count} file(s).`);

// Verify nothing broken remains
const remaining = [];
for (const file of walk('apps/web')) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(BROKEN)) {
        remaining.push(path.relative('.', file));
    }
}
if (remaining.length === 0) {
    console.log('✅ No remaining broken patterns found!');
} else {
    console.log('❌ Still broken:', remaining);
}
