import * as fs from "node:fs";
import * as path from "node:path";

export function piInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }
    const execName = path.basename(process.execPath).toLowerCase();
    if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
    return { command: process.execPath, args };
}
