const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(file));
        } else {
            if (file.endsWith('.tsx') || file.endsWith('.ts')) {
                results.push(file);
            }
        }
    });
    return results;
}

const files = walk('apps/web/app').concat(walk('apps/web/components'));
let changedFiles = 0;

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    if (content.includes('http://localhost:8081')) {
        // Replace all string notations (', ", `) with template literal notation mapping to the env variable
        content = content.replace(/`http:\/\/localhost:8081/g, '`${process.env.NEXT_PUBLIC_API_URL || \'http://localhost:8081\'}');
        content = content.replace(/'http:\/\/localhost:8081/g, '`${process.env.NEXT_PUBLIC_API_URL || \'http://localhost:8081\'}');
        content = content.replace(/"http:\/\/localhost:8081/g, '`${process.env.NEXT_PUBLIC_API_URL || \'http://localhost:8081\'}');

        fs.writeFileSync(file, content, 'utf8');
        changedFiles++;
        console.log(`Updated: ${file}`);
    }
});

console.log(`\nSuccess: Updated ${changedFiles} files with NEXT_PUBLIC_API_URL environment variable support.`);
