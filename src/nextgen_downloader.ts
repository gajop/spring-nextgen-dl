import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

// import log from 'electron-log';

import { Butler } from './butler';
import { parse, fillChannelPlatform } from './nextgen_version_parse';
import { NextGenRapidCompat } from './nextgen_rapid_compat';
import { makeParentDir, makeDir } from './fs_utils';
import { getPkgDir } from './nextgen_utils';

const isDev = false;
const PKG_URL = isDev ? 'http://0.0.0.0:8000/pkg' : 'https://content.spring-launcher.com/pkg';
const FALLBACK_URL = isDev ? PKG_URL : 'https://spring-launcher.ams3.digitaloceanspaces.com/pkg';

const PKG_INFO_CACHE_TIME = 3600;
const LATEST_VERSION_CACHE_TIME = 300;

// TODO 3rd April:
// Support downloading based on Spring path (game, map or engine full name)
// Fix interrupting a patch-apply resulting in incorrect local version information (might lag by one)

// TODO: later
// Multiple local channels (main, test..)
// Multiple local versions (same channel..?)
// Report downloads to some service
// Allow custom path (not just game)
// sync -> async for all IO operations?

const SYSTEM_VERSION = 3;

interface PatchVersion {
	fromVersion: number,
	toVersion: number
}

interface Version {
	name: string,
	version: number
}

class NextGenDownloader extends EventEmitter {
	private butler: Butler;

	private butlerPath: string;
	private springWritePath: string;
	private pkgDir: string;
	private tmpDir: string;
	private nextgenRapidCompat: NextGenRapidCompat;

	constructor(butlerPath: string, springWritePath: string) {
		super();

		this.butlerPath = butlerPath;
		this.springWritePath = springWritePath;
		this.nextgenRapidCompat = new NextGenRapidCompat(this.springWritePath);

		this.pkgDir = getPkgDir(this.springWritePath);

		this.tmpDir = path.join(springWritePath, 'tmp');

		/*
		// TODO: or not TODO
		// Check if any patches were in progress and correct any mistakes
		let inProgressFile = `${this.pkgDir}/.inprogress`;
		if (fs.existsSync(inProgressFile)) {
			const inProgress = JSON.parse(fs.readFileSync(inProgressFile));

			inProgress['originalFile'] = '';
			const localVersion = this.queryLocalVersion(inProgress['urlPart']);

			this.updateLocalVersion(inProgress['name'], resolvedVersion);

			fs.unlinkSync(inProgressFile);
		}
		*/

		this.systemVersionCheck();

		this.butler = new Butler(butlerPath, this.tmpDir);

		this.butler.on('log', (level: string, msg: string) => {
			this.emit('log', level, `Butler: ${msg}`);
		});
	}

	/// API

	async download(fullName: string): Promise<void> {
		try {
			await this.downloadInternal(fullName);
		} catch (err) {
			this.emit('failed', fullName, `Download failed ${fullName}`);
			this.emit('log', 'error', err);
		}
	}

	async downloadMetadata(fullName: string): Promise<void> {
		await this.downloadMetadataInternal(fullName).catch(err => {
			this.emit('log', 'error', err);
			this.emit('log', 'info', typeof err);
			throw err;
		});
	}

	/// END API

	private stopDownload(): void {
		// TODO
	}

	private systemVersionCheck(): void {
		const existingVersion = this.getSystemVersion();

		if (existingVersion == SYSTEM_VERSION) {
			return;
		}

		this.emit('log', 'info', `System upgrade: ${existingVersion} -> ${SYSTEM_VERSION}`);

		if (fs.existsSync(this.pkgDir)) {
			fs.rmdirSync(this.pkgDir, { recursive: true });
		}
		fs.mkdirSync(this.pkgDir);

		const systemVersionJson = path.join(this.pkgDir, 'system.json');
		fs.writeFileSync(systemVersionJson, JSON.stringify({
			version: SYSTEM_VERSION
		}));
	}

	private getSystemVersion(): number {
		const systemVersionJson = path.join(this.pkgDir, 'system.json');
		if (!fs.existsSync(systemVersionJson)) {
			return 0;
		}

		try {
			return JSON.parse(fs.readFileSync(systemVersionJson, 'utf8'))['version'];
		} catch (err) {
			this.emit('log', 'info', `Failed to parse ${systemVersionJson}, resetting`);
			fs.unlinkSync(systemVersionJson);
			return 0;
		}
	}

	private async downloadInternal(fullName: string): Promise<void> {
		let parsed = parse(fullName);
		const name = parsed.user + '/' + parsed.repo;
		this.emit('started', `${fullName}: metadata`);

		const pkgInfo = await this.queryPackageInfo(name);

		parsed = fillChannelPlatform(parsed, pkgInfo);
		const channel = parsed.channel;
		const platform = parsed.platform;
		const versionID = parsed.version;
		const urlPart = `${name}/${channel}/${platform}`;

		const localVersion = this.queryLocalVersion(name);
		const targetVersion: Version = await (
			versionID != null
				? this.queryRemoteVersion(urlPart, versionID)
				: this.queryLatestVersion(urlPart)
		);

		if (localVersion != null) {
			if (localVersion['version'] == targetVersion['version']) {
				this.emit('log', 'info', `No download necessary for ${fullName}`);

				const rapidTag: string = pkgInfo['rapid'];
				if (rapidTag != null && versionID == null) {
					const versionsGz = path.join(this.springWritePath, `rapid/repos.springrts.com/${rapidTag}/versions.gz`);
					if (!fs.existsSync(versionsGz)) {
						this.updateRapidTag(rapidTag, targetVersion);
					}
				}

				this.emit('finished', fullName);
				return;
			}
		}

		const packagePath = pkgInfo['path'];
		await this.downloadPackage(packagePath, fullName, name, urlPart, localVersion['version'], targetVersion);
		this.updateLocalVersion(name, targetVersion);
		if (versionID == null) {
			const rapidTag = pkgInfo['rapid'];
			if (rapidTag != null) {
				// TODO: also fill this in case versionID is specified as latest?
				this.updateRapidTag(rapidTag, targetVersion);
			}
		}

		this.emit('finished', name);
	}

	// DRY this and downloadInternal
	private async downloadMetadataInternal(fullName: string): Promise<void> {
		let parsed = parse(fullName);
		const name = parsed.user + '/' + parsed.repo;
		this.emit('started', `${fullName}: metadata`);

		const pkgInfo = await this.queryPackageInfo(name);

		parsed = fillChannelPlatform(parsed, pkgInfo);
		const channel = parsed.channel;
		const platform = parsed.platform;
		const versionID = parsed.version;
		const urlPart = `${name}/${channel}/${platform}`;

		await (
			versionID != null
				? this.queryRemoteVersion(urlPart, versionID)
				: this.queryLatestVersion(urlPart)
		);
	}

	private async queryPackageInfo(name: string) {
		return this.queryWithCache(`${name}/package-info.json`, PKG_INFO_CACHE_TIME);
	}

	private queryLocalVersion(name: string) {
		const versionInfo = `${this.pkgDir}/${name}/local-version.json`;
		if (!fs.existsSync(versionInfo)) {
			return null;
		}
		return JSON.parse(fs.readFileSync(versionInfo, 'utf8'));
	}

	private async queryLatestVersion(urlPart: string): Promise<Version> {
		return this.queryWithCache(`${urlPart}/latest.json`, LATEST_VERSION_CACHE_TIME);
	}

	private async queryRemoteVersion(urlPart: string, version: number): Promise<Version> {
		const versionInfo = await this.queryFileIfNotExist(`${urlPart}/patch/${version}.json`);
		return {
			version: version,
			name: versionInfo['name']
		};
	}

	private async queryWithCache(baseUrl: string, cacheTime: number) {
		const localFile = `${this.pkgDir}/${baseUrl}`;
		let shouldQueryRemote = true;
		if (fs.existsSync(localFile)) {
			const stat = fs.statSync(localFile);
			const now = new Date();
			if (+now - (+stat.mtime) < cacheTime * 1000) {
				shouldQueryRemote = false;
			}
		}

		while (true) {
			if (shouldQueryRemote) {
				await downloadFileWithFallback(this.butler, baseUrl, localFile);
			}
			try {
				return JSON.parse(fs.readFileSync(localFile, 'utf8'));
			} catch (err) {
				if (shouldQueryRemote) {
					// we already queried once, nothing we can do
					throw err;
				} else {
					// try to query the file again
					shouldQueryRemote = true;
				}
			}
		}
	}

	private async queryFileIfNotExist(baseUrl: string) {
		const localFile = `${this.pkgDir}/${baseUrl}`;
		let shouldQueryRemote = !fs.existsSync(localFile);

		while (true) {
			if (shouldQueryRemote) {
				await downloadFileWithFallback(this.butler, baseUrl, localFile);
			}
			try {
				return JSON.parse(fs.readFileSync(localFile, 'utf8'));
			} catch (err) {
				if (shouldQueryRemote) {
					// we already queried once, nothing we can do
					throw err;
				} else {
					// try to query the file again
					shouldQueryRemote = true;
				}
			}
		}
	}

	private async downloadPackage(packagePath: string, fullName: string, name: string, urlPart: string, localVersionID: number | null, targetVersion: Version): Promise<void> {
		if (localVersionID === null) {
			const latestVersion = await this.queryLatestVersion(urlPart);
			this.emit('started', fullName);
			await this.downloadPackageFull(packagePath, fullName, name, urlPart, latestVersion);
			return await this.downloadPackagePartial(packagePath, fullName, name, urlPart, latestVersion.version, targetVersion);
		} else {
			return await this.downloadPackagePartial(packagePath, fullName, name, urlPart, localVersionID, targetVersion);
		}
	}

	private async downloadPackageFull(packagePath: string, fullName: string, name: string, urlPart: string, targetVersion: Version): Promise<void> {
		const patchVersions: PatchVersion[] = [{
			fromVersion: 0,
			toVersion: targetVersion['version'],
		}];
		return await this.downloadPackagePartialInternal(packagePath, fullName, name, urlPart, patchVersions, targetVersion);
	}


	private async downloadPackagePartial(packagePath: string, fullName: string, name: string, urlPart: string, localVersionID: number, targetVersion: Version): Promise<void> {
		const targetVersionID = targetVersion['version'];

		// assume patches exist in linear order
		const versionDir = targetVersionID > localVersionID ? 1 : -1;
		const patchVersions: PatchVersion[] = [];
		for (let version = localVersionID; version != targetVersionID; version += versionDir) {
			patchVersions.push({
				fromVersion: version,
				toVersion: version + versionDir
			});
		}

		await this.downloadPackagePartialInternal(packagePath, fullName, name, urlPart, patchVersions, targetVersion);
	}

	private async downloadPackagePartialInternal(packagePath: string, fullName: string, name: string, urlPart: string, patchVersions: PatchVersion[], targetVersion: Version): Promise<void> {
		const patchJsonDls = [];
		const patchJsonFiles = [];
		for (const patchVersion of patchVersions) {
			const patchJsonUrl = `${urlPart}/patch/${patchVersion.fromVersion}-${patchVersion.toVersion}.json`;
			const patchJsonFile = `${this.pkgDir}/${patchJsonUrl}`;

			if (!fs.existsSync(patchJsonFile)) {
				patchJsonDls.push(downloadFileWithFallback(this.butler, patchJsonUrl, patchJsonFile));
			}
			patchJsonFiles.push(patchJsonFile);
		}
		this.emit('log', 'info', `${patchJsonDls.length} patches to download`);
		await Promise.all(patchJsonDls);

		const patchSizes = [];
		const patchSigSizes = [];
		let totalPatchSize = 0;
		for (const patchJsonFile of patchJsonFiles) {
			const patchesJson = JSON.parse(fs.readFileSync(patchJsonFile, 'utf8'));
			const size = patchesJson['size'];
			const sig_size = patchesJson['sig_size'];
			patchSizes.push(size);
			patchSigSizes.push(sig_size);
			totalPatchSize += size;
			totalPatchSize += sig_size;
		}

		const patches = [];
		this.emit('started', fullName);
		const downloads = [];
		for (const [i, patchVersion] of patchVersions.entries()) {
			const fromVersion = patchVersion.fromVersion;
			const toVersion = patchVersion.toVersion;

			const patchUrl = `${urlPart}/patch/${fromVersion}-${toVersion}`;
			const patchSigUrl = `${patchUrl}.sig`;

			const patchFile = `${this.pkgDir}/${urlPart}/patch/${fromVersion}-${toVersion}`;
			const patchSigFile = `${patchFile}.sig`;

			if (!fs.existsSync(patchFile)) {
				downloads.push({
					url: patchUrl,
					path: patchFile,
					size: patchSizes[i],
				});
			}

			if (!fs.existsSync(patchSigFile)) {
				downloads.push({
					url: patchSigUrl,
					path: patchSigFile,
					size: patchSigSizes[i],
				});
			}

			patches.push(patchFile);
		}

		const parallelPatchDownload = new ParallelDownload(this.butlerPath, this.tmpDir);
		parallelPatchDownload.on('progress', (current, total) => {
			this.emit('progress', fullName, current, total);
		});
		parallelPatchDownload.on('aborted', msg => {
			// TODO: abort should just act as if rejected?
			this.emit('aborted', fullName, msg);
		});
		parallelPatchDownload.on('warn', msg => {
			this.emit('log', 'warn', msg);
		});

		await parallelPatchDownload.download(downloads);
		await this.applyPatches(name, fullName, totalPatchSize, packagePath, patchVersions, patches, patchSizes, patchSigSizes, targetVersion);
	}

	private async applyPatches(name: string, fullName: string, totalPatchSize: number, packagePath: string,
		patchVersions: PatchVersion[], patches: string[], patchSizes: number[], patchSigSizes: number[], targetVersion: Version): Promise<void> {
		this.emit('started', `${fullName}: applying`);
		// Represent patch application in MBs to satisfy our progress display logic
		let progressedPatchSize = 0;
		const targetVersionCopy = JSON.parse(JSON.stringify(targetVersion));

		const repo_path = `${this.springWritePath}/${packagePath}`;
		for (const [i, patchVersion] of patchVersions.entries()) {
			makeDir(repo_path);

			const fromVersion = patchVersion.fromVersion;
			const toVersion = patchVersion.toVersion;
			this.emit('log', 'info', `Starting patch ${fromVersion} -> ${toVersion}`);
			// targetVersionCopy['patchProgress'] = '';
			targetVersionCopy['version'] = toVersion;
			await this.butler.apply(patches[i], repo_path);
			this.updateLocalVersion(name, targetVersionCopy);
			this.emit('log', 'info', `Finished patch ${fromVersion} -> ${toVersion}`);

			progressedPatchSize += patchSizes[i] + patchSigSizes[i];
			this.emit('progress', fullName, progressedPatchSize, totalPatchSize);
		}
	}

	private async updateRapidTag(rapidTag: string, targetVersion: Version): Promise<void> {
		const versionsGz = path.join(this.springWritePath, `rapid/repos.springrts.com/${rapidTag}/versions.gz`);
		this.nextgenRapidCompat.setTouchedByNextgen(versionsGz, true);

		const fullRapidTag = `${rapidTag}:test`;
		let archiveName = targetVersion['name'];
		archiveName = archiveName.substring(0, archiveName.length - '.sdz'.length);
		this.emit('log', 'info', `${fullRapidTag} rapid tag now points to: ${archiveName}`);
		const newLine = `${fullRapidTag},,,${archiveName}`;

		const lines = [];
		if (fs.existsSync(versionsGz)) {
			const lineReader = readline.createInterface({
				input: fs.createReadStream(versionsGz).pipe(zlib.createGunzip())
			});
			for await (let line of lineReader) {
				if (line.includes(fullRapidTag)) {
					line = newLine;
				}
				lines.push(line);
			}
		} else {
			lines.push(newLine);
		}

		makeParentDir(versionsGz);
		const output = fs.createWriteStream(versionsGz);
		const compress = zlib.createGzip();
		compress.pipe(output);
		for (const line of lines) {
			compress.write(line + '\n');
		}
		compress.end();
	}

	private updateLocalVersion(name: string, latestVersion: Version): void {
		const versionInfo = `${this.pkgDir}/${name}/local-version.json`;
		fs.writeFileSync(versionInfo, JSON.stringify(latestVersion));
	}
}

async function downloadFileWithFallback(butler: Butler, baseUrl: string, file: string) {
	try {
		return await butler.download(`${PKG_URL}/${baseUrl}`, file);
	} catch (err) {
		console.warn(`Primary url download failed ${PKG_URL}/${baseUrl} -> ${file}. Retrying with fallback: ${FALLBACK_URL}/${baseUrl}`);
		return await butler.download(`${FALLBACK_URL}/${baseUrl}`, file);
	}
}

interface Download {
	url: string,
	path: string,
	size: number,
}

class ParallelDownload extends EventEmitter {
	private downloads?: Download[];
	private butlerPath: string;
	private tmpDir: string;

	constructor(butlerPath: string, tmpDir: string) {
		super();

		this.butlerPath = butlerPath;
		this.tmpDir = tmpDir;
	}

	async download(downloads: Download[]) {
		const promises = [];
		this.downloads = downloads;
		let combinedTotal = 0;
		let combinedProgress = 0;
		const downloadProgresses: number[] = [];
		for (const download of downloads) {
			combinedTotal += download['size'];
			downloadProgresses.push(0);
		}

		for (const [i, download] of downloads.entries()) {
			const url = download['url'];
			const path = download['path'];

			const downloader = new Butler(this.butlerPath, this.tmpDir);

			downloader.on('progress', current => {
				combinedProgress += current - downloadProgresses[i];
				downloadProgresses[i] = current;
				this.emit('progress', combinedProgress, combinedTotal);
			});

			// downloader.on('aborted', msg => {
			// 	// TODO: abort should just act as if rejected?
			// 	this.emit('aborted', this.name, msg);
			// });

			downloader.on('warn', msg => {
				this.emit('log', 'warn', `${download}: ${msg}`);
			});

			promises.push(downloadFileWithFallback(downloader, url, path));
		}

		return Promise.all(promises);
	}
}

export {
	NextGenDownloader,
};
