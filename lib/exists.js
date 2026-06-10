// promisified missing fs.exists

import fs from 'node:fs/promises';

export default async (file) => {
	try {
		await fs.access(file, fs.constants.F_OK);
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	}
};
