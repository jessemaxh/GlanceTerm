// Standalone build config — used when running `npm run build` inside
// this plugin folder for fast dev iteration. The sibling `.mjs` is used
// by the monorepo build pipeline (scripts/build-modules.mjs) when
// packaging the final .dmg / .exe / .AppImage. The two configs use
// different toolchains by design: this `.js` runs plain `ts-loader`
// for speed; the `.mjs` goes through `webpack.plugin.config.mjs` which
// adds `@ngtools/webpack` for the Angular template compile path.
// Both exist on purpose; webpack-cli picks the `.js` first when run
// from this directory. Same pattern as tabby-plugin-ai-sidebar.
const path = require('path')

module.exports = {
    target: 'node',
    entry: './src/index.ts',
    devtool: 'source-map',
    context: __dirname,
    mode: 'development',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        pathinfo: true,
        libraryTarget: 'umd',
        devtoolModuleFilenameTemplate: 'webpack-tabby-plugin-mobile-bridge:///[resource-path]',
    },
    resolve: {
        modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: 'ts-loader',
                options: { configFile: path.resolve(__dirname, 'tsconfig.json') },
            },
        ],
    },
    externals: [
        'fs', 'path', 'os', 'child_process', 'crypto', 'http', 'https', 'net', 'tls',
        '@electron/remote',
        /^@angular/,
        /^@ng-bootstrap/,
        /^rxjs/,
        /^tabby-/,
    ],
}
