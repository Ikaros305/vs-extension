/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const path = require('path');
const webpack = require('webpack');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
	mode: 'none', // this leave the matter of minification of @vscode/extension-telemetry up to the extension
	target: 'node',
	node: {
		__dirname: false // leave __dirname unchanged
	},
	entry: {
		extension: './src/extension.ts',
	},
	output: {
		filename: '[name].js',
		path: path.resolve(__dirname, 'dist'),
		libraryTarget: 'commonjs',
		devtoolModuleFilenameTemplate: '../../[resource-path]'
	},
	resolve: {
		mainFields: ['module', 'main'],
		extensions: ['.ts', '.js'], // support ts-loader
		alias: {}
	},
	module: {
		rules: [{
			test: /\.ts$/,
			exclude: /node_modules/,
			use: [{
				loader: 'ts-loader'
			}]
		}]
	},
	externals: {
		'vscode': 'commonjs vscode', // ignored because it's provided by the runtime
	},
	performance: {
		hints: false
	},
	devtool: 'nosources-source-map', // create a source map that doesn't contain the source content,
	infrastructureLogging: {
		level: 'log', // use default level
	}
};

module.exports = [extensionConfig];
