import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PathEnvironment } from "../core/paths";

export interface Sandbox {
    root: string;
    environment: PathEnvironment;
    dispose(): void;
}

/// 每个测试用独立临时目录, 不触碰真实用户数据
export function makeSandbox(name: string): Sandbox {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `codexbar-${name}-`));
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const environment: PathEnvironment = {
        home,
        env: {
            APPDATA: path.join(root, "AppData"),
            LOCALAPPDATA: path.join(root, "Local"),
            PATHEXT: ".COM;.EXE;.BAT;.CMD"
        }
    };
    return {
        root,
        environment,
        dispose() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

export function writeLines(filePath: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

export function appendLines(filePath: string, lines: string[]): void {
    fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
