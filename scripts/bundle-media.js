/**
 * Simple script to bundle highlight.js into a single browser-ready UMD file.
 * Run with: node scripts/bundle-media.js
 */
const webpack = require('webpack');
const path = require('path');
const fs = require('fs');

const config = {
    mode: 'production',
    entry: path.resolve(__dirname, '../node_modules/highlight.js/lib/common.js'),
    output: {
        filename: 'highlight.min.js',
        path: path.resolve(__dirname, '../media'),
        library: 'hljs',
        libraryTarget: 'window',
        libraryExport: 'default'
    },
    resolve: {
        fallback: {}
    }
};

webpack(config, (err, stats) => {
    if (err) {
        console.error('Webpack fatal error:', err.message);
        process.exit(1);
    }
    if (stats.hasErrors()) {
        console.error(stats.toString({ colors: true }));
        process.exit(1);
    }
    console.log('highlight.min.js bundled successfully!');
});
