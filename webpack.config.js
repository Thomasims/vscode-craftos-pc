const path = require("path");

module.exports = {
	target: "webworker",
	mode: "development",
	entry: {
		main: "./src/index.ts",
	},
	output: {
		path: path.resolve(__dirname),
		libraryTarget: "commonjs2",
		filename: "extension.js",
		devtoolModuleFilenameTemplate: "../[resource-path]",
	},
	devtool: 'source-map',
	externals: {
		vscode: "commonjs vscode",
		child_process: "commonjs child_process",
		os: "commonjs os",
		fs: "commonjs fs",
		path: "commonjs path",
		https: "commonjs https",
		ws: "commonjs ws",
		events: "commonjs events",
	},
	resolve: {
		extensions: [".ts", ".tsx", ".js"],
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				loader: "ts-loader",
			},
		],
	},
};
