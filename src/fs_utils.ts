import fs from 'fs';
import path from 'path';

export function makeParentDir(filepath: string): void {
	const destinationParentDir = path.dirname(filepath);
	makeDir(destinationParentDir);
}

export function makeDir(dirpath: string): void {
	if (!fs.existsSync(dirpath)) {
		fs.mkdirSync(dirpath, { recursive: true });
	}
}

let tempCounter = 0;
export function getTemporaryFileName(tmpDir: string, baseName: string): string {
	while (true) {
		tempCounter++;
		const temp = path.join(tmpDir, `${baseName}.${tempCounter}`);
		if (!fs.existsSync(temp)) {
			return temp;
		}
	}
	// unreachable
}

export function removeTemporaryFiles(tmpDir: string): void {
	if (fs.existsSync(tmpDir)) {
		fs.rmdirSync(tmpDir, { recursive: true });
	}
}
