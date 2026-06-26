// Standalone build config — used when running `npm run build` inside this
// plugin folder for fast dev iteration. The sibling `.mjs` is used by the
// monorepo build pipeline (scripts/build-modules.mjs) when packaging the
// final .dmg / .exe / .AppImage. Both exist on purpose; webpack-cli picks
// the `.js` first when run from this directory.
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
        devtoolModuleFilenameTemplate: 'webpack-tabby-plugin-ai-sidebar:///[resource-path]',
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
            {
                test: /\.svg$/,
                type: 'asset/source',
            },
        ],
    },
    externals: [
        'fs', 'path', 'os', 'child_process',
        'electron',
        '@electron/remote',
        /^@angular/,
        /^@ng-bootstrap/,
        /^rxjs/,
        /^tabby-/,
    ],
}
