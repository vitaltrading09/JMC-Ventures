/**
 * definitive_fix.js
 * 
 * Fixes ALL url patterns in the frontend fetch calls:
 * - Replaces http://localhost:8081 with env var
 * - Ensures template literals are properly opened AND closed
 */
const fs = require('fs');
const path = require('path');

const API_VAR = `process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'`;

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

const BAD_NESTED = "process.env.NEXT_PUBLIC_API_URL || `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}`}";
const GOOD = `${API_VAR}}`;

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    // Step 1: Fix double-nested pattern (plain string replace - no regex)
    while (content.includes(BAD_NESTED)) {
        content = content.split(BAD_NESTED).join(GOOD);
    }

    // Step 2: Fix unclosed backtick template literals.
    // Pattern: `${API_VAR}/some/path', {  =>  should be  `${API_VAR}/some/path`, {
    // The closing single-quote ' before , or }) needs to become a backtick `
    // We look for lines that start with a backtick template literal but end with ' before ,
    const lines = content.split('\n');
    const fixed_lines = lines.map(line => {
        // Check if this line has an unclosed backtick fetch URL
        // Pattern: fetch(`${...} followed by url text then ' (instead of `)
        // Only fix if the line contains our env var pattern
        if (line.includes(`\${${API_VAR}}`) || line.includes('`${process.env.NEXT_PUBLIC_API_URL')) {
            // Fix: /some/path', => /some/path`, 
            line = line.replace(/(`\$\{process\.env\.NEXT_PUBLIC_API_URL[^`]*?)'(,|\)|\s*\{|\s*\))/g, '$1`$2');
        }
        return line;
    });
    content = fixed_lines.join('\n');

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        fixed++;
        console.log('Fixed:', path.relative('.', file));
    }
}

console.log(`\nDone. Fixed ${fixed} files.`);

// Verify
console.log('\nVerifying...');
let errors = 0;
for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(BAD_NESTED)) {
        console.log('❌ Still has double-nested issue:', path.relative('.', file));
        errors++;
    }
}
if (errors === 0) console.log('✅ All clear!');
