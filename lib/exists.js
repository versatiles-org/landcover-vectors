// promisified missing fs.exists

const fs = require("node:fs/promises");

module.exports = async file=>{
	try {
		await fs.access(file, fs.constants.F_OK);
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	};
};