const platformName = process.platform;

if (platformName != 'win32' && platformName != 'linux' && platformName != 'darwin') {
	throw 'Unsupported platform';
}

const platformMap = {
	'win32': 'windows-amd64',
	'linux': 'linux-amd64',
	'darwin': 'darwin-amd64',
	'any': 'any'
};
export const defaultPlatform: string = platformMap[platformName];
export const defaultChannel = 'main';

// fullName format: 'user/repo@channel:version#platform'
// channel, version and platform are optional
const fullNameRegex = new RegExp(
	'^' +
	'(?<user>[A-Za-z0-9_\\-\\.]+)' +
	'/' +
	'(?<repo>[A-Za-z0-9_\\-\\.]+)' +
	'(@(?<channel>[A-Za-z0-9]+))?' +
	'(:(?<version>[0-9]+))?' +
	'(#(?<platform>windows-amd64|linux-amd64|darwin-amd64|any))?' +
	'$'
);

export interface Version {
	user: string;
	repo: string;
	channel?: string;
	platform?: string;
	version?: number;
}

export function parse(fullName: string): Version {
	const match = fullNameRegex.exec(fullName);
	if (match == null || match.groups == null) {
		throw `Failed to parse: ${fullName}`;
	}

	const obj: Version = {
		user: match.groups.user,
		repo: match.groups.repo
	};

	if (match.groups.version != null) {
		obj.version = parseInt(match.groups.version);
	}
	if (match.groups.channel != null) {
		obj.channel = match.groups.channel;
	}
	if (match.groups.platform != null) {
		obj.platform = match.groups.platform;
	}

	return obj;
}

export function fillEmptyWithDefaults(obj: Version): Version {
	obj.channel = obj.channel != null ? obj.channel : defaultChannel;
	obj.platform = obj.platform != null ? obj.platform : defaultPlatform;
	return obj;
}

export function parseWithDefaults(fullName: string): Version {
	return fillEmptyWithDefaults(parse(fullName));
}

interface PkgInfo {
	channels: Channel[]
}

interface Channel {
	platform: string[],
}

export function fillChannelPlatform(obj: Version, pkgInfo: PkgInfo): Version {
	// If channel is specified require an exact match.
	// If no channel is specified prefer main but accept anything
	const matchChannelExactly = obj.channel != null;
	let channel = null;
	let platforms: string[] | null = null;
	for (const [remoteChannel, remotePlatforms] of Object.entries(pkgInfo['channels'])) {
		if (matchChannelExactly) {
			if (remoteChannel === obj.channel && Array.isArray(remotePlatforms)) {
				channel = remoteChannel;
				platforms = remotePlatforms;
				break;
			}
		} else {
			if ((channel == null || remoteChannel === 'main') && Array.isArray(remotePlatforms)) {
				channel = remoteChannel;
				platforms = remotePlatforms;

				if (remoteChannel === 'main') {
					break;
				}
			}
		}
	}

	if (channel == null || platforms == null) {
		throw 'No matching channel found';
	}

	// If platform is specified (as non-any) require an exact match.
	// If no platform is specified prefer native, but accept the 'any' platform.
	// Do not accept non-native platforms.
	const matchPlatformExactly = obj.platform != null && obj.platform != 'any';
	let platform = null;
	for (const remotePlatform of platforms) {
		if (matchPlatformExactly) {
			if (obj.platform === remotePlatform) {
				platform = remotePlatform;
				break;
			}
		} else {
			if (remotePlatform == 'any') {
				platform = remotePlatform;
			} else if (remotePlatform == defaultPlatform) {
				platform = defaultPlatform;
				break;
			}
		}
	}

	if (platform == null) {
		throw 'No matching platform found';
	}

	obj.channel = channel;
	obj.platform = platform;
	return obj;
}
