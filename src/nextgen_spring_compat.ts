import got from 'got';

const isDev = false;
const api_backend = isDev ? 'http://localhost:3000/api' : 'http://backend.spring-launcher.com/api';

export async function springToNextgen(springName: string): Promise<string> {
	const response = await got.post<{nextgenName: string}>(`${api_backend}/versions/from-springname/`, {
		json: {
			springName: springName
		},
		responseType: 'json'
	});

	return response.body.nextgenName;
}

