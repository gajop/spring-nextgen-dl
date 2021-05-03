import { spawn } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs';
import readline from 'readline';
import path from 'path';

import { makeParentDir, getTemporaryFileName } from './fs_utils';

enum LineType {
	Log = 'log',
	Progress = 'progress'
}

interface DownloadLine {
	type: LineType,
	message?: string,
	progress?: number
}

export class Butler extends EventEmitter {
	process?: import('child_process').ChildProcessWithoutNullStreams;
	butlerPath: string;
	tmpDir: string;

	constructor(butlerPath: string, tmpDir: string) {
		super();

		this.butlerPath = butlerPath;
		this.tmpDir = tmpDir;
	}

	apply(patch: string, target: string): Promise<void> {
		const applyDir = path.join(this.tmpDir, 'patch_apply');
		return new Promise((resolve, reject) => {
			const tmpDestination = getTemporaryFileName(this.tmpDir, 'download');
			makeParentDir(tmpDestination);
			fs.rmdirSync(applyDir, { recursive: true });

			const args = ['-j', 'apply', `--staging-dir=${applyDir}`, patch, target];
			const process = spawn(this.butlerPath, args);
			this.emit('started', args.join(' '));

			let finished = false;
			let total = 1;

			const rlStdout = readline.createInterface({ input: process.stdout });
			rlStdout.on('line', line => {
				this.emit('log', 'info', line);

				const downloadLine: DownloadLine = JSON.parse(line) as DownloadLine;
				if (downloadLine == null) {
					return;
				}

				const lineType = downloadLine.type;
				if (lineType === LineType.Log) {
					const msg = downloadLine.message;
					if (msg?.startsWith('Downloading')) {
						try {
							const msgParts = msg.split(' ');
							const size: number = +msgParts[1];
							const unit = msgParts[2];
							if (unit == 'KiB') {
								total = size * 1024;
							} else if (unit == 'MiB') {
								total = size * 1024 * 1024;
							} else if (unit == 'GiB') {
								total = size * 1024 * 1024 * 1024;
							} else if (unit == 'TiB') {
								total = size * 1024 * 1024 * 1024 * 1024;
							} else {
								total = size;
							}
						} catch (_) {
							// ignore errors when parsing unstructured data
						}
					}
				} else if (lineType === LineType.Progress && downloadLine.progress != null) {
					const progress: number = downloadLine.progress;
					this.emit('progress', progress * total, total);
				}
			});

			const rlStderr = readline.createInterface({ input: process.stderr });
			rlStderr.on('line', line => {
				this.emit('warn', line);
			});


			process.on('close', code => {
				if (finished) { // the process already counts as finished
					return;
				}
				if (code == 0) {
					this.emit('progress', total, total);
					resolve();
				} else {
					reject(`Applying patch failed with : ${code}`);
				}
			});

			process.on('error', error => {
				finished = true;
				reject(`Failed to launch butler with error: ${error}`);
			});

			this.process = process;
		});
	}

	download(url: string, downloadPath: string): Promise<void> {
		const promise: Promise<void> = new Promise((resolve, reject) => {
			const tmpDestination = getTemporaryFileName(this.tmpDir, path.basename(downloadPath));
			makeParentDir(tmpDestination);
			const args = ['-j', '-v', 'dl', url, tmpDestination];
			const process = spawn(this.butlerPath, args);
			this.emit('started', args.join(' '));

			let finished = false;
			let total = 1;

			const rlStdout = readline.createInterface({ input: process.stdout });
			rlStdout.on('line', line => {

				const downloadLine: DownloadLine = JSON.parse(line) as DownloadLine;

				const lineType = downloadLine.type;
				if (lineType === LineType.Log) {
					const msg = downloadLine.message;
					if (msg?.startsWith('Downloading')) {
						try {
							const msgParts = msg.split(' ');
							const size: number = +msgParts[1];
							const unit = msgParts[2];
							if (unit == 'KiB') {
								total = size * 1024;
							} else if (unit == 'MiB') {
								total = size * 1024 * 1024;
							} else if (unit == 'GiB') {
								total = size * 1024 * 1024 * 1024;
							} else if (unit == 'TiB') {
								total = size * 1024 * 1024 * 1024 * 1024;
							} else {
								total = size;
							}
						} catch (_) {
							// ignore errors when parsing unstructured data
						}
					}
				} else if (lineType === LineType.Progress && downloadLine.progress != null) {
					const progress: number = downloadLine.progress;
					this.emit('progress', progress * total, total);
				}
			});

			const rlStderr = readline.createInterface({ input: process.stderr });
			rlStderr.on('line', line => {
				if (line.includes('connect: connection refuse')) {
					this.emit('log', 'info', 'Connection refused error');
				}
				this.emit('warn', line);
			});

			process.on('close', code => {
				if (finished) { // the process already counts as finished
					return;
				}
				if (code == 0) {
					this.emit('progress', total, total);
					makeParentDir(downloadPath);
					fs.renameSync(tmpDestination, downloadPath);
					resolve();
				} else {
					if (fs.existsSync(tmpDestination)) {
						fs.unlinkSync(tmpDestination);
					}
					reject(`Download ${url} -> ${downloadPath} failed with: ${code}`);
				}
			});

			process.on('error', error => {
				finished = true;
				reject(`Failed to launch butler with error: ${error}, for download ${url} -> ${downloadPath}`);
			});

			this.process = process;
		});

		return promise;
	}

	stop(): void {
		if (this.process == null) {
			return;
		}

		this.process.kill('SIGKILL');
		this.emit('aborted', 'Butler process interrupted via user action.');
	}
}
