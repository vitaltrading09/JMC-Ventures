/**
 * fix_api_urls.js
 * 
 * Cleanly replaces all API fetch URLs in the frontend with the 
 * environment variable pattern. Handles all the edge cases created
 * by the previous broken replacement script.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = "process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'";
const CORRECT_PREFIX = `\${${API_BASE}}`;

function walk(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('.next')) {
                results = results.concat(walk(file));
            }
        } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('apps/web/app').concat(walk('apps/web/components'));
let changedFiles = 0;

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let original = content;

    // Step 1: Fix double-nested env vars (produced by running the script twice)
    // Pattern: `${process.env.NEXT_PUBLIC_API_URL || `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}'}`
    const doubleNestedRegex = /\$\{process\.env\.NEXT_PUBLIC_API_URL \|\| `\$\{process\.env\.NEXT_PUBLIC_API_URL \|\| 'http:\/\/localhost:8081'\}'?\}/g;
    content = content.replace(doubleNestedRegex, CORRECT_PREFIX);

    // Step 2: Fix broken quote endings - backtick opened but closed with double quote
    // Pattern: `${...}/some/path", {  =>  should be  `${...}/some/path`, {
    const brokenQuoteRegex = /(`\$\{process\.env\.NEXT_PUBLIC_API_URL \|\| 'http:\/\/localhost:8081'\}[^`]*?)"/g;
    content = content.replace(brokenQuoteRegex, '$1`');

    // Step 3: Fix any remaining raw localhost URLs (ones not yet converted)
    // Handle: 'http://localhost:8081/path'  =>  `${...}/path`
    content = content.replace(/'http:\/\/localhost:8081([^']*)'/g, (match, path) => {
        return `\`${CORRECT_PREFIX}${path}\``;
    });
    // Handle: "http://localhost:8081/path"  =>  `${...}/path`
    content = content.replace(/"http:\/\/localhost:8081([^"]*)"/g, (match, path) => {
        return `\`${CORRECT_PREFIX}${path}\``;
    });

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        changedFiles++;
        console.log(`Fixed: ${path.relative(process.cwd(), file)}`);
    }
});

console.log(`\n✅ Done! Fixed ${changedFiles} files.`);
console.log(`\nNext steps:`);
console.log(`1. Create apps/web/.env.production with NEXT_PUBLIC_API_URL=http://YOUR_AWS_IP:8081`);
console.log(`2. Push to GitHub with: git add . ; git commit -m "Fix: clean production API URLs" ; git push`);
console.log(`3. On the server: git pull, then npm run build && npm run start`);
