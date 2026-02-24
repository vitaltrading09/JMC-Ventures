/**
 * final_fix.js - One-shot definitive URL fixer
 * Replaces ALL variants of the broken API URL pattern with the clean version.
 */
const fs = require('fs');
const path = require('path');

const CLEAN = `\${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}`;

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

const files = [
    ...walk('apps/web/app'),
    ...walk('apps/web/components'),
];

let fixed = 0;
for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    // Replace ANY occurrence of the nested pattern back to the clean simple pattern
    // This regex matches the double-nested form produced by running the fix script multiple times
    content = content.replace(
        /\$\{process\.env\.NEXT_PUBLIC_API_URL \|\| `\$\{process\.env\.NEXT_PUBLIC_API_URL \|\| 'http:\/\/localhost:8081'\}`\}/g,
        CLEAN
    );

    // Also fix any lingering plain localhost URLs (belt+suspenders)
    content = content.replace(
        /'http:\/\/localhost:8081([^']*)'/g,
        (_, rest) => `\`${CLEAN}${rest}\``
    );
    content = content.replace(
        /"http:\/\/localhost:8081([^"]*)"/g,
        (_, rest) => `\`${CLEAN}${rest}\``
    );

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        fixed++;
        console.log('Fixed:', path.relative('.', file));
    }
}

console.log(`\nDone. Fixed ${fixed} files.`);
