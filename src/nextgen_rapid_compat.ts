import fs from 'fs';

import { getPkgDir } from './nextgen_utils';

export class NextGenRapidCompat {
	private springWritePath: string;

	constructor(springWritePath: string) {
		this.springWritePath = springWritePath;
	}

	setTouchedByNextgen(versionsGz: string, isTouched: boolean): void {
		let touchedFiles = [];
		const touchedFilesRegistry = `${getPkgDir(this.springWritePath)}/touched_rapid.json`;
		if (fs.existsSync(touchedFilesRegistry)) {
			touchedFiles = JSON.parse(fs.readFileSync(touchedFilesRegistry, 'utf8'));
		}
		if (isTouched) {
			touchedFiles.push(versionsGz);
		} else {
			const index = touchedFiles.indexOf(versionsGz);
			if (index > -1) {
				touchedFiles.splice(index, 1);
			}
		}

		fs.writeFileSync(touchedFilesRegistry, JSON.stringify(touchedFiles));
	}

	clearTouchedByNextgen(): void {
		const touchedFilesRegistry = `${getPkgDir(this.springWritePath)}/touched_rapid.json`;
		if (fs.existsSync(touchedFilesRegistry)) {
			fs.unlinkSync(touchedFilesRegistry);
		}
	}

	isTouchedByNextgen(versionsGz: string): boolean {
		return this.getTouchedByNextgen().includes(versionsGz);
	}

	getTouchedByNextgen(): string[] {
		const touchedFilesRegistry = `${getPkgDir(this.springWritePath)}/touched_rapid.json`;
		if (!fs.existsSync(touchedFilesRegistry)) {
			return [];
		}

		try {
			return JSON.parse(fs.readFileSync(touchedFilesRegistry, 'utf8'));
		} catch (err) {
			return [];
		}
	}
}
