import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const base = join(__dirname);

const cache: Record<string, any> = {};
const entries = readdirSync(base).filter(f => {
    const p = join(base, f);
    const s = require("node:fs").statSync(p);
    return s.isDirectory() && f.startsWith("run-");
});

console.log(`Found ${entries.length} run folders.`);

for (const runDir of entries) {
    const outputsPath = join(base, runDir, "outputs.jsonl");
    try {
        const content = readFileSync(outputsPath, "utf-8");
        const lines = content.trim().split("\n");
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const c = JSON.parse(line);
                if (c.gemini?.output?.citizen_summary !== undefined) {
                    const key = `${c.row.norm_id}::${c.row.block_id}`;
                    cache[key] = {
                        citizen_summary: c.gemini.output.citizen_summary,
                        citizen_tags: c.gemini.output.citizen_tags || [],
                        latency_ms: c.gemini.latency_ms,
                    };
                }
            } catch (e) {}
        }
    } catch (e) {
        // skip
    }
}

console.log(`Cached ${Object.keys(cache).length} unique norm/block pairs.`);
writeFileSync(join(base, "gemini-cache.json"), JSON.stringify(cache, null, 2));
console.log("Saved to gemini-cache.json");

const keys = Object.keys(cache).slice(0, 10);
console.log("Sample cache keys:");
for (const k of keys) console.log(`  ${k}`);
