/**
 * final_fix2.js
 * Uses string replacement with escaped characters to fix the double-nested pattern.
 */
const fs = require('fs');
const path = require('path');

const BAD = "process.env.NEXT_PUBLIC_API_URL || `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}`}";
const GOOD = "process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}";

function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    let results = [];
    for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory() && !['node_modules', '.git', '.next'].includes(file)) {
            results = results.concat(walk(full));
        } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
            results.push(full);
        }
    }
    return results;
}

const files = [...walk('apps/web/app'), ...walk('apps/web/components')];
let fixed = 0;

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    // Use plain string replacement - no regex needed
    while (content.includes(BAD)) {
        content = content.split(BAD).join(GOOD);
    }

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        fixed++;
        console.log('Fixed:', path.relative('.', file));
    }
}

console.log(`\nDone. Fixed ${fixed} files.`);

// Verify no more bad patterns exist
console.log('\nVerifying fix...');
let remaining = 0;
for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(BAD)) {
        console.log('Still broken:', file);
        remaining++;
    }
}
if (remaining === 0) {
    console.log('✅ All files clean!');
} else {
    console.log(`❌ ${remaining} files still have issues`);
}
