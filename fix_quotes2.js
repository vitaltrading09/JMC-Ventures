/**
 * fix_quotes2.js - Reverses the incorrect fallback string replacement
 * 
 * Finds: 'http://localhost:8081`}
 * Replaces with: 'http://localhost:8081'}
 */
const fs = require('fs');
const path = require('path');

const BROKEN = "'http://localhost:8081`}";
const FIXED = "'http://localhost:8081'}";

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
        content = content.replace(BROKEN, FIXED);
    }

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        const rel = path.relative('.', file);
        console.log(`Fixed: ${rel}`);
        count++;
    }
}

console.log(`\nDone. Fixed ${count} file(s).`);

// Double check for any other variations like 'http://localhost:8081`/
const BROKEN_SLASH = "'http://localhost:8081`/";
for (const file of walk('apps/web')) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(BROKEN_SLASH)) {
        console.log(`❌ Still broken with slash in ${file}`);
    }
}
