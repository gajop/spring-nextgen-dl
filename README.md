# spring-nextgen-dl
Spring NextGen download system

## Usage

`npm i --save spring-nextgen-dl`

```ts
import { NextGenDownloader } from 'spring-nextgen-dl';

(async () => {
	const butlerPath = 'path-to-butler-bin';
	const writePath = 'path-to-springdir';

	const nextGenDownloader = new NextGenDownloader(butlerPath, writePath);

	await nextGenDownloader.download('SpringBoard-Core/SpringBoard-Core');
	await nextGenDownloader.download('beyond-all-reason/BYAR-Chobby');
	await nextGenDownloader.download('Chobby/Chobby');
})();
```

See http://github.com/gajop/spring-launcher for details on how to include butler into your project.