"use strict";

/** 把渲染层静态资源复制到 dist, 构建产物保持自包含 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const targets = [
    ["src/renderer/index.html", "dist/renderer/index.html"],
    ["src/renderer/styles.css", "dist/renderer/styles.css"]
];

for (const [from, to] of targets) {
    const source = path.join(root, from);
    const destination = path.join(root, to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    process.stdout.write(`copied ${from} -> ${to}\n`);
}
