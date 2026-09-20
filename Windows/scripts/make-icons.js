"use strict";

/** 生成托盘与应用图标, 不引入额外依赖 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function writePNG(target, size, painter) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        for (let x = 0; x < size; x += 1) {
            const pixel = painter(x, y, size);
            const offset = rowStart + 1 + x * 4;
            raw[offset] = pixel[0];
            raw[offset + 1] = pixel[1];
            raw[offset + 2] = pixel[2];
            raw[offset + 3] = pixel[3];
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);
    process.stdout.write(`wrote ${target} (${size}x${size})\n`);
}

/** 抗锯齿覆盖率: 对单个像素做 3x3 采样 */
function coverage(x, y, test) {
    let hits = 0;
    for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
            if (test(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) {
                hits += 1;
            }
        }
    }
    return hits / 9;
}

/** 托盘图标画一个缺口圆环, 与主面板的额度圆弧呼应 */
function ringPainter(color) {
    return (x, y, size) => {
        const center = size / 2;
        const outer = size * 0.44;
        const inner = size * 0.28;
        const alpha = coverage(x, y, (px, py) => {
            const dx = px - center;
            const dy = py - center;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > outer || distance < inner) {
                return false;
            }
            // 右上角留缺口, 让图形在小尺寸下也能分辨
            const angle = Math.atan2(-dy, dx);
            return !(angle > Math.PI / 6 && angle < Math.PI / 2.2);
        });
        return [color[0], color[1], color[2], Math.round(alpha * 255)];
    };
}

function appPainter(x, y, size) {
    const radius = size * 0.22;
    const inside = coverage(x, y, (px, py) => {
        const cx = Math.min(Math.max(px, radius), size - radius);
        const cy = Math.min(Math.max(py, radius), size - radius);
        const dx = px - cx;
        const dy = py - cy;
        return dx * dx + dy * dy <= radius * radius;
    });
    if (inside <= 0) {
        return [0, 0, 0, 0];
    }
    const ring = ringPainter([255, 255, 255])(x, y, size);
    const background = [24, 30, 44, Math.round(inside * 255)];
    if (ring[3] === 0) {
        return background;
    }
    const alpha = ring[3] / 255;
    return [
        Math.round(255 * alpha + background[0] * (1 - alpha)),
        Math.round(255 * alpha + background[1] * (1 - alpha)),
        Math.round(255 * alpha + background[2] * (1 - alpha)),
        Math.max(background[3], ring[3])
    ];
}

const root = path.join(__dirname, "..", "resources");
writePNG(path.join(root, "tray.png"), 32, ringPainter([236, 240, 248]));
writePNG(path.join(root, "icon.png"), 256, appPainter);
